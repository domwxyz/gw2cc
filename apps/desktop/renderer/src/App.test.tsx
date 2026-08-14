import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BootstrapPayload, ConversationDetail, Gw2ccClient } from '@gw2cc/protocol';
import type { Gw2ccEvent } from '@gw2cc/protocol';
import { FixtureGw2Gateway } from '@gw2cc/gw2';
import { App } from './App';

let first: BootstrapPayload;
let second: BootstrapPayload;
let requestMock: ReturnType<typeof vi.fn>;
let emitEvent: (event: Gw2ccEvent) => void;
let current: BootstrapPayload;
let conversations: ConversationDetail[];

function conversationSummary(conversation: ConversationDetail) {
  return {
    id: conversation.id,
    title: conversation.title,
    isPinned: conversation.isPinned,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  };
}

beforeEach(async () => {
  const gateway = new FixtureGw2Gateway();
  const firstSnapshot = await gateway.getCharacterSnapshot('fixture-key', 'Aurelia Ward');
  const secondSnapshot = await gateway.getCharacterSnapshot('fixture-key', 'Sylvari Ranger');
  const connection = {
    status: 'connected' as const,
    account: { id: 'fixture-account-001', name: 'Fixture Commander.1234' },
    permissions: ['account', 'characters', 'builds', 'inventories', 'wallet', 'progression'],
    capabilities: { characters: true, equipment: true, builds: true },
    characterNames: ['Aurelia Ward', 'Sylvari Ranger'],
    selectedCharacterName: 'Aurelia Ward',
    lastConnectedAt: 1,
    secretStorage: { configured: true, available: true, strength: 'strong' as const, backend: 'fixture-memory' },
    fixtureMode: true
  };
  first = {
    connection,
    snapshot: firstSnapshot,
    globalInstructions: 'Global fixture instructions',
    characterLore: 'Aurelia lore',
    chat: {
      conversation: { id: 'conversation-1', title: 'Account-wide chat', isPinned: false, createdAt: 1, updatedAt: 1, messages: [], toolCalls: [] },
      provider: {
        configuration: { providerId: 'fixture', model: 'fixture-gw2-assistant', toolsEnabled: true, maxTokensEnabled: false, maxTokens: 1024 },
        credentialConfigured: true,
        credentialRequired: false,
        ready: true,
        capabilities: { streaming: true, tools: true },
        availableProviders: ['openrouter', 'openai-compatible', 'anthropic', 'ollama']
      }
    },
    research: {
      credentialConfigured: true,
      searchAvailable: true,
      directFetchAvailable: true,
      jsonFetchAvailable: true,
      metaBattleAvailable: true,
      fixtureMode: true,
      message: 'Web search, safe page fetching, and GW2 Wiki research are available.'
    }
  };
  second = {
    connection: { ...connection, selectedCharacterName: 'Sylvari Ranger' },
    snapshot: secondSnapshot,
    globalInstructions: 'Global fixture instructions',
    characterLore: 'Ranger lore',
    chat: first.chat,
    research: first.research
  };
  current = first;
  conversations = [first.chat.conversation];
  const listeners = new Set<(event: Gw2ccEvent) => void>();
  emitEvent = (event) => {
    for (const listener of listeners) listener(event);
  };
  requestMock = vi.fn(async (command: string, input: Record<string, unknown>) => {
    if (command === 'app.bootstrap') return current;
    if (command === 'characters.select') {
      current = input.name === 'Sylvari Ranger' ? second : first;
      return current;
    }
    if (command === 'equipment.inspectItem') {
      return current.snapshot!.equipment.find((item) => item.itemId === input.itemId)!;
    }
    if (command === 'characters.lore.set') {
      current = { ...current, characterLore: String(input.value) };
      return { value: String(input.value) };
    }
    if (command === 'instructions.set') return { value: String(input.value) };
    if (command === 'characters.refresh' || command === 'gw2.connection.get') return current;
    if (command === 'app.openExternal') return { opened: true };
    if (command === 'chat.send') return {
      runId: 'run-1', conversationId: 'conversation-1', userMessageId: 'chat-user-1', assistantMessageId: 'chat-assistant-1'
    };
    if (command === 'chat.cancel') return { cancelled: true };
    if (command === 'conversations.list') return conversations.map(conversationSummary);
    if (command === 'conversations.get') {
      return conversations.find((conversation) => conversation.id === input.id) ?? current.chat.conversation;
    }
    if (command === 'conversations.search') {
      const query = String(input.query).toLowerCase();
      return conversations.filter((conversation) => conversation.title?.toLowerCase().includes(query)).map(conversationSummary);
    }
    if (command === 'conversations.create') {
      const conversation: ConversationDetail = {
        id: `conversation-${conversations.length + 1}`,
        title: String(input.title ?? 'New conversation'),
        isPinned: false,
        createdAt: conversations.length + 2,
        updatedAt: conversations.length + 2,
        messages: [],
        toolCalls: []
      };
      conversations = [conversation, ...conversations];
      current = { ...current, chat: { ...current.chat, conversation } };
      return conversation;
    }
    if (command === 'conversations.select') {
      const conversation = conversations.find((entry) => entry.id === input.id)!;
      current = { ...current, chat: { ...current.chat, conversation } };
      return conversation;
    }
    if (command === 'conversations.rename' || command === 'conversations.setPinned') {
      const index = conversations.findIndex((entry) => entry.id === input.id);
      const updated = {
        ...conversations[index]!,
        ...(command === 'conversations.rename' ? { title: String(input.title) } : { isPinned: Boolean(input.isPinned) }),
        updatedAt: conversations[index]!.updatedAt + 1
      };
      conversations = conversations.map((entry, entryIndex) => entryIndex === index ? updated : entry);
      if (current.chat.conversation.id === updated.id) current = { ...current, chat: { ...current.chat, conversation: updated } };
      return updated;
    }
    if (command === 'conversations.delete') {
      conversations = conversations.filter((entry) => entry.id !== input.id);
      const conversation = conversations[0]!;
      current = { ...current, chat: { ...current.chat, conversation } };
      return conversation;
    }
    if (command === 'conversations.fork') {
      const source = conversations.find((conversation) => conversation.id === input.id)!;
      const sourceMessages = source.messages.slice(0, source.messages.findIndex((message) => message.id === input.messageId) + 1);
      const copiedMessages = sourceMessages.map((message, index) => ({
        ...message,
        id: `fork-message-${index + 1}`,
        conversationId: 'conversation-fork'
      }));
      const forked: ConversationDetail = {
        id: 'conversation-fork', title: `${source.title} (fork)`, isPinned: false, createdAt: 20, updatedAt: 20,
        messages: copiedMessages,
        toolCalls: source.toolCalls.flatMap((call) => {
          const messageIndex = sourceMessages.findIndex((message) => message.id === call.messageId);
          return messageIndex < 0 ? [] : [{ ...call, id: `fork-${call.id}`, messageId: copiedMessages[messageIndex]!.id }];
        })
      };
      conversations = [forked, ...conversations];
      current = { ...current, chat: { ...current.chat, conversation: forked } };
      return forked;
    }
    if (command === 'provider.settings.update') {
      const provider = {
        configuration: {
          providerId: input.providerId as 'openrouter' | 'openai-compatible' | 'anthropic' | 'ollama',
          model: String(input.model ?? ''),
          baseUrl: String(input.baseUrl ?? 'https://openrouter.ai/api/v1'),
          toolsEnabled: Boolean(input.toolsEnabled),
          maxTokensEnabled: Boolean(input.maxTokensEnabled),
          maxTokens: Number(input.maxTokens ?? 2048)
        },
        credentialConfigured: Boolean(input.apiKey) || current.chat.provider.credentialConfigured,
        credentialRequired: input.providerId === 'openrouter' || input.providerId === 'anthropic',
        ready: Boolean(input.model) && (Boolean(input.apiKey) || current.chat.provider.credentialConfigured),
        capabilities: { streaming: true as const, tools: Boolean(input.toolsEnabled) },
        availableProviders: ['openrouter', 'openai-compatible', 'anthropic', 'ollama'] as const
      };
      current = { ...current, chat: { ...current.chat, provider } };
      return provider;
    }
    if (command === 'provider.models') return [{ id: 'alpha/model', name: 'Alpha' }, { id: 'beta/model', name: 'Beta' }];
    if (command === 'provider.test') return { ok: true, providerId: 'openrouter', model: current.chat.provider.configuration.model, models: [{ id: 'alpha/model', name: 'Alpha' }], capabilities: { streaming: true, tools: true }, message: 'Connected.' };
    if (command === 'research.settings.setKey') return { ...current.research, credentialConfigured: true, searchAvailable: true, fixtureMode: false, message: 'Research ready.' };
    if (command === 'research.settings.test') return { ok: true, resultCount: 1, message: 'Connected to Tavily.' };
    if (command === 'research.settings.clear') return { ...current.research, credentialConfigured: false, searchAvailable: false, fixtureMode: false, message: 'Direct fetch only.' };
    if (command === 'chat.retry') return {
      runId: 'run-retry', conversationId: 'conversation-1', userMessageId: 'chat-user-2', assistantMessageId: 'chat-assistant-2'
    };
    if (command === 'chat.edit') return {
      runId: 'run-edit', conversationId: 'conversation-1', userMessageId: 'chat-user-3', assistantMessageId: 'chat-assistant-3'
    };
    throw new Error(`Unhandled test command ${command}`);
  });
  window.gw2cc = {
    request: requestMock,
    subscribe: (listener: (event: Gw2ccEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } as unknown as Gw2ccClient;
});

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
}

describe('Phase 1 renderer interactions', () => {
  it('switches characters and lore, then inspects equipment details through protocol commands', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByText('Aurelia Ward', { selector: 'option' })).toBeInTheDocument();
    const firstItem = await screen.findByRole('button', { name: /Head: Vigilant Dragon Helm/ });
    await user.click(firstItem);
    expect(await screen.findByRole('heading', { name: 'Vigilant Dragon Helm' })).toBeInTheDocument();
    expect(screen.getByText('selected', { exact: false })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Character'), 'Sylvari Ranger');
    expect(await screen.findByRole('button', { name: /Chest: Canopy Stalker Coat/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Character lore & goals')).toHaveValue('Ranger lore');
    expect(screen.getByLabelText('Global instructions')).toHaveValue('Global fixture instructions');

    const lore = screen.getByLabelText('Character lore & goals');
    await user.clear(lore);
    await user.type(lore, 'Updated ranger lore');
    const loreCard = lore.closest('.notes-card');
    expect(loreCard).not.toBeNull();
    await user.click(within(loreCard as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('characters.lore.set', { value: 'Updated ranger lore' }));

    await user.click(screen.getByRole('button', { name: /Chest: Canopy Stalker Coat/ }));
    expect(await screen.findByRole('heading', { name: 'Canopy Stalker Coat' })).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith('equipment.inspectItem', { itemId: 2001 });
  });

  it('renders streamed chat, compact tool activity, generation state, and cancellation without clearing on character focus changes', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('tab', { name: 'Console' }));
    await screen.findByRole('heading', { name: 'Account-wide chat' });
    const composer = screen.getByLabelText('Message');
    await user.type(composer, 'Check my power');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('chat.send', {
      content: 'Check my power', conversationId: 'conversation-1'
    }));

    const userMessage = {
      id: 'chat-user-1', conversationId: 'conversation-1', role: 'user' as const,
      content: 'Check my power', focusedCharacterName: 'Aurelia Ward', createdAt: 2, status: 'complete' as const
    };
    const assistantMessage = {
      id: 'chat-assistant-1', conversationId: 'conversation-1', role: 'assistant' as const,
      content: '', focusedCharacterName: 'Aurelia Ward', providerId: 'fixture' as const,
      modelId: 'fixture-gw2-assistant', createdAt: 3, status: 'streaming' as const
    };
    emitEvent({ type: 'chat.started', runId: 'run-1', conversationId: 'conversation-1', userMessage, assistantMessage });
    emitEvent({
      type: 'chat.reasoningDelta', runId: 'run-1', messageId: 'chat-assistant-1',
      delta: 'Checking the character snapshot before answering.', truncated: false
    });
    const reasoningTrace = (await screen.findByText('Reasoning trace')).closest('details');
    expect(reasoningTrace).not.toBeNull();
    expect(reasoningTrace).not.toHaveAttribute('open');
    await user.click(within(reasoningTrace as HTMLElement).getByText('Reasoning trace'));
    expect(within(reasoningTrace as HTMLElement).getByText('Checking the character snapshot before answering.')).toBeVisible();
    emitEvent({ type: 'chat.textDelta', runId: 'run-1', messageId: 'chat-assistant-1', delta: 'Checking live data. ' });
    emitEvent({
      type: 'chat.toolStarted', runId: 'run-1', messageId: 'chat-assistant-1',
      toolCall: {
        id: 'tool-1', messageId: 'chat-assistant-1', toolName: 'gw2_get_character_attributes',
        arguments: {}, status: 'running', startedAt: 4
      }
    });
    expect(await screen.findByText('gw2_get_character_attributes')).toBeInTheDocument();
    expect(screen.getByText('Checking live data.')).toBeInTheDocument();
    expect(document.querySelector('.message-context')).toHaveTextContent('Aurelia Ward');
    expect(document.querySelector('.assistant-label')).toHaveTextContent('Aurelia Ward');
    expect(screen.getByText('Focus: Aurelia Ward')).toBeInTheDocument();
    emitEvent({
      type: 'chat.toolCompleted', runId: 'run-1', messageId: 'chat-assistant-1', summary: 'Blocked unsafe page',
      toolCall: {
        id: 'tool-web-1', messageId: 'chat-assistant-1', toolName: 'fetch_url', arguments: { url: 'http://localhost' },
        result: { error: { code: 'WEB_FETCH_BLOCKED' } }, status: 'failed', startedAt: 4, completedAt: 5
      }
    });
    expect(await screen.findByText('fetch_url')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('chat.cancel', { runId: 'run-1' }));
    emitEvent({
      type: 'chat.cancelled', runId: 'run-1',
      message: {
        ...assistantMessage, content: 'Checking live data. ', status: 'cancelled',
        reasoningTrace: { content: 'Checking the character snapshot before answering.', finishReason: 'cancelled' }
      }
    });
    expect(await screen.findByText('Stopped')).toBeInTheDocument();

    second = {
      ...second,
      chat: {
        ...second.chat,
        conversation: {
          ...second.chat.conversation,
          messages: [{ ...userMessage }, {
            ...assistantMessage, content: 'Checking live data. ', status: 'cancelled',
            reasoningTrace: { content: 'Checking the character snapshot before answering.', finishReason: 'cancelled' }
          }],
          toolCalls: [{
            id: 'tool-1', messageId: 'chat-assistant-1', toolName: 'gw2_get_character_attributes',
            arguments: {}, status: 'running', startedAt: 4
          }]
        }
      }
    };
    await user.selectOptions(screen.getByLabelText('Character'), 'Sylvari Ranger');
    expect(await screen.findByText('Check my power')).toBeInTheDocument();
    expect(screen.getByText('Checking live data.')).toBeInTheDocument();
  });

  it('attaches Markdown files, sends attachment-only turns, and renders persisted file cards', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('tab', { name: 'Console' }));
    await screen.findByRole('heading', { name: 'Account-wide chat' });

    const file = new File(['# Rotation\nTwo'], 'rotation.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('Attach text files'), file);
    expect(await screen.findByText('rotation.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove rotation.md' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('chat.send', {
      content: '',
      conversationId: 'conversation-1',
      attachments: [{
        type: 'text', name: 'rotation.md', mediaType: 'text/markdown',
        content: '# Rotation\nTwo', size: 14
      }]
    }));

    const userMessage = {
      id: 'attachment-user', conversationId: 'conversation-1', role: 'user' as const,
      content: '', createdAt: 2, status: 'complete' as const,
      attachments: [{
        type: 'text' as const, name: 'rotation.md', mediaType: 'text/markdown' as const,
        content: '# Rotation\nTwo', size: 14
      }]
    };
    const assistantMessage = {
      id: 'attachment-assistant', conversationId: 'conversation-1', role: 'assistant' as const,
      content: '', providerId: 'fixture' as const, modelId: 'fixture-gw2-assistant',
      createdAt: 3, status: 'streaming' as const
    };
    emitEvent({
      type: 'chat.started', runId: 'run-1', conversationId: 'conversation-1', userMessage, assistantMessage
    });
    const attachedCard = await screen.findByText('rotation.md');
    const details = attachedCard.closest('details');
    expect(details).not.toBeNull();
    await user.click(attachedCard);
    expect(details).toHaveAttribute('open');
    expect(details?.querySelector('pre')).toHaveTextContent('# Rotation Two');
  });

  it('renders Markdown and supports keyboard send, retry, edit-and-resend, and assistant forks', async () => {
    const userMessage = {
      id: 'existing-user', conversationId: 'conversation-1', role: 'user' as const,
      content: 'Original question', focusedCharacterName: 'Aurelia Ward', createdAt: 2, status: 'complete' as const
    };
    const assistantMessage = {
      id: 'existing-assistant', conversationId: 'conversation-1', role: 'assistant' as const,
      content: '**Strong answer**\n\n- First\n- Second', focusedCharacterName: 'Aurelia Ward', providerId: 'fixture' as const,
      modelId: 'fixture-gw2-assistant', createdAt: 3, status: 'complete' as const
    };
    const populated: ConversationDetail = {
      ...first.chat.conversation,
      messages: [userMessage, assistantMessage],
      toolCalls: [{
        id: 'existing-tool', messageId: 'existing-assistant', toolName: 'gw2_get_account', arguments: {},
        result: { ok: true }, status: 'completed' as const, contentOffset: 0, startedAt: 3, completedAt: 4
      }]
    };
    first = { ...first, chat: { ...first.chat, conversation: populated } };
    current = first;
    conversations = [populated];
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('tab', { name: 'Console' }));

    expect(await screen.findByText('Strong answer')).toHaveStyle({ fontWeight: 'bold' });
    expect(screen.getByRole('list')).toHaveTextContent('First Second');
    expect(screen.getByText('gw2_get_account')).toBeInTheDocument();

    const composer = screen.getByLabelText('Message');
    await user.type(composer, 'Sent with Enter{enter}');
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('chat.send', {
      content: 'Sent with Enter', conversationId: 'conversation-1'
    }));

    emitEvent({ type: 'chat.cancelled', runId: 'run-1', message: { ...assistantMessage, status: 'cancelled' } });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('chat.retry', { messageId: 'existing-user' }));

    emitEvent({ type: 'chat.cancelled', runId: 'run-retry', message: { ...assistantMessage, status: 'cancelled' } });
    await user.click(screen.getByRole('button', { name: 'Edit and resend' }));
    const edit = screen.getByLabelText('Edit message');
    await user.clear(edit);
    await user.type(edit, 'Refined question');
    await user.click(screen.getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('chat.edit', {
      messageId: 'existing-user', content: 'Refined question'
    }));

    emitEvent({ type: 'chat.cancelled', runId: 'run-edit', message: { ...assistantMessage, status: 'cancelled' } });
    await user.click(screen.getByRole('button', { name: 'Fork conversation here' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('conversations.fork', {
      id: 'conversation-1', messageId: 'existing-assistant'
    }));
    expect(await screen.findByRole('heading', { name: 'Account-wide chat (fork)' })).toBeInTheDocument();
  });

  it('creates, renames, pins, searches, selects, and deletes persistent conversations', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('tab', { name: 'Console' }));
    const rail = await screen.findByRole('complementary', { name: 'Conversations' });

    await user.click(within(rail).getByRole('button', { name: 'New conversation' }));
    expect(await within(rail).findByText('New conversation')).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith('conversations.create', {});

    const newEntry = within(rail).getByText('New conversation').closest('.conversation-entry');
    expect(newEntry).not.toBeNull();
    await user.click(within(newEntry as HTMLElement).getByRole('button', { name: 'Rename conversation' }));
    const title = within(newEntry as HTMLElement).getByLabelText('Conversation title');
    await user.clear(title);
    await user.type(title, 'Pinned fractal notes');
    await user.click(within(newEntry as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('conversations.rename', {
      id: 'conversation-2', title: 'Pinned fractal notes'
    }));

    const renamedEntry = (await within(rail).findByText('Pinned fractal notes')).closest('.conversation-entry');
    expect(renamedEntry).not.toBeNull();
    await user.click(within(renamedEntry as HTMLElement).getByRole('button', { name: 'Pin conversation' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('conversations.setPinned', {
      id: 'conversation-2', isPinned: true
    }));

    await user.type(within(rail).getByLabelText('Search conversations'), 'fractal');
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('conversations.search', { query: 'fractal' }));
    expect(within(rail).getByText('Pinned fractal notes')).toBeInTheDocument();
    await user.click(within(rail).getByRole('button', { name: 'Clear conversation search' }));

    const deleteEntry = (await within(rail).findByText('Pinned fractal notes')).closest('.conversation-entry') as HTMLElement;
    await user.click(within(deleteEntry).getByRole('button', { name: 'Delete conversation' }));
    await user.click(within(deleteEntry).getByRole('button', { name: 'Confirm delete conversation' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('conversations.delete', { id: 'conversation-2' }));
    expect(await within(rail).findByText('Account-wide chat')).toBeInTheDocument();
  });

  it('configures, tests, and clears Tavily through status-only protocol outputs', async () => {
    first = {
      ...first,
      research: {
      credentialConfigured: false,
      searchAvailable: false,
      directFetchAvailable: true,
      jsonFetchAvailable: true,
      metaBattleAvailable: true,
        fixtureMode: false,
        message: 'Direct fetch only.'
      }
    };
    current = first;
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: /Settings/ }));
    await user.click(screen.getByRole('button', { name: 'Research' }));
    const key = screen.getByLabelText('Tavily API key');
    await user.type(key, 'tvly-renderer-one-way');
    await user.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('research.settings.setKey', { apiKey: 'tvly-renderer-one-way' }));
    expect(screen.queryByDisplayValue('tvly-renderer-one-way')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Test search' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('research.settings.test', {}));
    expect(await screen.findByText(/Connected to Tavily/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear key' }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('research.settings.clear', {}));
  });

  it('discovers provider models after saving a credential and persists model selection automatically', async () => {
    first = {
      ...first,
      connection: { ...first.connection, fixtureMode: false },
      chat: {
        ...first.chat,
        provider: {
          configuration: { providerId: 'openrouter', model: '', baseUrl: 'https://openrouter.ai/api/v1', toolsEnabled: true, maxTokensEnabled: false, maxTokens: 2048 },
          credentialConfigured: false,
          credentialRequired: true,
          ready: false,
          capabilities: { streaming: true, tools: true },
          availableProviders: ['openrouter', 'openai-compatible', 'anthropic', 'ollama']
        }
      }
    };
    current = first;
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Limit output tokens')).not.toBeChecked();
    expect(screen.getByLabelText('Maximum output tokens')).toBeDisabled();
    await user.type(screen.getByLabelText('Provider API key'), 'one-way-provider-secret');
    await user.click(screen.getByRole('button', { name: 'Connect & discover' }));

    const model = await screen.findByRole('combobox', { name: 'LLM model' });
    expect(model).toHaveValue('alpha/model');
    expect(screen.getByText('2 models found.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('one-way-provider-secret')).not.toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith('provider.models', {});
    expect(requestMock).toHaveBeenCalledWith('provider.settings.update', expect.objectContaining({
      providerId: 'openrouter', model: 'alpha/model', maxTokensEnabled: false
    }));

    await user.click(screen.getByLabelText('Limit output tokens'));
    expect(screen.getByLabelText('Maximum output tokens')).toBeEnabled();
    await user.selectOptions(model, 'beta/model');
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith('provider.settings.update', expect.objectContaining({
      providerId: 'openrouter', model: 'beta/model', maxTokensEnabled: true
    })));
  });
});
