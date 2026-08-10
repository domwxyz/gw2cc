import type {
  BootstrapPayload,
  ChatSendResult,
  ConversationAttachment,
  ConversationDetail,
  ConversationSummary,
  EquippedItem,
  Gw2ccErrorPayload,
  Gw2ccApplication,
  ProviderSettingsView,
  ProviderTestResult,
  ResearchSettingsView,
  ResearchTestResult
} from '@gw2cc/core';
import { Gw2ccError, toErrorPayload } from '@gw2cc/core';
import { z } from 'zod';
import {
  bootstrapSchema,
  conversationAttachmentsSchema,
  conversationDetailSchema,
  conversationSummarySchema,
  equippedItemSchema,
  errorSchema,
  providerSettingsSchema,
  researchSettingsSchema
} from './schemas';

export interface CommandMap {
  'app.bootstrap': { input: Record<string, never>; output: BootstrapPayload };
  'app.openExternal': { input: { url: string }; output: { opened: true } };
  'gw2.connection.get': { input: Record<string, never>; output: BootstrapPayload };
  'gw2.connection.setKey': { input: { apiKey: string }; output: BootstrapPayload };
  'gw2.connection.test': { input: Record<string, never>; output: BootstrapPayload };
  'gw2.connection.disconnect': { input: Record<string, never>; output: BootstrapPayload };
  'characters.select': { input: { name: string }; output: BootstrapPayload };
  'characters.refresh': { input: Record<string, never>; output: BootstrapPayload };
  'equipment.inspectItem': { input: { itemId: number }; output: EquippedItem };
  'instructions.set': { input: { value: string }; output: { value: string } };
  'characters.lore.set': { input: { value: string }; output: { value: string } };
  'provider.settings.get': { input: Record<string, never>; output: ProviderSettingsView };
  'provider.settings.update': {
    input: {
      providerId: 'openrouter' | 'openai-compatible' | 'anthropic' | 'ollama';
      model: string;
      baseUrl?: string;
      toolsEnabled: boolean;
      maxTokensEnabled?: boolean;
      maxTokens?: number;
      temperature?: number;
      apiKey?: string;
      clearApiKey?: boolean;
    };
    output: ProviderSettingsView;
  };
  'provider.test': { input: Record<string, never>; output: ProviderTestResult };
  'provider.models': { input: Record<string, never>; output: Array<{ id: string; name?: string }> };
  'research.settings.get': { input: Record<string, never>; output: ResearchSettingsView };
  'research.settings.setKey': { input: { apiKey: string }; output: ResearchSettingsView };
  'research.settings.test': { input: Record<string, never>; output: ResearchTestResult };
  'research.settings.clear': { input: Record<string, never>; output: ResearchSettingsView };
  'conversations.list': { input: Record<string, never>; output: ConversationSummary[] };
  'conversations.search': { input: { query: string }; output: ConversationSummary[] };
  'conversations.create': { input: { title?: string }; output: ConversationDetail };
  'conversations.get': { input: { id?: string }; output: ConversationDetail };
  'conversations.select': { input: { id: string }; output: ConversationDetail };
  'conversations.rename': { input: { id: string; title: string }; output: ConversationDetail };
  'conversations.setPinned': { input: { id: string; isPinned: boolean }; output: ConversationDetail };
  'conversations.delete': { input: { id: string }; output: ConversationDetail };
  'conversations.fork': { input: { id: string; messageId: string }; output: ConversationDetail };
  'chat.send': {
    input: { content: string; conversationId?: string; attachments?: ConversationAttachment[] };
    output: ChatSendResult;
  };
  'chat.cancel': { input: { runId: string }; output: { cancelled: boolean } };
  'chat.retry': { input: { messageId: string }; output: ChatSendResult };
  'chat.edit': { input: { messageId: string; content: string }; output: ChatSendResult };
}

export type CommandName = keyof CommandMap;
export type CommandInput<T extends CommandName> = CommandMap[T]['input'];
export type CommandOutput<T extends CommandName> = CommandMap[T]['output'];

const emptyInput = z.object({}).strict();
const commandNames = [
  'app.bootstrap',
  'app.openExternal',
  'gw2.connection.get',
  'gw2.connection.setKey',
  'gw2.connection.test',
  'gw2.connection.disconnect',
  'characters.select',
  'characters.refresh',
  'equipment.inspectItem',
  'instructions.set',
  'characters.lore.set',
  'provider.settings.get',
  'provider.settings.update',
  'provider.test',
  'provider.models',
  'research.settings.get',
  'research.settings.setKey',
  'research.settings.test',
  'research.settings.clear',
  'conversations.list',
  'conversations.search',
  'conversations.create',
  'conversations.get',
  'conversations.select',
  'conversations.rename',
  'conversations.setPinned',
  'conversations.delete',
  'conversations.fork',
  'chat.send',
  'chat.cancel',
  'chat.retry',
  'chat.edit'
] as const;

export const commandNameSchema = z.enum(commandNames);

