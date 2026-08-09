import { useCallback, useEffect, useRef } from 'react';
import type { ConversationDetail } from '@gw2cc/protocol';
import { MessageBubble } from './MessageBubble';

const NEAR_BOTTOM_MINIMUM = 20;
const NEAR_BOTTOM_MAXIMUM = 96;

export interface MessageListProps {
  conversation: ConversationDetail;
  generating: boolean;
  onRetry(messageId: string): Promise<void>;
  onEdit(messageId: string, content: string): Promise<void>;
  onFork(messageId: string): Promise<void>;
}

export function MessageList({ conversation, generating, onRetry, onEdit, onFork }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousCountRef = useRef(0);
  const followOutputRef = useRef(true);
  const isNearBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return true;
    const scrollable = Math.max(0, element.scrollHeight - element.clientHeight);
    const threshold = Math.max(NEAR_BOTTOM_MINIMUM, Math.min(NEAR_BOTTOM_MAXIMUM, scrollable * .2));
    return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const messageCountChanged = previousCountRef.current !== conversation.messages.length;
    previousCountRef.current = conversation.messages.length;
    if (messageCountChanged || followOutputRef.current) {
      element.scrollTop = element.scrollHeight;
      followOutputRef.current = true;
    }
  }, [conversation.messages, conversation.toolCalls]);

  const latestUserId = [...conversation.messages].reverse().find((message) => message.role === 'user')?.id;
  return (
    <div className="chat-transcript" ref={containerRef} aria-live="polite" onScroll={() => { followOutputRef.current = isNearBottom(); }}>
      {conversation.messages.length === 0 ? (
        <div className="chat-empty"><p>Send a message to begin.</p></div>
      ) : conversation.messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          toolCalls={conversation.toolCalls.filter((call) => call.messageId === message.id)}
          generating={generating && message.status === 'streaming'}
          latestUser={message.id === latestUserId}
          onRetry={onRetry}
          onEdit={onEdit}
          onFork={onFork}
        />
      ))}
    </div>
  );
}
