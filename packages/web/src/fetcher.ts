import { Gw2ccError, type ResearchDocument, type ResearchJsonDocument } from '@gw2cc/core';
import { extractHtmlDocument, extractTextDocument } from './extract';
import { DEFAULT_JSON_BOUNDING_LIMITS, parseAndBoundJson, type JsonBoundingLimits } from './json';
import { assertSafeHttpUrl, type DnsResolver } from './security';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_TEXT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/x-markdown'];
const ALLOWED_JSON_TEXT_TYPES = new Set(['text/plain', 'text/json']);
const RESEARCH_USER_AGENT = 'GW2CC/0.1 public-research (+https://github.com/domwxyz/gw2cc)';

export interface SafePageFetcherOptions {
  fetch: typeof globalThis.fetch;
  resolve: DnsResolver;
  timeoutMs?: number;
  maxRedirects?: number;
  maxDownloadBytes?: number;
  maxTextCharacters?: number;
  jsonBoundingLimits?: Partial<JsonBoundingLimits>;
  now?: () => number;
}

export class SafePageFetcher {
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxDownloadBytes: number;
  private readonly maxTextCharacters: number;
  private readonly jsonBoundingLimits: JsonBoundingLimits;
  private readonly now: () => number;

  constructor(private readonly options: SafePageFetcherOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 1_000_000;
    this.maxTextCharacters = options.maxTextCharacters ?? 36_000;
    this.jsonBoundingLimits = { ...DEFAULT_JSON_BOUNDING_LIMITS, ...options.jsonBoundingLimits };
    this.now = options.now ?? (() => Date.now());
  }

  validate(url: string, signal?: AbortSignal): Promise<URL> {
    return assertSafeHttpUrl(url, this.options.resolve, signal);
  }

  async fetch(urlValue: string, signal?: AbortSignal): Promise<ResearchDocument> {
    const response = await this.fetchResponse(urlValue, {
      accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9',
      acceptsContentType: (type) => !type || ALLOWED_TEXT_TYPES.includes(type),
      defaultContentType: 'text/html'
    }, signal);
    const common = {
      requestedUrl: response.requestedUrl,
      finalUrl: response.finalUrl,
      contentType: response.contentType,
      maxTextCharacters: this.maxTextCharacters,
      downloadedBytes: response.bytes.byteLength,
      retrievedAt: response.retrievedAt
    };
    const text = new TextDecoder('utf-8', { fatal: false }).decode(response.bytes);
    return response.contentType === 'text/html' || response.contentType === 'application/xhtml+xml'
      ? extractHtmlDocument({ ...common, html: text })
      : extractTextDocument({ ...common, text });
  }

