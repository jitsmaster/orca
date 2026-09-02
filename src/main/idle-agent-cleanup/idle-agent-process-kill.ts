import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'

/**
 * Bare-PID kill: POSIX SIGKILL, Windows `taskkill /pid <pid> /f` via `runProcess`.
 *
 * No `/t`: the candidate pid is already the specific agent process this tick
 * re-verified (command line + signature, byte-identical to build time) --
 * killing its whole subtree would take down any further descendant without
 * that same re-verify, unrelated processes included if one has spawned since
 * candidate-building. A descendant with its own agent signature is instead
 * tracked and verified as its own separate candidate.
 */
export async function killOrphanedAgentProcessByPid(
  pid: number
): Promise<'killed' | 'kill-failed'> {
  if (process.platform === 'win32') {
    const result = await runProcess({
      program: windowsSystem32Binary('taskkill.exe'),
      args: ['/pid', String(pid), '/f'],
      timeoutMs: 5_000
    })
    return result.code === 0 ? 'killed' : 'kill-failed'
  }

  try {
    process.kill(pid, 'SIGKILL')
    return 'killed'
  } catch (error) {
    // Already gone between re-verify and kill counts as success.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'killed' : 'kill-failed'
  }
}
