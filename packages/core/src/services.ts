import type {
  AccountStateRecord,
  BootstrapPayload,
  CharacterSnapshot,
  ConnectionCapabilities,
  ConnectionState,
  EquippedItem
} from './domain';
import { Gw2ccError, toErrorPayload } from './errors';
import type {
  AccountRepository,
  CharacterContextRepository,
  Clock,
  Gw2Gateway,
  SecretStore,
  SettingsRepository
} from './ports';
import type { ChatService, ConversationService, ProviderSettingsService } from './chat-services';
import type { ResearchService } from './research';

const EMPTY_CAPABILITIES: ConnectionCapabilities = {
  characters: false,
  equipment: false,
  builds: false
};

function capabilitiesFor(permissions: string[]): ConnectionCapabilities {
  const available = new Set(permissions);
  const characters = available.has('account') && available.has('characters');
  const builds = characters && available.has('builds');
  return {
    characters,
    builds,
    equipment: builds || (characters && available.has('inventories'))
  };
}

export class ConnectionService {
  constructor(
    private readonly gateway: Gw2Gateway,
    private readonly secrets: SecretStore,
    private readonly accounts: AccountRepository,
    private readonly clock: Clock
  ) {}

  async initialize(): Promise<ConnectionState> {
    const persisted = await this.accounts.getActive();
    let secret: string | null;
    try {
      secret = await this.secrets.get('gw2-api-key');
    } catch (error) {
      const payload = toErrorPayload(error);
      const state = await this.stateFromRecord(persisted);
      return { ...state, status: 'error', message: payload.message };
    }
    if (!secret) return this.stateFromRecord(null);

    try {
      return await this.connect(secret, false);
    } catch (error) {
      const payload = toErrorPayload(error);
      const state = await this.stateFromRecord(persisted);
      return { ...state, status: 'error', message: payload.message };
    }
  }

  async connect(apiKey: string, persistSecret = true): Promise<ConnectionState> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Gw2ccError('GW2_KEY_INVALID', 'Enter a Guild Wars 2 API key.');

    const existing = await this.accounts.getActive();
    const profile = await this.gateway.validateKey(trimmed);
    if (persistSecret) await this.secrets.set('gw2-api-key', trimmed);

    const selected =
      existing?.account.id === profile.account.id &&
      existing.selectedCharacterName &&
      profile.characterNames.includes(existing.selectedCharacterName)
        ? existing.selectedCharacterName
        : profile.characterNames[0];

    const record: AccountStateRecord = {
      account: profile.account,
      permissions: profile.permissions,
      characterNames: profile.characterNames,
      ...(selected ? { selectedCharacterName: selected } : {}),
      lastConnectedAt: this.clock.now()
    };
    await this.accounts.save(record);
    return this.stateFromRecord(record);
  }

  async test(): Promise<ConnectionState> {
    const secret = await this.requireKey();
    return this.connect(secret, false);
  }

  async disconnect(): Promise<ConnectionState> {
    await this.secrets.delete('gw2-api-key');
    await this.accounts.clearActive();
    return this.stateFromRecord(null);
  }

  async getState(): Promise<ConnectionState> {
    return this.stateFromRecord(await this.accounts.getActive());
  }

  async requireKey(): Promise<string> {
    const key = await this.secrets.get('gw2-api-key');
    if (!key) throw new Gw2ccError('GW2_NOT_CONNECTED', 'Connect a Guild Wars 2 API key first.');
    return key;
  }

  private async stateFromRecord(record: AccountStateRecord | null): Promise<ConnectionState> {
    const secretStorage = await this.secrets.status('gw2-api-key');
    if (!record) {
      return {
        status: 'disconnected',
        permissions: [],
        capabilities: EMPTY_CAPABILITIES,
        characterNames: [],
        secretStorage,
        fixtureMode: this.gateway.fixtureMode
      };
    }

    return {
      status: 'connected',
      account: record.account,
      permissions: record.permissions,
      capabilities: capabilitiesFor(record.permissions),
      characterNames: record.characterNames,
      ...(record.selectedCharacterName ? { selectedCharacterName: record.selectedCharacterName } : {}),
      lastConnectedAt: record.lastConnectedAt,
      secretStorage,
      fixtureMode: this.gateway.fixtureMode
    };
  }
}

export class CharacterService {
  readonly #snapshots = new Map<string, CharacterSnapshot>();

  constructor(
    private readonly gateway: Gw2Gateway,
    private readonly secrets: SecretStore,
    private readonly accounts: AccountRepository
  ) {}

  async select(characterName: string): Promise<CharacterSnapshot> {
    const account = await this.requireAccount();
    if (!account.characterNames.includes(characterName)) {
      throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', `Character “${characterName}” is not available on this account.`);
    }
    await this.accounts.save({ ...account, selectedCharacterName: characterName });
    return this.getSnapshot(characterName);
  }

  async getSelectedSnapshot(forceRefresh = false): Promise<CharacterSnapshot | undefined> {
    const account = await this.accounts.getActive();
    if (!account?.selectedCharacterName) return undefined;
    return this.getSnapshot(account.selectedCharacterName, forceRefresh);
  }

