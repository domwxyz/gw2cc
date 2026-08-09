import type { ReasoningTrace as ReasoningTraceData } from '@gw2cc/protocol';

function traceSummary(trace: ReasoningTraceData, generating: boolean): string {
  if (generating) return 'Streaming…';
  const parts = [
    trace.reasoningTokens !== undefined
      ? `${trace.reasoningTokens.toLocaleString()} reasoning tokens`
      : undefined,
    trace.finishReason ? `finish: ${trace.finishReason}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ') || 'Provider diagnostics';
}

export function ReasoningTrace({ trace, generating }: { trace: ReasoningTraceData; generating: boolean }) {
  return (
    <details className="reasoning-trace">
      <summary>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 3.5a3 3 0 0 0-2.7 4.3A3.2 3.2 0 0 0 6 14h1.5" /><path d="M12.5 3.5a3 3 0 0 1 2.7 4.3A3.2 3.2 0 0 1 14 14h-1.5M10 2v15M7.5 7.5H10M10 11h2.5" /></svg>
        <strong>Reasoning trace</strong>
        <small>{traceSummary(trace, generating)}</small>
        <span className="reasoning-disclosure" aria-hidden="true">›</span>
      </summary>
      <div className="reasoning-trace-body">
        <p>Provider-supplied reasoning may be summarized or omitted by the selected model.</p>
        {trace.content
          ? <pre>{trace.content}{trace.truncated ? '\n\n[Trace truncated by GW2CC]' : ''}</pre>
          : <div className="reasoning-unavailable">No visible reasoning content was exposed for this turn.</div>}
        <dl>
          {trace.inputTokens !== undefined && <><dt>Input</dt><dd>{trace.inputTokens.toLocaleString()} tokens</dd></>}
          {trace.outputTokens !== undefined && <><dt>Output</dt><dd>{trace.outputTokens.toLocaleString()} tokens</dd></>}
          {trace.reasoningTokens !== undefined && <><dt>Reasoning</dt><dd>{trace.reasoningTokens.toLocaleString()} tokens</dd></>}
          {trace.finishReason && <><dt>Finish reason</dt><dd>{trace.finishReason}</dd></>}
        </dl>
      </div>
    </details>
  );
}
