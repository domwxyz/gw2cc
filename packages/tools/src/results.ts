import { redactSensitive, type ToolExecutionOutcome } from '@gw2cc/core';

const DEFAULT_MAX_RESULT_BYTES = 48_000;

interface CompactLimits {
  arrayEntries: number;
  objectEntries: number;
  stringCharacters: number;
  depth: number;
}

function compact(value: unknown, limits: CompactLimits, depth = 0): unknown {
  if (depth > limits.depth) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    return value.length > limits.stringCharacters
      ? `${value.slice(0, limits.stringCharacters)}...`
      : value;
  }
  if (Array.isArray(value)) {
    const entries = value.slice(0, limits.arrayEntries).map((entry) => compact(entry, limits, depth + 1));
    return value.length > entries.length
      ? [...entries, { truncatedItems: value.length - entries.length }]
      : entries;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, limits.objectEntries)
        .map(([key, entry]) => [key, compact(entry, limits, depth + 1)])
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
  const compactLimits: CompactLimits[] = [
    { arrayEntries: 30, objectEntries: 60, stringCharacters: 2_000, depth: 8 },
    { arrayEntries: 20, objectEntries: 50, stringCharacters: 1_000, depth: 7 },
    { arrayEntries: 12, objectEntries: 40, stringCharacters: 500, depth: 6 },
    { arrayEntries: 8, objectEntries: 30, stringCharacters: 250, depth: 5 },
    { arrayEntries: 4, objectEntries: 20, stringCharacters: 120, depth: 4 },
    { arrayEntries: 2, objectEntries: 12, stringCharacters: 80, depth: 3 },
    { arrayEntries: 1, objectEntries: 8, stringCharacters: 40, depth: 2 }
  ];
  let preview: unknown = compact(safe, compactLimits[0]!);
  const buildValue = () => ({
    ok: true,
    data: preview,
    truncation: {
      truncated: true,
      originalBytes,
      limitBytes: maxResultBytes,
      previewIsComplete: false,
      representation: 'bounded_json_value'
    }
  });
  for (const limits of compactLimits.slice(1)) {
    if (byteLength(buildValue()) <= maxResultBytes) break;
    preview = compact(safe, limits);
  }
  if (byteLength(buildValue()) > maxResultBytes) preview = '[Preview omitted because its encoded form exceeded the result limit.]';
  return {
    ok: true,
    value: buildValue(),
    summary: `${summary} (result truncated to the tool safety limit)`,
    truncated: true
  };
}
