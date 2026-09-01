import { describe, expect, it } from 'vitest'
import {
  IDLE_AGENT_CLEANUP_SIGNATURES,
  matchIdleAgentCleanupCandidate,
  matchIdleAgentCleanupSignature
} from './idle-agent-cleanup-signatures'

describe('matchIdleAgentCleanupSignature', () => {
  it('matches a command line containing "claude" and returns the Claude Code signature', () => {
    expect(matchIdleAgentCleanupSignature('node /usr/local/bin/claude --resume')).toEqual(
      expect.objectContaining({ agentName: 'Claude Code' })
    )
  })

  it('matches a command line containing ".claude/" even with no "claude" token', () => {
    expect(
      matchIdleAgentCleanupSignature('find /Users/dev/.claude/projects -name "*.jsonl"')
    ).toEqual(expect.objectContaining({ agentName: 'Claude Code' }))
  })

  it('returns null for a command line matching no registered substring', () => {
    expect(matchIdleAgentCleanupSignature('vim notes.txt')).toBeNull()
  })

  // Case-sensitivity is a real false-negative risk (spec §8) — documented, not accidental.
  it('is case-sensitive, so a differently-cased agent token does not match', () => {
    expect(matchIdleAgentCleanupSignature('node /usr/local/bin/CLAUDE --resume')).toBeNull()
  })
})

describe('matchIdleAgentCleanupCandidate', () => {
  it("returns the candidate's own signature without needing the pane root to match", () => {
    // Pane root deliberately matches a DIFFERENT signature (Codex) to prove the
    // candidate's own match takes precedence and the root is not consulted.
    const result = matchIdleAgentCleanupCandidate(
      'node /usr/local/bin/claude --resume',
      'node /usr/local/bin/codex'
    )
    expect(result?.agentName).toBe('Claude Code')
  })

  it("falls back to the pane's root shell/agent command line when the candidate's own command line matches nothing (the find.exe incident case)", () => {
    const result = matchIdleAgentCleanupCandidate(
      'find . -iname "*.md"',
      'node /usr/local/bin/claude'
    )
    expect(result?.agentName).toBe('Claude Code')
  })

  it('returns null when neither the candidate nor the pane root command line matches any signature', () => {
    expect(matchIdleAgentCleanupCandidate('find . -iname "*.md"', 'bash -l')).toBeNull()
  })
})

// Architecture §2's adversarial false-positive review: common process names/paths
// that must NOT match any registered signature as a standalone command line.
describe('matchIdleAgentCleanupSignature adversarial false positives (architecture §2)', () => {
  it.each([
    ['pip install requests', 'pip'],
    ['spin up the dev server', 'spin (contains "pi" as a false pi-substring risk)'],
    ['optimize --level=3 build/', 'optimize'],
    ['rg TODO src/', 'rg'],
    ['grep -r TODO src/', 'grep'],
    ['find . -iname "*.tmp"', 'find'],
    ['node server.js', 'node'],
    ['python script.py', 'python'],
    ['git status', 'git'],
    ['bash', 'bare bash invocation'],
    ['pwsh', 'bare pwsh invocation'],
    ['cmd.exe', 'bare cmd.exe invocation']
  ])('does not match %s (%s)', (commandLine) => {
    expect(matchIdleAgentCleanupSignature(commandLine)).toBeNull()
  })

  // Known, accepted match per architecture §2 — NOT a bug. A search tool whose
  // search term or path is literally the agent name is indistinguishable, at the
  // command-line-substring level, from the agent's own orphaned process; the
  // scope (orphaned + Orca-pane-descendant-only) bounds the blast radius.
  it('DOES match a grep/rg invocation whose search term is literally "claude" (accepted, documented false-positive risk)', () => {
    expect(matchIdleAgentCleanupSignature('rg claude .')?.agentName).toBe('Claude Code')
  })

  it('DOES match a grep/rg invocation whose search term is literally "codex" (accepted, documented false-positive risk)', () => {
    expect(matchIdleAgentCleanupSignature('grep -r codex src')?.agentName).toBe('Codex')
  })
})

// Sanity check that the registry itself is non-empty and shaped as expected —
// guards against an accidental empty-array refactor silently disabling detection.
describe('IDLE_AGENT_CLEANUP_SIGNATURES', () => {
  it('registers at least the four known agent CLIs', () => {
    const names = IDLE_AGENT_CLEANUP_SIGNATURES.map((signature) => signature.agentName)
    expect(names).toEqual(expect.arrayContaining(['Claude Code', 'Codex', 'Pi', 'Prime Agent']))
  })
})
