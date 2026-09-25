# Idle Agent Process Cleanup — Spec & Pseudocode

Status: draft for architecture-phase review. Written directly from a fully-confirmed
design-decision brief (see "Confirmed decisions" below) — those decisions are treated
as fixed inputs, not re-litigated here.

## 1. Problem & confirmed decisions (recap, not open for debate)

Orphaned agent-CLI child processes (e.g. a Git-for-Windows `find.exe` left behind when
its parent Claude Code session's terminal pane closed mid-search) can run indefinitely,
pegging a CPU core. With ~131 concurrent Claude Code sessions typical for this user,
these accumulate silently. The fix must be generic across agent CLIs (Claude Code,
Codex, Pi, Prime-agent, future ones), live inside Orca, and run periodically.

Fixed decisions this spec builds on (do not re-derive):

1. "Idle" = orphaned only (ppid absent from the process table). No CPU-idle-while-parented detection.
2. Scope = descendants of Orca-owned local terminal panes only. No system-wide scan.
3. Safety = scope + signature + orphan-status only. No separate denylist.
4. Signature matching = command-line substring match against an internal, code-level, non-user-editable registry.
5. Reuse the existing per-pane process-table read path to keep a rolling descendant-PID record per pane.
6. On pane close: one immediate fresh snapshot, then retain that pane's last-known descendants for ~10 minutes (in-memory only, lost on Orca restart — accepted).
7. Every cleanup tick scans both live panes' current descendants and closed panes' still-in-grace retained descendants.
8. Action = auto-kill, no confirmation gate.
9. PID-reuse guard: re-verify signature + orphan status immediately before each kill.
10. Kill mechanism: new bare-PID path — POSIX `process.kill(pid, 'SIGKILL')`, Windows `taskkill /pid <pid> /t /f` via `runProcess`/`spawnProcess` (never raw `child_process`).
11. A "recently cleaned" log (pid, command, timestamp) persists to disk across restarts.
12. UI = a new section in the existing Settings panel: on/off toggle, interval control, recently-cleaned list.
13. Periodicity = a plain interval timer in Orca's main process, default ~5 minutes, user-configurable.

Explicitly out of scope: signature-registry UI, system-wide scanning, CPU-idle-while-parented detection, manual review/dry-run, disk persistence of the retained-PID tracking state.

Resolved after this draft (user sign-off, folded in below): v1 is explicitly
**local-panes-only** — SSH-hosted and WSL-guest panes are deferred, not silently
dropped (§8.2 is now resolved, not open). The signature match adds a **pane-lineage
fallback** (§3.1/§5c) rather than requiring the orphan's own command line to carry the
substring. `idleAgentCleanupEnabled` defaults to **`false`** (§3.4, §8.5 resolved).

## 2. Existing infrastructure this design reuses

Confirmed present and read as part of this spec's research:

- `src/shared/process-table-snapshot.ts` — POSIX process table (`ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command=`), TTL-cached (`getProcessTableSnapshot`) and fresh (`getFreshProcessTableSnapshot`) readers, single-flight deduped.
- `src/main/windows/windows-process-table.ts` — Windows Toolhelp32-based table, `readWindowsProcessTable()` / `readWindowsProcessTableFresh()`. **Both reject rather than return empty** when the table can't be read — "unavailable" must never be read as "empty" (`docs/reference/windows-process-enumeration.md`).
- `src/shared/child-process/run-process.ts` (`runProcess`, `spawnProcess`, types in `process-spec.ts`) — the one place Orca is allowed to start a child process; on Windows it pins `windowsHide`, refuses `shell: true`, and handles `.cmd`/`.bat` argument encoding. `src/main/windows-process-tree-kill.ts` (`terminateWindowsProcessTree`) is a *reference shape* for `taskkill /pid <pid> /T /F` but calls `execFile` directly rather than through `runProcess` — the new kill path must not repeat that; it has to go through `runProcess`.
- `src/main/providers/local-pty-provider-state.ts` — per-pane in-memory state maps (`ptyProcesses`, `ptyShellName`, …) and `clearPtyState(id)`, the single teardown function called on pane close. This is the hook point for the pane-close/grace-period behavior (decision #6).
- `src/renderer/src/components/terminal-pane/agent-completion-poll-cadence.ts` + `agent-completion-process-monitor.ts` — the actual per-pane process-inspection cadence: a **renderer-owned, self-rescheduling `setTimeout`** (not a fixed `setInterval`), with tiers `active=750ms / idle=2000ms / hidden=3000ms / no-evidence=15000ms` (`POLL_TIER_INTERVAL_MS`) plus small jitter. Each inspection calls down through IPC into main's `getForegroundProcess`/`confirmForegroundProcess`, which for local panes resolves through `src/main/providers/agent-foreground-process.ts#resolveAgentForegroundProcessWithAvailability` — the exact place a `ProcessTableRow[]` and the pane's shell PID are already both in hand. **This is the natural hook point for decision #5's rolling descendant record** (see §5a).
- `src/main/crash-reporting/crash-report-store.ts` (`CrashReportStore`) — the closest existing precedent for "bounded, disk-persisted, last-N-entries" storage: a capped array (`MAX_REPORTS`), one JSON file under `app.getPath('userData')`, atomic tmp-file-then-rename writes, a serialized `writeChain` so concurrent writers don't interleave, `ENOENT`/parse-failure treated as empty rather than thrown. This is the template for the "recently cleaned" log (§3.3, §6).
- `src/shared/global-settings-types.ts` + `src/shared/default-global-settings.ts` + `src/main/persistence/loading-store/profile-preferences.ts` (`ProfilePreferences.getSettings`/`updateSettings`/`onSettingsChanged`) + `src/main/ipc/settings.ts` (`settings:get` / `settings:set` / `settings:changed`) — the single existing settings pipeline. New toggle/interval fields are added *here*, not as a bespoke store (per AGENTS.md "Reuse Before Reimplementing").
- `src/renderer/src/components/settings/AgentCacheTimerSection.tsx` — precedent for a toggle + conditional interval `<Select>` section (`SettingsSwitch`, `SearchableSetting`, `SettingsSubsectionHeader` from `SettingsFormControls.tsx`).
- `src/renderer/src/components/settings/MobilePairedDevicesSection.tsx` — precedent for a list-of-entries-with-timestamp-and-action UI row, the closest existing analogue to the recently-cleaned list.
- `src/preload/index.ts` / `src/preload/api-types.ts` — `window.api.<namespace>.<method>` bridge convention; `agentAwake: { getStatus(), onChanged() }` is the closest precedent for a small IPC surface that pairs an on-demand read with a push-on-change subscription (used here for the cleaned-log feed, §6).

## 3. Data model

### 3.1 Signature registry (`src/shared/idle-agent-cleanup-signatures.ts`)

```ts
export type IdleAgentCleanupSignature = {
  /** Display label used in the recently-cleaned log/UI, e.g. "Claude Code". */
  agentName: string
  /** Case-sensitive substrings; ANY match against a process's full command line qualifies it. */
  commandLineSubstrings: readonly string[]
}

export const IDLE_AGENT_CLEANUP_SIGNATURES: readonly IdleAgentCleanupSignature[] = [
  { agentName: 'Claude Code', commandLineSubstrings: ['claude', '.claude/', '.claude\\'] },
  { agentName: 'Codex', commandLineSubstrings: ['codex', '.codex/', '.codex\\'] },
  { agentName: 'Pi', commandLineSubstrings: ['.pi/', '.pi\\'] },
  { agentName: 'Prime Agent', commandLineSubstrings: ['prime-agent', '.prime-agent/'] }
  // Adding a future agent CLI = append one entry here. No other file changes needed
  // for detection (UI/registry-editing is explicitly out of scope).
]

export function matchIdleAgentCleanupSignature(
  commandLine: string
): IdleAgentCleanupSignature | null {
  for (const signature of IDLE_AGENT_CLEANUP_SIGNATURES) {
    if (signature.commandLineSubstrings.some((needle) => commandLine.includes(needle))) {
      return signature
    }
  }
  return null
}
// TEST: matches a command line containing 'claude' and returns the Claude Code signature
// TEST: matches a command line containing '.claude/' (helper tool invoked from within an agent's home dir) even with no 'claude' token
// TEST: returns null for a command line matching no registered substring
// TEST: matching is case-sensitive as specified — document this explicitly since it is a real false-negative risk (see §8)

// RESOLVED (was §8.3): pane-lineage fallback. Scope is already Orca-pane-descendants-only
// (decision #2), so every candidate has a known owning pane. A candidate whose OWN command
// line matches no signature is still a candidate if the pane's root shell/agent command
// line (recorded once, at pane-open, alongside the pane's tracking entry — see §3.2) matches
// one. This directly covers the triggering incident: a `find.exe` invoked from a Claude Code
// session's own shell, whose own argv carries no 'claude'/'.claude/' substring at all.
export function matchIdleAgentCleanupCandidate(
  candidateCommandLine: string,
  paneRootCommandLine: string
): IdleAgentCleanupSignature | null {
  return (
    matchIdleAgentCleanupSignature(candidateCommandLine) ??
    matchIdleAgentCleanupSignature(paneRootCommandLine)
  )
}
// TEST: candidate's own command line matches -> returns that signature, pane root not consulted
// TEST: candidate's own command line matches nothing, but the pane's root shell command line
//       matches a signature -> returns the pane-root signature (the find.exe/incident case)
// TEST: neither the candidate's nor the pane root's command line matches any signature -> null
```

This is deliberately **separate from** `src/shared/agent-process-recognition.ts` /
`src/shared/tui-agent-config.ts`. That module answers "is this exact process the agent's
own foreground binary" with precise tokenizing/entrypoint logic, for routing keystrokes.
This registry answers a broader question — "does this process's command line carry any
trace of a known agent" — because the cleanup candidate is very often *not* the agent
binary itself but an incidental child tool it spawned (a `find`, `rg`, `grep`, helper
script, etc.) whose own argv may only carry the agent's identity indirectly (e.g. a path
under `~/.claude/`). Reusing the precise recognizer here would under-match; the substring
registry is intentionally coarser.

### 3.2 Rolling descendant tracking (in-memory, main process)

```ts
// src/main/idle-agent-cleanup/pane-descendant-tracking-state.ts

/** Rolling record of an open pane's most recently observed descendant PIDs. */
export type PaneObservedDescendants = {
  paneId: string
  /** The pane's root shell/agent command line, captured once and never re-read — used by
   * the pane-lineage signature fallback (§3.1) so a candidate whose own argv carries no
   * agent signature can still match through what launched it. */
  rootCommandLine: string
  descendantPids: ReadonlySet<number>
  observedAtMs: number
}

/** A closed pane's last-known descendants, held for a grace period (decision #6). */
export type RetainedPaneDescendants = {
  paneId: string
  rootCommandLine: string
  descendantPids: ReadonlySet<number>
  /** Pane-close time; the grace period is measured from here. */
  retainedAtMs: number
}

// Both maps are process-lifetime, in-memory only — never written to disk (decision #6).
export const paneObservedDescendants = new Map<string, PaneObservedDescendants>()
export const retainedClosedPaneDescendants = new Map<string, RetainedPaneDescendants>()
```

### 3.3 Recently-cleaned log entry (on-disk, main process)

```ts
// src/shared/idle-agent-cleanup-log-entry.ts
export type IdleAgentCleanupLogEntry = {
  pid: number
  /** Full command line captured at kill time. */
  command: string
  agentName: string
  /** Originating pane id, when the candidate was still traceable to one at kill time. */
  paneId?: string
  timestamp: number
  outcome: 'killed' | 'kill-failed'
}
```

### 3.4 Settings additions (`src/shared/global-settings-types.ts` + `default-global-settings.ts`)

```ts
// New fields on the existing GlobalSettings type — no new settings file/store.
idleAgentCleanupEnabled: boolean
idleAgentCleanupIntervalMs: number
```

Defaults (`default-global-settings.ts`): `idleAgentCleanupIntervalMs: 300_000` (5 minutes,
per decision #13), `idleAgentCleanupEnabled: false` (resolved — was open in §8; off by
default for both new and existing installs, since decision #8's auto-kill has no
confirmation gate and defaulting it on would silently start killing processes on upgrade
for every user, not just this one).

## 4. Module/file plan

New directory `src/main/idle-agent-cleanup/` (naming follows AGENTS.md: concrete domain
concept, never `helpers`/`utils`):

| File | Responsibility |
|---|---|
| `src/shared/idle-agent-cleanup-signatures.ts` | Registry + `matchIdleAgentCleanupSignature` (§3.1) |
| `src/shared/idle-agent-cleanup-log-entry.ts` | `IdleAgentCleanupLogEntry` type (§3.3), shared between main and renderer |
| `src/main/idle-agent-cleanup/pane-descendant-tracking-state.ts` | In-memory maps + types (§3.2) |
| `src/main/idle-agent-cleanup/pane-descendant-observation.ts` | The hook that updates `paneObservedDescendants` from an already-fetched process table (§5a) |
| `src/main/idle-agent-cleanup/pane-close-descendant-retention.ts` | Pane-close handler: fresh snapshot + retain-with-grace-period (§5b) |
| `src/main/idle-agent-cleanup/idle-agent-cleanup-candidate-scan.ts` | Builds the orphan+signature candidate list from live + retained descendants (§5c, scan half) |
| `src/main/idle-agent-cleanup/idle-agent-process-kill.ts` | Bare-PID kill (POSIX `process.kill`, Windows `runProcess` + `taskkill`) with the pre-kill re-verify guard (§5c, kill half) |
| `src/main/idle-agent-cleanup/idle-agent-cleanup-log-store.ts` | On-disk bounded log, `CrashReportStore`-shaped (§3.3, §6) |
| `src/main/idle-agent-cleanup/idle-agent-cleanup-scheduler.ts` | Owns the interval timer; starts/stops/reschedules from settings (§5c driver) |
| `src/main/ipc/idle-agent-cleanup.ts` | `idleAgentCleanup:getRecentActivity` / `idleAgentCleanup:activityChanged` handlers (§6) |
| `src/renderer/src/components/settings/IdleAgentCleanupSection.tsx` | Toggle + interval + log list UI (§6) |

Modified files:

- `src/main/providers/agent-foreground-process.ts` (or its caller in
  `local-pty-foreground-inspection.ts` — see the ambiguity in §8) — call into
  `pane-descendant-observation.ts` wherever a `ProcessTableRow[]`/`WindowsProcessRow[]`
  and the pane's shell PID are already available from the existing scan.
- `src/main/providers/local-pty-provider-state.ts` (`clearPtyState`) — call the pane-close
  retention handler before deleting `ptyProcesses`'s entry for the id (needs the PID while
  it is still known).
