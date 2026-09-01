import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from '../../shared/agent-process-recognition'
import type { WindowsProcessRow } from './windows-foreground-process-rows'

export function recognizeWindowsProcessCandidate(
  candidate: WindowsProcessRow
): RecognizedAgentProcess | null {
  return (
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  )
}

export function windowsCandidateIsAncestor(
  candidate: WindowsProcessRow,
  other: WindowsProcessRow,
  candidatesByPid: ReadonlyMap<number, WindowsProcessRow>
): boolean {
  let current = candidatesByPid.get(other.ppid)
  while (current) {
    if (current.pid === candidate.pid) {
      return true
    }
    current = candidatesByPid.get(current.ppid)
  }
  return false
}
