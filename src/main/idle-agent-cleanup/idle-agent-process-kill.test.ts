import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))

import { killOrphanedAgentProcessByPid } from './idle-agent-process-kill'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'

let platform: PropertyDescriptor | undefined

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

beforeEach(() => {
  runProcessMock.mockReset()
  platform = Object.getOwnPropertyDescriptor(process, 'platform')
})

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

describe('killOrphanedAgentProcessByPid — win32', () => {
  beforeEach(() => setPlatform('win32'))

  it("reports 'killed' when taskkill exits 0", async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await expect(killOrphanedAgentProcessByPid(4242)).resolves.toBe('killed')
  })

  it("reports 'kill-failed' when taskkill exits non-zero (e.g. access denied)", async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'Access is denied.',
      timedOut: false
    })

    await expect(killOrphanedAgentProcessByPid(4242)).resolves.toBe('kill-failed')
  })

  // Design Resolution C: architecture's pseudocode literally wrote
  // `program: 'taskkill'`, which is wrong for this codebase — bare-name
  // resolution on Windows depends on Electron's PATH. The absolute System32
  // path must be used instead (mirrors windows-process-table-cim-scan.ts,
  // browser-cookie-import.ts's existing use of windowsSystem32Binary).
  it('invokes taskkill through runProcess with an absolute System32 path, never a bare "taskkill" program name', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await killOrphanedAgentProcessByPid(4242)

    expect(runProcessMock).toHaveBeenCalledWith({
      program: windowsSystem32Binary('taskkill.exe'),
      args: ['/pid', '4242', '/f'],
      timeoutMs: 5_000
    })
  })
})

describe('killOrphanedAgentProcessByPid — posix', () => {
  beforeEach(() => setPlatform('darwin'))

  it("reports 'killed', not an error, when process.kill throws ESRCH (already exited between re-verify and kill)", async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    await expect(killOrphanedAgentProcessByPid(4242)).resolves.toBe('killed')
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
  })

  it("reports 'kill-failed' when process.kill throws EPERM", async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    await expect(killOrphanedAgentProcessByPid(4242)).resolves.toBe('kill-failed')
  })
})

// Design Resolution D: a fast, local, redundant check alongside the repo-wide
// child-process-import-boundary.test.ts ratchet — mirrors its intent without
// the full tree-walk, scoped to just this file's own imports.
describe('idle-agent-process-kill.ts import boundary (Design Resolution D)', () => {
  it('never imports child_process directly — the kill path must go through runProcess/spawnProcess', () => {
    const source = readFileSync(join(__dirname, 'idle-agent-process-kill.ts'), 'utf8')
    const codeOnly = source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n')

    expect(codeOnly).not.toMatch(/from\s+['"](?:node:)?child_process['"]/)
    expect(codeOnly).not.toMatch(/require\(\s*['"](?:node:)?child_process['"]/)
  })
})
