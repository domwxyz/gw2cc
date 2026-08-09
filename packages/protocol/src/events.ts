import type { Gw2ccEvent } from '@gw2cc/core';
import { z } from 'zod';
import { conversationMessageSchema, errorSchema, persistedToolCallSchema } from './schemas';

export const gw2ccEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat.started'),
    runId: z.string(),
    conversationId: z.string(),
    userMessage: conversationMessageSchema,
    assistantMessage: conversationMessageSchema
  }),
  z.object({
    type: z.literal('chat.textDelta'),
    runId: z.string(),
    messageId: z.string(),
    delta: z.string()
  }),
  z.object({
    type: z.literal('chat.reasoningDelta'),
    runId: z.string(),
    messageId: z.string(),
    delta: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    type: z.literal('chat.toolStarted'),
    runId: z.string(),
    messageId: z.string(),
    toolCall: persistedToolCallSchema
  }),
  z.object({
    type: z.literal('chat.toolCompleted'),
    runId: z.string(),
    messageId: z.string(),
    toolCall: persistedToolCallSchema,
    summary: z.string()
  }),
  z.object({ type: z.literal('chat.completed'), runId: z.string(), message: conversationMessageSchema }),
  z.object({ type: z.literal('chat.cancelled'), runId: z.string(), message: conversationMessageSchema }),
  z.object({
    type: z.literal('chat.failed'),
    runId: z.string(),
    message: conversationMessageSchema,
    error: errorSchema
  })
]);

export function parseGw2ccEvent(event: unknown): Gw2ccEvent {
  return gw2ccEventSchema.parse(event) as Gw2ccEvent;
}
