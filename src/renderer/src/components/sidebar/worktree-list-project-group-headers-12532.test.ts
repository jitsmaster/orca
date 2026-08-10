import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import { addHostSectionRows } from './host-section-rows'
import { buildRows } from './worktree-list-groups'
import { getRenderRowKey, getStickyHeaderIndexes } from './worktree-list-virtual-rows'

function makeRepo(id: string, projectGroupId: string, connectionId?: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    projectGroupId,
    projectGroupOrder: 0,
    connectionId
  }
}

function makeWorktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: `/${repoId}/${id}`,
    head: 'abc',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: true,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeGroup(id: string, name: string, tabOrder: number): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const groups = [makeGroup('infra', 'infra', 0), makeGroup('projects', 'projects', 1)]
const localA = makeRepo('local-a', 'infra')
const localB = makeRepo('local-b', 'projects')
const remoteA = makeRepo('remote-a', 'infra', 'ssh-1')
const remoteB = makeRepo('remote-b', 'projects', 'ssh-1')
const repos = [localA, localB, remoteA, remoteB]
const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
const worktrees = [
  makeWorktree('wt-local-a', localA.id),
  makeWorktree('wt-local-b', localB.id),
  makeWorktree('wt-remote-a', remoteA.id),
  makeWorktree('wt-remote-b', remoteB.id)
]
const hostOptions = [
  {
    id: 'local' as const,
    kind: 'local' as const,
    label: 'Local',
    detail: 'This computer',
    health: 'local' as const
  },
  {
    id: 'ssh:ssh-1' as const,
    kind: 'ssh' as const,
    label: 'Builder',
    detail: 'SSH',
    health: 'available' as const
  }
]

describe('project-group headers multi-host uniqueness (#12532)', () => {
  it('emits one header per project group on cold all-hosts prefer-project path', () => {
    const rows = buildRows(
      'repo',
      worktrees,
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      groups
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      preferProjectGrouping: true
    })
    const headers = sectioned.filter((row) => row.type === 'header')
    const projectGroupHeaders = headers.filter((row) => row.key.startsWith('project-group:'))
    expect(projectGroupHeaders.map((row) => row.key)).toEqual([
      'project-group:infra',
      'project-group:projects'
    ])
    const keys = sectioned.map((row) => getRenderRowKey(row))
    expect(new Set(keys).size).toBe(keys.length)
    // Single-tier sticky indexes: one slot per top-level group, no host tier.
    expect(getStickyHeaderIndexes(sectioned)).toEqual(
      projectGroupHeaders.map((row) => sectioned.indexOf(row))
    )
  })

  it('keeps unique virtualizer keys after expand/collapse rebuild with multi-host filter', () => {
    const collapsed = new Set(['project-group:infra'])
    const rows = buildRows(
      'repo',
      worktrees,
      repoMap,
      null,
      collapsed,
      undefined,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      groups
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local', 'ssh:ssh-1'],
      defaultHostId: 'local',
      preferProjectGrouping: true
    })
    const projectGroupHeaders = sectioned.filter(
      (row) => row.type === 'header' && row.key.startsWith('project-group:')
    )
    // Collapsed empty-of-items groups may land global once; expanded groups
    // are cloned per host with hostId. Either path must keep keys unique.
    expect(projectGroupHeaders.length).toBeGreaterThanOrEqual(2)
    const keys = sectioned.map((row) => getRenderRowKey(row))
    expect(new Set(keys).size).toBe(keys.length)
    const hostScoped = projectGroupHeaders.filter(
      (row) => row.type === 'header' && row.hostId != null
    )
    expect(hostScoped.length).toBeGreaterThan(0)
  })

  it('does not emit host sections for a single-host control', () => {
    const localOnly = worktrees.filter((wt) => wt.repoId.startsWith('local'))
    const rows = buildRows(
      'repo',
      localOnly,
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      groups
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local'],
      defaultHostId: 'local',
      preferProjectGrouping: true
    })
    expect(sectioned.some((row) => row.type === 'host-header')).toBe(false)
    const keys = sectioned.map((row) => getRenderRowKey(row))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
