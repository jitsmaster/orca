// Simple, self-contained daemon RPC request shapes that don't need CreateOrAttach's
// session-startup payload. Split out of types.ts (capped for wire-shape declarations).

export type CloseStartupQueryAuthorityRequest = {
  id: string
  type: 'closeStartupQueryAuthority'
  payload: { sessionId: string }
}

export type CancelCreateOrAttachRequest = {
  id: string
  type: 'cancelCreateOrAttach'
  payload: { sessionId: string; requestId?: string }
}

export type WriteRequest = {
  id: string
  type: 'write'
  payload: {
    sessionId: string
    data: string
  }
}

export type ResizeRequest = {
  id: string
  type: 'resize'
  payload: {
    sessionId: string
    cols: number
    rows: number
  }
}

// ─── Producer flow control (v19+) ───────────────────────────────────
// Why fire-and-forget notifications (like write/resize): pause/resume ride the
// hot data path and are best-effort — the daemon-side 5s failsafe, not an RPC
// reply, is what guarantees a paused shell can never stay wedged.
export type PausePtyRequest = {
  id: string
  type: 'pausePty'
  payload: {
    sessionId: string
  }
}

export type ResumePtyRequest = {
  id: string
  type: 'resumePty'
  payload: {
    sessionId: string
  }
}

// Why the notification stays backward-tolerated: unknown notify types are
// swallowed by old daemons. The adapter's v20 capability gate separately
// prevents v19 thinning without a sequence-safe recovery snapshot.
export type SetSessionBackgroundRequest = {
  id: string
  type: 'setSessionBackground'
  payload: {
    sessionId: string
    background: boolean
  }
}

export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
  }
}

export type SignalRequest = {
  id: string
  type: 'signal'
  payload: {
    sessionId: string
    signal: string
  }
}

export type ListSessionsRequest = {
  id: string
  type: 'listSessions'
}

export type ShutdownIfIdleRequest = {
  id: string
  type: 'shutdownIfIdle'
}

export type DetachRequest = {
  id: string
  type: 'detach'
  payload: {
    sessionId: string
  }
}

export type GetCwdRequest = {
  id: string
  type: 'getCwd'
  payload: {
    sessionId: string
  }
}

export type ClearScrollbackRequest = {
  id: string
  type: 'clearScrollback'
  payload: {
    sessionId: string
  }
}

export type ShutdownRequest = {
  id: string
  type: 'shutdown'
  payload: {
    killSessions: boolean
  }
}

export type PingRequest = {
  id: string
  type: 'ping'
}

export type GetRetainedPaneDescendantsRequest = {
  id: string
  type: 'getRetainedPaneDescendants'
}

/** One closed daemon-hosted pane's last-known descendants, still within its retention grace period. */
export type RetainedPaneDescendantsWireRecord = {
  paneId: string
  descendantPids: number[]
  rootCommandLine: string
  shellPid: number
  retainedAtMs: number
}

export type GetRetainedPaneDescendantsResult = {
  retained: RetainedPaneDescendantsWireRecord[]
}

export type SystemResolverHealthRequest = {
  id: string
  type: 'systemResolverHealth'
}

export type PtySpawnHealthRequest = {
  id: string
  type: 'ptySpawnHealth'
}

export type GetSnapshotRequest = {
  id: string
  type: 'getSnapshot'
  payload: {
    sessionId: string
    scrollbackRows?: number
  }
}

// Why: read-only readback of the size the PTY actually applied (vs the size the
// renderer last requested via the fire-and-forget resize notify). Lets the
// renderer's resume drift-check re-assert a resize the daemon dropped/coerced.
export type GetSizeRequest = {
  id: string
  type: 'getSize'
  payload: {
    sessionId: string
  }
}
