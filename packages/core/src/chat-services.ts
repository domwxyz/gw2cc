import type {
  ChatBootstrapPayload,
  ChatSendResult,
  ConversationDetail,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
  Gw2ccEvent,
  LlmMessage,
  PersistedToolCall,
  ProviderConfiguration,
  ProviderConfigurationInput,
  ProviderId,
  ProviderRuntimeConfiguration,
  ProviderSettingsView,
  ProviderTestResult,
  UserConfigurableProviderId
} from './chat-domain';
import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  USER_CONFIGURABLE_PROVIDER_IDS
} from './chat-domain';
import { Gw2ccError, toErrorPayload } from './errors';
import type {
  AccountRepository,
  Clock,
  ConversationRepository,
  LlmProvider,
  LlmProviderRegistry,
  SecretKey,
  SecretStore,
  SettingsRepository,
  ToolExecutor
} from './ports';
import { assemblePrompt, frameToolResult, redactSensitive } from './prompt';
import type { CharacterService, ContextService } from './services';

const PROVIDER_CONFIGURATION_KEY = 'llm-provider-configuration';
const ACTIVE_CONVERSATION_KEY = 'active-conversation-id';
const MAX_CONSECUTIVE_IDENTICAL_TOOL_ROUNDS = 3;
const MAX_REASONING_TRACE_CHARS = 262_144;
const DEFAULT_CONVERSATION_TITLES = new Set(['Account-wide chat', 'New conversation']);
const TOKEN_LIMIT_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

