import { useMemo, useRef } from 'react'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  applyAppends,
  createIncrementalAssembler,
  reset as resetAssembler
} from './native-chat-incremental-assembler'
import { prepareNativeChatLiveMessages } from './native-chat-live-message-preparation'

function sharesPrefix(
  whole: readonly NativeChatMessage[],
  prefix: readonly NativeChatMessage[],
  length: number
): boolean {
  for (let index = 0; index < length; index += 1) {
    if (whole[index] !== prefix[index]) {
      return false
    }
  }
  return true
}

/** Keeps transcript assembly off the status-only render axis. */
export function useNativeChatAssembledMessages(args: {
  agent: AgentType
  sessionId: string | null
  baseMessages: readonly NativeChatMessage[]
  appended: NativeChatMessage[]
}): { assembledMessages: NativeChatMessage[]; normalizedMessages: NativeChatMessage[] } {
  const assemblerRef = useRef(createIncrementalAssembler())
  const appliedTranscriptRef = useRef<readonly NativeChatMessage[]>([])
  const baseSignatureRef = useRef<string | null>(null)
  const baseMessagesRef = useRef<readonly NativeChatMessage[]>([])
  const { agent, sessionId, baseMessages, appended } = args

  const assembledMessages = useMemo(() => {
    const transcript =
      appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
    const baseSignature = `${agent}\u0000${sessionId ?? ''}`
    const baseChanged =
      baseSignature !== baseSignatureRef.current || baseMessages !== baseMessagesRef.current
    const applied = appliedTranscriptRef.current
    const isSuffixExtension =
      !baseChanged &&
      transcript.length >= applied.length &&
      sharesPrefix(transcript, applied, applied.length)

    const assembled = isSuffixExtension
      ? transcript.length > applied.length
        ? applyAppends(assemblerRef.current, transcript.slice(applied.length))
        : assemblerRef.current.messages
      : resetAssembler(assemblerRef.current, transcript)
    baseSignatureRef.current = baseSignature
    baseMessagesRef.current = baseMessages
    appliedTranscriptRef.current = transcript
    return assembled
  }, [agent, appended, baseMessages, sessionId])

  const normalizedMessages = useMemo(
    () => prepareNativeChatLiveMessages(assembledMessages, agent),
    [agent, assembledMessages]
  )
  return { assembledMessages, normalizedMessages }
}
