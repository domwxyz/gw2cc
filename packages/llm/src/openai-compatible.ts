import type {
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmToolCall,
  ModelInfo,
  ProviderId,
  ProviderRuntimeConfiguration
} from '@gw2cc/core';
import { Gw2ccError } from '@gw2cc/core';
import {
  assertProviderResponse,
  fetchProvider,
  joinUrl,
  parseProviderJson,
  parseToolArguments,
  providerHeaders,
  providerStreamError,
  readSseData
} from './streaming';

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content || null,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }))
          }
        : {})
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }
  return { role: message.role, content: message.content };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    readonly id: Extract<ProviderId, 'openrouter' | 'openai-compatible'>,
    private readonly fetchImpl: typeof globalThis.fetch,
    private readonly fixedBaseUrl?: string
  ) {}

  async listModels(configuration: ProviderRuntimeConfiguration, signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await fetchProvider(this.fetchImpl, joinUrl(this.baseUrl(configuration), 'models'), {
      method: 'GET',
      headers: this.headers(configuration),
      signal
    });
    await assertProviderResponse(response);
    const payload = await parseProviderJson(response) as { data?: unknown };
    if (!Array.isArray(payload.data)) return [];
    return payload.data.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as { id?: unknown; name?: unknown };
      return typeof model.id === 'string'
        ? [{ id: model.id, ...(typeof model.name === 'string' ? { name: model.name } : {}) }]
        : [];
    });
  }

  async *stream(
    request: LlmRequest,
    configuration: ProviderRuntimeConfiguration,
    signal: AbortSignal
  ): AsyncIterable<LlmEvent> {
    const response = await fetchProvider(this.fetchImpl, joinUrl(this.baseUrl(configuration), 'chat/completions'), {
      method: 'POST',
      headers: this.headers(configuration, { 'Content-Type': 'application/json' }),
      signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOpenAiMessage),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema
                }
              })),
              tool_choice: 'auto'
            }
          : {})
      })
    });
    await assertProviderResponse(response);
    const pending = new Map<number, PendingToolCall>();
    let finishReason: string | undefined;
    for await (const data of readSseData(response.body)) {
      if (data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw providerStreamError();
      }
      if (chunk?.error) throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'The LLM provider reported an error while streaming.', { retryable: true });
      if (chunk?.usage && typeof chunk.usage === 'object') {
        yield {
          type: 'usage',
          ...(typeof chunk.usage.prompt_tokens === 'number' ? { inputTokens: chunk.usage.prompt_tokens } : {}),
          ...(typeof chunk.usage.completion_tokens === 'number' ? { outputTokens: chunk.usage.completion_tokens } : {})
        };
      }
      const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta?.content === 'string' && delta.content) yield { type: 'text_delta', delta: delta.content };
      if (Array.isArray(delta?.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const index = typeof fragment?.index === 'number' ? fragment.index : pending.size;
          const current = pending.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof fragment?.id === 'string') current.id = fragment.id;
          if (typeof fragment?.function?.name === 'string') current.name += fragment.function.name;
          if (typeof fragment?.function?.arguments === 'string') current.arguments += fragment.function.arguments;
          pending.set(index, current);
        }
      }
    }
    for (const [index, call] of [...pending.entries()].sort(([left], [right]) => left - right)) {
      const normalized: LlmToolCall = {
        id: call.id || `${this.id}-tool-${index}`,
        name: call.name,
        arguments: parseToolArguments(call.arguments)
      };
      yield { type: 'tool_call', call: normalized };
    }
    yield { type: 'completed', ...(finishReason ? { finishReason } : {}) };
  }

  private baseUrl(configuration: ProviderRuntimeConfiguration): string {
    if (this.fixedBaseUrl) return this.fixedBaseUrl;
    if (!configuration.baseUrl) throw new Gw2ccError('VALIDATION_ERROR', 'The OpenAI-compatible base URL is missing.');
    return configuration.baseUrl;
  }

  private headers(
    configuration: ProviderRuntimeConfiguration,
    extra: Record<string, string> = {}
  ): Record<string, string> {
    return providerHeaders(configuration.apiKey, {
      ...extra,
      ...(this.id === 'openrouter' ? { 'X-OpenRouter-Title': 'GW2CC' } : {})
    });
  }
}
