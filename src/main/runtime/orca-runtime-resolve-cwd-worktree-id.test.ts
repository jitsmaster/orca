import { describe, expect, it } from 'vitest'
import { OrcaRuntimeWithResolveCwdWorktreeId } from './orca-runtime-resolve-cwd-worktree-id'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

class TestableRuntime extends OrcaRuntimeWithResolveCwdWorktreeId {
  constructor(private readonly onSelector: (selector: string) => Promise<{ id: string }>) {
    super()
  }
  protected override resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only override of the protected base method; only `.id` is ever read, never called outside this file.
    return this.onSelector(selector) as unknown as Promise<ResolvedWorktree>
  }
}

describe('resolveCwdWorktreeId', () => {
  it('resolves a matched cwd to its worktree id via the path: selector', async () => {
    const runtime = new TestableRuntime(async (selector) => {
      expect(selector).toBe('path:/repo/worktrees/feature-x')
      return { id: 'wt-feature' }
    })
    await expect(runtime.resolveCwdWorktreeId('/repo/worktrees/feature-x')).resolves.toBe(
      'wt-feature'
    )
  })

  it('returns null when the selector reports not found', async () => {
    const runtime = new TestableRuntime(async () => {
      throw new Error('selector_not_found')
    })
    await expect(runtime.resolveCwdWorktreeId('/repo/worktrees/unknown')).resolves.toBeNull()
  })

  it('returns null when the selector reports ambiguous', async () => {
    const runtime = new TestableRuntime(async () => {
      throw new Error('selector_ambiguous')
    })
    await expect(runtime.resolveCwdWorktreeId('/repo')).resolves.toBeNull()
  })
})
