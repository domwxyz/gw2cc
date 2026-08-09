import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationDetail } from '@gw2cc/protocol';
import { formatConversationTime } from '../../lib/format';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export interface ConversationRailProps {
  activeConversation: ConversationDetail;
  generating: boolean;
  onActivate(conversation: ConversationDetail): void;
}

export function ConversationRail({ activeConversation, generating, onActivate }: ConversationRailProps) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const conversations = useQuery({
    queryKey: ['gw2cc', 'conversations', searchQuery],
    queryFn: () => searchQuery
      ? window.gw2cc.request('conversations.search', { query: searchQuery })
      : window.gw2cc.request('conversations.list', {})
  });
  const refreshLists = () => queryClient.invalidateQueries({ queryKey: ['gw2cc', 'conversations'] });
  const createConversation = useMutation({
    mutationFn: () => window.gw2cc.request('conversations.create', {}),
    onSuccess: (conversation) => {
      onActivate(conversation);
      setSearchInput('');
      refreshLists();
    }
  });
  const selectConversation = useMutation({
    mutationFn: (id: string) => window.gw2cc.request('conversations.select', { id }),
    onSuccess: onActivate
  });
  const renameConversation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => window.gw2cc.request('conversations.rename', { id, title }),
    onSuccess: (conversation) => {
      if (conversation.id === activeConversation.id) onActivate(conversation);
      setRenamingId(undefined);
      refreshLists();
    }
  });
  const pinConversation = useMutation({
    mutationFn: ({ id, isPinned }: { id: string; isPinned: boolean }) => window.gw2cc.request('conversations.setPinned', { id, isPinned }),
    onSuccess: (conversation) => {
      if (conversation.id === activeConversation.id) onActivate(conversation);
      refreshLists();
    }
  });
  const deleteConversation = useMutation({
    mutationFn: (id: string) => window.gw2cc.request('conversations.delete', { id }),
    onSuccess: (conversation) => {
      onActivate(conversation);
      setConfirmDeleteId(undefined);
      refreshLists();
    }
  });
  const mutationError = createConversation.error ?? selectConversation.error ?? renameConversation.error
    ?? pinConversation.error ?? deleteConversation.error;
  const items = conversations.data ?? [];

  return (
    <aside className="conversation-rail" aria-label="Conversations">
      <div className="conversation-rail-heading">
        <div><span className="eyebrow">Account-wide</span><h3>Conversations</h3></div>
        <button
          className="new-conversation-button"
          onClick={() => createConversation.mutate()}
          disabled={generating || createConversation.isPending}
          aria-label="New conversation"
          title="New conversation"
        >+</button>
      </div>
      <label className="conversation-search">
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="Search conversations"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search chats…"
        />
        {searchInput && <button onClick={() => setSearchInput('')} aria-label="Clear conversation search">×</button>}
      </label>
      {generating && <p className="conversation-lock">Finish or stop the current response before switching chats.</p>}
      <div className="conversation-list">
        {conversations.isLoading && <p className="conversation-list-state">Loading conversations…</p>}
        {!conversations.isLoading && items.length === 0 && (
          <p className="conversation-list-state">{searchQuery ? 'No matching conversations.' : 'No conversations yet.'}</p>
        )}
        {items.map((conversation) => {
          const active = conversation.id === activeConversation.id;
          const renaming = renamingId === conversation.id;
          const confirmingDelete = confirmDeleteId === conversation.id;
          return (
            <article className={`conversation-entry ${active ? 'active' : ''}`} key={conversation.id}>
              {renaming ? (
                <form
                  className="conversation-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (renameValue.trim()) renameConversation.mutate({ id: conversation.id, title: renameValue.trim() });
                  }}
                >
                  <input aria-label="Conversation title" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                  <button type="submit" disabled={!renameValue.trim() || renameConversation.isPending}>Save</button>
                  <button type="button" onClick={() => setRenamingId(undefined)}>Cancel</button>
                </form>
              ) : (
                <>
                  <button
                    className="conversation-select"
                    onClick={() => !active && selectConversation.mutate(conversation.id)}
                    disabled={generating || selectConversation.isPending}
                    aria-current={active ? 'page' : undefined}
                  >
                    <strong>{conversation.title ?? 'Untitled conversation'}</strong>
                    <small>{formatConversationTime(conversation.updatedAt)}</small>
                  </button>
                  <div className="conversation-actions">
                    <button
                      onClick={() => pinConversation.mutate({ id: conversation.id, isPinned: !conversation.isPinned })}
                      disabled={generating}
                      className={conversation.isPinned ? 'is-pinned' : ''}
                      aria-label={conversation.isPinned ? 'Unpin conversation' : 'Pin conversation'}
                      title={conversation.isPinned ? 'Unpin' : 'Pin'}
                    >{conversation.isPinned ? '★' : '☆'}</button>
                    <button
                      onClick={() => { setRenamingId(conversation.id); setRenameValue(conversation.title ?? ''); }}
                      disabled={generating}
                      aria-label="Rename conversation"
                      title="Rename"
                    >✎</button>
                    <button
                      className={confirmingDelete ? 'confirm-delete' : ''}
                      onClick={() => confirmingDelete ? deleteConversation.mutate(conversation.id) : setConfirmDeleteId(conversation.id)}
                      onBlur={() => setConfirmDeleteId((current) => current === conversation.id ? undefined : current)}
                      disabled={generating || deleteConversation.isPending}
                      aria-label={confirmingDelete ? 'Confirm delete conversation' : 'Delete conversation'}
                      title={confirmingDelete ? 'Click again to delete' : 'Delete'}
                    >{confirmingDelete ? 'Delete?' : '×'}</button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
      {(conversations.error || mutationError) && <div className="conversation-error">{errorMessage(conversations.error ?? mutationError)}</div>}
    </aside>
  );
}
