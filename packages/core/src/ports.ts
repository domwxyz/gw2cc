import type {
  AccountStateRecord,
  CharacterSnapshot,
  ConnectionProfile,
  SecretStorageStatus
} from './domain';
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  LlmEvent,
  LlmRequest,
  LlmToolCall,
  LlmToolDefinition,
  ModelInfo,
  PersistedToolCall,
  ProviderId,
  ProviderRuntimeConfiguration,
  ToolExecutionContext,
  ToolExecutionOutcome
} from './chat-domain';
import type {
  MetaBattleBuildResponse,
  MetaBattleSearchInput,
  MetaBattleSearchResponse,
  ResearchDocument,
  ResearchFetchInput,
  ResearchJsonDocument,
  ResearchJsonFetchInput,
  ResearchSearchInput,
  ResearchSearchResponse
} from './research-domain';

export type QueryValue = string | number | boolean | readonly (string | number | boolean)[];

export type PublicGw2ResourceKind = 'items' | 'skills' | 'traits' | 'specializations';

export interface PublicGw2Definition {
  id: number;
  name: string;
  specializationId?: number;
  majorTraitIds?: number[];
  tier?: number;
  order?: number;
}

export interface Gw2Gateway {
  readonly fixtureMode: boolean;
  validateKey(apiKey: string): Promise<ConnectionProfile>;
  getCharacterSnapshot(apiKey: string, characterName: string, forceRefresh?: boolean, signal?: AbortSignal): Promise<CharacterSnapshot>;
  get<T>(apiKey: string | undefined, path: `/v2/${string}`, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T>;
  getPublicDefinitions?(
    kind: PublicGw2ResourceKind,
    ids: readonly number[] | undefined,
    signal?: AbortSignal
  ): Promise<PublicGw2Definition[]>;
}

export type SecretKey =
  | 'gw2-api-key'
  | 'openrouter-api-key'
  | 'openai-compatible-api-key'
  | 'anthropic-api-key'
  | 'ollama-api-key'
  | 'tavily-api-key';

export interface ResearchGateway {
  readonly fixtureMode: boolean;
  search(apiKey: string, input: ResearchSearchInput, signal?: AbortSignal): Promise<ResearchSearchResponse>;
  fetchUrl(
    input: ResearchFetchInput,
    options: { tavilyApiKey?: string },
    signal?: AbortSignal
  ): Promise<ResearchDocument>;
  fetchJson(input: ResearchJsonFetchInput, signal?: AbortSignal): Promise<ResearchJsonDocument>;
  searchMetaBattle(input: MetaBattleSearchInput, signal?: AbortSignal): Promise<MetaBattleSearchResponse>;
  fetchMetaBattleBuild(title: string, signal?: AbortSignal): Promise<MetaBattleBuildResponse>;
}

export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  status(key: SecretKey): Promise<SecretStorageStatus>;
}

export interface SettingsRepository {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface AccountRepository {
  getActive(): Promise<AccountStateRecord | null>;
  save(record: AccountStateRecord): Promise<void>;
  clearActive(): Promise<void>;
}

export interface CharacterContextRepository {
  getLore(accountId: string, characterName: string): Promise<string>;
  setLore(accountId: string, characterName: string, lore: string): Promise<void>;
}

export interface CachedResource<T = unknown> {
  key: string;
  source: string;
  schemaVersion?: string;
  payload: T;
  fetchedAt: number;
  expiresAt?: number;
}

export interface ResourceCache {
  get<T>(key: string): Promise<CachedResource<T> | null>;
  set<T>(resource: CachedResource<T>): Promise<void>;
  deleteBySource(source: string): Promise<void>;
}

export interface ConversationRepository {
  list(): Promise<ConversationSummary[]>;
  search(query: string): Promise<ConversationSummary[]>;
  get(id: string): Promise<ConversationDetail | null>;
  create(conversation: ConversationSummary): Promise<void>;
  updateSummary(conversation: ConversationSummary): Promise<void>;
  delete(id: string): Promise<void>;
  addMessage(message: ConversationMessage): Promise<void>;
  updateMessage(message: ConversationMessage): Promise<void>;
  deleteMessagesFrom(conversationId: string, messageId: string): Promise<void>;
  addToolCall(toolCall: PersistedToolCall): Promise<void>;
  updateToolCall(toolCall: PersistedToolCall): Promise<void>;
}

export interface LlmProvider {
  readonly id: ProviderId;
  listModels(configuration: ProviderRuntimeConfiguration, signal?: AbortSignal): Promise<ModelInfo[]>;
  stream(
    request: LlmRequest,
    configuration: ProviderRuntimeConfiguration,
    signal: AbortSignal
  ): AsyncIterable<LlmEvent>;
}

export interface LlmProviderRegistry {
  get(providerId: ProviderId): LlmProvider | undefined;
}

export interface ToolExecutor {
  definitions(): readonly LlmToolDefinition[];
  execute(call: LlmToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}

export interface Clock {
  now(): number;
}

export interface Gw2ccRepositories {
  settings: SettingsRepository;
  account: AccountRepository;
  contexts: CharacterContextRepository;
  cache: ResourceCache;
  conversations: ConversationRepository;
}
