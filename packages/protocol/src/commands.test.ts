import { describe, expect, it, vi } from 'vitest';
import { createGw2ccApplication, InMemorySecretStore, ResearchService } from '@gw2cc/core';
import { FixtureGw2Gateway } from '@gw2cc/gw2';
import { FixtureLlmProvider, StaticLlmProviderRegistry } from '@gw2cc/llm';
import { openSqlite } from '@gw2cc/storage';
import { CompositeToolExecutor, Gw2ToolExecutor, WebResearchToolExecutor } from '@gw2cc/tools';
import { FixtureResearchGateway } from '@gw2cc/web';
import { createGw2ccClient } from './client';
import { handleProtocolRequest } from './commands';

function createHarness() {
  const storage = openSqlite(':memory:');
  const gw2 = new FixtureGw2Gateway();
  const secrets = new InMemorySecretStore('fixture-key', true);
  const research = new ResearchService(new FixtureResearchGateway(), secrets);
  const application = createGw2ccApplication({
    gw2,
    repositories: storage.repositories,
    secrets,
    llmProviders: new StaticLlmProviderRegistry([new FixtureLlmProvider()]),
    tools: new CompositeToolExecutor([
      new Gw2ToolExecutor(gw2, secrets, storage.repositories.account),
      new WebResearchToolExecutor(research)
    ]),
    research,
    clock: { now: () => 123 }
  });
  const openExternal = vi.fn(async () => {});
  const eventListeners = new Set<(event: unknown) => void>();
  const unsubscribeApplication = application.chat.subscribe((event) => {
    for (const listener of eventListeners) listener(event);
  });
  const client = createGw2ccClient({
    invoke: (request) => handleProtocolRequest(application, request, { openExternal }),
    subscribe: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }
  });
  return { storage, application, client, openExternal, unsubscribeApplication };
}

describe('transport-neutral protocol validation', () => {
  it('validates and dispatches bootstrap, character selection, lore, and item inspection', async () => {
    const harness = createHarness();
    try {
      const first = await harness.client.request('app.bootstrap', {});
      expect(first.connection.selectedCharacterName).toBe('Aurelia Ward');
      expect(first.snapshot?.equipment.length).toBeGreaterThan(5);
      expect(first.research).toMatchObject({ searchAvailable: true, directFetchAvailable: true, fixtureMode: true });
      await expect(harness.client.request('research.settings.test', {})).resolves.toMatchObject({ ok: true, resultCount: 1 });

      const second = await harness.client.request('characters.select', { name: 'Sylvari Ranger' });
      expect(second.snapshot?.character.name).toBe('Sylvari Ranger');
      await expect(harness.client.request('characters.lore.set', { value: 'Persistent ranger lore' }))
        .resolves.toEqual({ value: 'Persistent ranger lore' });
      const itemId = second.snapshot!.equipment[0]!.itemId;
      await expect(harness.client.request('equipment.inspectItem', { itemId }))
        .resolves.toMatchObject({ itemId });
    } finally {
      harness.storage.close();
    }
  });

  it('rejects malformed commands and unsafe external URLs with structured validation errors', async () => {
    const harness = createHarness();
    try {
      const malformed = await handleProtocolRequest(
        harness.application,
        { command: 'equipment.inspectItem', input: { itemId: -1, extra: true } },
        { openExternal: harness.openExternal }
      );
      expect(malformed).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      await expect(harness.client.request('app.openExternal', { url: 'https://example.com' }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(harness.openExternal).not.toHaveBeenCalled();
    } finally {
      harness.storage.close();
    }
  });

  it('validates provider/chat commands and streams transport-neutral chat/tool events', async () => {
    const harness = createHarness();
    try {
      await harness.client.request('app.bootstrap', {});
      await expect(harness.client.request('provider.settings.get', {})).resolves.toMatchObject({
        configuration: { providerId: 'fixture', model: 'fixture-gw2-assistant' },
        ready: true
      });
      const terminal = new Promise<string>((resolve) => {
        const unsubscribe = harness.client.subscribe((event) => {
          if (event.type === 'chat.completed') {
            unsubscribe();
            resolve(event.message.content);
          }
        });
      });
      const run = await harness.client.request('chat.send', {
        content: 'Inspect my attributes.',
        attachments: [{
          type: 'text', name: 'goals.txt', mediaType: 'text/plain',
          content: 'Prioritize survivability.', size: 24
        }]
      });
      expect(run.runId).toBeTruthy();
      await expect(terminal).resolves.toContain('fixture-backed live ArenaNet account data');
      const conversation = await harness.client.request('conversations.get', {});
      expect(conversation.messages).toHaveLength(2);
      expect(conversation.messages[0]).toMatchObject({
        attachments: [{ name: 'goals.txt', content: 'Prioritize survivability.' }]
      });
      expect(conversation.messages[1]).toMatchObject({
        reasoningTrace: {
          content: expect.stringContaining('fixture tool provenance'),
          inputTokens: 240,
          outputTokens: 72,
          reasoningTokens: 14,
          finishReason: 'stop'
        }
      });
      expect(conversation.toolCalls.map((call) => call.toolName)).toEqual([
        'gw2_get_bank', 'gw2_wiki_search', 'fetch_url'
      ]);
      expect(conversation.toolCalls.every((call) => call.status === 'completed')).toBe(true);
      expect(conversation.toolCalls.every((call) => call.contentOffset === 0)).toBe(true);

      const forked = await harness.client.request('conversations.fork', {
        id: conversation.id,
        messageId: conversation.messages[1]!.id
      });
      expect(forked).toMatchObject({ title: 'Inspect my attributes. (fork)', isPinned: false });
      expect(forked.messages).toHaveLength(2);
      expect(forked.toolCalls).toHaveLength(3);
      await harness.client.request('conversations.select', { id: conversation.id });

      const editedTerminal = new Promise<void>((resolve) => {
        const unsubscribe = harness.client.subscribe((event) => {
          if (event.type === 'chat.completed') {
            unsubscribe();
            resolve();
          }
        });
      });
      await harness.client.request('chat.edit', {
        messageId: conversation.messages[0]!.id,
        content: 'Inspect my edited attributes.'
      });
      await editedTerminal;
      await expect(harness.client.request('conversations.get', { id: conversation.id })).resolves.toMatchObject({
        messages: [{
          role: 'user', content: 'Inspect my edited attributes.',
          attachments: [{ name: 'goals.txt', content: 'Prioritize survivability.' }]
        }, { role: 'assistant', status: 'complete' }]
      });

      const second = await harness.client.request('conversations.create', { title: 'Build notes' });
      await expect(harness.client.request('conversations.rename', { id: second.id, title: 'Pinned build notes' }))
        .resolves.toMatchObject({ title: 'Pinned build notes' });
      await expect(harness.client.request('conversations.setPinned', { id: second.id, isPinned: true }))
        .resolves.toMatchObject({ isPinned: true });
      await expect(harness.client.request('conversations.search', { query: 'Pinned' }))
        .resolves.toMatchObject([{ id: second.id, isPinned: true }]);
      await expect(harness.client.request('conversations.select', { id: conversation.id }))
        .resolves.toMatchObject({ id: conversation.id });
      await expect(harness.client.request('conversations.delete', { id: second.id }))
        .resolves.toMatchObject({ id: conversation.id });
    } finally {
      harness.unsubscribeApplication();
      harness.storage.close();
    }
  });
});