  async getSnapshot(characterName: string, forceRefresh = false): Promise<CharacterSnapshot> {
    if (!forceRefresh) {
      const cached = this.#snapshots.get(characterName);
      if (cached) return cached;
    }
    const key = await this.secrets.get('gw2-api-key');
    if (!key) throw new Gw2ccError('GW2_NOT_CONNECTED', 'Connect a Guild Wars 2 API key first.');
    const snapshot = await this.gateway.getCharacterSnapshot(key, characterName, forceRefresh);
    this.#snapshots.set(characterName, snapshot);
    return snapshot;
  }

  async inspectItem(itemId: number): Promise<EquippedItem> {
    const snapshot = await this.getSelectedSnapshot();
    const equipped = snapshot?.equipment.find((entry) => entry.itemId === itemId);
    if (!equipped) {
      throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', `Equipped item ${itemId} is not in the active character snapshot.`);
    }
    return equipped;
  }

  clearMemoryCache(): void {
    this.#snapshots.clear();
  }

  private async requireAccount(): Promise<AccountStateRecord> {
    const account = await this.accounts.getActive();
    if (!account) throw new Gw2ccError('GW2_NOT_CONNECTED', 'Connect a Guild Wars 2 API key first.');
    return account;
  }
}

export class ContextService {
  private static readonly INSTRUCTIONS_KEY = 'global-instructions';

  constructor(
    private readonly settings: SettingsRepository,
    private readonly contexts: CharacterContextRepository,
    private readonly accounts: AccountRepository
  ) {}

  async getGlobalInstructions(): Promise<string> {
    return (await this.settings.get<string>(ContextService.INSTRUCTIONS_KEY)) ?? '';
  }

  async setGlobalInstructions(value: string): Promise<string> {
    await this.settings.set(ContextService.INSTRUCTIONS_KEY, value);
    return value;
  }

  async getSelectedLore(): Promise<string> {
    const account = await this.accounts.getActive();
    if (!account?.selectedCharacterName) return '';
    return this.contexts.getLore(account.account.id, account.selectedCharacterName);
  }

  async getLore(accountId: string, characterName: string): Promise<string> {
    return this.contexts.getLore(accountId, characterName);
  }

  async setSelectedLore(value: string): Promise<string> {
    const account = await this.accounts.getActive();
    if (!account?.selectedCharacterName) {
      throw new Gw2ccError('GW2_NOT_CONNECTED', 'Select a character before editing lore.');
    }
    await this.contexts.setLore(account.account.id, account.selectedCharacterName, value);
    return value;
  }
}

export class Gw2ccApplication {
  readonly connection: ConnectionService;
  readonly characters: CharacterService;
  readonly context: ContextService;
  readonly chat: ChatService;
  readonly conversations: ConversationService;
  readonly providers: ProviderSettingsService;
  readonly research: ResearchService;

  constructor(services: {
    connection: ConnectionService;
    characters: CharacterService;
    context: ContextService;
    chat: ChatService;
    conversations: ConversationService;
    providers: ProviderSettingsService;
    research: ResearchService;
  }) {
    this.connection = services.connection;
    this.characters = services.characters;
    this.context = services.context;
    this.chat = services.chat;
    this.conversations = services.conversations;
    this.providers = services.providers;
    this.research = services.research;
  }

  async bootstrap(initialize = false): Promise<BootstrapPayload> {
    const connection = initialize ? await this.connection.initialize() : await this.connection.getState();
    const globalInstructions = await this.context.getGlobalInstructions();
    let snapshot: CharacterSnapshot | undefined;
    let snapshotError: ReturnType<typeof toErrorPayload> | undefined;
    if (connection.selectedCharacterName && connection.status !== 'disconnected') {
      try {
        snapshot = await this.characters.getSnapshot(connection.selectedCharacterName);
      } catch (error) {
        snapshotError = toErrorPayload(error);
      }
    }
    const characterLore = await this.context.getSelectedLore();
    const chat = await this.chat.bootstrap();
    const research = await this.research.getView();
    return {
      connection,
      ...(snapshot ? { snapshot } : {}),
      ...(snapshotError ? { snapshotError } : {}),
      globalInstructions,
      characterLore,
      chat,
      research
    };
  }

  async connect(apiKey: string): Promise<BootstrapPayload> {
    this.characters.clearMemoryCache();
    await this.connection.connect(apiKey);
    return this.bootstrap();
  }

  async testConnection(): Promise<BootstrapPayload> {
    this.characters.clearMemoryCache();
    await this.connection.test();
    return this.bootstrap();
  }

  async disconnect(): Promise<BootstrapPayload> {
    this.characters.clearMemoryCache();
    await this.connection.disconnect();
    return this.bootstrap();
  }

  async selectCharacter(name: string): Promise<BootstrapPayload> {
    await this.characters.select(name);
    return this.bootstrap();
  }

  async refreshCharacter(): Promise<BootstrapPayload> {
    await this.characters.getSelectedSnapshot(true);
    return this.bootstrap();
  }
}
