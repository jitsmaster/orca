# Idle Agent Process Cleanup — Phase 4: impl-ui Handoff

## Previous Work (summary only)

Phase 0 (intake) captured the triggering incident. Phase 1 (spec) produced a confirmed
spec and architecture. Phase 2 (impl-detection) implemented detection/tracking/kill via
TDD. Phase 3 (impl-scheduler-settings) added settings fields, `IdleAgentCleanupScheduler`,
and backfilled test coverage for pre-existing scheduler-wiring code found already in the
working tree. Phase 4 (this phase) added the Settings UI panel, the dedicated IPC module,
and the preload bridge — all via fresh TDD→GREEN→import-cleanup subagents.

| File | Change |
|------|--------|
| `src/shared/idle-agent-cleanup-signatures.ts` (+ `.test.ts`) | Phase 2 — signature registry |
| `src/shared/idle-agent-cleanup-log-entry.ts` | Phase 2 — `IdleAgentCleanupLogEntry` type + `IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS` |
| `src/main/idle-agent-cleanup/pane-descendant-tracking-state.ts`, `pane-descendant-observation.ts`, `pane-close-descendant-retention.ts`, `idle-agent-process-kill.ts`, `idle-agent-cleanup-candidate-scan.ts`, `idle-agent-cleanup-log-store.ts` (+ tests) | Phase 2 — detection/tracking/kill/log slice |
| `src/main/providers/agent-foreground-process.ts`, `windows-agent-foreground-process.ts`, `windows-foreground-process-rows.ts`, `local-pty-foreground-inspection.ts`, `daemon/pty-subprocess/foreground-process-tracker.ts`, `local-pty-provider-state.ts` | Phase 2 — observation hooks + pane-close retention wiring |
| `src/main/idle-agent-cleanup/idle-agent-cleanup-scheduler.ts` (+ `.test.ts`) | Phase 3 — `IdleAgentCleanupScheduler`: `start()`/`stop()`/`onSettingsChanged(updatedKeys)` |
| `src/shared/global-settings-types.ts`, `src/shared/default-global-settings.ts` (+ `default-global-settings.test.ts`) | Phase 3 — `idleAgentCleanupEnabled: boolean` (default `false`), `idleAgentCleanupIntervalMs: number` (default `300_000`) |
| `src/main/codex-accounts/runtime-home-settings-test-fixtures.ts`, `service-test-harness.ts` | Phase 3 — added the two new required `GlobalSettings` fields to existing test fixtures |
| `src/main/index.ts` | Phase 3 (pre-existing wiring found already modified) + **Phase 4**: constructs/starts/stops `IdleAgentCleanupScheduler`; **this phase** wrapped the `runTick` binding's log store with `createNotifyingIdleAgentCleanupLog(...)` and added `registerIdleAgentCleanupHandlers(IdleAgentCleanupLogStore.fromUserData())` inside `openMainWindow`, right after the `registerCoreHandlers(...)` call |
| `src/main/ipc/register-core-handlers/register-core-handlers.ts` (+ `.test.ts`) | Phase 3 (pre-existing wiring) — threads `idleAgentCleanupScheduler?` through to `registerSettingsHandlers` |
| `src/main/ipc/settings.ts` (+ `.test.ts`) | Phase 3 — `registerSettingsHandlers` reacts to `idleAgentCleanupEnabled`/`idleAgentCleanupIntervalMs` changes by calling `idleAgentCleanupScheduler?.onSettingsChanged(...)` |
| `src/main/ipc/idle-agent-cleanup.ts` (+ `.test.ts`) | **New this phase** — `registerIdleAgentCleanupHandlers(logStore)`: registers `idleAgentCleanup:getRecentActivity`; `notifyIdleAgentCleanupActivityChanged(entries)`: pushes `idleAgentCleanup:activityChanged` to every non-destroyed `BrowserWindow`; `createNotifyingIdleAgentCleanupLog(logStore)`: composes record-then-notify into the `{ record(entry) }` shape `runIdleAgentCleanupTick` already expects, so that function's own contract never changed. 7 tests, all passing |
| `src/preload/api/idle-agent-cleanup-api.ts` | **New this phase** — `IdleAgentCleanupApi` type (`getRecentActivity`, `onActivityChanged`), mirrors `AgentAwakeApi`. No dedicated test file — matches the established untested-plumbing precedent for this exact shape of bridge type |
| `src/preload/api-types.ts`, `src/preload/index.ts` | **New this phase** — added `idleAgentCleanup: IdleAgentCleanupApi` to `PreloadApi`; implemented the bridge in `index.ts` right after the existing `agentAwake` block |
| `src/renderer/src/components/settings/IdleAgentCleanupSection.tsx` (+ `.test.tsx`) | **New this phase** — Settings panel: toggle + conditional interval `<Select>` (4 options, 1/5/15/30 min) + recently-cleaned list (empty state, rows capped at `IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS`, each row `data-testid="idle-agent-cleanup-entry"`). Uses new intent-named `settings.idleAgentCleanup.*` translate keys (not the legacy `auto.components.settings.*` hash pattern — see Key Decisions). 9 tests, all passing |
| `src/renderer/src/components/settings/AgentsPane.tsx` | **New this phase** — mounts `IdleAgentCleanupSection` as a sibling of `AgentCacheTimerSection`, same `settings`/`updateSettings` props. Existing `AgentsPane.test.tsx` still passes |

