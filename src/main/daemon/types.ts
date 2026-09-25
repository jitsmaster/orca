import type {
  ConfirmForegroundProcessRequest,
  ConfirmShellForegroundRequest,
  GetForegroundProcessRequest,
  InspectProcessRequest
} from './daemon-foreground-process-protocol'

export type {
  ConfirmForegroundProcessRequest,
  ConfirmShellForegroundRequest,
  GetForegroundProcessRequest,
  InspectProcessRequest
} from './daemon-foreground-process-protocol'

// ─── Protocol Version ────────────────────────────────────────────────
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type * as HistorySeedProtocol from './terminal-history-seed-transfer-protocol'
export type { TerminalModes } from './terminal-modes'
import type { TerminalSnapshot } from './terminal-snapshot'
export type { TerminalSnapshot } from './terminal-snapshot'
export {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  ASYNC_CWD_VALIDATION_DAEMON_PROTOCOL_VERSION,
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  PTY_STARTUP_INGRESS_PROTOCOL_VERSION,
  MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION,
  supportsMode2031UnsubscribeFact,
  supportsPtyStartupIngress
} from './daemon-protocol-version'

// ─── Session State Machine ──────────────────────────────────────────
export type SessionState = 'created' | 'spawning' | 'running' | 'exiting' | 'exited'

export type ShellReadyState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

// The on-disk checkpoint.json shape lives in daemon-checkpoint-file.ts (it
// depends only on TerminalModes here) — re-exported so existing importers of
// `./types` keep working.
export type { TerminalCheckpointFile } from './daemon-checkpoint-file'

// ─── NDJSON Protocol Messages ───────────────────────────────────────

// Hello handshake (first message on each socket)
export type { DaemonEndpointIdentity, HelloMessage, HelloResponse } from './daemon-hello-protocol'

// ─── RPC Requests (Client → Daemon, on control socket) ─────────────

export type CreateOrAttachRequest = {
  id: string
  type: 'createOrAttach'
  payload: HistorySeedProtocol.CreateOrAttachHistorySeedPayload & {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    /** Rejects an absent session instead of interpreting mount uncertainty as create permission. */
    attachOnly?: boolean
    /** Explicit Windows shell override selected by the user (e.g. 'wsl.exe').
     *  The daemon forwards this to its subprocess spawner so each tab honors
     *  the shell picked in the "+" menu or the persisted default-shell setting,
     *  instead of defaulting to COMSPEC (which is always cmd.exe on Windows)
     *  or the hard-coded powershell.exe fallback. */
    shellOverride?: string
    terminalShellArgs?: string[]
    /** Preferred WSL distro for generic `wsl.exe` launches. */
    terminalWindowsWslDistro?: string | null
    /** Why: the UI keeps PowerShell as one shell family, but the runtime may
     *  need to substitute pwsh.exe for powershell.exe when the user selected
     *  PowerShell 7+. Forward the persisted implementation choice so the daemon
     *  PTY path resolves the same effective executable as LocalPtyProvider. */
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    /** Server-side fence that prevents a client timeout from publishing an orphan PTY. */
    cancelAfterMs?: number
    startupIngress?: PtyStartupIngressIntent
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
  }
}

// Simple, self-contained request shapes live in daemon-simple-request-protocol.ts
// (this file is capped for wire-shape declarations); re-exported so existing
// importers of `./types` keep working.
export type {
  CloseStartupQueryAuthorityRequest,
  CancelCreateOrAttachRequest,
  WriteRequest,
  ResizeRequest,
  PausePtyRequest,
  ResumePtyRequest,
  SetSessionBackgroundRequest,
  KillRequest,
  SignalRequest,
  ListSessionsRequest,
  ShutdownIfIdleRequest,
  DetachRequest,
  GetCwdRequest,
  ClearScrollbackRequest,
  ShutdownRequest,
  PingRequest,
  GetRetainedPaneDescendantsRequest,
  RetainedPaneDescendantsWireRecord,
  GetRetainedPaneDescendantsResult,
  SystemResolverHealthRequest,
  PtySpawnHealthRequest,
  GetSnapshotRequest,
  GetSizeRequest
} from './daemon-simple-request-protocol'
import type {
  CloseStartupQueryAuthorityRequest,
  CancelCreateOrAttachRequest,
  WriteRequest,
  ResizeRequest,
  PausePtyRequest,
  ResumePtyRequest,
  SetSessionBackgroundRequest,
  KillRequest,
  SignalRequest,
  ListSessionsRequest,
  ShutdownIfIdleRequest,
  DetachRequest,
  GetCwdRequest,
  ClearScrollbackRequest,
  ShutdownRequest,
  PingRequest,
  GetRetainedPaneDescendantsRequest,
  GetSnapshotRequest,
  GetSizeRequest
} from './daemon-simple-request-protocol'

