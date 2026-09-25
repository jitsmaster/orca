# Idle Agent Process Cleanup — Architecture

Status: architecture-phase resolution of the six open items flagged in
`idle-agent-process-cleanup-spec-pseudocode.md` §8 (items 1, 4, 6, 7, 8 there,
plus the two additional items the architecture brief asked for: MAX_LOG_ENTRIES
sizing and an IPC/preload collision check). This document does not restate the
spec's data model or confirmed decisions — see that file for those. Everything
below is additive/resolving, not a re-litigation.

All file paths below were read directly from the repo at `d:\dev\ai\orca`
(branch `idle-agent-process-cleanup`) as part of this research; line numbers
refer to the state at research time and will drift as the branch is edited.

## 1. Hook granularity — resolved call graph

### 1.1 What actually calls `resolveAgentForegroundProcessWithAvailability`

Read in full: `src/main/providers/agent-foreground-process.ts`,
`src/main/providers/windows-agent-foreground-process.ts`,
`src/main/providers/local-pty-foreground-inspection.ts`,
`src/main/daemon/pty-subprocess/foreground-process-tracker.ts`,
`src/main/providers/local-pty-provider-state.ts`,
`src/main/daemon/pty-subprocess/subprocess-handle.ts`,
`src/main/daemon/pty-subprocess.ts`.

There are exactly two PTY-ownership stacks for a local pane, and a pane is
owned by exactly one of them, never both:

- **Direct/local stack.** `local-pty-session-activation.ts` is the only place
  that ever does `ptyProcesses.set(id, proc)` (confirmed by grep — one call
  site in the whole `src/main` tree). This stack's foreground inspection lives
  in `local-pty-foreground-inspection.ts`, with two entry points that both
  call `resolveAgentForegroundProcessWithAvailability`:
  - `getLocalPtyForegroundProcess(id)` — cached scan (`options.fresh` unset).
  - `confirmLocalPtyForegroundProcess(id)` — fresh scan (`options.fresh: true`).
  Both already have `id` (the pane id used everywhere else in this stack,
  including `clearPtyState(id)`) in scope at the call site.

- **Daemon-routed stack.** `pty-subprocess.ts#createPtySubprocess` returns a
  `SubprocessHandle` built by `subprocess-handle.ts#createDaemonPtySubprocessHandle`,
  which owns its own `createPtyForegroundProcessTracker` (in
  `foreground-process-tracker.ts`) instead of touching `ptyProcesses`. Two
  closures inside that tracker call the same shared
  `resolveAgentForegroundProcessWithAvailability`:
  - `scheduleRefresh`'s `.then()` callback — cached scan.
  - `confirmForegroundProcess()` — fresh scan (`options.fresh: true`).
  Both close over `args.sessionId` (the id minted by `mintPtySessionId`/
  `ptySessionIdForAgentCreateOperation` in `pty-session-id.ts`), which is this
  stack's pane identity.

So there are 4 outer call sites, but all 4 fan into the **same shared
function**, `resolveAgentForegroundProcessWithAvailability`, whose POSIX
branch already does its own `getProcessTableSnapshot`/`getFreshProcessTableSnapshot`
fetch (lines ~177–191 of `agent-foreground-process.ts`), and whose Windows
branch delegates to `resolveWindowsAgentForegroundProcessWithAvailability`
(`windows-agent-foreground-process.ts`), which already does its own
`queryWindowsPaneProcessInventory` fetch (lines ~80–86 there).

### 1.2 Resolved hook point

