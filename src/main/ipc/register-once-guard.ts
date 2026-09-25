/**
 * Guards an `ipcMain.handle` registration block against running twice.
 *
 * Why this exists: on macOS the app can stay alive after all windows close,
 * then `openMainWindow()` runs again on `'activate'`. `ipcMain.handle()`
 * throws if a channel is registered twice, so every registration entry point
 * needs exactly this one-shot latch.
 */
export function createRegisterOnceGuard(): () => boolean {
  let registered = false
  return () => {
    if (registered) {
      return false
    }
    registered = true
    return true
  }
}
