import { useEffect, useRef, useState } from 'react';
import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type ConversationAttachment
} from '@gw2cc/protocol';

export interface ChatComposerProps {
  value: string;
  ready: boolean;
  generating: boolean;
  sending: boolean;
  attachments: ConversationAttachment[];
  focusedCharacter?: string;
  onChange(value: string): void;
  onAttachmentsChange(attachments: ConversationAttachment[]): void;
  onSend(): void;
  onCancel(): void;
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file, 'utf-8');
  });
}

function displaySize(size: number): string {
  return size < 1_000 ? `${size} B` : `${Math.ceil(size / 1_000)} KB`;
}

export function ChatComposer({
  value,
  ready,
  generating,
  sending,
  attachments,
  focusedCharacter,
  onChange,
  onAttachmentsChange,
  onSend,
  onCancel
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState<string>();
  const resize = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden';
  };
  useEffect(resize, [value]);

  const attachFiles = async (files: File[]) => {
    setAttachmentError(undefined);
    if (attachments.length + files.length > MAX_MESSAGE_ATTACHMENTS) {
      setAttachmentError(`You can attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message.`);
      return;
    }
    const next = [...attachments];
    try {
      for (const file of files) {
        const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        if (extension !== '.txt' && extension !== '.md') {
          throw new Error('Only .txt and .md files are supported right now.');
        }
        if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} is larger than ${MAX_TEXT_ATTACHMENT_BYTES / 1_000} KB.`);
        }
        if (next.reduce((sum, attachment) => sum + attachment.size, 0) + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(`Attachments may total no more than ${MAX_TOTAL_ATTACHMENT_BYTES / 1_000} KB.`);
        }
        const content = await readTextFile(file);
        if (content.includes('\0')) throw new Error(`${file.name} does not appear to be a plain-text file.`);
        next.push({
          type: 'text',
          name: file.name,
          mediaType: extension === '.md' ? 'text/markdown' : 'text/plain',
          content,
          size: file.size
        });
      }
      onAttachmentsChange(next);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not attach that file.');
    }
  };

  const canSend = ready && !generating && !sending && Boolean(value.trim() || attachments.length);
  return (
    <div className="composer-shell">
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="Attached files">
          {attachments.map((attachment, index) => (
            <div className="composer-attachment" key={`${attachment.name}-${index}`}>
              <span aria-hidden="true">{attachment.mediaType === 'text/markdown' ? 'MD' : 'TXT'}</span>
              <strong>{attachment.name}</strong>
              <small>{displaySize(attachment.size)}</small>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                title="Remove attachment"
                disabled={generating || sending}
                onClick={() => onAttachmentsChange(attachments.filter((_, attachmentIndex) => attachmentIndex !== index))}
              >×</button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && <div className="composer-attachment-error" role="alert">{attachmentError}</div>}
      <div className="chat-composer">
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          aria-label="Attach text files"
          accept=".txt,.md,text/plain,text/markdown"
          multiple
          disabled={!ready || generating || sending}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void attachFiles(files);
          }}
        />
        <button
          type="button"
          className="composer-icon-button attach-button"
          aria-label="Attach files"
          title="Attach .txt or .md files"
          disabled={!ready || generating || sending || attachments.length >= MAX_MESSAGE_ATTACHMENTS}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M7 10.5 12.5 5a3 3 0 0 1 4.25 4.25L9.5 16.5a5 5 0 0 1-7.07-7.07L9 2.86" /></svg>
        </button>
        <textarea
          ref={textareaRef}
          aria-label="Message"
          rows={1}
          value={value}
          onChange={(event) => { onChange(event.target.value); resize(); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && canSend) {
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
          <button type="button" className="composer-icon-button send-button" aria-label="Send message" title="Send" onClick={onSend} disabled={!canSend}>
            <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m3 3 14 7-14 7 3-7-3-7Z" /><path d="M6 10h11" /></svg>
          </button>
        )}
      </div>
      <div className="composer-footer"><span>{generating ? 'Generating…' : 'Enter to send · Shift+Enter for a new line · .txt/.md up to 100 KB'}</span><span>Focus: {focusedCharacter ?? 'Account'}</span></div>
    </div>
  );
}