function titleFromFirstMessage(content: string): string {
  const normalized = content
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61).trimEnd()}...`;
}

function normalizeAttachments(attachments: readonly ConversationAttachment[]): ConversationAttachment[] {
  if (attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Gw2ccError('VALIDATION_ERROR', `Attach no more than ${MAX_MESSAGE_ATTACHMENTS} files to one message.`);
  }
  let totalBytes = 0;
  return attachments.map((attachment) => {
    const name = attachment.name.trim();
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    const expectedMediaType = extension === '.md' ? 'text/markdown' : extension === '.txt' ? 'text/plain' : undefined;
    const contentBytes = new TextEncoder().encode(attachment.content).byteLength;
    if (!name || name.length > 255 || !expectedMediaType || attachment.mediaType !== expectedMediaType) {
      throw new Gw2ccError('VALIDATION_ERROR', 'Only .txt and .md text attachments are supported.');
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 ||
        attachment.size > MAX_TEXT_ATTACHMENT_BYTES || contentBytes > MAX_TEXT_ATTACHMENT_BYTES) {
      throw new Gw2ccError('VALIDATION_ERROR', `Each attachment must be ${MAX_TEXT_ATTACHMENT_BYTES / 1_000} KB or smaller.`);
    }
    if (attachment.content.includes('\0')) {
      throw new Gw2ccError('VALIDATION_ERROR', `${name} does not appear to be a plain-text file.`);
    }
    totalBytes += Math.max(attachment.size, contentBytes);
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Gw2ccError('VALIDATION_ERROR', `Attachments may total no more than ${MAX_TOTAL_ATTACHMENT_BYTES / 1_000} KB.`);
    }
    return { ...attachment, name };
  });
}

function normalizeProviderEvent(value: unknown): import('./chat-domain').LlmEvent {
  if (!value || typeof value !== 'object') {
    throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'The LLM provider returned a malformed stream event.', { retryable: true });
  }
  const event = value as Record<string, unknown>;
  if (event.type === 'text_delta' && typeof event.delta === 'string' && event.delta.length <= 65_536) {
    return { type: 'text_delta', delta: event.delta };
  }
  if (event.type === 'reasoning_delta' && typeof event.delta === 'string' && event.delta.length <= 65_536) {
    return { type: 'reasoning_delta', delta: event.delta };
  }
  if (event.type === 'tool_call' && event.call && typeof event.call === 'object') {
    const call = event.call as Record<string, unknown>;
    if (typeof call.id === 'string' && call.id.length <= 500 &&
        typeof call.name === 'string' && /^[a-zA-Z0-9_]{1,128}$/.test(call.name) &&
        'arguments' in call) {
      return { type: 'tool_call', call: { id: call.id, name: call.name, arguments: call.arguments } };
    }
  }
  if (event.type === 'usage') {
    const tokenCount = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.floor(candidate)
      : undefined;
    const inputTokens = tokenCount(event.inputTokens);
    const outputTokens = tokenCount(event.outputTokens);
    const reasoningTokens = tokenCount(event.reasoningTokens);
    return {
      type: 'usage',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
    };
  }
  if (event.type === 'completed' && (event.finishReason === undefined || typeof event.finishReason === 'string')) {
    return { type: 'completed', ...(typeof event.finishReason === 'string' ? { finishReason: event.finishReason.slice(0, 200) } : {}) };
  }
  throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'The LLM provider returned a malformed stream event.', { retryable: true });
}

function normalizeToolOutcome(value: unknown): import('./chat-domain').ToolExecutionOutcome {
  if (value && typeof value === 'object') {
    const outcome = value as Record<string, unknown>;
    if (typeof outcome.ok === 'boolean' && 'value' in outcome &&
        typeof outcome.summary === 'string' && outcome.summary.length <= 2_000 &&
        typeof outcome.truncated === 'boolean') {
      return {
        ok: outcome.ok,
        value: outcome.value,
        summary: outcome.summary,
        truncated: outcome.truncated
      };
    }
  }
  const error = {
    code: 'VALIDATION_ERROR' as const,
    message: 'A read-only tool returned a malformed response.',
    retryable: false
  };
  return { ok: false, value: { ok: false, error }, summary: error.message, truncated: false };
}

const DEFAULT_BASE_URLS: Record<UserConfigurableProviderId, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  ollama: 'http://127.0.0.1:11434'
};

function secretKeyFor(providerId: ProviderId): SecretKey | undefined {
  switch (providerId) {
    case 'openrouter': return 'openrouter-api-key';
    case 'openai-compatible': return 'openai-compatible-api-key';
    case 'anthropic': return 'anthropic-api-key';
    case 'ollama': return 'ollama-api-key';
    case 'fixture': return undefined;
  }
}

function credentialRequired(providerId: ProviderId): boolean {
  return providerId === 'openrouter' || providerId === 'anthropic';
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Gw2ccError('VALIDATION_ERROR', 'Enter a valid provider base URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Gw2ccError('VALIDATION_ERROR', 'Provider base URLs must use HTTP(S) without credentials, query data, or fragments.');
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeConfiguration(value: unknown, fixtureMode: boolean): ProviderConfiguration {
  if (fixtureMode) {
    return {
      providerId: 'fixture',
      model: 'fixture-gw2-assistant',
      toolsEnabled: true,
      maxTokensEnabled: false,
      maxTokens: 1024
    };
  }
  const candidate = value && typeof value === 'object' ? value as Partial<ProviderConfiguration> : {};
  const providerId = USER_CONFIGURABLE_PROVIDER_IDS.includes(candidate.providerId as UserConfigurableProviderId)
    ? candidate.providerId as UserConfigurableProviderId
    : 'openrouter';
  return {
    providerId,
    model: typeof candidate.model === 'string' ? candidate.model.trim().slice(0, 256) : '',
    baseUrl: validateBaseUrl(
      typeof candidate.baseUrl === 'string' && candidate.baseUrl.trim()
        ? candidate.baseUrl.trim()
        : DEFAULT_BASE_URLS[providerId]
    ),
    toolsEnabled: candidate.toolsEnabled !== false,
    maxTokensEnabled: candidate.maxTokensEnabled === true,
    maxTokens: typeof candidate.maxTokens === 'number'
      ? Math.min(16_384, Math.max(128, Math.round(candidate.maxTokens)))
      : 2048,
    ...(typeof candidate.temperature === 'number'
      ? { temperature: Math.min(2, Math.max(0, candidate.temperature)) }
      : {})
  };
}

export class ProviderSettingsService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly secrets: SecretStore,
    private readonly providers: LlmProviderRegistry,
    private readonly fixtureMode: boolean
  ) {}

  async getView(): Promise<ProviderSettingsView> {
    const configuration = await this.getConfiguration();
    const key = secretKeyFor(configuration.providerId);
    const credentialConfigured = key ? (await this.secrets.status(key)).configured : true;
    const required = credentialRequired(configuration.providerId);
    const ready = Boolean(configuration.model) && (!required || credentialConfigured);
    return {
      configuration,
      credentialConfigured,
      credentialRequired: required,
      ready,
      capabilities: { streaming: true, tools: configuration.toolsEnabled },
      availableProviders: USER_CONFIGURABLE_PROVIDER_IDS,
      ...(!configuration.model
        ? { message: 'Choose a model before sending a message.' }
        : required && !credentialConfigured
          ? { message: 'Save this provider\'s API key before sending a message.' }
          : !configuration.toolsEnabled
            ? { message: 'Live GW2 and web retrieval are disabled for this model; ordinary chat remains available.' }
            : {})
    };
  }

  async update(input: ProviderConfigurationInput): Promise<ProviderSettingsView> {
    if (this.fixtureMode) return this.getView();
    const providerId = input.providerId;
    const configuration = normalizeConfiguration({
      providerId,
      model: input.model,
      baseUrl: input.baseUrl?.trim() || DEFAULT_BASE_URLS[providerId],
      toolsEnabled: input.toolsEnabled,
      maxTokensEnabled: input.maxTokensEnabled,
      maxTokens: input.maxTokens,
      temperature: input.temperature
    }, false);
    const key = secretKeyFor(providerId)!;
    if (input.clearApiKey) await this.secrets.delete(key);
    if (input.apiKey?.trim()) await this.secrets.set(key, input.apiKey.trim());
    await this.settings.set(PROVIDER_CONFIGURATION_KEY, configuration);
    return this.getView();
  }

  async test(): Promise<ProviderTestResult> {
    const { provider, configuration } = await this.resolveActive();
    const models = await this.loadModels(provider, configuration);
    if (models.length > 0 && !models.some((model) => model.id === configuration.model)) {
      throw new Gw2ccError('LLM_MODEL_NOT_FOUND', `Model “${configuration.model}” was not found at this provider.`);
    }
    return {
      ok: true,
      providerId: configuration.providerId,
      model: configuration.model,
      models,
      capabilities: { streaming: true, tools: configuration.toolsEnabled },
      message: models.length > 0
        ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`
        : 'Connected. The configured endpoint did not publish a model catalog.'
    };
  }

  async listModels(): Promise<import('./chat-domain').ModelInfo[]> {
    const { provider, configuration } = await this.resolveConfigured(false);
    return this.loadModels(provider, configuration);
  }

  async resolveActive(): Promise<{ provider: LlmProvider; configuration: ProviderRuntimeConfiguration }> {
    return this.resolveConfigured(true);
  }

  private async loadModels(
    provider: LlmProvider,
    configuration: ProviderRuntimeConfiguration
  ): Promise<import('./chat-domain').ModelInfo[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const catalog = await provider.listModels(configuration, controller.signal);
      const unique = new Map<string, import('./chat-domain').ModelInfo>();
      for (const entry of catalog) {
        const id = entry.id.trim();
        if (!id || unique.has(id)) continue;
        unique.set(id, { id, ...(entry.name?.trim() ? { name: entry.name.trim() } : {}) });
      }
      return [...unique.values()]
        .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))
        .slice(0, 500);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveConfigured(requireModel: boolean): Promise<{
    provider: LlmProvider;
    configuration: ProviderRuntimeConfiguration;
  }> {
    const view = await this.getView();
    if (requireModel && !view.configuration.model) {
      throw new Gw2ccError('LLM_MODEL_NOT_FOUND', 'Choose an LLM model in Settings before sending a message.');
    }
    const provider = this.providers.get(view.configuration.providerId);
    if (!provider) throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'The configured LLM provider is unavailable.');
    const key = secretKeyFor(view.configuration.providerId);
    const apiKey = key ? await this.secrets.get(key) : null;
    if (credentialRequired(view.configuration.providerId) && !apiKey) {
      throw new Gw2ccError('LLM_KEY_MISSING', 'Save an API key for the selected provider before sending a message.');
    }
    return {
      provider,
      configuration: {
        ...view.configuration,
        ...(apiKey ? { apiKey } : {})
      }
    };
  }

  private async getConfiguration(): Promise<ProviderConfiguration> {
    return normalizeConfiguration(
      await this.settings.get<unknown>(PROVIDER_CONFIGURATION_KEY),
      this.fixtureMode
    );
  }
}

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly settings: SettingsRepository,
    private readonly clock: Clock,
    private readonly createId: () => string
  ) {}

  async getPrimary(): Promise<ConversationDetail> {
    const activeId = await this.settings.get<string>(ACTIVE_CONVERSATION_KEY);
    if (activeId) {
      const active = await this.repository.get(activeId);
      if (active) return active;
    }
    const existing = (await this.repository.list())[0];
    if (existing) {
      await this.settings.set(ACTIVE_CONVERSATION_KEY, existing.id);
      return (await this.repository.get(existing.id))!;
    }
    return this.create();
  }

  async list(): Promise<import('./chat-domain').ConversationSummary[]> {
    return this.repository.list();
  }

  async search(query: string): Promise<ConversationSummary[]> {
    return this.repository.search(query);
  }

  async create(title?: string): Promise<ConversationDetail> {
    const now = this.clock.now();
    const conversation = {
      id: this.createId(),
      title: title?.trim() || 'New conversation',
      isPinned: false,
      createdAt: now,
      updatedAt: now
    };
    await this.repository.create(conversation);
    await this.settings.set(ACTIVE_CONVERSATION_KEY, conversation.id);
    return { ...conversation, messages: [], toolCalls: [] };
  }

  async get(id: string): Promise<ConversationDetail> {
    const conversation = await this.repository.get(id);
    if (!conversation) throw new Gw2ccError('VALIDATION_ERROR', 'The requested conversation does not exist.');
    return conversation;
  }

  async select(id: string): Promise<ConversationDetail> {
    const conversation = await this.get(id);
    await this.settings.set(ACTIVE_CONVERSATION_KEY, id);
    return conversation;
  }

  async rename(id: string, title: string): Promise<ConversationDetail> {
    const trimmed = title.trim();
    if (!trimmed) throw new Gw2ccError('VALIDATION_ERROR', 'Conversation titles cannot be empty.');
    const conversation = await this.get(id);
    const updated = {
      ...conversation,
      title: trimmed.slice(0, 200),
      updatedAt: this.clock.now()
    };
    await this.repository.updateSummary(updated);
    return updated;
  }

  async setPinned(id: string, isPinned: boolean): Promise<ConversationDetail> {
    const conversation = await this.get(id);
    const updated = { ...conversation, isPinned };
    await this.repository.updateSummary(updated);
    return updated;
  }

  async delete(id: string): Promise<ConversationDetail> {
    await this.get(id);
    const activeId = await this.settings.get<string>(ACTIVE_CONVERSATION_KEY);
    await this.repository.delete(id);
    if (activeId === id) await this.settings.set(ACTIVE_CONVERSATION_KEY, '');
    return this.getPrimary();
  }

  async fork(id: string, messageId: string): Promise<ConversationDetail> {
    const source = await this.get(id);
    const cutoff = source.messages.findIndex((message) => message.id === messageId);
    if (cutoff < 0) throw new Gw2ccError('VALIDATION_ERROR', 'The fork point does not exist in this conversation.');

    const now = this.clock.now();
    const titleRoot = (source.title?.trim() || 'Conversation').replace(/\s+\(fork\)$/i, '');
    const summary: ConversationSummary = {
      id: this.createId(),
      title: `${titleRoot.slice(0, 190)} (fork)`,
      isPinned: false,
      createdAt: now,
      updatedAt: now
    };
    await this.repository.create(summary);

    const copiedMessageIds = new Map<string, string>();
    for (const message of source.messages.slice(0, cutoff + 1)) {
      const copiedId = this.createId();
      copiedMessageIds.set(message.id, copiedId);
      await this.repository.addMessage({
        ...message,
        id: copiedId,
        conversationId: summary.id,
        status: message.status === 'streaming' ? 'complete' : message.status
      });
    }
    for (const toolCall of source.toolCalls) {
      const copiedMessageId = copiedMessageIds.get(toolCall.messageId);
      if (!copiedMessageId) continue;
      await this.repository.addToolCall({
        ...toolCall,
        id: this.createId(),
        messageId: copiedMessageId,
        status: toolCall.status === 'running' ? 'cancelled' : toolCall.status
      });
    }
    await this.repository.updateSummary(summary);
    await this.settings.set(ACTIVE_CONVERSATION_KEY, summary.id);
    return (await this.repository.get(summary.id))!;
  }
}