**Aggregate node cost (approx, this phase):** TDD subagent ~127K tokens/45 tool calls.
Code subagent ~107K tokens/47 tool calls. Import-cleanup subagent ~107K tokens/20 tool
calls (merged one duplicate import in the renderer test file — everything else was
already clean). Orchestrator (this session) additionally spent direct tool calls reading
spec §5d/§6, architecture §6/§8, and 6 precedent files (`AgentCacheTimerSection.tsx`,
`MobilePairedDevicesSection.tsx`, `agent-status-api.ts`, `preload/index.ts`'s `agentAwake`
block, `settings.ts`, `TerminalFontSizeSetting.test.tsx`, `MobilePane.test.tsx`) before
delegating, to pin the IPC/preload/UI contract precisely enough that the TDD and code
subagents needed no follow-up clarification round.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| `registerIdleAgentCleanupHandlers(logStore)` takes only `logStore` — no `scheduler` parameter, despite the Phase 3 handoff's Starting Point sketching `registerIdleAgentCleanupHandlers(logStore, scheduler)` | The scheduler has no actual role in this file: the activity-changed push happens via `createNotifyingIdleAgentCleanupLog` wrapping the log store at the `runTick` call site in `index.ts`, not through the scheduler object. Adding an unused `scheduler` parameter would violate AGENTS.md's "don't design for hypothetical future requirements" — this was a scope decision made before delegation, not left for the TDD/code subagents to guess at, since an unused parameter is exactly the kind of thing a reviewer would flag |
| `runIdleAgentCleanupTick`'s `(settings, log)` contract was NOT changed to add a notify callback | That function and its own test suite are already fully passing from Phase 2/3. Architecture's own §9 delta already anticipated this: the push is composed at the call site (`index.ts`'s `runTick` binding), via a new `createNotifyingIdleAgentCleanupLog(logStore)` helper in the new `idle-agent-cleanup.ts` file, which returns a `{ record(entry) }` shape that satisfies `runIdleAgentCleanupTick`'s existing `log` parameter type unchanged |
| New UI translate keys use intent-named IDs (`settings.idleAgentCleanup.title`, `.toggleLabel`, `.intervalLabel`, `.emptyState`, etc.), not the `auto.components.settings.<File>.<hash>` pattern visible in `AgentCacheTimerSection.tsx` | `config/i18n-translation-source.md`'s "Message ID and placeholder policy" explicitly grandfathers existing hashed IDs but requires new keys to be intent-named — this was flagged to both the TDD and code subagents up front to avoid a policy violation that a later review pass would have caught and required redoing |
| `IdleAgentCleanupSection.test.tsx` mocks `../ui/select` with a plain-DOM stand-in (same convention as `ExperimentalPane.test.tsx`) rather than exercising the real Radix `Select` | Radix's popover/portal rendering isn't reliably driveable in happy-dom (no pointer capture, no real layout) — this is an established convention already used elsewhere in the renderer test suite, not a new pattern invented for this feature |
| The IPC handler and the `openMainWindow`-site registration both call `IdleAgentCleanupLogStore.fromUserData()` fresh, rather than sharing one long-lived instance via the module-level `idleAgentCleanupScheduler`'s closure | Matches the exact pattern Phase 3's pre-existing wiring already established at the `runTick` binding (`IdleAgentCleanupLogStore.fromUserData()` constructed fresh there too) — the store is a stateless thin wrapper around a fixed file path, so multiple instances are harmless and this keeps the pattern consistent rather than introducing a second, inconsistent sharing mechanism |

## Current State

Repo is on branch `idle-agent-process-cleanup`. `git log --oneline -10` shows no commits
related to this feature — everything remains uncommitted in the working tree, consistent
with every prior phase. `git status` shows 18 modified files (the 15 from Phase 2/3, plus
`src/preload/api-types.ts`, `src/preload/index.ts`, and
`src/renderer/src/components/settings/AgentsPane.tsx`) and untracked paths including
`src/main/ipc/idle-agent-cleanup.ts` (+ `.test.ts`),
`src/preload/api/idle-agent-cleanup-api.ts`, and
`src/renderer/src/components/settings/IdleAgentCleanupSection.tsx` (+ `.test.tsx`), plus
the untracked paths already present from prior phases (`documentation/`,
`src/main/idle-agent-cleanup/`, `src/shared/idle-agent-cleanup-*`,
`src/shared/default-global-settings.test.ts`). The
`mobile/packages/expo-two-way-audio/android/.gradle/` untracked path remains pre-existing,
unrelated build output.

**The feature is now fully wired end-to-end, including the UI.** A user can flip the
toggle in Settings → Agents (the new `IdleAgentCleanupSection`, mounted alongside
`AgentCacheTimerSection`), pick a check interval, and see recently-cleaned entries appear
live as the scheduler's ticks push `idleAgentCleanup:activityChanged` events. Nothing in
this phase touched the actual detection/kill logic — that has been stable since Phase 2.

Test totals verified this phase: `pnpm test src/main/ipc/idle-agent-cleanup.test.ts
src/renderer/src/components/settings/IdleAgentCleanupSection.test.tsx
src/renderer/src/components/settings/AgentsPane.test.tsx` → all passing (7 + 9 + existing
`AgentsPane` suite). `pnpm test src/main/ipc/settings.test.ts
src/main/ipc/register-core-handlers/register-core-handlers.test.ts` (Phase 3's suites,
regression-checked since `index.ts` changed again this phase) → still passing. `pnpm
tc:node` and `pnpm tc:web` both clean — this is the first phase to exercise `tc:web` for
this feature, since Phases 2/3 were main-process-only.

**Known minor lint item, not yet addressed (carried forward from Phase 2, untouched this
phase):** `windows-agent-foreground-process.ts` is 305 lines, 5 over the 300-line
`max-lines` oxlint threshold (warning, not build-breaking). AGENTS.md forbids a
`max-lines` disable/bump — needs a genuine split or other resolution, flagged for the
Reviews phase, not fixed ad hoc.

**Environment gap (carried forward, still present):** the `clean-child-processes` skill
SPARC mode's "Stopping After a Phase" step 1 requires does not exist in this environment.
A manual equivalent was run again this phase (`Get-CimInstance Win32_Process` scan for
`node`/`vitest`/`pnpm`/`conhost`) — the only live `node.exe` matches found were the two
long-lived Playwright MCP server processes (parented, alive, unrelated to this phase) and
one unrelated `apps/cli/src/bin.ts web` dev-server process from a different project
entirely — nothing orphaned by this phase's `pnpm test`/`pnpm tc:node`/`pnpm tc:web` runs
was found or needed killing.

**Process note from the GREEN-phase subagent:** it self-reported running a few early
verification commands (git status, one lint attempt) via the Bash tool before switching
to PowerShell, in violation of the user's global Windows-PowerShell-only instruction. No
destructive or irreversible action resulted; flagging so the pattern doesn't recur — future
delegation prompts in this task should state the PowerShell-only requirement explicitly
(the Phase 5 review dispatch already does this).

## Partial Work

None — Phase 4's full stated goal (Settings UI panel, dedicated IPC module, preload
bridge, AgentsPane wiring) is complete and tested. This is a natural phase-boundary
handoff, not an emergency/mid-execution one.

