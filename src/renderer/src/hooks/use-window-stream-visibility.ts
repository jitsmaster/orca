import { useEffect, useState, useSyncExternalStore } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/stale-document-visibility'

function getWindowVisibleSnapshot(): boolean {
  return isWindowVisible() || isDocumentVisibilityProvenStale()
}

function subscribeWindowVisible(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  const unregisterStaleRecovery = registerStaleDocumentVisibilityRecovery(onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    unregisterStaleRecovery()
  }
}

// Avoid renegotiating expensive streams during a quick app-switch round trip.
export const WINDOW_STREAM_PARK_DELAY_MS = 500

export function useWindowStreamVisible(parkDelayMs = WINDOW_STREAM_PARK_DELAY_MS): boolean {
  const rawVisible = useSyncExternalStore(
    subscribeWindowVisible,
    getWindowVisibleSnapshot,
    getWindowVisibleSnapshot
  )
  const [effectiveVisible, setEffectiveVisible] = useState(rawVisible)

  useEffect(() => {
    if (rawVisible) {
      setEffectiveVisible(true)
      return
    }
    const timer = window.setTimeout(() => setEffectiveVisible(false), parkDelayMs)
    return () => window.clearTimeout(timer)
  }, [parkDelayMs, rawVisible])

  return effectiveVisible
}