**Do not** hook at the 4 outer call sites (spec §4's tentative "or its caller
in `local-pty-foreground-inspection.ts`" phrasing). Hook inside the two
platform-specific resolver functions instead, where `rows`/`inventory` and
`shellPid` are already in hand, and thread pane identity in via a new optional
field on the options bag both functions already accept:

```ts
// AgentForegroundResolutionOptions (agent-foreground-process.ts, re-exported
// from windows-agent-foreground-process.ts) — one new optional field:
paneId?: string
```

- **POSIX**: in `resolveAgentForegroundProcessWithAvailability`
  (`agent-foreground-process.ts`), immediately after the `rows = await
  getProcessTableSnapshot()/getFreshProcessTableSnapshot()` call succeeds
  (inside the existing `try` block, before the `return`), call:
  `if (options.paneId) recordPaneDescendantObservation(options.paneId, shellPid, rows)`.
  `recordPaneDescendantObservation` re-derives `collectDescendants`/`shellRow`
  itself from `rows`+`shellPid` (spec §5a already does this) — no need to
  hoist `resolveAgentForegroundProcessFromPs`'s internal descendant computation
  out, a second cheap in-memory walk over an already-fetched array is fine.

- **Windows**: in `resolveWindowsAgentForegroundProcessWithAvailability`
  (`windows-agent-foreground-process.ts`), immediately after `inventory =
  await queryWindowsPaneProcessInventory(...)` succeeds. `inventory.candidates`
  is *already* the full descendant set of `shellPid` (`collectDescendants`
  inside `windows-foreground-process-rows.ts`, unfiltered by agent-recognition
  — filtering only happens afterward, on `filteredCandidates`), so no second
  scan is needed. One small delta to `WindowsPaneProcessInventory`: add a
  `rootRow: WindowsProcessRow | null` field, populated by changing the
  existing `rows.some((row) => row.pid === rootPid)` presence check (line ~72
  of `windows-foreground-process-rows.ts`) to `rows.find(...)` and reusing the
  result for both the presence check and `rootRow` — zero extra scan cost.
  Then: `if (options.paneId) recordPaneDescendantObservation(options.paneId, shellPid, inventory.candidates, inventory.rootRow?.command ?? '')`.

- **The 4 outer call sites** each get a one-line addition to the options
  object they already build, no control-flow changes:
  - `getLocalPtyForegroundProcess(id)` / `confirmLocalPtyForegroundProcess(id)`
    in `local-pty-foreground-inspection.ts`: add `paneId: id`.
  - `scheduleRefresh` / `confirmForegroundProcess` in `foreground-process-tracker.ts`:
    add `paneId: args.sessionId`.

This satisfies "every path covered exactly once, no path silently skipped, no
path double-counted": coverage is exhaustive because it rides the *shared*
resolver instead of the 4 divergent callers (a 5th call site added later for
either stack automatically inherits the hook for free, as long as it goes
through the shared resolver); double-counting is structurally impossible
because a given pane's `ptyProcesses` entry and its daemon-stack
`SubprocessHandle` are mutually exclusive (one `id`/`sessionId` is never
tracked by both stacks at once — confirmed by `ptyProcesses.set` having a
single call site that the daemon stack never touches).

Windows early-return branches (`agent-foreground-process.ts` lines ~148–154,
where `!fallbackProcess || (!shouldInspectWindowsAgentForeground(...) &&
!options.forceProcessScan)`) correctly get **no** observation update on that
call — there is no `inventory` to observe from, so recording nothing is
correct, not a coverage gap. The rolling record simply reflects "last tick
that actually had rows in hand," which is what spec §5a already specifies.

### 1.3 File-plan delta

- `src/main/idle-agent-cleanup/pane-descendant-observation.ts` (`recordPaneDescendantObservation`,
  per spec §5a — unchanged) is now imported and called from
  `src/main/providers/agent-foreground-process.ts` and
  `src/main/providers/windows-agent-foreground-process.ts`, **not** from
  `local-pty-foreground-inspection.ts` or `foreground-process-tracker.ts` as
  spec §4 tentatively suggested. Those two files only gain the one-line
  `paneId` addition to an options object they already construct.
- `src/main/providers/windows-foreground-process-rows.ts`: `WindowsPaneProcessInventory`
  gains `rootRow: WindowsProcessRow | null`.
- `AgentForegroundResolutionOptions` (defined in `windows-agent-foreground-process.ts`,
  re-exported from `agent-foreground-process.ts`) gains `paneId?: string`.

Pane-close retention (spec §5b) is unaffected by this section — it already
correctly targets `clearPtyState` in `local-pty-provider-state.ts`, the single
choke point for the direct/local stack (3 callers — `local-pty-session-activation.ts`,
`local-pty-provider.ts`, `local-pty-termination.ts` — all funnel through this
one function, confirmed by grep). The daemon-routed stack has no equivalent
retention hook in this design: `SubprocessHandle`s from `createPtySubprocess`
are local-machine processes too (the daemon here is Orca's own in-process/
same-host PTY-hosting abstraction, not a remote SSH/WSL host — see
`docs/reference/ssh-execution-boundary.md`), but their close-time retention
is out of scope for this architecture pass and should reuse the same
`retainDescendantsOnPaneClose` shape once that stack's teardown entry point
(analogous to `clearPtyState`) is identified — flagged as a follow-up, not
resolved here, since the spec's file plan and confirmed decisions only named
`clearPtyState` as the retention hook. **Practical mitigation for v1**: daemon-
stack panes still get *live* observation via §1.2's hook (rolling
`paneObservedDescendants` entries), so a candidate is only missed if it
orphans in the narrow window between the daemon pane's close and the next
cleanup tick, with no 10-minute grace period — an accepted, smaller gap than
having no coverage at all, and consistent with the spec's already-stated
acceptance of losing in-memory tracking state on Orca restart.

