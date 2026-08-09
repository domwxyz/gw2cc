import { describe, expect, it } from 'vitest';
import { boundToolResult } from './results';

describe('valid JSON tool-result truncation', () => {
  it('keeps the encoded envelope within its byte cap even for multi-byte content', () => {
    const result = boundToolResult({ rows: Array.from({ length: 500 }, () => '🦖'.repeat(200)) }, 'large', 4_000);
    const serialized = JSON.stringify(result.value);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(result.value).toMatchObject({ truncation: { truncated: true, limitBytes: 4_000, previewIsComplete: false } });
    expect((result.value as any).data).toMatchObject({ rows: expect.any(Array) });
    expect((result.value as any).truncation.representation).toBe('bounded_json_value');
  });
});
