import Database from 'better-sqlite3';
import {
  Gw2ccError,
  type AccountRepository,
  type AccountStateRecord,
  type CachedResource,
  type CharacterContextRepository,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationRepository,
  type ConversationSummary,
  type Gw2ccRepositories,
  type ResourceCache,
  type PersistedToolCall,
  type SettingsRepository
} from '@gw2cc/core';
import { runMigrations } from './migrations';

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Gw2ccError('DATABASE_ERROR', `Stored ${label} data is invalid.`, { cause: error });
  }
}

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly database: Database.Database) {}

  async get<T>(key: string): Promise<T | null> {
    const row = this.database.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    return row ? parseJson<T>(row.value_json, 'settings') : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.database.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }
}

export class SqliteAccountRepository implements AccountRepository {
  constructor(private readonly database: Database.Database) {}

  async getActive(): Promise<AccountStateRecord | null> {
    const row = this.database.prepare(`
      SELECT account_id, account_name, world_id, permissions_json, characters_json,
             selected_character_name, last_connected_at
      FROM account_state ORDER BY last_connected_at DESC LIMIT 1
    `).get() as {
      account_id: string;
      account_name: string;
      world_id: number | null;
      permissions_json: string;
      characters_json: string;
      selected_character_name: string | null;
      last_connected_at: number;
    } | undefined;
    if (!row) return null;
    return {
      account: {
        id: row.account_id,
        name: row.account_name,
        ...(row.world_id !== null ? { worldId: row.world_id } : {})
      },
      permissions: parseJson<string[]>(row.permissions_json, 'permissions'),
      characterNames: parseJson<string[]>(row.characters_json, 'characters'),
      ...(row.selected_character_name ? { selectedCharacterName: row.selected_character_name } : {}),
      lastConnectedAt: row.last_connected_at
    };
  }

  async save(record: AccountStateRecord): Promise<void> {
    const transaction = this.database.transaction(() => {
      this.database.prepare('DELETE FROM account_state WHERE account_id <> ?').run(record.account.id);
      this.database.prepare(`
        INSERT INTO account_state (
          account_id, account_name, world_id, permissions_json, characters_json,
          selected_character_name, last_connected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          account_name = excluded.account_name,
          world_id = excluded.world_id,
          permissions_json = excluded.permissions_json,
          characters_json = excluded.characters_json,
          selected_character_name = excluded.selected_character_name,
          last_connected_at = excluded.last_connected_at
      `).run(
        record.account.id,
        record.account.name,
        record.account.worldId ?? null,
        JSON.stringify(record.permissions),
        JSON.stringify(record.characterNames),
        record.selectedCharacterName ?? null,
        record.lastConnectedAt
      );
    });
    transaction();
  }

  async clearActive(): Promise<void> {
    this.database.prepare('DELETE FROM account_state').run();
  }
}

export class SqliteCharacterContextRepository implements CharacterContextRepository {
  constructor(private readonly database: Database.Database) {}

  async getLore(accountId: string, characterName: string): Promise<string> {
    const row = this.database.prepare(`
      SELECT lore FROM character_contexts WHERE account_id = ? AND character_name = ?
    `).get(accountId, characterName) as { lore: string } | undefined;
    return row?.lore ?? '';
  }

  async setLore(accountId: string, characterName: string, lore: string): Promise<void> {
    this.database.prepare(`
      INSERT INTO character_contexts (account_id, character_name, lore, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, character_name) DO UPDATE SET lore = excluded.lore, updated_at = excluded.updated_at
    `).run(accountId, characterName, lore, Date.now());
  }
}

export class SqliteResourceCache implements ResourceCache {
  constructor(private readonly database: Database.Database) {}