## 2. Signature registry false-positive review (spec §3.1 draft, §8.4)

Per-entry review, matching against realistic command-line shapes that could
occur as an **orphaned descendant of an Orca-owned local pane** (the scope is
already narrowed by decision #2/#3 — a false match still requires the process
to be parentless, which excludes almost all normal foreground work):

| Substring | Verdict | Reasoning |
|---|---|---|
| `'claude'` | Keep, residual risk accepted | Needed to catch the CLI's own orphaned top-level binary (`claude`, `claude.cmd`, `claude-code`), which does not necessarily run from under `~/.claude/`. Residual risk: any orphaned process whose argv contains the literal word "claude" as a path/search-term component (e.g. an abandoned `grep -r claude .` or `rg claude` left running against a directory that mentions Claude Code — plausible on this exact codebase, which has `.claude/`, `documentation/superpowers/`, etc. throughout). Not tightened further because (a) decision #3 forbids a denylist, (b) decision #4 fixes substring matching as the mechanism, (c) the blast radius is already bounded to orphaned-only + Orca-pane-scoped, and (d) killing an abandoned (parentless) search process is low-harm even when the label attribution is wrong — it wasn't going to deliver output to anyone. |
| `'.claude/'`, `'.claude\\'` | Confirmed safe | Directory-convention substrings unique to Claude Code's own home dir; effectively zero collision risk. |
| `'codex'` | Keep, residual risk accepted | Same reasoning as `'claude'`: needed for the bare CLI binary. `codex` is a real word (manuscript) but rare enough in ordinary command lines that the risk is lower than `'claude'` for this specific codebase (no repo/doc directory here is named after it). Accepted as-is. |
| `'.codex/'`, `'.codex\\'` | Confirmed safe | Same reasoning as `.claude/`. |
| `'.pi/'`, `'.pi\\'` | Confirmed safe (already resolved in spec) | The spec's own reasoning for omitting bare `'pi'` (collides with `pip`, `spin`, `optimize`, and any word containing the two letters "pi") is correct and does not need revisiting. |
| `'prime-agent'` | Confirmed safe | Hyphenated, multi-syllable compound — negligible risk of appearing as a substring of an unrelated command line, unlike the 2-character `'pi'` case the spec already excluded. Safe to keep bare, unlike `'pi'`. |
| `'.prime-agent/'` | Confirmed safe | Directory-convention substring, same category as `.claude/`/`.codex/`. |

**Conclusion**: the draft registry is safe to ship as-is. No entries need
tightening beyond what §3.1 already resolved for Pi. The two entries carrying
non-trivial residual risk (`'claude'`, `'codex'`) are both necessary for
primary-binary detection and already the best available tradeoff given the
fixed no-denylist/substring-only constraints — call this out explicitly in
the implementation PR description so a future reviewer doesn't assume it was
overlooked. Recommend adding the adversarial test file the spec's §8.4
already suggested (`idle-agent-cleanup-signatures.adversarial.test.ts` or
similar), enumerating common process names/paths that must NOT match:
`pip`, `spin`, `optimize`, `rg`, `grep`, `find`, `node`, `python`, `git`, a
plain `bash`/`pwsh`/`cmd.exe` invocation, and — specific to this codebase —
a `grep`/`rg` invocation whose search term or path happens to be `claude` or
`codex` (documenting that this is a known, accepted match, not a test bug).