interface ActiveRun {
  controller: AbortController;
  assistantMessageId: string;
}

export class ChatService {
  readonly #listeners = new Set<(event: Gw2ccEvent) => void>();
  readonly #runs = new Map<string, ActiveRun>();

  constructor(
    private readonly conversations: ConversationService,
    private readonly repository: ConversationRepository,
    private readonly providers: ProviderSettingsService,
    private readonly tools: ToolExecutor,
    private readonly characters: CharacterService,
    private readonly context: ContextService,
    private readonly accounts: AccountRepository,
    private readonly clock: Clock,
    private readonly createId: () => string
  ) {}

  subscribe(listener: (event: Gw2ccEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async bootstrap(): Promise<ChatBootstrapPayload> {
    return {
      conversation: await this.conversations.getPrimary(),
      provider: await this.providers.getView()
    };
  }

  async send(
    content: string,
    conversationId?: string,
    attachments: readonly ConversationAttachment[] = []
  ): Promise<ChatSendResult> {
    const trimmed = content.trim();
    const normalizedAttachments = normalizeAttachments(attachments);
    if (!trimmed && !normalizedAttachments.length) {
      throw new Gw2ccError('VALIDATION_ERROR', 'Enter a message or attach a file before sending.');
    }
    const { provider, configuration } = await this.providers.resolveActive();
    let conversation = conversationId
      ? await this.conversations.get(conversationId)
      : await this.conversations.getPrimary();
    if (conversation.messages.length === 0 &&
        (!conversation.title || DEFAULT_CONVERSATION_TITLES.has(conversation.title))) {
      const titleSource = trimmed || `Attached ${normalizedAttachments[0]!.name}`;
      conversation = await this.conversations.rename(conversation.id, titleFromFirstMessage(titleSource));
    }
    const account = await this.accounts.getActive();
    const focus = account?.selectedCharacterName;
    const snapshot = focus ? await this.characters.getSnapshot(focus) : undefined;
    const lore = account && focus ? await this.context.getLore(account.account.id, focus) : '';
    const now = this.clock.now();
    const userMessage: ConversationMessage = {
      id: this.createId(),
      conversationId: conversation.id,
      role: 'user',
      content: trimmed,
      ...(normalizedAttachments.length ? { attachments: normalizedAttachments } : {}),
      ...(focus ? { focusedCharacterName: focus } : {}),
      createdAt: now,
      status: 'complete'
    };
    const assistantMessage: ConversationMessage = {
      id: this.createId(),
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      ...(focus ? { focusedCharacterName: focus } : {}),
      providerId: configuration.providerId,
      modelId: configuration.model,
      createdAt: now + 1,
      status: 'streaming'
    };
    await this.repository.addMessage(userMessage);
    await this.repository.addMessage(assistantMessage);
    const history = [...conversation.messages, userMessage];
    const messages = assemblePrompt({
      globalInstructions: await this.context.getGlobalInstructions(),
      lore,
      ...(account ? { account: account.account } : {}),
      ...(snapshot ? { snapshot } : {}),
      history,
      toolsAvailable: configuration.toolsEnabled
    });
    const runId = this.createId();
    const controller = new AbortController();
    this.#runs.set(runId, { controller, assistantMessageId: assistantMessage.id });
    this.emit({
      type: 'chat.started',
      runId,
      conversationId: conversation.id,
      userMessage,
      assistantMessage
    });
    void this.run({ runId, provider, configuration, messages, assistantMessage, focus, controller });
    return {
      runId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id
    };
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const run = this.#runs.get(runId);
    if (!run) return { cancelled: false };
    run.controller.abort();
    return { cancelled: true };
  }

  async retry(messageId: string): Promise<ChatSendResult> {
    const conversation = await this.conversations.getPrimary();
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Gw2ccError('VALIDATION_ERROR', 'The failed message could not be found.');
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const message = conversation.messages[cursor];
      if (message?.role === 'user') {
        await this.repository.deleteMessagesFrom(conversation.id, message.id);
        return this.send(message.content, conversation.id, message.attachments);
      }
    }
    throw new Gw2ccError('VALIDATION_ERROR', 'There is no user message to retry.');
  }

  async edit(messageId: string, content: string): Promise<ChatSendResult> {
    const trimmed = content.trim();
    const conversation = await this.conversations.getPrimary();
    const message = conversation.messages.find((entry) => entry.id === messageId);
    if (!message || message.role !== 'user') {
      throw new Gw2ccError('VALIDATION_ERROR', 'Only a user message can be edited.');
    }
    if (!trimmed && !message.attachments?.length) {
      throw new Gw2ccError('VALIDATION_ERROR', 'Enter a message before resending.');
    }
    const lastUser = [...conversation.messages].reverse().find((entry) => entry.role === 'user');
    if (lastUser?.id !== message.id) {
      throw new Gw2ccError('VALIDATION_ERROR', 'Only the latest user message can be edited and resent.');
    }
    await this.repository.deleteMessagesFrom(conversation.id, message.id);
    return this.send(trimmed, conversation.id, message.attachments);
  }

  private async run(input: {
    runId: string;
    provider: LlmProvider;
    configuration: ProviderRuntimeConfiguration;
    messages: LlmMessage[];
    assistantMessage: ConversationMessage;
    focus?: string;
    controller: AbortController;
  }): Promise<void> {
    let assistant = input.assistantMessage;
    const messages = [...input.messages];
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    let totalReasoningTokens: number | undefined;
    let previousToolRoundSignature: string | undefined;
    let identicalToolRoundCount = 0;
    try {
      for (;;) {
        const toolCalls: import('./chat-domain').LlmToolCall[] = [];
        let roundText = '';
        let roundReasoning = '';
        let roundInputTokens: number | undefined;
        let roundOutputTokens: number | undefined;
        let roundReasoningTokens: number | undefined;
        let roundFinishReason: string | undefined;
        let reasoningStarted = false;
        const request = {
          model: input.configuration.model,
          messages,
          tools: input.configuration.toolsEnabled ? [...this.tools.definitions()] : [],
          ...(input.configuration.maxTokensEnabled ? { maxTokens: input.configuration.maxTokens } : {}),
          ...(input.configuration.temperature !== undefined ? { temperature: input.configuration.temperature } : {})
        };
        for await (const rawEvent of input.provider.stream(request, input.configuration, input.controller.signal)) {
          const event = normalizeProviderEvent(rawEvent);
          if (input.controller.signal.aborted) throw new Gw2ccError('CANCELLED', 'Generation was cancelled.');
          if (event.type === 'text_delta' && event.delta) {
            roundText += event.delta;
            assistant = { ...assistant, content: assistant.content + event.delta };
            await this.repository.updateMessage(assistant);
            this.emit({ type: 'chat.textDelta', runId: input.runId, messageId: assistant.id, delta: event.delta });
          } else if (event.type === 'reasoning_delta' && event.delta) {
            roundReasoning = `${roundReasoning}${event.delta}`.slice(0, MAX_REASONING_TRACE_CHARS);
            const previousTrace = assistant.reasoningTrace ?? { content: '' };
            const separator = !reasoningStarted && previousTrace.content ? '\n\n' : '';
            reasoningStarted = true;
            const candidate = `${separator}${event.delta}`;
            const remaining = Math.max(0, MAX_REASONING_TRACE_CHARS - previousTrace.content.length);
            const accepted = candidate.slice(0, remaining);
            const truncated = previousTrace.truncated === true || accepted.length < candidate.length;
            assistant = {
              ...assistant,
              reasoningTrace: {
                ...previousTrace,
                content: previousTrace.content + accepted,
                ...(truncated ? { truncated: true } : {})
              }
            };
            await this.repository.updateMessage(assistant);
            if (accepted || truncated !== previousTrace.truncated) {
              this.emit({
                type: 'chat.reasoningDelta',
                runId: input.runId,
                messageId: assistant.id,
                delta: accepted,
                truncated
              });
            }
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.call);
          } else if (event.type === 'usage') {
            if (event.inputTokens !== undefined) roundInputTokens = event.inputTokens;
            if (event.outputTokens !== undefined) roundOutputTokens = event.outputTokens;
            if (event.reasoningTokens !== undefined) roundReasoningTokens = event.reasoningTokens;
          } else if (event.type === 'completed') {
            roundFinishReason = event.finishReason;
          }
        }

        if (roundInputTokens !== undefined) totalInputTokens = (totalInputTokens ?? 0) + roundInputTokens;
        if (roundOutputTokens !== undefined) totalOutputTokens = (totalOutputTokens ?? 0) + roundOutputTokens;
        if (roundReasoningTokens !== undefined) {
          totalReasoningTokens = (totalReasoningTokens ?? 0) + roundReasoningTokens;
        }
        const previousTrace = assistant.reasoningTrace;
        if (previousTrace || totalInputTokens !== undefined || totalOutputTokens !== undefined ||
            totalReasoningTokens !== undefined || roundFinishReason !== undefined) {
          assistant = {
            ...assistant,
            reasoningTrace: {
              content: previousTrace?.content ?? '',
              ...(totalInputTokens !== undefined ? { inputTokens: totalInputTokens } : {}),
              ...(totalOutputTokens !== undefined ? { outputTokens: totalOutputTokens } : {}),
              ...(totalReasoningTokens !== undefined ? { reasoningTokens: totalReasoningTokens } : {}),
              ...(roundFinishReason !== undefined ? { finishReason: roundFinishReason } : {}),
              ...(previousTrace?.truncated ? { truncated: true } : {})
            }
          };
          await this.repository.updateMessage(assistant);
        }

        if (toolCalls.length === 0) {
          const details = {
            ...(roundFinishReason ? { finishReason: roundFinishReason } : {}),
            ...(totalInputTokens !== undefined ? { inputTokens: totalInputTokens } : {}),
            ...(totalOutputTokens !== undefined ? { outputTokens: totalOutputTokens } : {}),
            ...(totalReasoningTokens !== undefined ? { reasoningTokens: totalReasoningTokens } : {})
          };
          if (roundFinishReason && TOKEN_LIMIT_FINISH_REASONS.has(roundFinishReason.toLowerCase())) {
            throw new Gw2ccError(
              'LLM_UPSTREAM_ERROR',
              input.configuration.maxTokensEnabled
                ? 'The model reached the configured output-token limit before completing a final answer. Increase or disable the output limit, or use a smaller reasoning budget.'
                : 'The provider or model reached its own output limit before completing a final answer.',
              { retryable: true, details }
            );
          }
          if (!roundText.trim()) {
            throw new Gw2ccError(
              'LLM_UPSTREAM_ERROR',
              `The model finished without producing a final assistant answer${roundFinishReason ? ` (${roundFinishReason})` : ''}.`,
              { retryable: true, details }
            );
          }
          break;
        }
        if (!input.configuration.toolsEnabled) {
          throw new Gw2ccError('LLM_TOOLS_UNSUPPORTED', 'The selected model attempted a tool call while tools were disabled.');
        }
        const toolRoundSignature = JSON.stringify(toolCalls.map((call) => ({
          name: call.name,
          arguments: redactSensitive(call.arguments)
        })));
        identicalToolRoundCount = toolRoundSignature === previousToolRoundSignature
          ? identicalToolRoundCount + 1
          : 1;
        previousToolRoundSignature = toolRoundSignature;
        if (identicalToolRoundCount >= MAX_CONSECUTIVE_IDENTICAL_TOOL_ROUNDS) {
          throw new Gw2ccError(
            'LLM_UPSTREAM_ERROR',
            'The model repeated the same GW2 tool request without making progress. Try again or refine the request.'
          );
        }
        messages.push({
          role: 'assistant',
          content: roundText,
          ...(roundReasoning ? { reasoning: roundReasoning } : {}),
          toolCalls
        });
        for (const call of toolCalls) {
          const persisted: PersistedToolCall = {
            id: this.createId(),
            messageId: assistant.id,
            toolName: call.name,
            arguments: redactSensitive(call.arguments),
            status: 'running',
            contentOffset: assistant.content.length,
            startedAt: this.clock.now()
          };
          await this.repository.addToolCall(persisted);
          this.emit({ type: 'chat.toolStarted', runId: input.runId, messageId: assistant.id, toolCall: persisted });
          const outcome = normalizeToolOutcome(await this.tools.execute(call, {
            ...(input.focus ? { focusedCharacterName: input.focus } : {}),
            signal: input.controller.signal
          }));
          const completed: PersistedToolCall = {
            ...persisted,
            result: redactSensitive(outcome.value),
            status: outcome.ok ? 'completed' : 'failed',
            completedAt: this.clock.now()
          };
          await this.repository.updateToolCall(completed);
          this.emit({
            type: 'chat.toolCompleted',
            runId: input.runId,
            messageId: assistant.id,
            toolCall: completed,
            summary: outcome.summary
          });
          messages.push({
            role: 'tool',
            content: frameToolResult(call.name, outcome.value),
            toolCallId: call.id,
            toolName: call.name
          });
        }
      }
      assistant = { ...assistant, status: 'complete' };
      await this.repository.updateMessage(assistant);
      this.emit({ type: 'chat.completed', runId: input.runId, message: assistant });
    } catch (error) {
      if (input.controller.signal.aborted || (error instanceof Gw2ccError && error.code === 'CANCELLED')) {
        assistant = { ...assistant, status: 'cancelled' };
        await this.repository.updateMessage(assistant);
        this.emit({ type: 'chat.cancelled', runId: input.runId, message: assistant });
      } else {
        const payload = toErrorPayload(error);
        assistant = { ...assistant, status: 'failed', error: payload };
        await this.repository.updateMessage(assistant);
        this.emit({ type: 'chat.failed', runId: input.runId, message: assistant, error: payload });
      }
    } finally {
      this.#runs.delete(input.runId);
    }
  }

  private emit(event: Gw2ccEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
