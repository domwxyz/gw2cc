import { Gw2ccError, type QueryValue } from '@gw2cc/core';
import type { z } from 'zod';

export const GW2_API_ORIGIN = 'https://api.guildwars2.com';
export const GW2_SCHEMA_VERSION = '2025-08-29T01:00:00.000Z';

export function validateGw2V2Path(path: string): asserts path is `/v2/${string}` {
  if (
    !path.startsWith('/v2/') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Gw2ccError('VALIDATION_ERROR', 'GW2 paths must be a clean absolute path under /v2/.');
  }
}

export interface Gw2HttpClientOptions {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class Gw2HttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: Gw2HttpClientOptions) {
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 5_000_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 250;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 2_000;
    this.sleep = options.sleep ?? ((milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Gw2ccError('CANCELLED', 'The GW2 request was cancelled.'));
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Gw2ccError('CANCELLED', 'The GW2 request was cancelled.'));
      }, { once: true });
    }));
  }

  async get<T>(
    path: string,
    apiKey?: string,
    query: Record<string, QueryValue> = {},
    signal?: AbortSignal
  ): Promise<T> {
    validateGw2V2Path(path);
    const url = new URL(path, GW2_API_ORIGIN);
    if (url.origin !== GW2_API_ORIGIN || !url.pathname.startsWith('/v2/')) {
      throw new Gw2ccError('VALIDATION_ERROR', 'The GW2 API host and /v2/ path are fixed.');
    }
    url.searchParams.set('v', GW2_SCHEMA_VERSION);
    for (const [key, rawValue] of Object.entries(query)) {
      if (!/^[a-zA-Z0-9_]+$/.test(key)) {
        throw new Gw2ccError('VALIDATION_ERROR', `Invalid GW2 query key: ${key}`);
      }
      if (key.toLowerCase() === 'v' || /(api_?key|access_?token|authorization|secret)/i.test(key)) {
        throw new Gw2ccError('VALIDATION_ERROR', `GW2 query key ${key} is reserved and cannot be supplied by callers.`);
      }
      const value = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue);
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            signal: controller.signal,
            redirect: 'error'
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (attempt < this.maxRetries) {
            await this.waitForRetry(attempt, undefined, controller.signal);
            continue;
          }
          throw error;
        }
        if (!response.ok) {
          if (this.isTransientStatus(response.status) && attempt < this.maxRetries) {
            const retryAfter = response.headers.get('retry-after') ?? undefined;
            void response.body?.cancel();
            await this.waitForRetry(attempt, retryAfter, controller.signal);
            continue;
          }
          await this.throwForResponse(response);
        }
        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (contentLength > this.maxResponseBytes) {
          throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'GW2 response exceeded the configured size limit.');
        }
        const bytes = await this.readBounded(response.body, controller.signal);
        try {
          return JSON.parse(new TextDecoder().decode(bytes)) as T;
        } catch (error) {
          throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'GW2 returned malformed JSON.', { retryable: true, cause: error });
        }
      }
      throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'The Guild Wars 2 API request exhausted its retry limit.', { retryable: true });
    } catch (error) {
      if (error instanceof Gw2ccError) {
        if (error.code === 'CANCELLED' && !signal?.aborted && controller.signal.aborted) {
          throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'The GW2 request timed out.', { retryable: true });
        }
        throw error;
      }
      if (controller.signal.aborted && signal?.aborted) {
        throw new Gw2ccError('CANCELLED', 'The GW2 request was cancelled.');
      }
      if (controller.signal.aborted) {
        throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'The GW2 request timed out.', { retryable: true });
      }
      throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'Could not reach the Guild Wars 2 API.', {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async getParsed<T>(
    path: string,
    schema: z.ZodType<T>,
    apiKey?: string,
    query: Record<string, QueryValue> = {},
    signal?: AbortSignal
  ): Promise<T> {
    const data = await this.get<unknown>(path, apiKey, query, signal);
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'GW2 returned an unexpected response shape.', {
        retryable: true,
        details: { path, issues: result.error.issues.slice(0, 5).map((issue) => issue.message) }
      });
    }
    return result.data;
  }

  private async throwForResponse(response: Response): Promise<never> {
    if (response.status === 401) {
      throw new Gw2ccError('GW2_KEY_INVALID', 'The Guild Wars 2 API key is invalid or expired.');
    }
    if (response.status === 403) {
      throw new Gw2ccError('GW2_PERMISSION_MISSING', 'The API key lacks permission for this GW2 resource.');
    }
    if (response.status === 404) {
      throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', 'The requested GW2 resource was not found.');
    }
    if (response.status === 429) {
      throw new Gw2ccError('GW2_RATE_LIMITED', 'ArenaNet rate-limited the request after bounded retries. Try again shortly.', {
        retryable: true,
        details: { status: 429 }
      });
    }
    throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', `GW2 returned HTTP ${response.status}.`, {
      retryable: this.isTransientStatus(response.status),
      details: { status: response.status }
    });
  }

  private isTransientStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private async waitForRetry(attempt: number, retryAfter: string | undefined, signal: AbortSignal): Promise<void> {
    let delay = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** attempt));
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        delay = Math.min(this.maxRetryDelayMs, seconds * 1_000);
      } else {
        const at = Date.parse(retryAfter);
        if (Number.isFinite(at)) delay = Math.min(this.maxRetryDelayMs, Math.max(0, at - Date.now()));
      }
    }
    await this.sleep(delay, signal);
  }

  private async readBounded(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
    if (!body) throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'GW2 returned an empty response body.', { retryable: true });
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Gw2ccError('CANCELLED', 'The GW2 request was cancelled.');
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'GW2 response exceeded the configured size limit.');
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