## 3. Recently-cleaned log cap (spec §6, `MAX_LOG_ENTRIES`)

`CrashReportStore.MAX_REPORTS = 5` (confirmed at
`src/main/crash-reporting/crash-report-store.ts:16`). That number is sized for
a *rare, high-severity* event a human is expected to triage one at a time
(each crash report becomes a startup prompt) — it is not a good precedent for
sizing a *routine, low-severity, potentially frequent* housekeeping log. At
~131 concurrent sessions, a single tick after a burst of pane closes could
plausibly log several entries at once; 5 would roll over almost immediately
and defeat the log's audit purpose.

Resolved:

- **Storage cap: 200.** Generous enough to retain a meaningful history across
  many ticks/days without becoming an unbounded-growth risk — each entry is a
  handful of small string/number fields (pid, command, agentName, paneId,
  timestamp, outcome), so 200 entries is a small, boring JSON file (well under
  the concern threshold `CrashReportStore`'s own file-size assumptions
  implicitly accept for `MAX_REPORTS × entry-size`, and cleanup entries are
  smaller than crash reports which also embed breadcrumbs/details).
- **UI-displayed cap: 25.** Enough rows to show a meaningful recent-activity
  window in a Settings panel section without needing pagination/virtualization
  (`MobilePairedDevicesSection.tsx`, the UI precedent named in the spec,
  renders its list unbounded because paired-device counts are naturally small;
  a cleanup log has no such natural bound, hence the explicit UI cap here).
  `listRecent()` can keep returning up to the storage cap (200); the renderer
  slices to 25 for display, consistent with spec §5d's existing note that
  storage and UI caps need not match.

`IdleAgentCleanupLogStore`'s `MAX_LOG_ENTRIES` constant (storage) becomes
`200`, replacing the `100` placeholder; add a separate exported
`IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS = 25` in
`src/shared/idle-agent-cleanup-log-entry.ts` (co-located with the entry type,
since both main's `listRecent()` callers and the renderer's list component
need to agree on it) for `IdleAgentCleanupSection.tsx` to slice against.

## 4. Re-verify granularity (spec §5c/§8.7)

**Resolved: one shared fresh scan per tick's kill phase, not one scan per
candidate.**

Tradeoff:

- **Strictly per-candidate** (spec's literal pseudocode): safest — every kill
  is checked against a scan taken as close as possible to that specific kill.
  Cost: N candidates in one tick → N additional full fresh process-table
  scans, serialized (each `killVerifiedOrphanedAgentProcess` awaits its own
  `getFreshProcessTableSnapshot()`/`readWindowsProcessTableFresh()` before
  proceeding). At ~131 concurrent sessions, a tick that finds a double-digit
  candidate count (plausible after a mass pane-close event) turns into a
  double-digit number of back-to-back full-table scans — on Windows in
  particular, `readWindowsProcessTableFresh()` is a real Toolhelp32 snapshot
  of the *whole system* table, not a cheap operation, and this is exactly the
  kind of scan-storm CPU pressure the feature exists to relieve, not add.
- **One shared scan for the whole kill phase**: still strictly fresher than
  candidate-building's own scan (spec's `rows` in `runIdleAgentCleanupTick`,
  taken before the loop even starts) — it is a *second*, later, dedicated
  fresh scan taken specifically at the start of the kill phase — but is
  reused across every kill in that tick rather than re-taken per kill. Cost:
  exactly one extra scan per tick regardless of candidate count. Weakness: a
  candidate near the end of a long kill list is checked against a snapshot
  that may be stale by (num-candidates-so-far × per-kill latency), typically
  well under a few seconds even for dozens of candidates, since each kill is
  a single `process.kill`/`taskkill` call, not another scan.

