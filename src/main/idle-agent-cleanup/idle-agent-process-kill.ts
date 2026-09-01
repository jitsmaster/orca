import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'

/** Bare-PID kill: POSIX SIGKILL, Windows `taskkill /pid <pid> /t /f` via `runProcess`. */
export async function killOrphanedAgentProcessByPid(
  pid: number
): Promise<'killed' | 'kill-failed'> {
  if (process.platform === 'win32') {
    const result = await runProcess({
      program: windowsSystem32Binary('taskkill.exe'),
      args: ['/pid', String(pid), '/t', '/f'],
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