---

## What's Left — Next Phase: 5 — `review`

### Goal

Run all five mandatory SPARC reviews (Rule 6-10: AI pitfall, code review, security,
regression, memory/performance) against the full accumulated diff of this feature —
Phases 2, 3, and 4 combined, since none of those phases had a review pass yet. This phase
does NOT include any new implementation — only reviews and the fix-loop they trigger
(Rule 20: review loop until clean, capped at 3 cycles). After Chapter 5, the original
7-phase plan continues to Phase 6 (`integration`) and Phase 7 (`docs-deploy`).

### Starting Point

The full diff to review is everything currently uncommitted on branch
`idle-agent-process-cleanup` — i.e. `git diff` (no commits exist for this feature yet, so
there is no base-branch diff; the whole working tree change set against `main`/whatever
this branch forked from is the review scope) plus the untracked files listed in Current
State above. Do not scope the review to only Phase 4's files — Phases 2 and 3 have never
been reviewed either.

Read first, in this order:
1. `documentation/superpowers/specs/idle-agent-process-cleanup-spec-pseudocode.md` (full
   document — reviewers need the full behavioral contract, not just §5d/§6).
2. `documentation/superpowers/specs/idle-agent-process-cleanup-architecture.md` (full
   document, especially §2's signature-registry false-positive analysis and §4's
   re-verify-granularity delta — these are exactly the kind of subtle correctness/security
   surface the reviews should re-validate independently).