**Recommendation**: share one scan per tick. The spec's own motivating
incident (CPU pressure from ~131 concurrent sessions) is precisely the
scenario where per-candidate scanning scales worst, and the residual
PID-reuse window under the shared-scan design is bounded by the kill phase's
own short duration, not by anything approaching the 5-minute tick interval.
This is a legitimate safety/performance tradeoff, made deliberately here per
the spec's own instruction not to default into it.

### Pseudocode delta (supersedes spec §5c's two functions)

```
async function runIdleAgentCleanupTick(settings, log):
  if not settings.idleAgentCleanupEnabled:
    return
  evictExpiredRetainedPanes(now())
  try:
    rows = await getFreshProcessTableSnapshot()   # candidate-building scan, unchanged
  catch:
    return
  byPid = indexByPid(rows)
  # ... candidate-building loop: UNCHANGED from spec §5c ...

  if candidates.length == 0:
    return

  # NEW: one shared fresh scan for the whole kill phase, taken once, after
  # candidate-building, immediately before the kill loop begins.
  try:
    verifyRows = await getFreshProcessTableSnapshot()   # readWindowsProcessTableFresh() on win32
  catch:
    return   # cannot re-verify anything this tick -> no kills, no log entries (same rule as the initial scan)
  verifyByPid = indexByPid(verifyRows)

  for candidate in candidates:
    outcome = await killVerifiedOrphanedAgentProcess(candidate, verifyByPid)
    if outcome != 'skipped':
      await log.record({ ... })   # unchanged
      notifySettingsWindowsOfNewActivity()
# TEST: a tick's kill phase performs exactly one fresh scan regardless of candidate count
# TEST: the shared verify scan failing aborts the whole kill phase — no partial kills, no log entries (mirrors the candidate-building scan's own failure rule)
# TEST: a candidate re-parented or PID-recycled by the time of the SHARED scan is skipped, same as the per-candidate design
# TEST: candidates.length === 0 skips the verify scan entirely (no wasted scan when there is nothing to kill)

async function killVerifiedOrphanedAgentProcess(candidate, verifyByPid):
  # No longer async-fetches its own rows — takes the tick's shared verify snapshot.
  row = verifyByPid.get(candidate.pid)
  if row == null:
    return 'skipped'
  if verifyByPid.has(row.ppid):
    return 'skipped'
  if matchIdleAgentCleanupCandidate(row.command, candidate.rootCommandLine)?.agentName != candidate.agentName:
    return 'skipped'
  return await killOrphanedAgentProcessByPid(candidate.pid)
# TEST: (all 4 existing TESTs from spec §5c's killVerifiedOrphanedAgentProcess carry over unchanged in behavior, just sourced from the shared snapshot instead of a fresh per-call one)
```

`killOrphanedAgentProcessByPid` (spec §5c's third function, the actual
POSIX/Windows kill mechanism) is unaffected by this delta.

## 5. Scheduler construction/wiring point (spec §8.8)

Read `src/main/index.ts` in full around the app-ready sequence and shutdown
handlers. `AgentAwakeService` — the spec's named precedent — is:

- **Constructed** at `src/main/index.ts:2601`, inside the same async
  app-startup sequence that also calls `initializeBrowserSessionsForApp`,
  `registerSystemResumeBroadcast()`, and sets up `agentHookServer` status
  subscriptions — i.e. well after `store` (the settings store) is guaranteed
  hydrated and available, which `idle-agent-cleanup-scheduler.ts` also needs
  (`settings.idleAgentCleanupEnabled`/`idleAgentCleanupIntervalMs`).
- **Disposed** inside the `app.on('before-quit', ...)` handler at
  `src/main/index.ts:3605–3620`, alongside `agentAwakeService?.dispose()` and
  `rateLimits?.stop()` — this is the established location for "stop this
  long-lived main-process service before quitting."