  async fetchJson(urlValue: string, signal?: AbortSignal): Promise<ResearchJsonDocument> {
    const response = await this.fetchResponse(urlValue, {
      accept: 'application/json,application/*+json;q=0.9,text/json;q=0.7,text/plain;q=0.5',
      acceptsContentType: (type) => !type || type === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type) || ALLOWED_JSON_TEXT_TYPES.has(type),
      defaultContentType: 'application/json'
    }, signal);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(response.bytes);
    const bounded = parseAndBoundJson(text, this.jsonBoundingLimits);
    const domain = new URL(response.finalUrl).hostname.toLowerCase();
    return {
      trust: 'untrusted_external',
      requestedUrl: response.requestedUrl,
      finalUrl: response.finalUrl,
      domain,
      contentType: response.contentType,
      data: bounded.data,
      downloadedBytes: response.bytes.byteLength,
      retrievedAt: response.retrievedAt,
      bounding: { truncated: bounded.truncated, ...this.jsonBoundingLimits },
      provenance: {
        trust: 'untrusted_external',
        sourceKind: 'live_json',
        sourceName: 'Public JSON response',
        url: response.finalUrl,
        domain,
        retrievedAt: response.retrievedAt
      }
    };
  }

  private async fetchResponse(
    urlValue: string,
    request: {
      accept: string;
      acceptsContentType: (contentType: string) => boolean;
      defaultContentType: string;
    },
    signal?: AbortSignal
  ): Promise<{
    requestedUrl: string;
    finalUrl: string;
    contentType: string;
    bytes: Uint8Array;
    retrievedAt: number;
  }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestedUrl = urlValue;
    try {
      let current = await this.validate(urlValue, controller.signal);
      for (let redirectCount = 0; ; redirectCount += 1) {
        const response = await this.options.fetch(current, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: request.accept, 'User-Agent': RESEARCH_USER_AGENT },
          signal: controller.signal
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirectCount >= this.maxRedirects) {
            throw new Gw2ccError('WEB_FETCH_FAILED', 'The page exceeded the redirect limit.');
          }
          const location = response.headers.get('location');
          if (!location) throw new Gw2ccError('WEB_FETCH_FAILED', 'The page returned a redirect without a destination.');
          void response.body?.cancel();
          current = await this.validate(new URL(location, current).toString(), controller.signal);
          continue;
        }
        if (!response.ok) {
          void response.body?.cancel();
          if (response.status === 429) {
            throw new Gw2ccError('WEB_RATE_LIMITED', 'The webpage rate-limited this request. Retry later.', {
              retryable: true,
              details: {
                status: 429,
                ...(response.headers.get('retry-after') ? { retryAfter: response.headers.get('retry-after') } : {})
              }
            });
          }
          throw new Gw2ccError('WEB_FETCH_FAILED', `The page returned HTTP ${response.status}.`, {
            retryable: response.status === 429 || response.status >= 500,
            details: { status: response.status }
          });
        }
        const rawType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!request.acceptsContentType(rawType)) {
          void response.body?.cancel();
          throw new Gw2ccError('WEB_CONTENT_UNSUPPORTED', `The response content type ${rawType} is not supported.`);
        }
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > this.maxDownloadBytes) {
          void response.body?.cancel();
          throw new Gw2ccError('WEB_FETCH_FAILED', 'The page exceeded the download size limit.');
        }
        const bytes = await this.readBounded(response.body, controller.signal);
        if (!rawType && this.looksBinary(bytes)) {
          throw new Gw2ccError('WEB_CONTENT_UNSUPPORTED', 'The page returned binary content without a supported content type.');
        }
        const type = rawType || request.defaultContentType;
        return {
          requestedUrl,
          finalUrl: current.toString(),
          contentType: type,
          bytes,
          retrievedAt: this.now()
        };
      }
    } catch (error) {
      if (error instanceof Gw2ccError) {
        if (error.code === 'CANCELLED' && !signal?.aborted && controller.signal.aborted) {
          throw new Gw2ccError('WEB_FETCH_FAILED', 'The web request timed out.', { retryable: true });
        }
        throw error;
      }
      if (controller.signal.aborted && signal?.aborted) throw new Gw2ccError('CANCELLED', 'Web fetching was cancelled.');
      if (controller.signal.aborted) {
        throw new Gw2ccError('WEB_FETCH_FAILED', 'The web request timed out.', { retryable: true });
      }
      throw new Gw2ccError('WEB_FETCH_FAILED', 'The web resource could not be fetched.', { retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async readBounded(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
    if (!body) throw new Gw2ccError('WEB_FETCH_FAILED', 'The page returned an empty response body.');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Gw2ccError('CANCELLED', 'Page fetching was cancelled.');
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxDownloadBytes) {
          await reader.cancel();
          throw new Gw2ccError('WEB_FETCH_FAILED', 'The page exceeded the download size limit.');
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

  private looksBinary(bytes: Uint8Array): boolean {
    const sample = bytes.slice(0, Math.min(bytes.length, 1_024));
    if (sample.some((byte) => byte === 0)) return true;
    const controls = sample.filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length;
    return sample.length > 0 && controls / sample.length > 0.05;
  }
}