- `src/shared/global-settings-types.ts`, `src/shared/default-global-settings.ts` — new fields (§3.4).
- `src/main/ipc/settings.ts` — no new channels needed for the toggle/interval themselves
  (they ride the existing `settings:get`/`settings:set`/`settings:changed`); add a
  post-`updateSettings` hook that reschedules the timer in
  `idle-agent-cleanup-scheduler.ts` when `idleAgentCleanupIntervalMs`/`idleAgentCleanupEnabled`
  change, mirroring the existing `APPEARANCE_MENU_KEYS` "rebuild something after this key
  changes" pattern already in that file.
- `src/preload/index.ts`, `src/preload/api-types.ts` — add the `idleAgentCleanup` bridge namespace.
- Main-process startup wiring (wherever `agentAwakeService`/other long-lived main services
  are constructed and started) — construct and start `idle-agent-cleanup-scheduler.ts`.

## 5. Control flow

### 5a. Per-pane polling hook — update the rolling descendant record

```
function recordPaneDescendantObservation(paneId, shellPid, rows):
  # rows: ProcessTableRow[] | WindowsProcessRow[] already fetched by the existing
  # foreground-process scan for this pane — do not trigger a new scan.
  shellRow = indexByPid(rows).get(shellPid)
  if shellRow == null:
    return   # shell itself not in this snapshot; nothing reliable to record this pass
  descendants = collectDescendants(rows, shellPid)   # already exists in agent-foreground-process.ts
  paneObservedDescendants.set(paneId, {
    paneId,
    rootCommandLine: shellRow.command,   # §3.1 pane-lineage fallback source
    descendantPids: new Set(descendants.map(d => d.pid)),
    observedAtMs: now()
  })
# TEST: given a rows snapshot with shellPid's tree [shell, childA, grandchildB], records {childA, grandchildB}
#       and rootCommandLine equal to the shell row's command
# TEST: a shellPid with no descendants records an empty set (not "no entry" — an empty set is still evidence the pane was observed)
# TEST: called with a stale/foreign rows snapshot for an id whose pane already closed must not resurrect its entry (mirror the `ptyProcesses.get(id) !== proc` staleness guard already used elsewhere in this file)
# TEST: shellPid itself missing from rows (edge race) -> no-op, previous observation (if any) is left untouched rather than overwritten with a blank rootCommandLine
```

