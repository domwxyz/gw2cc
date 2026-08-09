import type {
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  ModelInfo,
  ProviderRuntimeConfiguration
} from '@gw2cc/core';
import { Gw2ccError } from '@gw2cc/core';
import {
  assertProviderResponse,
  fetchProvider,
  joinUrl,
  parseProviderJson,
  parseToolArguments,
  providerStreamError,
  readSseData
} from './streaming';

const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_384;

function anthropicHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) throw new Gw2ccError('LLM_KEY_MISSING', 'An Anthropic API key is required.');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
}

function toAnthropicMessages(messages: LlmMessage[]): { system: string; messages: Array<Record<string, unknown>> } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const converted: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
  const append = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>) => {
    const previous = converted.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else converted.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      append('assistant', [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: 'tool_use', id: call.id, name: call.name, input: call.arguments
        }))
      ]);
    } else if (message.role === 'tool') {
      append('user', [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content
      }]);
    } else {
      append('user', [{ type: 'text', text: message.content }]);
    }
  }
  return { system, messages: converted };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly fetchImpl: typeof globalThis.fetch,
    private readonly baseUrl = 'https://api.anthropic.com/v1'
  ) {}

  async listModels(configuration: ProviderRuntimeConfiguration, signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await fetchProvider(this.fetchImpl, joinUrl(this.baseUrl, 'models?limit=1000'), {
      method: 'GET',
      headers: anthropicHeaders(configuration.apiKey),
      signal
    });
    await assertProviderResponse(response);
    const payload = await parseProviderJson(response) as { data?: unknown };
    if (!Array.isArray(payload.data)) return [];
    return payload.data.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as { id?: unknown; display_name?: unknown };
      if (typeof model.id !== 'string') return [];
      return [{ id: model.id, ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}) }];
    });
  }

  async *stream(
    request: LlmRequest,
    configuration: ProviderRuntimeConfiguration,
    signal: AbortSignal
  ): AsyncIterable<LlmEvent> {
    const normalized = toAnthropicMessages(request.messages);
    const maxTokens = request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    const response = await fetchProvider(this.fetchImpl, joinUrl(this.baseUrl, 'messages'), {
      method: 'POST',
      headers: anthropicHeaders(configuration.apiKey),
      signal,
      body: JSON.stringify({
        model: request.model,
        system: normalized.system,
        messages: normalized.messages,
        max_tokens: maxTokens,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema
              }))
            }
          : {})
      })
    });
    await assertProviderResponse(response);
    const toolBlocks = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: string | undefined;
    for await (const data of readSseData(response.body)) {
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        throw providerStreamError();
      }
      if (event?.type === 'error') throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'Anthropic reported an error while streaming.', { retryable: true });
      if (event?.type === 'message_start' && event.message?.usage) {
        const usage = event.message.usage;
        yield {
          type: 'usage',
          ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
          ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
          ...(typeof usage.output_tokens_details?.thinking_tokens === 'number'
            ? { reasoningTokens: usage.output_tokens_details.thinking_tokens }
            : {})
        };
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolBlocks.set(event.index, {
          id: String(event.content_block.id ?? `anthropic-tool-${event.index}`),
          name: String(event.content_block.name ?? ''),
          arguments: ''
        });
      } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (typeof event.delta.text === 'string' && event.delta.text) yield { type: 'text_delta', delta: event.delta.text };
      } else if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        if (typeof event.delta.thinking === 'string' && event.delta.thinking) {
          yield { type: 'reasoning_delta', delta: event.delta.thinking };
        }
      } else if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const block = toolBlocks.get(event.index);
        if (block && typeof event.delta.partial_json === 'string') block.arguments += event.delta.partial_json;
      } else if (event?.type === 'message_delta') {
        if (typeof event.delta?.stop_reason === 'string') finishReason = event.delta.stop_reason;
        yield {
          type: 'usage',
          ...(typeof event.usage?.input_tokens === 'number' ? { inputTokens: event.usage.input_tokens } : {}),
          ...(typeof event.usage?.output_tokens === 'number' ? { outputTokens: event.usage.output_tokens } : {}),
          ...(typeof event.usage?.output_tokens_details?.thinking_tokens === 'number'
            ? { reasoningTokens: event.usage.output_tokens_details.thinking_tokens }
            : {})
        };
      }
    }
    for (const [index, block] of [...toolBlocks.entries()].sort(([left], [right]) => left - right)) {
      yield {
        type: 'tool_call',
        call: {
          id: block.id || `anthropic-tool-${index}`,
          name: block.name,
          arguments: parseToolArguments(block.arguments)
        }
      };
    }
    yield { type: 'completed', ...(finishReason ? { finishReason } : {}) };
  }
}
