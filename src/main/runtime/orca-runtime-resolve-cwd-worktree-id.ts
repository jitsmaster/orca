import { OrcaRuntimeWithResolveWorktreeSelector } from './orca-runtime-resolve-worktree-selector'

export class OrcaRuntimeWithResolveCwdWorktreeId extends OrcaRuntimeWithResolveWorktreeSelector {
  /** Resolves a live cwd (from a Claude hook event) to a known worktree id, or null when the
   *  catalog has no match or more than one — never throws. Reuses the same `path:` selector
   *  grammar `orca worktree ps` already resolves through. */
  async resolveCwdWorktreeId(cwd: string): Promise<string | null> {
    try {
      const worktree = await this.resolveWorktreeSelector(`path:${cwd}`)
      return worktree.id
    } catch {
      return null
    }
  }
}