  async get<T>(key: string): Promise<CachedResource<T> | null> {
    const row = this.database.prepare(`
      SELECT cache_key, source, schema_version, payload_json, fetched_at, expires_at
      FROM resource_cache WHERE cache_key = ?
    `).get(key) as {
      cache_key: string;
      source: string;
      schema_version: string | null;
      payload_json: string;
      fetched_at: number;
      expires_at: number | null;
    } | undefined;
    if (!row) return null;
    return {
      key: row.cache_key,
      source: row.source,
      ...(row.schema_version ? { schemaVersion: row.schema_version } : {}),
      payload: parseJson<T>(row.payload_json, 'resource cache'),
      fetchedAt: row.fetched_at,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {})
    };
  }

  async set<T>(resource: CachedResource<T>): Promise<void> {
    this.database.prepare(`
      INSERT INTO resource_cache (
        cache_key, source, schema_version, payload_json, fetched_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        source = excluded.source,
        schema_version = excluded.schema_version,
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    `).run(
      resource.key,
      resource.source,
      resource.schemaVersion ?? null,
      JSON.stringify(resource.payload),
      resource.fetchedAt,
      resource.expiresAt ?? null
    );
  }

  async deleteBySource(source: string): Promise<void> {
    this.database.prepare('DELETE FROM resource_cache WHERE source = ?').run(source);
  }
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: Database.Database) {}

  async list(): Promise<ConversationSummary[]> {
    return (this.database.prepare(`
      SELECT id, title, is_pinned, created_at, updated_at
      FROM conversations
      ORDER BY is_pinned DESC, updated_at DESC
    `).all() as Array<{ id: string; title: string | null; is_pinned: number; created_at: number; updated_at: number }>).map((row) => ({
      id: row.id,
      ...(row.title ? { title: row.title } : {}),
      isPinned: Boolean(row.is_pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async search(query: string): Promise<ConversationSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return this.list();
    const escaped = trimmed.replace(/[\\%_]/g, (character) => `\\${character}`);
    const pattern = `%${escaped}%`;
    return (this.database.prepare(`
      SELECT DISTINCT c.id, c.title, c.is_pinned, c.created_at, c.updated_at
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
      ORDER BY c.is_pinned DESC, c.updated_at DESC
    `).all(pattern, pattern) as Array<{
      id: string;
      title: string | null;
      is_pinned: number;
      created_at: number;
      updated_at: number;
    }>).map((row) => ({
      id: row.id,
      ...(row.title ? { title: row.title } : {}),
      isPinned: Boolean(row.is_pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async get(id: string): Promise<ConversationDetail | null> {
    const row = this.database.prepare(`
      SELECT id, title, is_pinned, created_at, updated_at FROM conversations WHERE id = ?
    `).get(id) as {
      id: string;
      title: string | null;
      is_pinned: number;
      created_at: number;
      updated_at: number;
    } | undefined;
    if (!row) return null;
    const messageRows = this.database.prepare(`
      SELECT id, conversation_id, role, content, focused_character_name, provider_id,
             model_id, created_at, metadata_json
      FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid
    `).all(id) as Array<{
      id: string;
      conversation_id: string;
      role: string;
      content: string;
      focused_character_name: string | null;
      provider_id: string | null;
      model_id: string | null;
      created_at: number;
      metadata_json: string | null;
    }>;
    const messages: ConversationMessage[] = messageRows
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => {
        const metadata = message.metadata_json
          ? parseJson<{ status?: ConversationMessage['status']; error?: ConversationMessage['error'] }>(message.metadata_json, 'message metadata')
          : {};
        return {
          id: message.id,
          conversationId: message.conversation_id,
          role: message.role as ConversationMessage['role'],
          content: message.content,
          ...(message.focused_character_name ? { focusedCharacterName: message.focused_character_name } : {}),
          ...(message.provider_id ? { providerId: message.provider_id as ConversationMessage['providerId'] } : {}),
          ...(message.model_id ? { modelId: message.model_id } : {}),
          createdAt: message.created_at,
          status: metadata.status ?? 'complete',
          ...(metadata.error ? { error: metadata.error } : {})
        };
      });
    const messageIds = messages.map((message) => message.id);
    const toolCalls = messageIds.length === 0 ? [] : (this.database.prepare(`
      SELECT id, message_id, tool_name, arguments_json, result_json, status, content_offset, started_at, completed_at
      FROM tool_calls WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY started_at, rowid
    `).all(...messageIds) as Array<{
      id: string;
      message_id: string;
      tool_name: string;
      arguments_json: string;
      result_json: string | null;
      status: PersistedToolCall['status'];
      content_offset: number | null;
      started_at: number | null;
      completed_at: number | null;
    }>).map((toolCall): PersistedToolCall => ({
      id: toolCall.id,
      messageId: toolCall.message_id,
      toolName: toolCall.tool_name,
      arguments: parseJson<unknown>(toolCall.arguments_json, 'tool arguments'),
      ...(toolCall.result_json ? { result: parseJson<unknown>(toolCall.result_json, 'tool result') } : {}),
      status: toolCall.status,
      ...(toolCall.content_offset !== null ? { contentOffset: toolCall.content_offset } : {}),
      ...(toolCall.started_at !== null ? { startedAt: toolCall.started_at } : {}),
      ...(toolCall.completed_at !== null ? { completedAt: toolCall.completed_at } : {})
    }));
    return {
      id: row.id,
      ...(row.title ? { title: row.title } : {}),
      isPinned: Boolean(row.is_pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
      toolCalls
    };
  }

  async create(conversation: ConversationSummary): Promise<void> {
    this.database.prepare(`
      INSERT INTO conversations (id, title, is_pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.title ?? null,
      conversation.isPinned ? 1 : 0,
      conversation.createdAt,
      conversation.updatedAt
    );
  }

  async updateSummary(conversation: ConversationSummary): Promise<void> {
    this.database.prepare(`
      UPDATE conversations
      SET title = ?, is_pinned = ?, updated_at = ?
      WHERE id = ?
    `).run(
      conversation.title ?? null,
      conversation.isPinned ? 1 : 0,
      conversation.updatedAt,
      conversation.id
    );
  }

  async delete(id: string): Promise<void> {
    this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  async addMessage(message: ConversationMessage): Promise<void> {
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, content, focused_character_name, provider_id,
          model_id, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.focusedCharacterName ?? null,
        message.providerId ?? null,
        message.modelId ?? null,
        message.createdAt,
        JSON.stringify({ status: message.status, ...(message.error ? { error: message.error } : {}) })
      );
      this.database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(message.createdAt, message.conversationId);
    });
    transaction();
  }

  async updateMessage(message: ConversationMessage): Promise<void> {
    this.database.prepare(`
      UPDATE messages SET content = ?, focused_character_name = ?, provider_id = ?, model_id = ?, metadata_json = ?
      WHERE id = ?
    `).run(
      message.content,
      message.focusedCharacterName ?? null,
      message.providerId ?? null,
      message.modelId ?? null,
      JSON.stringify({ status: message.status, ...(message.error ? { error: message.error } : {}) }),
      message.id
    );
    this.database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(Date.now(), message.conversationId);
  }

  async deleteMessagesFrom(conversationId: string, messageId: string): Promise<void> {
    const cutoff = this.database.prepare(`
      SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?
    `).get(messageId, conversationId) as { rowid: number } | undefined;
    if (!cutoff) throw new Error('Conversation message cutoff was not found.');
    this.database.prepare(`
      DELETE FROM messages WHERE conversation_id = ? AND rowid >= ?
    `).run(conversationId, cutoff.rowid);
  }

  async addToolCall(toolCall: PersistedToolCall): Promise<void> {
    this.database.prepare(`
      INSERT INTO tool_calls (
        id, message_id, tool_name, arguments_json, result_json, status, content_offset, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolCall.id,
      toolCall.messageId,
      toolCall.toolName,
      JSON.stringify(toolCall.arguments),
      toolCall.result === undefined ? null : JSON.stringify(toolCall.result),
      toolCall.status,
      toolCall.contentOffset ?? null,
      toolCall.startedAt ?? null,
      toolCall.completedAt ?? null
    );
  }

  async updateToolCall(toolCall: PersistedToolCall): Promise<void> {
    this.database.prepare(`
      UPDATE tool_calls SET result_json = ?, status = ?, content_offset = ?, started_at = ?, completed_at = ? WHERE id = ?
    `).run(
      toolCall.result === undefined ? null : JSON.stringify(toolCall.result),
      toolCall.status,
      toolCall.contentOffset ?? null,
      toolCall.startedAt ?? null,
      toolCall.completedAt ?? null,
      toolCall.id
    );
  }
}

export class SqliteSecretBlobRepository {
  constructor(private readonly database: Database.Database) {}

  get(key: string): Buffer | null {
    const row = this.database.prepare('SELECT ciphertext FROM secret_blobs WHERE key = ?').get(key) as
      | { ciphertext: Buffer }
      | undefined;
    return row?.ciphertext ?? null;
  }

  set(key: string, ciphertext: Buffer): void {
    this.database.prepare(`
      INSERT INTO secret_blobs (key, ciphertext, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
    `).run(key, ciphertext, Date.now());
  }

  delete(key: string): void {
    this.database.prepare('DELETE FROM secret_blobs WHERE key = ?').run(key);
  }

  has(key: string): boolean {
    return this.database.prepare('SELECT 1 FROM secret_blobs WHERE key = ?').get(key) !== undefined;
  }
}

export interface OpenSqliteResult {
  database: Database.Database;
  repositories: Gw2ccRepositories;
  secretBlobs: SqliteSecretBlobRepository;
  close(): void;
}

export function openSqlite(databasePath: string): OpenSqliteResult {
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  if (databasePath !== ':memory:') database.pragma('journal_mode = WAL');
  runMigrations(database);
  return {
    database,
    repositories: {
      settings: new SqliteSettingsRepository(database),
      account: new SqliteAccountRepository(database),
      contexts: new SqliteCharacterContextRepository(database),
      cache: new SqliteResourceCache(database),
      conversations: new SqliteConversationRepository(database)
    },
    secretBlobs: new SqliteSecretBlobRepository(database),
    close: () => database.close()
  };
}
