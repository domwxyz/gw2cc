import type { CharacterSnapshot, Gw2ccErrorPayload } from './domain';

export const USER_CONFIGURABLE_PROVIDER_IDS = [
  'openrouter',
  'openai-compatible',
  'anthropic',
  'ollama'
] as const;

export type UserConfigurableProviderId = (typeof USER_CONFIGURABLE_PROVIDER_IDS)[number];
export type ProviderId = UserConfigurableProviderId | 'fixture';

export interface ProviderConfiguration {
  providerId: ProviderId;
  model: string;
  baseUrl?: string;
  toolsEnabled: boolean;
  maxTokensEnabled: boolean;
  maxTokens: number;
  temperature?: number;
}

export interface ProviderConfigurationInput {
  providerId: UserConfigurableProviderId;
  model: string;
  baseUrl?: string;
  toolsEnabled: boolean;
  maxTokensEnabled?: boolean;
  maxTokens?: number;
  temperature?: number;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ProviderCapabilities {
  streaming: true;
  tools: boolean;
}

export interface ProviderSettingsView {
  configuration: ProviderConfiguration;
  credentialConfigured: boolean;
  credentialRequired: boolean;
  ready: boolean;
  capabilities: ProviderCapabilities;
  availableProviders: readonly UserConfigurableProviderId[];
  message?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
}

export interface ProviderTestResult {
  ok: true;
  providerId: ProviderId;
  model: string;
  models: ModelInfo[];
  capabilities: ProviderCapabilities;
  message: string;
}

export interface ProviderRuntimeConfiguration extends ProviderConfiguration {
  apiKey?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Provider-supplied visible reasoning used only to continue the active tool round. */
  reasoning?: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export type LlmEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
  | { type: 'completed'; finishReason?: string };

export interface ConversationSummary {
  id: string;
  title?: string;
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ConversationMessageStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';

export const MAX_MESSAGE_ATTACHMENTS = 5;
export const MAX_TEXT_ATTACHMENT_BYTES = 100_000;
export const MAX_TOTAL_ATTACHMENT_BYTES = 250_000;

/** A persisted, provider-neutral attachment union designed for future attachment kinds. */
export type ConversationAttachment = {
  type: 'text';
  name: string;
  mediaType: 'text/plain' | 'text/markdown';
  content: string;
  size: number;
};

export interface ReasoningTrace {
  /** Visible text explicitly returned by the provider; it may be raw, summarized, or omitted. */
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  truncated?: boolean;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  focusedCharacterName?: string;
  providerId?: ProviderId;
  modelId?: string;
  createdAt: number;
  status: ConversationMessageStatus;
  attachments?: ConversationAttachment[];
  reasoningTrace?: ReasoningTrace;
  error?: Gw2ccErrorPayload;
}

export type ToolCallStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface PersistedToolCall {
  id: string;
  messageId: string;
  toolName: string;
  arguments: unknown;
  result?: unknown;
  status: ToolCallStatus;
  contentOffset?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
  toolCalls: PersistedToolCall[];
}

export interface ChatBootstrapPayload {
  conversation: ConversationDetail;
  provider: ProviderSettingsView;
}

export interface ChatSendResult {
  runId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export type Gw2ccEvent =
  | {
      type: 'chat.started';
      runId: string;
      conversationId: string;
      userMessage: ConversationMessage;
      assistantMessage: ConversationMessage;
    }
  | { type: 'chat.textDelta'; runId: string; messageId: string; delta: string }
  | {
      type: 'chat.reasoningDelta';
      runId: string;
      messageId: string;
      delta: string;
      truncated: boolean;
    }
  | {
      type: 'chat.toolStarted';
      runId: string;
      messageId: string;
      toolCall: PersistedToolCall;
    }
  | {
      type: 'chat.toolCompleted';
      runId: string;
      messageId: string;
      toolCall: PersistedToolCall;
      summary: string;
    }
  | { type: 'chat.completed'; runId: string; message: ConversationMessage }
  | { type: 'chat.cancelled'; runId: string; message: ConversationMessage }
  | {
      type: 'chat.failed';
      runId: string;
      message: ConversationMessage;
      error: Gw2ccErrorPayload;
    };

export interface PromptAssemblyInput {
  globalInstructions: string;
  lore: string;
  account?: { id: string; name: string };
  snapshot?: CharacterSnapshot;
  history: ConversationMessage[];
  toolsAvailable: boolean;
}

export interface ToolExecutionContext {
  focusedCharacterName?: string;
  timeZone: string;
  signal: AbortSignal;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  value: unknown;
  summary: string;
  truncated: boolean;
}
