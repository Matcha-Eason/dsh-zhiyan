import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export const contextSchema = z.object({
  revision: z.number().int(),
  messages: z.array(z.object({
    seq: z.number().int(),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  })),
})

export type PreviewContext = z.infer<typeof contextSchema>

// DSH's compiled SDK pins a Zod minor in its type. The registry only calls parse();
// keep this package on patched Zod without inheriting the SDK's older runtime.
const projectionSchema = contextSchema as unknown as ProjectionDefinition<'keyboardDuplex'>['stateSchema']

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { keyboardDuplex: PreviewContext }
  interface SessionProjectionMap { keyboardDuplex: PreviewContext }
}

/** Bounded committed text; no tool results, reasoning blocks, or unsent drafts are persisted here. */
export const contextProjection = {
  key: 'keyboardDuplex',
  stateVersion: 1,
  stateSchema: projectionSchema,
  init: () => ({ revision: -1, messages: [] }),
  apply(state, event) {
    let messages = state.messages
    // Compaction/replacement invalidates the cached window. Never reuse shadowed text.
    if ('surfaceOp' in event && typeof event.surfaceOp === 'object') messages = []
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      const content = event.type === 'user/message' ? event.data.content : event.data.message.content
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(-1_200)
      if (text.trim()) messages = [...messages, {
        seq: event.seq,
        role: event.type === 'user/message' ? 'user' as const : 'assistant' as const,
        text,
      }].slice(-6)
      return { revision: event.seq, messages }
    }
    if (messages !== state.messages || event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'model/selection' || event.type === 'request/header') {
      return { revision: event.seq, messages }
    }
    return state
  },
  wire: { viewSchema: projectionSchema, view: state => state },
} satisfies ProjectionDefinition<'keyboardDuplex'>
