import type {
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  ModelInfo,
  ProviderRuntimeConfiguration
} from '@gw2cc/core';
import { Gw2ccError } from '@gw2cc/core';
import { assertProviderResponse, fetchProvider, joinUrl, parseProviderJson, parseToolArguments, providerHeaders, providerStreamError, readLines } from './streaming';

function toOllamaMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.reasoning ? { thinking: message.reasoning } : {}),
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call, index) => ({
              type: 'function',
              function: { index, name: call.name, arguments: call.arguments }
            }))
          }
        : {})
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_name: message.toolName, content: message.content };
  }
  return { role: message.role, content: message.content };
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;

  constructor(private readonly fetchImpl: typeof globalThis.fetch) {}

  async listModels(configuration: ProviderRuntimeConfiguration, signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await fetchProvider(this.fetchImpl, joinUrl(this.baseUrl(configuration), 'api/tags'), {
      method: 'GET',
      headers: providerHeaders(configuration.apiKey),
      signal
    });
    await assertProviderResponse(response);
    const payload = await parseProviderJson(response) as { models?: unknown };
    if (!Array.isArray(payload.models)) return [];
    return payload.models.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as { model?: unknown; name?: unknown };
      const id = typeof model.model === 'string' ? model.model : typeof model.name === 'string' ? model.name : undefined;
      return id ? [{ id, ...(typeof model.name === 'string' ? { name: model.name } : {}) }] : [];
    });
  }

  async *stream(
    request: LlmRequest,
    configuration: ProviderRuntimeConfiguration,
    signal: AbortSignal
  ): AsyncIterable<LlmEvent> {
    const response = await fetchProvider(this.fetchImpl, joinUrl(this.baseUrl(configuration), 'api/chat'), {
      method: 'POST',
      headers: providerHeaders(configuration.apiKey, { 'Content-Type': 'application/json' }),
      signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOllamaMessage),
        stream: true,
        ...(request.maxTokens !== undefined || request.temperature !== undefined
          ? {
              options: {
                ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
              }
            }
          : {}),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
              }))
            }
          : {})
      })
    });
    await assertProviderResponse(response);
    const toolCalls = new Map<number, { name: string; arguments: unknown }>();
    let finishReason: string | undefined;
    for await (const line of readLines(response.body)) {
      if (!line.trim()) continue;
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        throw providerStreamError();
      }
      if (chunk?.error) throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'Ollama reported an error while streaming.');
      if (typeof chunk?.message?.thinking === 'string' && chunk.message.thinking) {
        yield { type: 'reasoning_delta', delta: chunk.message.thinking };
      }
      if (typeof chunk?.message?.content === 'string' && chunk.message.content) {
        yield { type: 'text_delta', delta: chunk.message.content };
      }
      if (Array.isArray(chunk?.message?.tool_calls)) {
        for (const [position, call] of chunk.message.tool_calls.entries()) {
          const index = typeof call?.function?.index === 'number' ? call.function.index : position;
          const rawArguments = call?.function?.arguments;
          toolCalls.set(index, {
            name: typeof call?.function?.name === 'string' ? call.function.name : '',
            arguments: typeof rawArguments === 'string' ? parseToolArguments(rawArguments) : rawArguments ?? {}
          });
        }
      }
      if (chunk?.done) {
        finishReason = typeof chunk.done_reason === 'string' ? chunk.done_reason : 'stop';
        yield {
          type: 'usage',
          ...(typeof chunk.prompt_eval_count === 'number' ? { inputTokens: chunk.prompt_eval_count } : {}),
          ...(typeof chunk.eval_count === 'number' ? { outputTokens: chunk.eval_count } : {})
        };
      }
    }
    for (const [index, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      yield {
        type: 'tool_call',
        call: { id: `ollama-tool-${index}`, name: call.name, arguments: call.arguments }
      };
    }
    yield { type: 'completed', ...(finishReason ? { finishReason } : {}) };
  }

  private baseUrl(configuration: ProviderRuntimeConfiguration): string {
    if (!configuration.baseUrl) throw new Gw2ccError('VALIDATION_ERROR', 'The Ollama base URL is missing.');
    return configuration.baseUrl;
  }
}
