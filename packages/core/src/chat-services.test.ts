import { describe, expect, it } from 'vitest';
import { FixtureGw2Gateway } from '@gw2cc/gw2';
import { openSqlite } from '@gw2cc/storage';
import { Gw2ToolExecutor } from '@gw2cc/tools';
import { FixtureResearchGateway } from '@gw2cc/web';
import { createGw2ccApplication } from './application';
import type { Gw2ccEvent, LlmEvent, LlmRequest, ProviderRuntimeConfiguration } from './chat-domain';
import { InMemorySecretStore } from './memory';
import { ResearchService } from './research';
import type { LlmProvider, ToolExecutor } from './ports';

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

function waitForTerminal(subscribe: (listener: (event: Gw2ccEvent) => void) => () => void): Promise<Gw2ccEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for chat event.')), 2_000);
    const unsubscribe = subscribe((event) => {
      if (event.type === 'chat.completed' || event.type === 'chat.failed' || event.type === 'chat.cancelled') {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

function createHarness(provider: LlmProvider, tools?: ToolExecutor, timeZone = 'UTC') {
  const storage = openSqlite(':memory:');
  const gw2 = new FixtureGw2Gateway();
  const secrets = new InMemorySecretStore('fixture-key', true);
  const research = new ResearchService(new FixtureResearchGateway(), secrets);
  let now = 100;
  const application = createGw2ccApplication({
    gw2,
    repositories: storage.repositories,
    secrets,
    llmProviders: { get: (providerId) => providerId === 'fixture' ? provider : undefined },
    tools: tools ?? new Gw2ToolExecutor(gw2, secrets, storage.repositories.account),
    research,
    timeZone,
    clock: { now: () => ++now },
    createId: ids()
  });
  return { storage, application };
}

class ToolThenAnswerProvider implements LlmProvider {
  readonly id = 'fixture' as const;
  requests: LlmRequest[] = [];

  async listModels() { return [{ id: 'fixture-gw2-assistant' }]; }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    if (!request.messages.some((message) => message.role === 'tool')) {
      yield { type: 'reasoning_delta', delta: 'Need current character attributes.' };
      yield { type: 'tool_call', call: { id: 'tool-call-1', name: 'gw2_get_character_attributes', arguments: {} } };
      yield { type: 'completed', finishReason: 'tool_calls' };
    } else {
      yield { type: 'reasoning_delta', delta: 'The tool result is sufficient.' };
      yield { type: 'text_delta', delta: 'Tool-backed ' };
      yield { type: 'text_delta', delta: 'answer.' };
      yield { type: 'usage', inputTokens: 20, outputTokens: 8, reasoningTokens: 3 };
      yield { type: 'completed', finishReason: 'stop' };
    }
  }
}

describe('ChatService bounded orchestration', () => {
  it('persists focused messages, executes a real GW2 tool round, streams events, and keeps chat account-wide across focus changes', async () => {
    const provider = new ToolThenAnswerProvider();
    const harness = createHarness(provider);
    try {
      await harness.application.bootstrap(true);
      const events: Gw2ccEvent[] = [];
      const unsubscribe = harness.application.chat.subscribe((event) => events.push(event));
      const terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Inspect my baseline.');
      const terminal = await terminalPromise;
      expect(terminal.type).toBe('chat.completed');
      const firstConversation = await harness.application.conversations.getPrimary();
      expect(firstConversation.title).toBe('Inspect my baseline.');
      expect(firstConversation.isPinned).toBe(false);
      expect(firstConversation.messages).toMatchObject([
        { role: 'user', focusedCharacterName: 'Aurelia Ward', content: 'Inspect my baseline.' },
        {
          role: 'assistant', focusedCharacterName: 'Aurelia Ward', content: 'Tool-backed answer.', status: 'complete',
          reasoningTrace: {
            content: 'Need current character attributes.\n\nThe tool result is sufficient.',
            inputTokens: 20, outputTokens: 8, reasoningTokens: 3, finishReason: 'stop'
          }
        }
      ]);
      expect(firstConversation.toolCalls[0]).toMatchObject({
        toolName: 'gw2_get_character_attributes', status: 'completed'
      });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        'chat.started', 'chat.reasoningDelta', 'chat.toolStarted', 'chat.toolCompleted', 'chat.textDelta', 'chat.completed'
      ]));
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0]).not.toHaveProperty('maxTokens');
      expect(provider.requests[1]!.messages.some((message) => message.role === 'tool')).toBe(true);
      expect(provider.requests[1]!.messages.find((message) => message.role === 'assistant')).toMatchObject({
        reasoning: 'Need current character attributes.'
      });

      await harness.application.selectCharacter('Sylvari Ranger');
      const before = (await harness.application.conversations.getPrimary()).id;
      const secondTerminal = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Now inspect the ranger.');
      await secondTerminal;
      const after = await harness.application.conversations.getPrimary();
      expect(after.id).toBe(before);
      expect(after.messages.at(-2)).toMatchObject({ role: 'user', focusedCharacterName: 'Sylvari Ranger' });
      unsubscribe();
    } finally {
      harness.storage.close();
    }
  });

  it('propagates the application-injected IANA timezone to tool execution context', async () => {
    let receivedTimeZone: string | undefined;
    const tools: ToolExecutor = {
      definitions: () => [],
      execute: async (_call, context) => {
        receivedTimeZone = context.timeZone;
        return { ok: true, value: { inspected: true }, summary: 'inspected', truncated: false };
      }
    };
    const harness = createHarness(new ToolThenAnswerProvider(), tools, 'America/Chicago');
    try {
      await harness.application.bootstrap(true);
      const terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Inspect timezone context.');
      await terminalPromise;
      expect(receivedTimeZone).toBe('America/Chicago');
    } finally {
      harness.storage.close();
    }
  });

  it('persists and frames text attachments, including attachment-only retries and forks', async () => {
    const provider = new ToolThenAnswerProvider();
    const harness = createHarness(provider);
    const attachment = {
      type: 'text' as const,
      name: 'rotation.md',
      mediaType: 'text/markdown' as const,
      content: '# Rotation\nUse skill two first.',
      size: 31
    };
    try {
      await harness.application.bootstrap(true);
      let terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('', undefined, [attachment]);
      await terminalPromise;

      const original = await harness.application.conversations.getPrimary();
      expect(original.title).toBe('Attached rotation.md');
      expect(original.messages[0]).toMatchObject({ content: '', attachments: [attachment] });
      const framedUserMessage = provider.requests[0]!.messages.find((message) => message.role === 'user');
      expect(framedUserMessage?.content).toContain('BEGIN USER-ATTACHED FILE ("rotation.md", text/markdown)');
      expect(framedUserMessage?.content).toContain('# Rotation\nUse skill two first.');

      terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.retry(original.messages[1]!.id);
      await terminalPromise;
      const retried = await harness.application.conversations.getPrimary();
      expect(retried.messages[0]).toMatchObject({ content: '', attachments: [attachment] });

      terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.edit(retried.messages[0]!.id, '');
      await terminalPromise;
      const edited = await harness.application.conversations.getPrimary();
      expect(edited.messages[0]).toMatchObject({ content: '', attachments: [attachment] });

      const forked = await harness.application.conversations.fork(edited.id, edited.messages[1]!.id);
      expect(forked.messages[0]).toMatchObject({ attachments: [attachment] });
    } finally {
      harness.storage.close();
    }
  });

  it('retries and edits the latest turn in place, then forks the complete trace with tool placement', async () => {
    const provider = new ToolThenAnswerProvider();
    const harness = createHarness(provider);
    try {
      await harness.application.bootstrap(true);
      let terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Review this build.');
      await terminalPromise;
      const original = await harness.application.conversations.getPrimary();
      expect(original.messages).toHaveLength(2);
      expect(original.toolCalls).toMatchObject([{ contentOffset: 0, status: 'completed' }]);

      terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.retry(original.messages[1]!.id);
      await terminalPromise;
      const retried = await harness.application.conversations.getPrimary();
      expect(retried.messages).toHaveLength(2);
      expect(retried.messages[0]).toMatchObject({ role: 'user', content: 'Review this build.' });
      expect(retried.messages[0]!.id).not.toBe(original.messages[0]!.id);
      expect(retried.toolCalls).toHaveLength(1);

      terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.edit(retried.messages[0]!.id, 'Review this refined build.');
      await terminalPromise;
      const edited = await harness.application.conversations.getPrimary();
      expect(edited.messages).toHaveLength(2);
      expect(edited.messages[0]).toMatchObject({ role: 'user', content: 'Review this refined build.' });
      expect(edited.toolCalls).toMatchObject([{ contentOffset: 0, status: 'completed' }]);

      const forked = await harness.application.conversations.fork(edited.id, edited.messages[1]!.id);
      expect(forked).toMatchObject({ title: 'Review this build. (fork)', isPinned: false });
      expect(forked.messages).toHaveLength(2);
      expect(forked.toolCalls).toMatchObject([{ contentOffset: 0, status: 'completed' }]);
      expect(forked.messages.map((message) => message.id)).not.toEqual(edited.messages.map((message) => message.id));
      expect((await harness.application.conversations.getPrimary()).id).toBe(forked.id);
      expect((await harness.application.conversations.get(edited.id)).messages).toHaveLength(2);
    } finally {
      harness.storage.close();
    }
  });

  it('allows a model to complete after more than four distinct tool rounds', async () => {
    let round = 0;
    const provider: LlmProvider = {
      id: 'fixture',
      listModels: async () => [{ id: 'fixture-gw2-assistant' }],
      async *stream() {
        if (round < 6) {
          round += 1;
          yield {
            type: 'tool_call',
            call: { id: `progress-tool-${round}`, name: 'test_progress', arguments: { page: round } }
          };
        } else {
          yield { type: 'text_delta', delta: 'Finished after six tool rounds.' };
          yield { type: 'completed', finishReason: 'stop' };
        }
      }
    };
    const tools: ToolExecutor = {
      definitions: () => [],
      execute: async (call) => ({ ok: true, value: { page: call.arguments }, summary: 'progress', truncated: false })
    };
    const harness = createHarness(provider, tools);
    try {
      await harness.application.bootstrap(true);
      const terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Use as many distinct tool rounds as needed.');
      const terminal = await terminalPromise;
      expect(terminal).toMatchObject({ type: 'chat.completed', message: { content: 'Finished after six tool rounds.' } });
      expect((await harness.application.conversations.getPrimary()).toolCalls).toHaveLength(6);
    } finally {
      harness.storage.close();
    }
  });

  it('stops a provider loop that repeats the exact same tool round without progress', async () => {
    let call = 0;
    const provider: LlmProvider = {
      id: 'fixture',
      listModels: async () => [{ id: 'fixture-gw2-assistant' }],
      async *stream() {
        yield {
          type: 'tool_call',
          call: { id: `loop-tool-${++call}`, name: 'test_loop', arguments: { page: 0 } }
        };
      }
    };
    const tools: ToolExecutor = {
      definitions: () => [],
      execute: async () => ({ ok: true, value: { page: 0 }, summary: 'same result', truncated: false })
    };
    const harness = createHarness(provider, tools);
    try {
      await harness.application.bootstrap(true);
      const terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Repeat forever.');
      const terminal = await terminalPromise;
      expect(terminal).toMatchObject({
        type: 'chat.failed',
        error: { code: 'LLM_UPSTREAM_ERROR', message: expect.stringContaining('without making progress') }
      });
      expect((await harness.application.conversations.getPrimary()).toolCalls).toHaveLength(2);
    } finally {
      harness.storage.close();
    }
  });

  it('cancels provider streaming and persists the partial assistant message as cancelled', async () => {
    const provider: LlmProvider = {
      id: 'fixture',
      listModels: async () => [{ id: 'fixture-gw2-assistant' }],
      async *stream(_request: LlmRequest, _configuration: ProviderRuntimeConfiguration, signal: AbortSignal) {
        yield { type: 'text_delta', delta: 'Partial' };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
    };
    const harness = createHarness(provider);
    try {
      await harness.application.bootstrap(true);
      const terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      const firstDelta = new Promise<void>((resolve) => {
        const unsubscribe = harness.application.chat.subscribe((event) => {
          if (event.type === 'chat.textDelta') {
            unsubscribe();
            resolve();
          }
        });
      });
      const run = await harness.application.chat.send('Cancel this.');
      await firstDelta;
      await harness.application.chat.cancel(run.runId);
      const terminal = await terminalPromise;
      expect(terminal).toMatchObject({ type: 'chat.cancelled', message: { content: 'Partial', status: 'cancelled' } });
    } finally {
      harness.storage.close();
    }
  });

  it('exposes provider reasoning and fails visibly when the token budget ends without a final answer', async () => {
    const provider: LlmProvider = {
      id: 'fixture',
      listModels: async () => [{ id: 'fixture-gw2-assistant' }],
      async *stream() {
        yield { type: 'reasoning_delta', delta: 'I inspected the supplied context but used the remaining budget.' };
        yield { type: 'usage', inputTokens: 80, outputTokens: 32, reasoningTokens: 32 };
        yield { type: 'completed', finishReason: 'length' };
      }
    };
    const harness = createHarness(provider);
    try {
      await harness.application.bootstrap(true);
      const events: Gw2ccEvent[] = [];
      const unsubscribe = harness.application.chat.subscribe((event) => events.push(event));
      const terminalPromise = waitForTerminal((listener) => harness.application.chat.subscribe(listener));
      await harness.application.chat.send('Diagnose the empty turn.');
      const terminal = await terminalPromise;
      expect(terminal).toMatchObject({
        type: 'chat.failed',
        message: {
          content: '',
          status: 'failed',
          reasoningTrace: {
            content: 'I inspected the supplied context but used the remaining budget.',
            inputTokens: 80,
            outputTokens: 32,
            reasoningTokens: 32,
            finishReason: 'length'
          }
        },
        error: {
          code: 'LLM_UPSTREAM_ERROR',
          message: expect.stringContaining('its own output limit'),
          details: { finishReason: 'length', reasoningTokens: 32 }
        }
      });
      expect(events.some((event) => event.type === 'chat.reasoningDelta')).toBe(true);
      expect((await harness.application.conversations.getPrimary()).messages.at(-1)).toMatchObject({
        status: 'failed', reasoningTrace: { finishReason: 'length', reasoningTokens: 32 }
      });
      unsubscribe();
    } finally {
      harness.storage.close();
    }
  });

  it('fails safely on malformed provider events and converts malformed tool outcomes into structured failures', async () => {
    const malformedProvider: LlmProvider = {
      id: 'fixture',
      listModels: async () => [{ id: 'fixture-gw2-assistant' }],
      async *stream() {
        yield { type: 'text_delta', delta: 42 } as any;
      }
    };
    const malformedHarness = createHarness(malformedProvider);
    try {
      await malformedHarness.application.bootstrap(true);
      const terminalPromise = waitForTerminal((listener) => malformedHarness.application.chat.subscribe(listener));
      await malformedHarness.application.chat.send('Malformed provider event.');
      await expect(terminalPromise).resolves.toMatchObject({ type: 'chat.failed', error: { code: 'LLM_UPSTREAM_ERROR' } });
    } finally {
      malformedHarness.storage.close();
    }

    const toolProvider: LlmProvider = {
      id: 'fixture',
      listModels: async () => [{ id: 'fixture-gw2-assistant' }],
      async *stream(request) {
        if (!request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'tool_call', call: { id: 'malformed-tool', name: 'malformed_read', arguments: {} } };
        } else {
          yield { type: 'text_delta', delta: 'Handled malformed tool data.' };
          yield { type: 'completed' };
        }
      }
    };
    const malformedTools: ToolExecutor = {
      definitions: () => [{ name: 'malformed_read', description: 'test', inputSchema: { type: 'object' } }],
      execute: async () => ({ unexpected: true }) as any
    };
    const toolHarness = createHarness(toolProvider, malformedTools);
    try {
      await toolHarness.application.bootstrap(true);
      const terminalPromise = waitForTerminal((listener) => toolHarness.application.chat.subscribe(listener));
      await toolHarness.application.chat.send('Malformed tool response.');
      await expect(terminalPromise).resolves.toMatchObject({ type: 'chat.completed' });
      expect((await toolHarness.application.conversations.getPrimary()).toolCalls[0]).toMatchObject({
        status: 'failed',
        result: { error: { code: 'VALIDATION_ERROR', message: 'A read-only tool returned a malformed response.' } }
      });
    } finally {
      toolHarness.storage.close();
    }
  });

  it('manages searchable, selectable, pinnable, renamable, and deletable conversations', async () => {
    const harness = createHarness(new ToolThenAnswerProvider());
    try {
      await harness.application.bootstrap(true);
      const primary = await harness.application.conversations.getPrimary();
      const second = await harness.application.conversations.create('Build lab');
      expect(second.isPinned).toBe(false);
      expect((await harness.application.conversations.getPrimary()).id).toBe(second.id);

      const renamed = await harness.application.conversations.rename(second.id, 'WvW build lab');
      expect(renamed.title).toBe('WvW build lab');
      const pinned = await harness.application.conversations.setPinned(second.id, true);
      expect(pinned.isPinned).toBe(true);
      expect((await harness.application.conversations.search('WvW')).map((entry) => entry.id)).toEqual([second.id]);

      await harness.application.conversations.select(primary.id);
      expect((await harness.application.conversations.getPrimary()).id).toBe(primary.id);
      const afterDelete = await harness.application.conversations.delete(second.id);
      expect(afterDelete.id).toBe(primary.id);
      expect((await harness.application.conversations.list()).map((entry) => entry.id)).toEqual([primary.id]);
    } finally {
      harness.storage.close();
    }
  });
});
