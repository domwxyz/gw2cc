import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';

describe('MessageBubble controls', () => {
  it('keeps collapse, fork, and copy controls on one row', async () => {
    const user = userEvent.setup();
    render(
      <MessageBubble
        message={{
          id: 'assistant-long',
          conversationId: 'conversation-1',
          role: 'assistant',
          content: 'A detailed assistant response. '.repeat(30),
          createdAt: 1,
          status: 'complete'
        }}
        toolCalls={[]}
        generating={false}
        latestUser={false}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onFork={vi.fn()}
      />
    );

    const controls = screen.getByRole('button', { name: 'Collapse' }).closest('.message-controls');
    expect(controls).not.toBeNull();
    expect(controls).toContainElement(screen.getByRole('button', { name: 'Fork conversation here' }));
    expect(controls).toContainElement(screen.getByRole('button', { name: 'Copy' }));

    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-expanded', 'false');
  });
});
