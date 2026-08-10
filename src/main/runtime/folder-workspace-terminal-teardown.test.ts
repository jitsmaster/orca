import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'

const { killAllProcessesForWorktreeMock } = vi.hoisted(() => ({
  killAllProcessesForWorktreeMock: vi.fn()
}))

vi.mock('./worktree-teardown', () => ({
  killAllProcessesForWorktree: killAllProcessesForWorktreeMock,
  teardownRpcDeadline: (deadline: number) => deadline - 500
}))

import {
  stopFolderWorkspaceTerminals,
  type FolderWorkspaceTerminalTeardownTarget
} from './folder-workspace-terminal-teardown'

function createInventoryProvider(): {
  provider: IPtyProvider
  listProcesses: ReturnType<typeof vi.fn>
} {
  const listProcesses = vi.fn().mockResolvedValue([])
  return {
    provider: { listProcesses } as unknown as IPtyProvider,
    listProcesses
  }
}

describe('folder workspace terminal teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caps combined provider and runtime-only fanout while sharing each inventory', async () => {
    let activeTeardowns = 0
    let peakTeardowns = 0
    const settleTrackedTeardown = async <T>(result: T): Promise<T> => {
      activeTeardowns += 1
      peakTeardowns = Math.max(peakTeardowns, activeTeardowns)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      activeTeardowns -= 1
      return result
    }
    const providerA = createInventoryProvider()
    const providerB = createInventoryProvider()
    killAllProcessesForWorktreeMock.mockImplementation(
      async (_workspaceKey: string, deps: { localProvider: IPtyProvider }) => {
        await deps.localProvider.listProcesses()
        return settleTrackedTeardown({
          runtimeStopped: 0,
          providerStopped: 1,
          registryStopped: 0
        })
      }
    )
    const stopTerminalsForWorktree = vi.fn(
      (_workspaceKey: string, _options: { deadline: number }) =>
        settleTrackedTeardown({ stopped: 1 })
    )
    const targets: FolderWorkspaceTerminalTeardownTarget[] = [
      ...Array.from({ length: 4 }, (_, index) => ({
        workspaceKey: `ssh-a-${index}`,
        connection: { kind: 'ssh' as const, connectionId: 'ssh-a' }
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        workspaceKey: `ssh-b-${index}`,
        connection: { kind: 'ssh' as const, connectionId: 'ssh-b' }
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        workspaceKey: `ambiguous-${index}`,
        connection: { kind: 'ambiguous' as const }
      }))
    ]

    const result = await stopFolderWorkspaceTerminals(targets, {
      runtime: { stopTerminalsForWorktree } as unknown as OrcaRuntimeService,
      getLocalProvider: () => null,
      getSshProvider: (connectionId) =>
        connectionId === 'ssh-a' ? providerA.provider : providerB.provider
    })

    expect(peakTeardowns).toBe(4)
    expect(providerA.listProcesses).toHaveBeenCalledTimes(1)
    expect(providerB.listProcesses).toHaveBeenCalledTimes(1)
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(8)
    expect(stopTerminalsForWorktree).toHaveBeenCalledTimes(12)
    const deadlineByWorkspace = new Map(
      stopTerminalsForWorktree.mock.calls.map(([workspaceKey, options]) => [
        workspaceKey,
        options.deadline
      ])
    )
    const waveDeadlines = [0, 4, 8].map((index) =>
      deadlineByWorkspace.get(targets[index].workspaceKey)
    )
    expect(waveDeadlines[0]).toBeLessThan(waveDeadlines[1]!)
    expect(waveDeadlines[1]).toBeLessThan(waveDeadlines[2]!)
    for (const [index, target] of targets.entries()) {
      expect(deadlineByWorkspace.get(target.workspaceKey)).toBe(
        waveDeadlines[Math.floor(index / 4)]
      )
    }
    expect(result).toEqual({ runtimeStopped: 12, providerStopped: 8, registryStopped: 0 })
  })

  it('reserves teardown budget for a late queued workspace and its runtime sweep', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'))
    try {
      let activeTeardowns = 0
      let peakTeardowns = 0
      const track = async <T>(work: () => Promise<T>): Promise<T> => {
        activeTeardowns += 1
        peakTeardowns = Math.max(peakTeardowns, activeTeardowns)
        try {
          return await work()
        } finally {
          activeTeardowns -= 1
        }
      }
      const provider = createInventoryProvider()
      const providerBudgets: number[] = []
      killAllProcessesForWorktreeMock.mockImplementation(
        async (_workspaceKey: string, deps: { localProvider: IPtyProvider; timeoutMs: number }) =>
          track(async () => {
            await deps.localProvider.listProcesses()
            providerBudgets.push(deps.timeoutMs)
            await new Promise<void>((resolve) => setTimeout(resolve, deps.timeoutMs))
            return { runtimeStopped: 0, providerStopped: 0, registryStopped: 0 }
          })
      )
      const runtimeStarts: { workspaceKey: string; startedAt: number; deadline: number }[] = []
      const stopTerminalsForWorktree = vi.fn(
        (workspaceKey: string, options: { deadline: number }) =>
          track(async () => {
            runtimeStarts.push({ workspaceKey, startedAt: Date.now(), deadline: options.deadline })
            if (workspaceKey.startsWith('blocked-')) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.max(1, options.deadline - Date.now()))
              )
              return { stopped: 0 }
            }
            return { stopped: Date.now() < options.deadline ? 1 : 0 }
          })
      )
      const targets: FolderWorkspaceTerminalTeardownTarget[] = [
        ...Array.from({ length: 4 }, (_, index) => ({
          workspaceKey: `blocked-${index}`,
          connection: { kind: 'ambiguous' as const }
        })),
        { workspaceKey: 'late-live', connection: { kind: 'local' as const } }
      ]

      const pending = stopFolderWorkspaceTerminals(targets, {
        runtime: { stopTerminalsForWorktree } as unknown as OrcaRuntimeService,
        getLocalProvider: () => provider.provider,
        getSshProvider: () => undefined
      })
      await vi.runAllTimersAsync()

      await expect(pending).resolves.toEqual({
        runtimeStopped: 1,
        providerStopped: 0,
        registryStopped: 0
      })
      const lateRuntime = runtimeStarts.find((call) => call.workspaceKey === 'late-live')
      expect(lateRuntime?.startedAt).toBeLessThan(lateRuntime!.deadline)
      expect(providerBudgets).toHaveLength(1)
      expect(providerBudgets[0]).toBeGreaterThan(1)
      expect(provider.listProcesses).toHaveBeenCalledTimes(1)
      expect(peakTeardowns).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives one slow shared inventory a stable budget across a large target batch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'))
    try {
      const startedAt = Date.now()
      const provider = createInventoryProvider()
      const providerJobStarts: number[] = []
      const providerBudgets: number[] = []
      provider.listProcesses.mockImplementation(
        async () => new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 4_000))
      )
      killAllProcessesForWorktreeMock.mockImplementation(
        async (_workspaceKey: string, deps: { localProvider: IPtyProvider; timeoutMs: number }) => {
          providerJobStarts.push(Date.now())
          providerBudgets.push(deps.timeoutMs)
          await deps.localProvider.listProcesses()
          return { runtimeStopped: 0, providerStopped: 1, registryStopped: 0 }
        }
      )
      const stopTerminalsForWorktree = vi.fn(async () => ({ stopped: 1 }))
      const targets: FolderWorkspaceTerminalTeardownTarget[] = Array.from(
        { length: 49 },
        (_, index) => ({ workspaceKey: `large-${index}`, connection: { kind: 'local' as const } })
      )

      const pending = stopFolderWorkspaceTerminals(targets, {
        runtime: { stopTerminalsForWorktree } as unknown as OrcaRuntimeService,
        getLocalProvider: () => provider.provider,
        getSshProvider: () => undefined
      })
      await vi.runAllTimersAsync()

      await expect(pending).resolves.toEqual({
        runtimeStopped: 49,
        providerStopped: 49,
        registryStopped: 0
      })
      expect(provider.listProcesses.mock.calls).toEqual([[{ deadlineMs: expect.any(Number) }]])
      const inventoryOptions = provider.listProcesses.mock.calls[0][0] as {
        deadlineMs: number
      }
      expect(inventoryOptions.deadlineMs).toBeGreaterThan(startedAt + 4_000)
      expect(providerJobStarts.every((started) => started >= startedAt + 4_000)).toBe(true)
      expect(providerBudgets.every((budget) => budget > 1)).toBe(true)
      expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(49)
    } finally {
      vi.useRealTimers()
    }
  })
})
