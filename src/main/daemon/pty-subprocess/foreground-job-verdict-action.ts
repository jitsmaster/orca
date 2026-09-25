import type * as pty from 'node-pty'
import { judgeCachedAgentJobEvidence } from '../../providers/windows-cached-agent-revalidation'
import {
  isWindowsPtyJobReadable,
  readWindowsPtyJobProcessIds
} from '../../providers/windows-pty-job-membership'

export type WindowsAgentJobAction = 'retire' | 'retire-if-aged' | 'restamp' | 'hold'

/** Windows-only: job-table evidence (not console attachment) decides whether a stale cached
 *  agent identity should be retired, restamped, or held (#10857). */
export function resolveWindowsAgentJobAction(args: {
  proc: pty.IPty
  cachedAgentPid: number | null
  cachedAgentRefreshedAt: number
  anchorPidForeign: boolean | undefined
}): WindowsAgentJobAction {
  const verdict = judgeCachedAgentJobEvidence({
    jobProcessIds: readWindowsPtyJobProcessIds(args.proc),
    jobSupported: isWindowsPtyJobReadable(),
    shellPid: args.proc.pid,
    anchorProcessId: args.cachedAgentPid,
    identityAgeMs: Date.now() - args.cachedAgentRefreshedAt
  })
  // Unverifiable is never exit proof (ssh-execution-boundary.md): hold.
  if (verdict === 'unavailable') {
    return 'hold'
  }
  if (verdict === 'unsupported') {
    // No job to consult on this build, and the scan that got here was available and found
    // no agent. Trust it, as every other platform does, rather than holding a dead name
    // forever (#16059).
    return 'retire'
  }
  if (verdict === 'confirmed' || verdict === 'recheck') {
    // The scan proved the pid recycled to a non-agent, or the anchor pid is still in the
    // job and the scan simply lost the row.
    return args.anchorPidForeign === true ? 'retire' : 'restamp'
  }
  if (verdict === 'exited' || verdict === 'anchor-exited') {
    // Safe mid-restart: an available scan already found no agent.
    return 'retire'
  }
  // Unanchored superset evidence cannot tell a working agent from a leftover; the age bound
  // settles it.
  return 'retire-if-aged'
}