// Incremental checkpoint record types live in daemon-pending-output-checkpoint.ts
// (this file is capped for wire-shape declarations); re-exported so existing
// importers of `./types` keep working.
export type {
  PendingOutputRecord,
  TakePendingOutputRequest,
  TakePendingOutputResult
} from './daemon-pending-output-checkpoint'
import type { TakePendingOutputRequest } from './daemon-pending-output-checkpoint'

export type DaemonRequest =
  | CreateOrAttachRequest
  | HistorySeedProtocol.TerminalHistorySeedTransferRequest
  | CancelCreateOrAttachRequest
  | WriteRequest
  | ResizeRequest
  | PausePtyRequest
  | ResumePtyRequest
  | SetSessionBackgroundRequest
  | KillRequest
  | SignalRequest
  | ListSessionsRequest
  | ShutdownIfIdleRequest
  | DetachRequest
  | GetCwdRequest
  | GetForegroundProcessRequest
  | InspectProcessRequest
  | ConfirmForegroundProcessRequest
  | ConfirmShellForegroundRequest
  | ClearScrollbackRequest
  | ShutdownRequest
  | PingRequest
  | GetRetainedPaneDescendantsRequest
  | SystemResolverHealthRequest
  | PtySpawnHealthRequest
  | GetSnapshotRequest
  | GetSizeRequest
  | TakePendingOutputRequest
  | CloseStartupQueryAuthorityRequest

// ─── RPC Responses (Daemon → Client, on control socket) ────────────

export type RpcResponseOk<T = unknown> = {
  id: string
  ok: true
  payload: T
}

export type RpcResponseError = {
  id: string
  ok: false
  error: string
}

export type RpcResponse<T = unknown> = RpcResponseOk<T> | RpcResponseError

export type { DaemonCreateOrAttachResult as CreateOrAttachResult } from './daemon-create-or-attach-result'
export type GetSnapshotResult = {
  snapshot: TerminalSnapshot | null
}

export type ListSessionsResult = {
  sessions: SessionInfo[]
}

export type ShutdownIfIdleResult = {
  retiring: boolean
}

export type SystemResolverHealth = 'healthy' | 'unhealthy' | 'unknown'

export type SystemResolverHealthResult = {
  health: SystemResolverHealth
}

export type SessionInfo = {
  sessionId: string
  incarnationId?: string
  state: SessionState
  shellState: ShellReadyState
  isAlive: boolean
  terminalHandle?: string
  wslDistro?: string | null
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

// Why: SessionInfo + source protocol version, so the Manage Sessions UI can
// label legacy-backed sessions. Populated by the router/adapter at RPC time;
// never transmitted over the daemon wire (daemon only speaks its own
// protocol version and doesn't know about other versions).
export type DaemonSessionInfo = SessionInfo & {
  protocolVersion: number
}

// Stream-socket event shapes live in daemon-stream-events.ts; re-exported so
// existing importers keep one types entry point.
export type * from './daemon-stream-events'

// ─── Notify prefix ──────────────────────────────────────────────────
// Requests with IDs starting with this prefix are fire-and-forget:
// the daemon processes them but does not send a response.
export const NOTIFY_PREFIX = 'notify_'

// ─── Error types ────────────────────────────────────────────────────
// Re-exported so existing importers of `./types` keep working; the classes
// live in daemon-errors.ts (this file is capped for wire-shape declarations).
export {
  TerminalAttachCanceledError,
  DaemonConnectionLostError,
  DaemonProtocolError,
  DaemonRequestTimeoutError,
  DAEMON_UNAVAILABLE_RECONNECT_MESSAGE,
  SessionNotFoundError
} from './daemon-errors'
