import { Gw2ccError } from '@gw2cc/core';

export function joinUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath.replace(/^\//, ''), base).toString();
}

export function providerHeaders(apiKey?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json',
    ...extra,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };
}

export async function fetchProvider(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    if (init.signal?.aborted) throw new Gw2ccError('CANCELLED', 'LLM generation was cancelled.');
    throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'Could not reach the configured LLM provider.', {
      retryable: true,
      cause: error
    });
  }
}

export async function assertProviderResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new Gw2ccError('LLM_AUTH_FAILED', 'The LLM provider rejected the configured credential.');
  }
  if (response.status === 404) {
    throw new Gw2ccError('LLM_MODEL_NOT_FOUND', 'The provider endpoint or configured model was not found.');
  }
  if (response.status === 429) {
    throw new Gw2ccError('LLM_RATE_LIMITED', 'The LLM provider rate-limited this request. Try again shortly.', { retryable: true });
  }
  throw new Gw2ccError('LLM_UPSTREAM_ERROR', `The LLM provider returned HTTP ${response.status}.`, {
    retryable: response.status >= 500
  });
}

export async function parseProviderJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'The LLM provider returned malformed JSON.', {
      retryable: true,
      cause: error
    });
  }
}

export async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!body) throw new Gw2ccError('LLM_UPSTREAM_ERROR', 'The LLM provider returned an empty streaming response.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) yield line;
      if (done) break;
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export async function* readSseData(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  let data: string[] = [];
  for await (const line of readLines(body)) {
    if (!line) {
      if (data.length > 0) yield data.join('\n');
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length > 0) yield data.join('\n');
}

export function parseToolArguments(value: string): unknown {
  try {
    return value.trim() ? JSON.parse(value) : {};
  } catch {
    return { __invalidJsonArguments: value.slice(0, 8_000) };
  }
}

export function providerStreamError(message = 'The LLM provider returned a malformed streaming event.'): Gw2ccError {
  return new Gw2ccError('LLM_UPSTREAM_ERROR', message, { retryable: true });
}
