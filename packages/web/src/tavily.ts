import { Gw2ccError } from '@gw2cc/core';
import { z } from 'zod';

const TAVILY_ORIGIN = 'https://api.tavily.com';
const MAX_RESPONSE_BYTES = 1_500_000;

const searchSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string().default(''),
    score: z.number().optional(),
    published_date: z.string().optional()
  }).passthrough()).max(20)
}).passthrough();

const extractSchema = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string() }).passthrough()).max(20),
  failed_results: z.array(z.unknown()).optional()
}).passthrough();

export type TavilySearchPayload = z.infer<typeof searchSchema>;
export type TavilyExtractPayload = z.infer<typeof extractSchema>;

export class TavilyClient {
  constructor(
    private readonly fetchImpl: typeof globalThis.fetch,
    private readonly timeoutMs = 20_000,
    private readonly maxRetries = 1,
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> = (milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Gw2ccError('CANCELLED', 'Web research was cancelled.'));
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Gw2ccError('CANCELLED', 'Web research was cancelled.'));
      }, { once: true });
    })
  ) {}

  search(
    apiKey: string,
    input: { query: string; maxResults: number; includeDomains?: string[] },
    signal?: AbortSignal
  ): Promise<TavilySearchPayload> {
    return this.request('/search', apiKey, {
      query: input.query,
      search_depth: 'basic',
      chunks_per_source: 2,
      max_results: input.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      safe_search: true,
      ...(input.includeDomains?.length ? { include_domains: input.includeDomains } : {})
    }, searchSchema, signal);
  }

  extract(apiKey: string, url: string, query?: string, signal?: AbortSignal): Promise<TavilyExtractPayload> {
    return this.request('/extract', apiKey, {
      urls: url,
      extract_depth: 'basic',
      format: 'markdown',
      include_images: false,
      timeout: 12,
      ...(query ? { query, chunks_per_source: 5 } : {})
    }, extractSchema, signal);
  }

  private async request<T>(
    path: '/search' | '/extract',
    apiKey: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          response = await this.fetchImpl(new URL(path, TAVILY_ORIGIN), {
            method: 'POST',
            redirect: 'error',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted || attempt >= this.maxRetries) throw error;
          await this.sleep(Math.min(2_000, 300 * (2 ** attempt)), controller.signal);
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after') ?? Number.NaN);
          void response.body?.cancel();
          await this.sleep(Number.isFinite(retryAfter) ? Math.min(2_000, Math.max(0, retryAfter * 1_000)) : 300 * (2 ** attempt), controller.signal);
          response = undefined;
          continue;
        }
        break;
      }
      if (!response) throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily exhausted its retry limit.', { retryable: true });
      if (!response.ok) {
        void response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw new Gw2ccError('WEB_AUTH_FAILED', 'Tavily rejected the configured credential.');
        }
        if (response.status === 429) {
          throw new Gw2ccError('WEB_RATE_LIMITED', 'Tavily rate-limited the request. Try again shortly.', { retryable: true });
        }
        throw new Gw2ccError('WEB_FETCH_FAILED', `Tavily returned HTTP ${response.status}.`, {
          retryable: response.status >= 500
        });
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_RESPONSE_BYTES) {
        void response.body?.cancel();
        throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily returned an oversized response.');
      }
      const bytes = await this.readBounded(response.body, controller.signal);
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily returned malformed JSON.', { retryable: true, cause: error });
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily returned an unexpected response shape.', {
          retryable: true,
          details: { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message) }
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof Gw2ccError) {
        if (error.code === 'CANCELLED' && !signal?.aborted && controller.signal.aborted) {
          throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily request timed out.', { retryable: true });
        }
        throw error;
      }
      if (controller.signal.aborted && signal?.aborted) throw new Gw2ccError('CANCELLED', 'Web research was cancelled.');
      if (controller.signal.aborted) throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily request timed out.', { retryable: true });
      throw new Gw2ccError('WEB_FETCH_FAILED', 'Could not reach Tavily.', { retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async readBounded(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
    if (!body) throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily returned an empty response body.', { retryable: true });
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Gw2ccError('CANCELLED', 'Web research was cancelled.');
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Gw2ccError('WEB_FETCH_FAILED', 'Tavily returned an oversized response.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}