Call site: inside (or immediately after) `resolveAgentForegroundProcessWithAvailability`
in `agent-foreground-process.ts`, for **both** the cached-scan and fresh-scan branches,
POSIX and Windows — every branch that already has rows in hand should feed this, since
skipping any branch leaves gaps in coverage exactly on the cadence tier
(`hidden`/`no-evidence`, up to 15s) where an orphan is most likely to go unnoticed.

### 5b. Pane-close handler — immediate snapshot + retain with grace period

```
async function retainDescendantsOnPaneClose(paneId, shellPid):
  # Captured from the last rolling observation BEFORE the fresh scan below — the shell
  # itself is exiting as part of this close, so it may already be gone from a fresh
  # snapshot by the time it runs; the rolling record is the reliable source for it.
  lastRootCommandLine = paneObservedDescendants.get(paneId)?.rootCommandLine ?? ''

  try:
    rows = await getFreshProcessTableSnapshot()   # or readWindowsProcessTableFresh() on win32
  catch:
    # Table unavailable at the exact moment of close: fall back to the last rolling
    # observation rather than losing this pane's descendants outright.
    rows = null

  descendants = rows != null
    ? collectDescendants(rows, shellPid).map(d => d.pid)
    : Array.from(paneObservedDescendants.get(paneId)?.descendantPids ?? [])

  paneObservedDescendants.delete(paneId)
  if descendants.length > 0:
    retainedClosedPaneDescendants.set(paneId, {
      paneId,
      rootCommandLine: lastRootCommandLine,
      descendantPids: new Set(descendants),
      retainedAtMs: now()
    })
# TEST: a fresh snapshot succeeds and finds a live grandchild the last rolling observation had missed -> retained set includes it
# TEST: the fresh snapshot rejects (table unavailable) -> falls back to the last rolling observation instead of retaining nothing
# TEST: a pane with zero observed descendants at close time is not retained at all (nothing to clean up later, no need to carry a dead entry for 10 minutes)
# TEST: retainedAtMs is stamped at call time, not at eventual eviction, so the grace period is measured from pane-close
# TEST: rootCommandLine on the retained entry comes from the last rolling observation, not a post-close re-scan (the shell itself may already be gone from the fresh snapshot)
```

