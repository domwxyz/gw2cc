import { redactSensitive, type ToolExecutionOutcome } from '@gw2cc/core';

const DEFAULT_MAX_RESULT_BYTES = 48_000;

function compact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (Array.isArray(value)) {
    const entries = value.slice(0, 30).map((entry) => compact(entry, depth + 1));
    return value.length > entries.length
      ? [...entries, { truncatedItems: value.length - entries.length }]
      : entries;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 60)
        .map(([key, entry]) => [key, compact(entry, depth + 1)])
    );
  }
  return value;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function boundToolResult(
  data: unknown,
  summary: string,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES
): ToolExecutionOutcome {
  const safe = redactSensitive(data);
  const wrapped = { ok: true, data: safe };
  const originalBytes = byteLength(wrapped);
  if (originalBytes <= maxResultBytes) {
    return { ok: true, value: wrapped, summary, truncated: false };
  }
  let preview = compact(safe);
  if (byteLength(preview) > maxResultBytes - 1_000) {
    preview = JSON.stringify(preview).slice(0, Math.max(1_000, maxResultBytes - 1_500));
  }
  const buildValue = () => ({
    ok: true,
    data: preview,
    truncation: {
      truncated: true,
      originalBytes,
      limitBytes: maxResultBytes,
      previewIsComplete: false,
      representation: typeof preview === 'string' ? 'bounded_json_text' : 'bounded_json_value'
    }
  });
  while (byteLength(buildValue()) > maxResultBytes && typeof preview === 'string' && preview.length > 100) {
    preview = preview.slice(0, Math.max(100, Math.floor(preview.length * 0.75)));
  }
  if (byteLength(buildValue()) > maxResultBytes) preview = '[Preview omitted because its encoded form exceeded the result limit.]';
  return {
    ok: true,
    value: buildValue(),
    summary: `${summary} (result truncated to the tool safety limit)`,
    truncated: true
  };
}
