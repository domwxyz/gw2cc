import { useMemo, useRef, useState } from 'react';
import type { ConversationMessage, PersistedToolCall } from '@gw2cc/protocol';
import { formatConversationTime } from '../../lib/format';
import { ToolActivityCard } from './ToolActivityCard';
import { MarkdownContent } from './MarkdownContent';
import { MessageActions, type MessageAction } from './MessageActions';
import { ReasoningTrace } from './ReasoningTrace';
import { useCopyAction } from './useCopyAction';

type MessageSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; call: PersistedToolCall };

const COLLAPSE_MINIMUM = 700;
const COLLAPSE_PREVIEW = 280;

function attachmentSize(size: number): string {
  return size < 1_000 ? `${size} B` : `${Math.ceil(size / 1_000)} KB`;
}

function buildSegments(content: string, toolCalls: PersistedToolCall[]): MessageSegment[] {
  if (!toolCalls.length) return content ? [{ kind: 'text', content }] : [];
  const legacy = toolCalls.filter((call) => call.contentOffset === undefined);
  const positioned = toolCalls
    .filter((call) => call.contentOffset !== undefined)
    .sort((left, right) => left.contentOffset! - right.contentOffset!);
  const segments: MessageSegment[] = legacy.map((call) => ({ kind: 'tool', call }));
  let cursor = 0;
  for (const call of positioned) {
    const offset = Math.max(cursor, Math.min(content.length, call.contentOffset!));
    const text = content.slice(cursor, offset);
    if (text.trim()) segments.push({ kind: 'text', content: text });
    segments.push({ kind: 'tool', call });
    cursor = offset;
  }
  const remaining = content.slice(cursor);
  if (remaining.trim()) segments.push({ kind: 'text', content: remaining });
  return segments;
}

export interface MessageBubbleProps {
  message: ConversationMessage;
  toolCalls: PersistedToolCall[];
  generating: boolean;
  latestUser: boolean;
  onRetry(messageId: string): Promise<void>;
  onEdit(messageId: string, content: string): Promise<void>;
  onFork(messageId: string): Promise<void>;
}

export function MessageBubble({ message, toolCalls, generating, latestUser, onRetry, onEdit, onFork }: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const segments = useMemo(() => buildSegments(message.content, toolCalls), [message.content, toolCalls]);
  const copy = useCopyAction(message.content);
  const canCollapse = message.role === 'assistant' && !generating && message.content.length > COLLAPSE_MINIMUM;

  const actions = useMemo<MessageAction[]>(() => {
    if (generating || editing) return [];
    const result: MessageAction[] = [];
    if (message.role === 'user' && latestUser) {
      result.push({ key: 'retry', label: 'Retry', icon: 'retry', onClick: () => void onRetry(message.id) });
      result.push({ key: 'edit', label: 'Edit and resend', icon: 'edit', onClick: () => { setEditValue(message.content); setEditing(true); } });
    }
    if (message.role === 'assistant') {
      result.push({ key: 'fork', label: 'Fork conversation here', icon: 'fork', onClick: () => void onFork(message.id) });
    }
    result.push(copy);
    return result;
  }, [copy, editing, generating, latestUser, message.content, message.id, message.role, onFork, onRetry]);

  const submitEdit = async () => {
    const content = editValue.trim();
    if ((!content && !message.attachments?.length) || submitting) return;
    setSubmitting(true);
    try {
      await onEdit(message.id, content);
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (message.role === 'user') {
    return (
      <article className="message-row message-row-user">
        <div className="message-bubble user">
          {editing ? (
            <div className="message-edit">
              <textarea
                ref={editRef}
                autoFocus
                aria-label="Edit message"
                value={editValue}
                onChange={(event) => {
                  setEditValue(event.target.value);
                  const textarea = editRef.current;
                  if (textarea) {
                    textarea.style.height = 'auto';
                    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitEdit();
                  }
                }}
                disabled={submitting}
              />
              <div><button type="button" onClick={() => setEditing(false)} disabled={submitting}>Cancel</button><button type="button" className="primary-button" onClick={() => void submitEdit()} disabled={(!editValue.trim() && !message.attachments?.length) || submitting}>{submitting ? 'Resending…' : 'Resend'}</button></div>
            </div>
          ) : message.content ? <p className="user-message-text">{message.content}</p> : null}
          {message.attachments?.map((attachment, index) => (
            <details className="message-attachment" key={`${attachment.name}-${index}`}>
              <summary>
                <span aria-hidden="true">{attachment.mediaType === 'text/markdown' ? 'MD' : 'TXT'}</span>
                <strong>{attachment.name}</strong>
                <small>{attachmentSize(attachment.size)}</small>
              </summary>
              <pre>{attachment.content}</pre>
            </details>
          ))}
        </div>
        <div className="message-context"><span>{message.focusedCharacterName ?? 'Account'}</span><time>{formatConversationTime(message.createdAt)}</time></div>
        <MessageActions actions={actions} align="right" />
      </article>
    );
  }

  return (
    <article className="message-row message-row-assistant">
      <div className="assistant-label"><strong>GW2CC</strong><span>{message.focusedCharacterName ?? 'Account'}</span>{message.modelId && <span>{message.modelId}</span>}<time>{formatConversationTime(message.createdAt)}</time></div>
      <div className="assistant-message-shell">
        {message.reasoningTrace && <ReasoningTrace trace={message.reasoningTrace} generating={generating} />}
        {collapsed ? (
          <div className="message-bubble assistant assistant-preview"><p>{message.content.slice(0, COLLAPSE_PREVIEW).trimEnd()}…</p></div>
        ) : (
          <>
            {segments.map((segment, index) => segment.kind === 'tool'
              ? <ToolActivityCard call={segment.call} key={segment.call.id} />
              : <div className="message-bubble assistant" key={`text-${index}`}><MarkdownContent content={segment.content} /></div>)}
            {generating && (
              <div className="message-bubble assistant streaming-bubble" aria-label="Generating response"><span className="streaming-cursor" /></div>
            )}
          </>
        )}
        {canCollapse && <button type="button" className="message-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>{collapsed ? 'Expand' : 'Collapse'}</button>}
      </div>
      {message.error && <div className="message-error"><span>{message.error.message}</span></div>}
      {message.status === 'cancelled' && <div className="message-status">Stopped</div>}
      <MessageActions actions={actions} align="left" />
    </article>
  );
}
