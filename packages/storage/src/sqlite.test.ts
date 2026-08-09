import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openSqlite } from './index';

describe('SQLite migrations and repositories', () => {
  it('runs ordered migrations and creates all Phase 1/future conversation tables', () => {
    const storage = openSqlite(':memory:');
    try {
      const tables = storage.database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `).all().map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining([
        'schema_migrations',
        'app_settings',
        'secret_blobs',
        'account_state',
        'character_contexts',
        'resource_cache',
        'conversations',
        'messages',
        'tool_calls'
      ]));
      expect(storage.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get())
        .toEqual({ count: MIGRATIONS.length });
    } finally {
      storage.close();
    }
  });

  it('persists settings, account selection, per-character lore, cache data, and ciphertext only', async () => {
    const storage = openSqlite(':memory:');
    try {
      await storage.repositories.settings.set('global-instructions', 'Be concise.');
      expect(await storage.repositories.settings.get('global-instructions')).toBe('Be concise.');

      await storage.repositories.account.save({
        account: { id: 'account-1', name: 'Commander.1234', worldId: 1001 },
        permissions: ['account', 'characters', 'builds'],
        characterNames: ['A', 'B'],
        selectedCharacterName: 'B',
        lastConnectedAt: 1234
      });
      expect(await storage.repositories.account.getActive()).toMatchObject({
        account: { id: 'account-1' },
        selectedCharacterName: 'B',
        characterNames: ['A', 'B']
      });

      await storage.repositories.contexts.setLore('account-1', 'A', 'Lore A');
      await storage.repositories.contexts.setLore('account-1', 'B', 'Lore B');
      expect(await storage.repositories.contexts.getLore('account-1', 'A')).toBe('Lore A');
      expect(await storage.repositories.contexts.getLore('account-1', 'B')).toBe('Lore B');

      await storage.repositories.cache.set({
        key: 'items:1', source: 'items', schemaVersion: 'v1', payload: { id: 1 }, fetchedAt: 10, expiresAt: 20
      });
      expect(await storage.repositories.cache.get('items:1')).toEqual({
        key: 'items:1', source: 'items', schemaVersion: 'v1', payload: { id: 1 }, fetchedAt: 10, expiresAt: 20
      });
      await storage.repositories.cache.deleteBySource('items');
      expect(await storage.repositories.cache.get('items:1')).toBeNull();

      const encrypted = Buffer.from([1, 2, 3, 4]);
      storage.secretBlobs.set('gw2-api-key', encrypted);
      expect(storage.secretBlobs.get('gw2-api-key')).toEqual(encrypted);
      const raw = storage.database.prepare('SELECT ciphertext FROM secret_blobs WHERE key = ?').get('gw2-api-key') as { ciphertext: Buffer };
      expect(raw.ciphertext.toString('hex')).toBe('01020304');
    } finally {
      storage.close();
    }
  });

  it('preserves lore rows after disconnecting the active account', async () => {
    const storage = openSqlite(':memory:');
    try {
      await storage.repositories.account.save({
        account: { id: 'account-1', name: 'Commander.1234' },
        permissions: [],
        characterNames: ['Renamed Later'],
        lastConnectedAt: 1
      });
      await storage.repositories.contexts.setLore('account-1', 'Old Name', 'Never delete this.');
      await storage.repositories.account.clearActive();
      expect(await storage.repositories.account.getActive()).toBeNull();
      expect(await storage.repositories.contexts.getLore('account-1', 'Old Name')).toBe('Never delete this.');
    } finally {
      storage.close();
    }
  });

  it('persists account-wide conversations, focused messages, streaming status, and tool metadata', async () => {
    const storage = openSqlite(':memory:');
    try {
      await storage.repositories.conversations.create({
        id: 'conversation-1', title: 'Account-wide chat', isPinned: false, createdAt: 1, updatedAt: 1
      });
      await storage.repositories.conversations.addMessage({
        id: 'user-1', conversationId: 'conversation-1', role: 'user', content: 'Question',
        focusedCharacterName: 'Aurelia Ward', createdAt: 2, status: 'complete'
      });
      await storage.repositories.conversations.addMessage({
        id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant', content: '',
        focusedCharacterName: 'Aurelia Ward', providerId: 'anthropic', modelId: 'claude-test',
        createdAt: 3, status: 'streaming'
      });
      await storage.repositories.conversations.updateMessage({
        id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant', content: 'Answer',
        focusedCharacterName: 'Aurelia Ward', providerId: 'anthropic', modelId: 'claude-test',
        createdAt: 3, status: 'complete',
        reasoningTrace: {
          content: 'Inspected the current build.', inputTokens: 20, outputTokens: 8,
          reasoningTokens: 3, finishReason: 'end_turn'
        }
      });
      await storage.repositories.conversations.addToolCall({
        id: 'tool-1', messageId: 'assistant-1', toolName: 'gw2_get_account', arguments: {},
        status: 'running', contentOffset: 0, startedAt: 4
      });
      await storage.repositories.conversations.updateToolCall({
        id: 'tool-1', messageId: 'assistant-1', toolName: 'gw2_get_account', arguments: {},
        result: { ok: true }, status: 'completed', contentOffset: 0, startedAt: 4, completedAt: 5
      });
      const restored = await storage.repositories.conversations.get('conversation-1');
      expect(restored).toMatchObject({
        id: 'conversation-1',
        messages: [
          { id: 'user-1', focusedCharacterName: 'Aurelia Ward', status: 'complete' },
          {
            id: 'assistant-1', providerId: 'anthropic', content: 'Answer', status: 'complete',
            reasoningTrace: {
              content: 'Inspected the current build.', inputTokens: 20, outputTokens: 8,
              reasoningTokens: 3, finishReason: 'end_turn'
            }
          }
        ],
        toolCalls: [{ id: 'tool-1', status: 'completed', contentOffset: 0, result: { ok: true } }]
      });
      await storage.repositories.conversations.addMessage({
        id: 'user-2', conversationId: 'conversation-1', role: 'user', content: 'Replacement target',
        focusedCharacterName: 'Aurelia Ward', createdAt: 6, status: 'complete'
      });
      await storage.repositories.conversations.addMessage({
        id: 'assistant-2', conversationId: 'conversation-1', role: 'assistant', content: 'Replace me',
        focusedCharacterName: 'Aurelia Ward', providerId: 'anthropic', modelId: 'claude-test',
        createdAt: 7, status: 'complete'
      });
      await storage.repositories.conversations.deleteMessagesFrom('conversation-1', 'user-2');
      expect((await storage.repositories.conversations.get('conversation-1'))?.messages.map((message) => message.id))
        .toEqual(['user-1', 'assistant-1']);
      expect((await storage.repositories.conversations.list())[0]).toMatchObject({
        id: 'conversation-1', isPinned: false
      });
      await storage.repositories.conversations.updateSummary({
        id: 'conversation-1', title: 'Pinned build review', isPinned: true, createdAt: 1, updatedAt: 6
      });
      expect(await storage.repositories.conversations.search('Question')).toMatchObject([
        { id: 'conversation-1', title: 'Pinned build review', isPinned: true }
      ]);
      await storage.repositories.conversations.delete('conversation-1');
      expect(await storage.repositories.conversations.get('conversation-1')).toBeNull();
      expect(storage.database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
      expect(storage.database.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    } finally {
      storage.close();
    }
  });
});
