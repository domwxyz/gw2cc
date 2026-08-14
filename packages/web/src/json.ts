import { Gw2ccError, type ResearchJsonValue } from '@gw2cc/core';

export interface JsonBoundingLimits {
  maxDepth: number;
  maxArrayEntries: number;
  maxObjectEntries: number;
  maxStringCharacters: number;
  maxNodes: number;
}

export interface BoundedJsonValue {
  data: ResearchJsonValue;
  truncated: boolean;
}

export const DEFAULT_JSON_BOUNDING_LIMITS: JsonBoundingLimits = {
  maxDepth: 14,
  maxArrayEntries: 200,
  maxObjectEntries: 200,
  maxStringCharacters: 128_000,
  maxNodes: 12_000
};

export function parseAndBoundJson(
  text: string,
  limits: JsonBoundingLimits = DEFAULT_JSON_BOUNDING_LIMITS
): BoundedJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Gw2ccError('WEB_JSON_INVALID', 'The response body was not valid JSON.', { cause: error });
  }

  let truncated = false;
  let nodes = 0;
  const visit = (value: unknown, depth: number): ResearchJsonValue => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      truncated = true;
      return '[TRUNCATED_NODE_LIMIT]';
    }
    if (depth > limits.maxDepth) {
      truncated = true;
      return '[TRUNCATED_DEPTH]';
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.length <= limits.maxStringCharacters) return value;
      truncated = true;
      return `${value.slice(0, limits.maxStringCharacters)}[TRUNCATED_STRING]`;
    }
    if (Array.isArray(value)) {
      const entries = value.slice(0, limits.maxArrayEntries).map((entry) => visit(entry, depth + 1));
      if (value.length > entries.length) {
        truncated = true;
        entries.push({ __gw2ccTruncatedItems: value.length - entries.length });
      }
      return entries;
    }
    if (typeof value === 'object') {
      const allEntries = Object.entries(value as Record<string, unknown>);
      const entries = allEntries.slice(0, limits.maxObjectEntries).map(([key, entry]) => [
        key.length > limits.maxStringCharacters ? key.slice(0, limits.maxStringCharacters) : key,
        visit(entry, depth + 1)
      ] as const);
      if (allEntries.length > entries.length) {
        truncated = true;
        entries.push(['__gw2ccTruncatedProperties', allEntries.length - entries.length]);
      }
      return Object.fromEntries(entries) as { [key: string]: ResearchJsonValue };
    }
    truncated = true;
    return `[UNSUPPORTED_JSON_VALUE:${typeof value}]`;
  };

  return { data: visit(parsed, 0), truncated };
}
