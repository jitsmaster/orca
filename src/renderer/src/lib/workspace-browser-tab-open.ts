import { translate } from '@/i18n/i18n'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { SEARCH_ENGINE_LABELS, type SearchEngine } from '../../../shared/browser-url'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

export type WorkspaceBrowserOwner =
  | { kind: 'client'; workspaceExecutionHostId: ExecutionHostId }
  | {
      kind: 'runtime'
      environmentId: string
      workspaceExecutionHostId: ExecutionHostId
    }

export type WorkspaceBrowserOwnerResolution =
  | { status: 'resolved'; owner: WorkspaceBrowserOwner }
  | { status: 'unresolved'; reason: 'missing' | 'ambiguous' | 'invalid-workspace-host' }

export type WorkspaceBrowserTabIntent = { kind: 'url' } | { kind: 'search'; engine: SearchEngine }

export type OpenWorkspaceBrowserTabRequest = {
  workspaceId: string
  targetGroupId?: string
  url: string
  intent: WorkspaceBrowserTabIntent
}

export function resolveWorkspaceBrowserOwner(
  state: WorktreeOperationRouteState,
  workspaceId: string
): WorkspaceBrowserOwnerResolution {
  const resolution = resolveWorktreeOperationRouteResult(state, workspaceId)
  if (resolution.kind !== 'resolved') {
    return { status: 'unresolved', reason: resolution.kind }
  }
  const environmentId = resolution.route.runtimeEnvironmentId?.trim() || null
  const parsedHost = parseExecutionHostId(resolution.route.executionHostId)
  if (environmentId) {
    if (!resolution.route.executionHostId) {
      return {
        status: 'resolved',
        owner: {
          kind: 'runtime',
          environmentId,
          workspaceExecutionHostId: toRuntimeExecutionHostId(environmentId)
        }
      }
    }
    if (
      !parsedHost ||
      (parsedHost.kind === 'runtime' && parsedHost.environmentId !== environmentId)
    ) {
      return { status: 'unresolved', reason: 'invalid-workspace-host' }
    }
    return {
      status: 'resolved',
      owner: {
        kind: 'runtime',
        environmentId,
        workspaceExecutionHostId: parsedHost.id
      }
    }
  }
  if (!parsedHost || parsedHost.kind === 'runtime') {
    return { status: 'unresolved', reason: 'invalid-workspace-host' }
  }
  return {
    status: 'resolved',
    owner: { kind: 'client', workspaceExecutionHostId: parsedHost.id }
  }
}

function intentPresentation(intent: WorkspaceBrowserTabIntent): {
  error: string
  title: string
} {
  if (intent.kind === 'url') {
    return {
      error: translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.'),
      title: translate('auto.components.tab.bar.TabBarCreateEntry.7cdf8ee0c8', 'Open URL')
    }
  }
  const engine = SEARCH_ENGINE_LABELS[intent.engine]
  return {
    error: translate(
      'auto.lib.workspace.browser.tab.open.searchFailed',
      'Unable to search with {{value0}}.',
      { value0: engine }
    ),
    title: translate(
      'auto.components.tab.bar.TabBarCreateEntry.searchProvider',
      'Search {{value0}}',
      { value0: engine }
    )
  }
}

function validateTarget(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}

function effectiveClientProfileId(state: AppState, hostId: ExecutionHostId): string | null {
  return (
    state.defaultBrowserSessionProfileIdByHostId[hostId] ?? state.defaultBrowserSessionProfileId
  )
}

function createClientBrowserTab(
  state: AppState,
  request: OpenWorkspaceBrowserTabRequest,
  hostId: ExecutionHostId,
  title: string
): void {
  state.createBrowserTab(request.workspaceId, request.url, {
    activate: true,
    browserRuntimeEnvironmentId: null,
    focusAddressBar: false,
    sessionProfileId: effectiveClientProfileId(state, hostId),
    targetGroupId: request.targetGroupId,
    title
  })
}

export async function openWorkspaceBrowserTab(
  request: OpenWorkspaceBrowserTabRequest
): Promise<void> {
  const presentation = intentPresentation(request.intent)
  if (!validateTarget(request.url)) {
    throw new Error(presentation.error)
  }
  const state = useAppStore.getState()
  const resolution = resolveWorkspaceBrowserOwner(state, request.workspaceId)
  if (resolution.status === 'unresolved') {
    throw new Error(presentation.error)
  }
  if (resolution.owner.kind === 'client') {
    try {
      createClientBrowserTab(
        state,
        request,
        resolution.owner.workspaceExecutionHostId,
        presentation.title
      )
    } catch {
      throw new Error(presentation.error)
    }
    return
  }
  let created = false
  try {
    created = await createWebRuntimeSessionBrowserTab({
      worktreeId: request.workspaceId,
      environmentId: resolution.owner.environmentId,
      url: request.url,
      targetGroupId: request.targetGroupId,
      selectWorktree: false,
      stagedTitle: presentation.title,
      stagedFocusAddressBar: false,
      failureLogMode: 'operation-only'
    })
  } catch {
    throw new Error(presentation.error)
  }
  if (!created) {
    try {
      createClientBrowserTab(state, request, LOCAL_EXECUTION_HOST_ID, presentation.title)
    } catch {
      throw new Error(presentation.error)
    }
  }
}
