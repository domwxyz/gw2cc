import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'phase_1_foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secret_blobs (
        key TEXT PRIMARY KEY,
        ciphertext BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_state (
        account_id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL,
        world_id INTEGER,
        permissions_json TEXT NOT NULL,
        characters_json TEXT NOT NULL,
        selected_character_name TEXT,
        last_connected_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS character_contexts (
        account_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        lore TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, character_name)
      );
      CREATE TABLE IF NOT EXISTS resource_cache (
        cache_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        schema_version TEXT,
        payload_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS resource_cache_source_idx ON resource_cache(source);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        focused_character_name TEXT,
        provider_id TEXT,
        model_id TEXT,
        created_at INTEGER NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
    `
  },
  {
    version: 2,
    name: 'conversation_console',
    sql: `
      ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS conversations_priority_idx
        ON conversations(is_pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_conversation_content_idx
        ON messages(conversation_id, content);
    `
  },
  {
    version: 3,
    name: 'mature_chat_interactions',
    sql: `
      ALTER TABLE tool_calls ADD COLUMN content_offset INTEGER;
      CREATE INDEX IF NOT EXISTS messages_conversation_order_idx
        ON messages(conversation_id, created_at);
    `
  }
];

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    database.prepare('SELECT version FROM schema_migrations').all().map((row) => (row as { version: number }).version)
  );
  const apply = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, Date.now());
  });
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) apply(migration);
  }
}
