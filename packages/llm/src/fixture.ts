import type {
  LlmEvent,
  LlmProvider,
  LlmRequest,
  ModelInfo,
  ProviderRuntimeConfiguration
} from '@gw2cc/core';
import { Gw2ccError } from '@gw2cc/core';

export class FixtureLlmProvider implements LlmProvider {
  readonly id = 'fixture' as const;

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'fixture-gw2-assistant', name: 'Fixture GW2 Assistant' }];
  }

  async *stream(
    request: LlmRequest,
    _configuration: ProviderRuntimeConfiguration,
    signal: AbortSignal
  ): AsyncIterable<LlmEvent> {
    if (signal.aborted) throw new Gw2ccError('CANCELLED', 'Generation was cancelled.');
    const toolResults = request.messages.filter((message) => message.role === 'tool');
    if (toolResults.length === 0) {
      yield {
        type: 'tool_call',
        call: { id: 'fixture-tool-bank', name: 'gw2_get_bank', arguments: { limit: 20 } }
      };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    if (toolResults.length === 1) {
      yield {
        type: 'tool_call',
        call: { id: 'fixture-tool-wiki-search', name: 'gw2_wiki_search', arguments: { query: 'account bank', maxResults: 3 } }
      };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    if (toolResults.length === 2) {
      yield {
        type: 'tool_call',
        call: { id: 'fixture-tool-wiki-fetch', name: 'fetch_url', arguments: { url: 'https://wiki.guildwars2.com/wiki/Bank', query: 'account bank storage' } }
      };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    let bankSlots: number | undefined;
    try {
      const result = JSON.parse(toolResults[0]!.content) as any;
      bankSlots = result?.payload?.data?.entries?.length;
    } catch {
      // The fixture still returns a deterministic final answer for structured tool errors.
    }
    yield { type: 'reasoning_delta', delta: 'Reviewed the fixture tool provenance and prepared a bounded answer.' };
    for (const delta of [
      'I combined the fixture-backed live ArenaNet account data with external Guild Wars 2 Wiki research. ',
      bankSlots === undefined ? 'The bank result was bounded but did not expose a slot count.' : `The fixture bank has ${bankSlots} non-empty returned slots.`,
      ' The Wiki page is untrusted external research—not ArenaNet API data—and its embedded instructions were ignored.'
    ]) {
      if (signal.aborted) throw new Gw2ccError('CANCELLED', 'Generation was cancelled.');
      yield { type: 'text_delta', delta };
      await Promise.resolve();
    }
    yield { type: 'usage', inputTokens: 240, outputTokens: 72, reasoningTokens: 14 };
    yield { type: 'completed', finishReason: 'stop' };
  }
}