const definitions: Record<CommandName, { input: z.ZodType; output: z.ZodType }> = {
  'app.bootstrap': { input: emptyInput, output: bootstrapSchema },
  'app.openExternal': {
    input: z.object({ url: z.url() }).strict(),
    output: z.object({ opened: z.literal(true) })
  },
  'gw2.connection.get': { input: emptyInput, output: bootstrapSchema },
  'gw2.connection.setKey': {
    input: z.object({ apiKey: z.string().trim().min(1).max(512) }).strict(),
    output: bootstrapSchema
  },
  'gw2.connection.test': { input: emptyInput, output: bootstrapSchema },
  'gw2.connection.disconnect': { input: emptyInput, output: bootstrapSchema },
  'characters.select': {
    input: z.object({ name: z.string().trim().min(1).max(128) }).strict(),
    output: bootstrapSchema
  },
  'characters.refresh': { input: emptyInput, output: bootstrapSchema },
  'equipment.inspectItem': {
    input: z.object({ itemId: z.number().int().positive() }).strict(),
    output: equippedItemSchema
  },
  'instructions.set': {
    input: z.object({ value: z.string().max(40_000) }).strict(),
    output: z.object({ value: z.string() })
  },
  'characters.lore.set': {
    input: z.object({ value: z.string().max(40_000) }).strict(),
    output: z.object({ value: z.string() })
  },
  'provider.settings.get': { input: emptyInput, output: providerSettingsSchema },
  'provider.settings.update': {
    input: z.object({
      providerId: z.enum(['openrouter', 'openai-compatible', 'anthropic', 'ollama']),
      model: z.string().trim().max(256),
      baseUrl: z.string().trim().max(2_000).optional(),
      toolsEnabled: z.boolean(),
      maxTokensEnabled: z.boolean().optional(),
      maxTokens: z.number().int().min(128).max(16_384).optional(),
      temperature: z.number().min(0).max(2).optional(),
      apiKey: z.string().trim().min(1).max(4_096).optional(),
      clearApiKey: z.boolean().optional()
    }).strict(),
    output: providerSettingsSchema
  },
  'provider.test': {
    input: emptyInput,
    output: z.object({
      ok: z.literal(true),
      providerId: z.enum(['openrouter', 'openai-compatible', 'anthropic', 'ollama', 'fixture']),
      model: z.string(),
      models: z.array(z.object({ id: z.string(), name: z.string().optional() })),
      capabilities: z.object({ streaming: z.literal(true), tools: z.boolean() }),
      message: z.string()
    })
  },
  'provider.models': {
    input: emptyInput,
    output: z.array(z.object({ id: z.string(), name: z.string().optional() }))
  },
  'research.settings.get': { input: emptyInput, output: researchSettingsSchema },
  'research.settings.setKey': {
    input: z.object({ apiKey: z.string().trim().min(1).max(4_096) }).strict(),
    output: researchSettingsSchema
  },
  'research.settings.test': {
    input: emptyInput,
    output: z.object({ ok: z.literal(true), resultCount: z.number().int().nonnegative(), message: z.string() })
  },
  'research.settings.clear': { input: emptyInput, output: researchSettingsSchema },
  'conversations.list': { input: emptyInput, output: z.array(conversationSummarySchema) },
  'conversations.search': {
    input: z.object({ query: z.string().trim().min(1).max(200) }).strict(),
    output: z.array(conversationSummarySchema)
  },
  'conversations.create': {
    input: z.object({ title: z.string().trim().min(1).max(200).optional() }).strict(),
    output: conversationDetailSchema
  },
  'conversations.get': {
    input: z.object({ id: z.string().min(1).max(200).optional() }).strict(),
    output: conversationDetailSchema
  },
  'conversations.select': {
    input: z.object({ id: z.string().min(1).max(200) }).strict(),
    output: conversationDetailSchema
  },
  'conversations.rename': {
    input: z.object({ id: z.string().min(1).max(200), title: z.string().trim().min(1).max(200) }).strict(),
    output: conversationDetailSchema
  },
  'conversations.setPinned': {
    input: z.object({ id: z.string().min(1).max(200), isPinned: z.boolean() }).strict(),
    output: conversationDetailSchema
  },
  'conversations.delete': {
    input: z.object({ id: z.string().min(1).max(200) }).strict(),
    output: conversationDetailSchema
  },
  'conversations.fork': {
    input: z.object({ id: z.string().min(1).max(200), messageId: z.string().min(1).max(200) }).strict(),
    output: conversationDetailSchema
  },
  'chat.send': {
    input: z.object({
      content: z.string().max(40_000),
      conversationId: z.string().min(1).max(200).optional(),
      attachments: conversationAttachmentsSchema.optional()
    }).strict().superRefine((input, context) => {
      if (!input.content.trim() && !input.attachments?.length) {
        context.addIssue({ code: 'custom', path: ['content'], message: 'Enter a message or attach a file before sending.' });
      }
    }),
    output: z.object({
      runId: z.string(), conversationId: z.string(), userMessageId: z.string(), assistantMessageId: z.string()
    })
  },
  'chat.cancel': {
    input: z.object({ runId: z.string().min(1).max(200) }).strict(),
    output: z.object({ cancelled: z.boolean() })
  },
  'chat.retry': {
    input: z.object({ messageId: z.string().min(1).max(200) }).strict(),
    output: z.object({
      runId: z.string(), conversationId: z.string(), userMessageId: z.string(), assistantMessageId: z.string()
    })
  },
  'chat.edit': {
    input: z.object({ messageId: z.string().min(1).max(200), content: z.string().max(40_000) }).strict(),
    output: z.object({
      runId: z.string(), conversationId: z.string(), userMessageId: z.string(), assistantMessageId: z.string()
    })
  }
};