**Resolved wiring point**: construct and `.start()`
`IdleAgentCleanupScheduler` in `src/main/index.ts` immediately after the
`agentAwakeService = new AgentAwakeService()` block (after line ~2609,
`agentAwakeService.setStatuses([])`), following the same pattern: a
module-level `let idleAgentCleanupScheduler: IdleAgentCleanupScheduler | null
= null`, assigned here, read by `registerSettingsHandlers`/`idle-agent-cleanup.ts`'s
wiring so the settings-set handler can call
`idleAgentCleanupScheduler?.onSettingsChanged(sanitizedArgs)` (mirroring the
existing `agentAwakeService?.setMode(...)` call already made from inside
`settings.ts`'s handler). Stop it in the same `before-quit` block, right next
to `agentAwakeService?.dispose()`: `idleAgentCleanupScheduler?.stop()`.

This keeps the new scheduler's lifecycle textually and behaviorally adjacent
to its closest existing analogue, rather than inventing a new startup/shutdown
convention.

## 6. IPC/preload wiring correctness

Confirmed via grep across `src/main/ipc/**` and `src/preload/**`: no existing
channel named `idleAgentCleanup:*`, and no collision with the proposed
`idleAgentCleanup:getRecentActivity` / `idleAgentCleanup:activityChanged`
names. `settings:*`, `agentAwake:*`, `localhostWorktreeLabels:*`, etc. are the
only precedents in the same file; the proposed names follow the same
`<namespace>:<verb/event>` convention already used throughout.

`registerSettingsHandlers` (`src/main/ipc/settings.ts:71`) is the exact
pattern to extend: it already takes an optional second constructor-injected
service (`agentAwakeService?: AgentAwakeService`) and, inside the same
function, both registers that service's own channel
(`ipcMain.handle('agentAwake:getStatus', ...)` at line 76) and reacts to
relevant settings changes inside the `settings:set` handler (the
`APPEARANCE_MENU_KEYS`-style `if (key in sanitizedArgs && before.X !==
result.X)` blocks at lines ~252–268). Two viable placements for the new
channel registration:

- (a) Add a third optional parameter, `idleAgentCleanupScheduler?:
  IdleAgentCleanupScheduler`, to `registerSettingsHandlers`, and register
  `idleAgentCleanup:getRecentActivity`/subscribe-for-push inside that same
  function, right next to the `agentAwake:*` registration; or
- (b) Give it its own `src/main/ipc/idle-agent-cleanup.ts` (as spec §4
  already names) with its own `registerIdleAgentCleanupHandlers(logStore,
  scheduler)`, called from wherever `registerSettingsHandlers` itself is
  called in `src/main/index.ts` (i.e. alongside it, not inside it).

**Resolved: (b)**, matching spec §4's file plan as written — a dedicated
`idle-agent-cleanup.ts` IPC module, not folded into `settings.ts`. Reasoning:
`registerSettingsHandlers`'s `agentAwakeService` parameter exists because
`agentAwakeService`'s status is itself read *through* the settings
window/flow (computer-awake mode is a `GlobalSettings` field); the
recently-cleaned log is explicitly *not* a `GlobalSettings` field (spec §5d
is explicit about this — "not part of `GlobalSettings` ... gets its own
small IPC surface"), so it has no structural reason to live inside
`settings.ts`. The only settings-pipeline touch point this feature needs
inside `settings.ts` is the reschedule reaction — a small `if
('idleAgentCleanupEnabled' in sanitizedArgs || 'idleAgentCleanupIntervalMs'
in sanitizedArgs) { idleAgentCleanupScheduler?.onSettingsChanged(sanitizedArgs)
}` block added next to the existing `APPEARANCE_MENU_KEYS` block, which means
`registerSettingsHandlers` does still need the scheduler reference threaded
in as a new optional parameter (same shape as `agentAwakeService` today) —
but the *channel registration* itself belongs in the dedicated file.

Preload: add `src/preload/api/idle-agent-cleanup-api.ts` exporting an
`IdleAgentCleanupApi` type (matching the `AgentAwakeApi` precedent's own file,
`src/preload/api/agent-status-api.ts`), imported into `api-types.ts`'s
`PreloadApi` interface as `idleAgentCleanup: IdleAgentCleanupApi`, and
implemented in `src/preload/index.ts` right next to the existing `agentAwake:
{ ... } satisfies PreloadApi['agentAwake']` block (lines 2220–2228), following
its exact getStatus/onChanged→getRecentActivity/onActivityChanged shape as
spec §5d already sketches.

## 7. No hardcoded env vars

Confirmed by re-reading the full spec: every configurable value
(`idleAgentCleanupEnabled`, `idleAgentCleanupIntervalMs`) is a `GlobalSettings`
field read through the existing settings pipeline (`store.getSettings()`),
not `process.env`. The signature registry (§3.1) is a code-level constant, not
env-configurable, by design (decision #4 — non-user-editable). The kill path
uses `runProcess`/`spawnProcess` with an explicit `program`/`args`/`timeoutMs`
object, not shell interpolation or env-var-driven command construction. No
part of this design reads or requires a new environment variable; nothing to
change here relative to the spec as drafted.

## 8. Component/service-boundary diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ src/main/providers/  (existing, unchanged in shape — §1 adds one field) │
│                                                                          │
│  agent-foreground-process.ts                                           │
│    resolveAgentForegroundProcessWithAvailability(shellPid, fb, opts)   │
│      ├─ POSIX: getProcessTableSnapshot()/getFreshProcessTableSnapshot()│
│      │    └─(opts.paneId set)→ recordPaneDescendantObservation() ──┐   │
│      └─ win32: delegates to ↓                                      │   │
│                                                                     │   │
│  windows-agent-foreground-process.ts                               │   │
│    resolveWindowsAgentForegroundProcessWithAvailability(...)       │   │
│      └─ queryWindowsPaneProcessInventory()                         │   │
│           └─(opts.paneId set)→ recordPaneDescendantObservation() ──┤   │
└──────────────────────────────────────────────────────────────────┼────┘
        ▲ paneId threaded in by 4 outer callers (§1.1)              │
        │                                                            │
┌───────┴────────────────────────┐   ┌────────────────────────────┐ │
│ local-pty-foreground-inspection │   │ pty-subprocess/             │ │
│  .ts (direct/local stack)       │   │  foreground-process-tracker │ │
│  getLocalPtyForegroundProcess   │   │  .ts (daemon-routed stack)  │ │
│  confirmLocalPtyForegroundProc  │   │  scheduleRefresh            │ │
│  paneId = id (ptyProcesses key) │   │  confirmForegroundProcess   │ │
└──────────────────────────────────┘   │  paneId = args.sessionId    │ │
                                        └────────────────────────────┘ │
                                                                        │
┌────────────────────────────────────────────────────────────────────┐│
│ src/main/idle-agent-cleanup/  (new)                                 ││
│                                                                      ││
│  pane-descendant-tracking-state.ts                                  ││
│    paneObservedDescendants: Map<paneId, PaneObservedDescendants> ◄──┘│
│    retainedClosedPaneDescendants: Map<paneId, RetainedPaneDescendants│
│                                       ▲                              │
│  pane-descendant-observation.ts      │ writes                       │
│    recordPaneDescendantObservation() ┘                               │
│                                                                       │
│  pane-close-descendant-retention.ts                                 │
│    retainDescendantsOnPaneClose() ◄── clearPtyState() in             │
│                                        local-pty-provider-state.ts   │
│                                        (single choke point, 3 callers)│
│                                                                       │
│  idle-agent-cleanup-candidate-scan.ts + idle-agent-process-kill.ts   │
│    runIdleAgentCleanupTick()  [§4: candidate scan (1 fresh scan) →   │
│                                     shared verify scan (1 fresh scan)│
│                                     → per-candidate kill, no scan]   │
│      reads: paneObservedDescendants, retainedClosedPaneDescendants  │
│      reads: process-table-snapshot.ts / windows-process-table.ts    │
│      calls: runProcess/spawnProcess (taskkill) or process.kill       │
│      writes: idle-agent-cleanup-log-store.ts                        │
│                                                                       │
│  idle-agent-cleanup-log-store.ts                                    │
│    IdleAgentCleanupLogStore (CrashReportStore-shaped, §3: cap 200)  │
│                                                                       │
│  idle-agent-cleanup-scheduler.ts                                    │
│    IdleAgentCleanupScheduler  [§5: constructed src/main/index.ts    │
│                                     ~line 2609, disposed in          │
│                                     before-quit ~line 3616]          │
│      reads: store.getSettings() (idleAgentCleanupEnabled/IntervalMs)│
│      driven by: settings.ts's settings:set handler → §6             │
│                  onSettingsChanged() reschedule call                │
└────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│ src/main/ipc/idle-agent-cleanup.ts  (new, dedicated file — §6)      │
│   ipcMain.handle('idleAgentCleanup:getRecentActivity', ...)         │
│   push: 'idleAgentCleanup:activityChanged' to all BrowserWindows    │
│   registered alongside (not inside) registerSettingsHandlers        │
└──────────────────────┬────────────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ src/preload/index.ts + api/idle-agent-cleanup-api.ts  (new)         │
│   window.api.idleAgentCleanup.{getRecentActivity, onActivityChanged}│
│   (shape mirrors window.api.agentAwake, §6)                         │
└──────────────────────┬────────────────────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ IdleAgentCleanupSection.tsx (Settings panel, unchanged from spec §5d)│
│   toggle + interval (existing settings:get/set/changed pipeline)    │
│   recently-cleaned list, display-capped at 25 (§3)                  │
└────────────────────────────────────────────────────────────────────┘
```

## 9. Summary of deltas vs. the spec-pseudocode document

1. §5a/§4 hook point: moves from the 4 outer PTY-lifecycle callers into the 2
   shared platform resolver functions (`agent-foreground-process.ts`,
   `windows-agent-foreground-process.ts`), reached via a new `paneId?: string`
   field on `AgentForegroundResolutionOptions`; outer callers now only add one
   line each. `WindowsPaneProcessInventory` gains `rootRow`.
2. §3.1 registry: confirmed safe as drafted; no substring changes. Add an
   adversarial test file per §8.4's own suggestion.
3. §6 `MAX_LOG_ENTRIES`: `100` placeholder → storage cap `200`
   (`idle-agent-cleanup-log-store.ts`), UI display cap `25`
   (new `IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS` constant in
   `idle-agent-cleanup-log-entry.ts`).
4. §5c re-verify: per-candidate fresh scan → one shared fresh scan for the
   whole kill phase, taken once after candidate-building and only when
   `candidates.length > 0`; `killVerifiedOrphanedAgentProcess` becomes
   non-scanning, taking a `verifyByPid` map instead. Full pseudocode delta in
   §4 above.
5. §4/§8.8 scheduler wiring: pinned to `src/main/index.ts`, constructed at
   ~line 2609 (right after `agentAwakeService.setStatuses([])`), stopped in
   the `before-quit` handler at ~line 3616 (right after
   `agentAwakeService?.dispose()`).
6. §5d/§6 IPC: confirmed no name collisions. Channel registration stays in a
   dedicated `src/main/ipc/idle-agent-cleanup.ts` (not folded into
   `settings.ts`), called alongside `registerSettingsHandlers` from
   `src/main/index.ts`; `registerSettingsHandlers` gains one new optional
   `idleAgentCleanupScheduler` parameter purely to react to the two new
   settings fields (reschedule), matching the existing
   `agentAwakeService?.setMode(...)` pattern already in that handler.
   Preload type lives in its own `src/preload/api/idle-agent-cleanup-api.ts`
   file, matching `agent-status-api.ts`'s precedent.
7. No env vars introduced anywhere in this design — confirmed explicitly, no
   change from the spec.

## Open items intentionally not addressed here

- Daemon-routed-stack pane-close retention (§1.3's flagged follow-up): this
  architecture pass only pins the *live-observation* hook for that stack; a
  `clearPtyState`-equivalent retention hook for daemon-owned `SubprocessHandle`
  teardown was not identified within this pass's scope and should be picked
  up before/during implementation of that stack's coverage, or explicitly
  deferred with the same reasoning §1.3 gives (live observation only, no
  grace period, for v1).
