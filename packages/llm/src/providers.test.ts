import { describe, expect, it, vi } from 'vitest';
import type { LlmEvent, LlmProvider, LlmRequest, ProviderRuntimeConfiguration } from '@gw2cc/core';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { OpenAiCompatibleProvider } from './openai-compatible';

const request: LlmRequest = {
  model: 'test-model',
  messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Question' }],
  tools: [{
    name: 'gw2_get_account',
    description: 'Get account',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  }],
  maxTokens: 512
};

const configuration = (providerId: ProviderRuntimeConfiguration['providerId']): ProviderRuntimeConfiguration => ({
  providerId,
  model: 'test-model',
  baseUrl: providerId === 'ollama' ? 'http://127.0.0.1:11434' : 'https://provider.example/v1',
  toolsEnabled: true,
  maxTokens: 512,
  apiKey: 'provider-test-secret'
});

async function collect(provider: LlmProvider, config: ProviderRuntimeConfiguration): Promise<LlmEvent[]> {
  const controller = new AbortController();
  const events: LlmEvent[] = [];
  for await (const event of provider.stream(request, config, controller.signal)) events.push(event);
  return events;
}

const openAiSse = [
  'data: {"choices":[{"delta":{"content":"Checking "},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"gw2_get_","arguments":"{\\""}}]},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"account","arguments":"focus\\":true}"}}]},"finish_reason":"tool_calls"}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
  '',
  'data: [DONE]',
  ''
].join('\n');

describe('provider-neutral streaming contracts', () => {
  for (const providerId of ['openrouter', 'openai-compatible'] as const) {
    it(`normalizes ${providerId} OpenAI-style SSE text and fragmented tool calls`, async () => {
      const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(openAiSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      });
      const provider = new OpenAiCompatibleProvider(
        providerId,
        fetchMock as unknown as typeof fetch,
        providerId === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined
      );
      const events = await collect(provider, configuration(providerId));
      expect(events).toEqual(expect.arrayContaining([
        { type: 'text_delta', delta: 'Checking ' },
        { type: 'tool_call', call: { id: 'call-1', name: 'gw2_get_account', arguments: { focus: true } } },
        { type: 'usage', inputTokens: 12, outputTokens: 7 },
        { type: 'completed', finishReason: 'tool_calls' }
      ]));
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(String(init.body))).toMatchObject({ stream: true, tool_choice: 'auto' });
      expect(String(init.body)).not.toContain('provider-test-secret');
    });
  }

  it('normalizes native Anthropic content blocks and input_json_delta tool use', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"content":[]}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking "}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu-1","name":"gw2_get_account","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      ''
    ].join('\n');
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(sse, { status: 200 });
    });
    const events = await collect(
      new AnthropicProvider(fetchMock as unknown as typeof fetch),
      configuration('anthropic')
    );
    expect(events).toEqual(expect.arrayContaining([
      { type: 'text_delta', delta: 'Checking ' },
      { type: 'tool_call', call: { id: 'toolu-1', name: 'gw2_get_account', arguments: {} } },
      { type: 'completed', finishReason: 'tool_use' }
    ]));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.tools[0]).toMatchObject({ name: 'gw2_get_account', input_schema: { type: 'object' } });
    expect(String(init.body)).not.toContain('provider-test-secret');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('provider-test-secret');
  });

  it('normalizes native Ollama NDJSON text and tool calls', async () => {
    const ndjson = [
      JSON.stringify({ model: 'test-model', message: { role: 'assistant', content: 'Checking ' }, done: false }),
      JSON.stringify({
        model: 'test-model',
        message: { role: 'assistant', content: '', tool_calls: [{ function: { index: 0, name: 'gw2_get_account', arguments: {} } }] },
        done: false
      }),
      JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4 })
    ].join('\n');
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(ndjson, { status: 200 });
    });
    const events = await collect(
      new OllamaProvider(fetchMock as unknown as typeof fetch),
      configuration('ollama')
    );
    expect(events).toEqual(expect.arrayContaining([
      { type: 'text_delta', delta: 'Checking ' },
      { type: 'tool_call', call: { id: 'ollama-tool-0', name: 'gw2_get_account', arguments: {} } },
      { type: 'usage', inputTokens: 10, outputTokens: 4 },
      { type: 'completed', finishReason: 'stop' }
    ]));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'test-model', stream: true });
    expect(String(init.body)).not.toContain('provider-test-secret');
  });

  it('maps malformed provider JSON into a sanitized structured failure', async () => {
    const provider = new OpenAiCompatibleProvider(
      'openai-compatible',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{not-json', { status: 200 }))
    );
    await expect(provider.listModels(configuration('openai-compatible'))).rejects.toMatchObject({
      code: 'LLM_UPSTREAM_ERROR',
      message: 'The LLM provider returned malformed JSON.'
    });
  });
});