Call site: `clearPtyState(id)` in `local-pty-provider-state.ts`, invoked *before* the
existing `ptyProcesses.delete(id)` line (the PID is still needed). This is fire-and-forget
from `clearPtyState`'s perspective — it must not block pane teardown on a process-table
scan; it schedules the async retention and returns.

Grace-period eviction (a small piece of §5c's tick, stated separately for clarity):

```
function evictExpiredRetainedPanes(nowMs, graceMs = 10 * 60_000):
  for [paneId, retained] in retainedClosedPaneDescendants:
    if nowMs - retained.retainedAtMs > graceMs:
      retainedClosedPaneDescendants.delete(paneId)
# TEST: an entry exactly at the grace boundary is retained; one past it is evicted (pick and document an inclusive/exclusive convention)
```

### 5c. Periodic cleanup tick

```
async function runIdleAgentCleanupTick(settings, log):
  if not settings.idleAgentCleanupEnabled:
    return

  evictExpiredRetainedPanes(now())

  try:
    rows = await getFreshProcessTableSnapshot()   # readWindowsProcessTableFresh() on win32
  catch (error):
    # Decision #2/#3's safety story depends on scope, not on this scan succeeding.
    # An unavailable table must not be read as "nothing to clean" (same rule as
    # everywhere else in this codebase) — just skip this tick and try again next time.
    return

  byPid = indexByPid(rows)   # pid -> row, for O(1) ppid-presence checks

  # Union of every tracked descendant PID, tagged with its owning pane (live or retained)
  # and that pane's root command line (for the §3.1 pane-lineage fallback).
  trackedDescendants = []
  for [paneId, observed] in paneObservedDescendants:
    trackedDescendants.push(...observed.descendantPids.map(pid =>
      ({ pid, paneId, rootCommandLine: observed.rootCommandLine })))
  for [paneId, retained] in retainedClosedPaneDescendants:
    trackedDescendants.push(...retained.descendantPids.map(pid =>
      ({ pid, paneId, rootCommandLine: retained.rootCommandLine })))

  candidates = []
  for { pid, paneId, rootCommandLine } in trackedDescendants:
    row = byPid.get(pid)
    if row == null:
      continue                          # already gone; nothing to do
    if byPid.has(row.ppid):
      continue                          # still parented; not orphaned (decision #1)
    signature = matchIdleAgentCleanupCandidate(row.command, rootCommandLine)   # pane-lineage fallback
    if signature == null:
      continue                          # orphaned but not a recognized agent process
    candidates.push({ pid, command: row.command, agentName: signature.agentName, paneId, rootCommandLine })

  for candidate in candidates:
    # Decision #9: re-verify immediately before killing — a second, independent read.
    outcome = await killVerifiedOrphanedAgentProcess(candidate)
    if outcome != 'skipped':
      await log.record({
        pid: candidate.pid,
        command: candidate.command,
        agentName: candidate.agentName,
        paneId: candidate.paneId,
        timestamp: now(),
        outcome: outcome == 'killed' ? 'killed' : 'kill-failed'
      })
      notifySettingsWindowsOfNewActivity()   # idleAgentCleanup:activityChanged push, §6
# TEST: a live pane's descendant that is still parented is never a candidate
# TEST: a live pane's descendant that is orphaned but matches no registered signature is never a candidate
# TEST: a retained (closed-pane) descendant still within grace, orphaned, matching a signature -> is a candidate
# TEST: a retained descendant past its grace period was already evicted before candidate-building runs, so it never becomes a candidate
# TEST: the same pid tracked by two stale entries (e.g. a pane closed and reopened reusing tracking before eviction) is only killed once — candidate list must dedupe by pid
# TEST: process-table read failure aborts the whole tick with no partial kills and no false "recently cleaned" log entries
```

```
async function killVerifiedOrphanedAgentProcess(candidate):
  try:
    rows = await getFreshProcessTableSnapshot()   # a SECOND, later fresh read (decision #9)
  catch:
    return 'skipped'   # cannot re-verify -> do not kill (mirrors "unavailable != empty")

  byPid = indexByPid(rows)
  row = byPid.get(candidate.pid)
  if row == null:
    return 'skipped'                              # gone since candidate-building; nothing to kill
  if byPid.has(row.ppid):
    return 'skipped'                               # re-parented since candidate-building
  if matchIdleAgentCleanupCandidate(row.command, candidate.rootCommandLine)?.agentName != candidate.agentName:
    return 'skipped'                               # PID recycled to something else (decision #9)

  return await killOrphanedAgentProcessByPid(candidate.pid)
# TEST: pid still orphaned and still matches the same signature at re-verify time -> proceeds to kill
# TEST: pid now has a live parent at re-verify time (re-parented or recycled to a non-orphan) -> skip, no kill
# TEST: pid's command line no longer matches ANY signature at re-verify time -> skip (recycled to something unrelated)
# TEST: pid's command line now matches a DIFFERENT signature than at candidate time -> still counts as "no longer this candidate", skip (do not kill on a changed identity)
```

```
// src/main/idle-agent-cleanup/idle-agent-process-kill.ts
async function killOrphanedAgentProcessByPid(pid): Promise<'killed' | 'kill-failed'>
  if process.platform == 'win32':
    result = await runProcess({
      program: 'taskkill',
      args: ['/pid', String(pid), '/t', '/f'],
      timeoutMs: 5_000   # mirrors WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS precedent
    })
    return result.code == 0 ? 'killed' : 'kill-failed'
  else:
    try:
      process.kill(pid, 'SIGKILL')
      return 'killed'
    catch (error):
      return error.code == 'ESRCH' ? 'killed' : 'kill-failed'   # already gone counts as success
# TEST: win32 — taskkill exits 0 -> 'killed'
# TEST: win32 — taskkill exits non-zero (e.g. access denied) -> 'kill-failed', still logged
# TEST: win32 — taskkill invoked through runProcess/spawnProcess, never a raw child_process import (guard test, mirrors the existing import-boundary test)
# TEST: posix — process.kill throws ESRCH (already exited between re-verify and kill) -> 'killed', not an error
# TEST: posix — process.kill throws EPERM -> 'kill-failed'
```

Driver (`idle-agent-cleanup-scheduler.ts`):

```
class IdleAgentCleanupScheduler:
  start(): reads current settings, if enabled schedules runIdleAgentCleanupTick on
           setInterval(settings.idleAgentCleanupIntervalMs); no-ops if already running
  stop(): clearInterval; safe to call when not running
  onSettingsChanged(updates):
    if 'idleAgentCleanupEnabled' in updates or 'idleAgentCleanupIntervalMs' in updates:
      stop(); start()   # re-read current settings and re-arm
# TEST: enabling the feature from Settings starts the timer without an app restart
# TEST: disabling stops it before its next tick would have fired
# TEST: changing the interval while enabled re-arms with the new interval, not the old one
# TEST: a tick already in flight when the scheduler is stopped is allowed to finish (no torn kill/log write)
```

### 5d. Settings UI data flow

No new IPC channels for the toggle/interval — they are ordinary `GlobalSettings` fields,
so the existing pipeline covers them: renderer reads `settings.idleAgentCleanupEnabled` /
`settings.idleAgentCleanupIntervalMs` from the store hydrated by `settings:get`, writes via
`updateSettings({ idleAgentCleanupEnabled: … })` → IPC `settings:set` → main's
`registerSettingsHandlers` → `store.updateSettings(...)` → broadcast on `settings:changed`
to every other window.

The recently-cleaned log is not part of `GlobalSettings` (it is an append-only history,
not a preference), so it gets its own small IPC surface, mirroring `agentAwake`:

```
// main: src/main/ipc/idle-agent-cleanup.ts
ipcMain.handle('idleAgentCleanup:getRecentActivity', () => logStore.listRecent())

// pushed after every tick that produced at least one log entry (§5c)
function notifySettingsWindowsOfNewActivity(entries):
  for window in BrowserWindow.getAllWindows():
    if not window.isDestroyed():
      window.webContents.send('idleAgentCleanup:activityChanged', entries)

// preload: src/preload/index.ts
idleAgentCleanup: {
  getRecentActivity: () => ipcRenderer.invoke('idleAgentCleanup:getRecentActivity'),
  onActivityChanged: (listener) => {
    ipcRenderer.on('idleAgentCleanup:activityChanged', listener)
    return () => ipcRenderer.removeListener('idleAgentCleanup:activityChanged', listener)
  }
} satisfies PreloadApi['idleAgentCleanup']

// renderer: IdleAgentCleanupSection.tsx
on mount: window.api.idleAgentCleanup.getRecentActivity().then(setEntries)
subscribe: window.api.idleAgentCleanup.onActivityChanged(setEntries) // or append+cap client-side
```

```
// UI shape (pattern-matched off AgentCacheTimerSection.tsx + MobilePairedDevicesSection.tsx)
<SettingsSubsectionHeader title="Idle Agent Process Cleanup" description="…" />
<SearchableSetting title="Automatic Cleanup" …>
  <SettingsSwitch checked={settings.idleAgentCleanupEnabled}
                   onChange={() => updateSettings({ idleAgentCleanupEnabled: !… })} />
</SearchableSetting>
{settings.idleAgentCleanupEnabled && (
  <SearchableSetting title="Check Interval" …>
    <Select value={String(settings.idleAgentCleanupIntervalMs)}
            onValueChange={(v) => updateSettings({ idleAgentCleanupIntervalMs: Number(v) })}>
      {/* e.g. 1/5/15/30 minute options */}
    </Select>
  </SearchableSetting>
)}
<section>{/* recently-cleaned list, empty state + rows: agentName, pid, command (truncated), relative timestamp */}</section>
# TEST (renderer): toggling the switch calls updateSettings with the flipped boolean, matching AgentCacheTimerSection's contract
# TEST (renderer): the interval control is not rendered while the feature is off (mirrors the existing conditional-render pattern)
# TEST (renderer): the recently-cleaned list renders an empty state with zero entries and caps displayed rows at N
# TEST (renderer): onActivityChanged updates the list without a manual refresh
```

## 6. Recently-cleaned log store

```ts
// src/main/idle-agent-cleanup/idle-agent-cleanup-log-store.ts
// Shaped directly on CrashReportStore: capped array, atomic tmp-then-rename write,
// a serialized writeChain, ENOENT/parse-failure read as empty rather than thrown.

const MAX_LOG_ENTRIES = 100   // open question: exact N — see §8

class IdleAgentCleanupLogStore:
  constructor(filePath = path.join(app.getPath('userData'), 'idle-agent-cleanup-log.json'))
  async record(entry: IdleAgentCleanupLogEntry): Promise<void>
    # reads current entries under writeChain, prepends, slices to MAX_LOG_ENTRIES, atomic-writes
  async listRecent(): Promise<IdleAgentCleanupLogEntry[]>
# TEST: record() prepends newest-first and caps at MAX_LOG_ENTRIES, dropping the oldest
# TEST: two concurrent record() calls (a tick that kills 2 candidates) do not interleave/corrupt the file (writeChain serialization)
# TEST: listRecent() on a missing file returns [] rather than throwing
# TEST: listRecent() on a corrupt/truncated file returns [] rather than throwing
# TEST: a write that is interrupted mid-rename never leaves the log file half-written (atomic tmp+rename, same guarantee as CrashReportStore)
```

## 7. Cross-cutting constraints (from AGENTS.md, applied to this feature)

- **Windows child processes**: the kill path uses `runProcess`, never raw `child_process`
  — the existing `child-process-import-boundary.test.ts`-style ratchet test should be
  expected to cover the new file too.
- **Windows process enumeration**: reads go only through `readWindowsProcessTable[Fresh]`
  in `windows-process-table.ts`; a rejection must abort the tick, never be treated as "no
  processes" (§5c).
- **SSH / remote execution**: per `docs/reference/ssh-execution-boundary.md`, PTYs and
  agent CLIs execute **on the remote host**, not the client. A local main-process
  `setInterval` (decision #13) has no visibility into a remote host's process table at
  all. This spec's scan/kill path is therefore implicitly **local-panes-only** — see §8,
  this needs an explicit confirmed answer, not an inferred one, before implementation.
- **Folder workspace vs. git worktree**: this feature keys entirely off pane/PTY
  identity and OS process trees, not off worktree/repo metadata, so it should be
  unaffected by folder-workspace-vs-worktree distinctions — noted here only to confirm
  no special-casing is needed, not left silently unconsidered.
- **File naming**: every new file name above names a concrete domain concept (e.g.
  `pane-descendant-tracking-state.ts`, `idle-agent-cleanup-log-store.ts`), never
  `helpers`/`utils`/`common`.

## 8. Open ambiguities for the architecture phase (flagged, not resolved here)

1. **Hook granularity for §5a.** The existing per-pane scan is renderer-driven and
   event/cadence-based (750ms–15s depending on tier), not main-process-owned. This spec
   assumes observation happens wherever `agent-foreground-process.ts` already has fresh
   rows in hand — but that function is called from multiple call sites
   (`local-pty-foreground-inspection.ts`'s `getLocalPtyForegroundProcess` and
   `confirmLocalPtyForegroundProcess`, plus the daemon-side
   `pty-subprocess/foreground-process-tracker.ts` for daemon-routed local sessions).
   Architecture needs to pick the exact call site(s) so every code path that owns a
   local pane's PTY is covered exactly once, with no path silently skipped.
2. **RESOLVED — SSH/WSL scope.** Confirmed local-panes-only for v1. Decision #13's main-
   process interval timer only ever sees the local host's own process table, and that is
   now the explicit, confirmed scope — not an inferred consequence. SSH-hosted and
   WSL-guest panes are deferred; a remote-side equivalent, if ever built, belongs on the
   relay/terminal daemon, not the app's main process.
3. **RESOLVED — signature registry coverage vs. the motivating incident.** Confirmed: add
   the pane-lineage fallback (§3.1's `matchIdleAgentCleanupCandidate`, §3.2's
   `rootCommandLine` field, §5c's updated candidate/re-verify flow). A candidate whose own
   command line matches no signature can still match through its owning pane's root
   shell/agent command line — this covers the triggering `find.exe` case regardless of
   whether its own argv ever carried a literal `claude`/`.claude/` substring.
4. **False-positive risk from short/common substrings.** `'pi'` was deliberately
   omitted as a bare substring above (it would match `pip`, `spin`, `optimize`, etc.);
   only `.pi/`/`.pi\` were kept. Given decision #8's no-confirmation auto-kill, the exact
   substring list per agent is a real safety surface, not a cosmetic detail — it should
   get explicit sign-off per entry during architecture/implementation, and ideally a
   dedicated adversarial test file enumerating known-common process names that must
   *not* match.
5. **RESOLVED — `idleAgentCleanupEnabled` default.** Confirmed `false` (§3.4).
6. **Recently-cleaned log cap (`MAX_LOG_ENTRIES`).** §6 uses 100 as a placeholder;
   decision #12 only says "last N entries" without naming N for either storage or UI
   display, and the two need not be the same number (store more than the UI shows).
7. **Re-verify granularity in §5c.** Decision #9 says re-verify "immediately before
   killing" each candidate. This spec's pseudocode takes that literally — one fresh
   process-table scan per candidate, right before its kill. Under many simultaneous
   candidates (plausible at ~131 concurrent sessions) that is many back-to-back fresh
   scans in one tick; whether to keep it per-candidate or relax to one shared fresh scan
   reused across all of that tick's kills (weaker but faster) is a performance/
   correctness tradeoff for architecture to make deliberately, not default into.
8. **Where `idle-agent-cleanup-scheduler.ts` is constructed/started.** This spec names
   "wherever `agentAwakeService` and other long-lived main services are constructed" as
   the wiring point without pinning the exact file/function — architecture should name it.
