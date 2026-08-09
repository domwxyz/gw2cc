import type { PersistedToolCall } from '@gw2cc/protocol';

function formatToolPayload(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized.length > 12_000
      ? `${serialized.slice(0, 12_000)}\n... display preview truncated ...`
      : serialized;
  } catch {
    return '[Tool payload could not be displayed]';
  }
}

export function ToolActivityCard({ call }: { call: PersistedToolCall }) {
  return (
    <details className={`tool-card tool-${call.status}`}>
      <summary>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m12.7 3.2 4.1 4.1-3 3-1.7-1.7-5.9 5.9-1.7-1.7 5.9-5.9-1.7-1.7 3-3Z" /><path d="m3.5 14.5 2 2" /></svg>
        <strong>{call.toolName}</strong>
        <small>{call.status === 'running' ? 'Running…' : call.status === 'completed' ? 'Complete' : call.status === 'cancelled' ? 'Stopped' : 'Failed'}</small>
        <span className="tool-disclosure" aria-hidden="true">›</span>
      </summary>
      <div className="tool-payload">
        <section><h4>Arguments</h4><pre>{formatToolPayload(call.arguments)}</pre></section>
        {call.result !== undefined && <section><h4>Result</h4><pre>{formatToolPayload(call.result)}</pre></section>}
      </div>
    </details>
  );
}