export const requestEnvelopeSchema = z.object({
  command: commandNameSchema,
  input: z.unknown()
}).strict();

export const responseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), output: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict()
]);

export type ProtocolResponse =
  | { ok: true; output: unknown }
  | { ok: false; error: Gw2ccErrorPayload };

export async function handleProtocolRequest(
  application: Gw2ccApplication,
  request: unknown,
  adapters: { openExternal(url: string): Promise<void> }
): Promise<ProtocolResponse> {
  try {
    const envelope = requestEnvelopeSchema.parse(request);
    const input = definitions[envelope.command].input.parse(envelope.input) as any;
    let output: unknown;
    switch (envelope.command) {
      case 'app.bootstrap':
        output = await application.bootstrap(true);
        break;
      case 'gw2.connection.get':
        output = await application.bootstrap();
        break;
      case 'gw2.connection.setKey':
        output = await application.connect(input.apiKey);
        break;
      case 'gw2.connection.test':
        output = await application.testConnection();
        break;
      case 'gw2.connection.disconnect':
        output = await application.disconnect();
        break;
      case 'characters.select':
        output = await application.selectCharacter(input.name);
        break;
      case 'characters.refresh':
        output = await application.refreshCharacter();
        break;
      case 'equipment.inspectItem':
        output = await application.characters.inspectItem(input.itemId);
        break;
      case 'instructions.set':
        output = { value: await application.context.setGlobalInstructions(input.value) };
        break;
      case 'characters.lore.set':
        output = { value: await application.context.setSelectedLore(input.value) };
        break;
      case 'provider.settings.get':
        output = await application.providers.getView();
        break;
      case 'provider.settings.update':
        output = await application.providers.update(input);
        break;
      case 'provider.test':
        output = await application.providers.test();
        break;
      case 'provider.models':
        output = await application.providers.listModels();
        break;
      case 'research.settings.get':
        output = await application.research.getView();
        break;
      case 'research.settings.setKey':
        output = await application.research.setCredential(input.apiKey);
        break;
      case 'research.settings.test':
        output = await application.research.test();
        break;
      case 'research.settings.clear':
        output = await application.research.clearCredential();
        break;
      case 'conversations.list':
        output = await application.conversations.list();
        break;
      case 'conversations.search':
        output = await application.conversations.search(input.query);
        break;
      case 'conversations.create':
        output = await application.conversations.create(input.title);
        break;
      case 'conversations.get':
        output = input.id
          ? await application.conversations.get(input.id)
          : await application.conversations.getPrimary();
        break;
      case 'conversations.select':
        output = await application.conversations.select(input.id);
        break;
      case 'conversations.rename':
        output = await application.conversations.rename(input.id, input.title);
        break;
      case 'conversations.setPinned':
        output = await application.conversations.setPinned(input.id, input.isPinned);
        break;
      case 'conversations.delete':
        output = await application.conversations.delete(input.id);
        break;
      case 'conversations.fork':
        output = await application.conversations.fork(input.id, input.messageId);
        break;
      case 'chat.send':
        output = await application.chat.send(input.content, input.conversationId, input.attachments);
        break;
      case 'chat.cancel':
        output = await application.chat.cancel(input.runId);
        break;
      case 'chat.retry':
        output = await application.chat.retry(input.messageId);
        break;
      case 'chat.edit':
        output = await application.chat.edit(input.messageId, input.content);
        break;
      case 'app.openExternal': {
        const url = new URL(input.url);
        if (url.protocol !== 'https:' || url.hostname !== 'wiki.guildwars2.com') {
          throw new Gw2ccError('VALIDATION_ERROR', 'Only Guild Wars 2 Wiki links may be opened from the inspector.');
        }
        await adapters.openExternal(url.toString());
        output = { opened: true };
        break;
      }
    }
    return { ok: true, output: definitions[envelope.command].output.parse(output) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The application command was invalid.',
          retryable: false,
          details: { issues: error.issues.slice(0, 5).map((issue) => issue.message) }
        }
      };
    }
    return { ok: false, error: toErrorPayload(error) };
  }
}

export function parseCommandOutput<T extends CommandName>(command: T, output: unknown): CommandOutput<T> {
  return definitions[command].output.parse(output) as CommandOutput<T>;
}
