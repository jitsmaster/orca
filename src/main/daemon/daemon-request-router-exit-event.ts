import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'

/** Split out of daemon-request-router.ts (capped for the request switch). */
export function sendDaemonRequestExitEvent(
  streamDataBatcher: DaemonStreamDataBatcher,
  client: ConnectedDaemonClient | undefined,
  sessionId: string,
  code: number
): void {
  if (!client?.streamSocket) {
    return
  }
  streamDataBatcher.enqueueControlEvent(client.clientId, sessionId, {
    type: 'event',
    event: 'exit',
    sessionId,
    payload: { code }
  })
  streamDataBatcher.flush(client.clientId)
}
