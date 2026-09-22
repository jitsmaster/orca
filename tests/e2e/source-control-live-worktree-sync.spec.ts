import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@playwright/test'

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('source-control')
  })
}

// Why: exercises the real end-to-end path a live Claude Code session would drive —
// main sends the same IPC event server-lifecycle.ts/main-window-source-control-live-worktree.ts
// produce, and this asserts the renderer's Source Control picker actually re-points.
test("Source Control worktree picker follows a tab's live cwd-resolved worktree", async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const activeWorktreeId = await waitForActiveWorktree(orcaPage)
  await openSourceControl(orcaPage)

  const picker = orcaPage.getByTestId('source-control-worktree-picker')
  await expect(picker).toBeVisible()

  const { activeTabId, secondaryWorktreeId, secondaryWorktreeName } = await orcaPage.evaluate(
    (worktreeId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const activeTabId = state.getActiveTab(worktreeId)?.id
      if (!activeTabId) {
        throw new Error('no active tab for the active worktree')
      }
      const secondary = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id !== worktreeId)
      if (!secondary) {
        throw new Error('no secondary worktree seeded')
      }
      return {
        activeTabId,
        secondaryWorktreeId: secondary.id,
        secondaryWorktreeName: secondary.displayName
      }
    },
    activeWorktreeId
  )

  await expect(picker).not.toContainText(secondaryWorktreeName)

  // Simulate the live-cwd signal a running Claude Code session's PostToolUse hook
  // (EnterWorktree/ExitWorktree or a plain cd) would produce end to end.
  await electronApp.evaluate(
    ({ BrowserWindow }, { activeTabId, secondaryWorktreeId }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!window) {
        throw new Error('Orca BrowserWindow is unavailable')
      }
      window.webContents.send('sourceControlLiveWorktree:set', {
        paneKey: `${activeTabId}:e2e-live-worktree-leaf`,
        tabId: activeTabId,
        worktreeId: secondaryWorktreeId
      })
    },
    { activeTabId, secondaryWorktreeId }
  )

  await expect(picker).toContainText(secondaryWorktreeName)
})
