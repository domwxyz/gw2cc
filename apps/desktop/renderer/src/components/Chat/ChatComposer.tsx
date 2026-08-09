import { useEffect, useRef } from 'react';

export interface ChatComposerProps {
  value: string;
  ready: boolean;
  generating: boolean;
  sending: boolean;
  focusedCharacter?: string;
  onChange(value: string): void;
  onSend(): void;
  onCancel(): void;
}

export function ChatComposer({ value, ready, generating, sending, focusedCharacter, onChange, onSend, onCancel }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden';
  };
  useEffect(resize, [value]);
  return (
    <div className="composer-shell">
      <div className="chat-composer">
        <textarea
          ref={textareaRef}
          aria-label="Message"
          rows={1}
          value={value}
          onChange={(event) => { onChange(event.target.value); resize(); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && value.trim() && ready && !generating) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={ready ? 'Type a message…' : 'Configure a provider in Settings…'}
          disabled={!ready || generating}
        />
        {generating ? (
          <button type="button" className="composer-icon-button stop-button" aria-label="Stop generating" title="Stop" onClick={onCancel}><span /></button>
        ) : (
          <button type="button" className="composer-icon-button send-button" aria-label="Send message" title="Send" onClick={onSend} disabled={!ready || !value.trim() || sending}>
            <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m3 3 14 7-14 7 3-7-3-7Z" /><path d="M6 10h11" /></svg>
          </button>
        )}
      </div>
      <div className="composer-footer"><span>{generating ? 'Generating…' : 'Enter to send · Shift+Enter for a new line'}</span><span>Focus: {focusedCharacter ?? 'Account'}</span></div>
    </div>
  );
}