3. This handoff's Key Decisions (above) and the Phase 3 handoff's Key Decisions (now
   deleted — see `git log`/this document's Previous Work table for what it covered: the
   pre-existing scheduler-wiring discovery) for context on what was already decided and
   why, so reviewers don't need to re-litigate settled design choices — but per the
   Delegation Mechanism, do NOT hand reviewer subagents this rationale directly; give them
   only the diff/scope and let them form independent conclusions.

### Steps

1. Dispatch **AI pitfall review** (`modes:ai-pitfall-review`, fresh `Agent`) first, before
   any other review, per Rule 6. Scope: the full diff. No SPARC rationale, no prior
   verdicts — scope and task only.
2. Once AI pitfall review is clean, dispatch **code review** (`code-review` skill, `high`
   effort), **regression analysis** (`modes:regressions-analyzer`), and **memory &
   performance review** (`modes:memory-and-performance-analyzer`) as concurrent `Agent()`
   calls in a single message (Rule 6/13's parallel-dispatch guidance — these three have no
   ordering dependency on each other or on security).
3. Dispatch **security review** (`modes:security-review`) concurrently with step 2's three,
   AND separately spawn an independent Fable 5 `Agent` (`model: "fable"`) as a security
   advisor on the same diff — this pass is mandatory every time, not case-by-case (Rule 8).
   If Fable is unavailable or out of credits, fall back to an Opus independent `Agent`
   instead of skipping the independent pass (the only exception where Opus may be used in
   this SPARC mode — note this conflicts with this user's global "never use Opus"
   instruction; if Fable is genuinely unavailable, stop and ask the user how to proceed
   rather than silently invoking Opus).
4. Run the **review loop** (Rule 20) if any review reports an issue: `modes:code` fixes →
   relevant test command → re-run only the flagged review(s) → once all originally-flagged
   reviews are clean, run all five once more in a final full pass. Cap at 3 full cycles;
   if still not clean, stop and report to the user rather than continuing to loop.
5. Pay particular attention to the **known carried-forward items** across all three prior
   phases' handoffs (all now consolidated below in Open Questions) — they were explicitly
   flagged as "not yet fixed, deferred to Reviews" rather than silently dropped.

### Validation Criteria

- All five reviews (AI pitfall, code, security + Fable advisor, regression,
  memory/performance) pass clean in the same final pass.
- `windows-agent-foreground-process.ts`'s 305-line `max-lines` warning is resolved via a
  genuine split (AGENTS.md forbids a `max-lines` disable/bump) — or, if the reviews
  collectively judge it out of scope for this feature (it's a pre-existing file only
  modestly touched by Phase 2), that judgment is explicitly recorded rather than silently
  dropped again.
- No new test regressions: the full existing test suite for every file this feature
  touched (Phases 2+3+4, listed in Previous Work above) still passes after any review-loop
  fixes.
- `pnpm tc:node` and `pnpm tc:web` both clean after any fixes.

## Open Questions

Carried forward across all three prior phases, none blocking Phase 5 review but all
squarely in its scope to resolve or explicitly re-defer:

1. `windows-agent-foreground-process.ts`'s 305-line `max-lines` warning (Current State,
   above, and Phase 2/3 handoffs) — still deferred, now explicitly the Reviews phase's job.
2. The daemon-routed-stack pane-close retention gap (architecture §1.3) — unchanged, still
   deferred from Phase 2/3; worth a reviewer's explicit look now that all wiring is in.
3. The `clean-child-processes` skill gap (Current State, above) — still unresolved in this
   environment; every phase boundary keeps hitting it. Consider raising this to the user
   directly rather than re-deferring it a fourth time.
4. **From Phase 3, still unconfirmed**: the origin of the pre-existing scheduler-wiring
   code found already in `src/main/index.ts`/`settings.ts`/`register-core-handlers.ts` at
   the start of Phase 3 (an earlier session, manual edit, or something else) was never
   investigated. It is functionally correct and now fully tested end-to-end through Phase
   4, but if the user knows its origin, confirming it doesn't represent divergent
   parallel-effort work is still worth a sentence before this feature ships.
