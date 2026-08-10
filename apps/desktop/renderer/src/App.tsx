import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttributeKey,
  BootstrapPayload,
  BuildInspection,
  ConversationAttachment,
  ConversationDetail,
  ConversationMessage,
  EquippedItem,
  Gw2ccEvent,
  ProviderSettingsView,
  SkillSelection
} from '@gw2cc/protocol';
import { ConversationRail } from './components/Chat/ConversationRail';
import { MessageList } from './components/Chat/MessageList';
import { ChatComposer } from './components/Chat/ChatComposer';
import { NotesEditor } from './components/Context/NotesEditor';

const BOOTSTRAP_KEY = ['gw2cc', 'bootstrap'] as const;

type WorkspaceView = 'character' | 'console';
type SettingsView = 'account' | 'assistant' | 'research';
type ProviderModel = { id: string; name?: string };
type ConfigurableProvider = 'openrouter' | 'openai-compatible' | 'anthropic' | 'ollama';

const PROVIDER_DEFAULT_BASE_URLS: Record<ConfigurableProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  ollama: 'http://127.0.0.1:11434'
};

function resolveCatalogModel(currentModel: string, models: ProviderModel[]): string {
  const current = currentModel.trim();
  return current && models.some((entry) => entry.id === current) ? current : models[0]?.id ?? current;
}

const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  Power: 'Power',
  Precision: 'Precision',
  Toughness: 'Toughness',
  Vitality: 'Vitality',
  Ferocity: 'Ferocity',
  ConditionDamage: 'Condition Damage',
  Expertise: 'Expertise',
  Concentration: 'Concentration',
  HealingPower: 'Healing Power',
  AgonyResistance: 'Agony Resistance'
};

const SLOT_LABELS: Record<string, string> = {
  Helm: 'Head',
  Shoulders: 'Shoulders',
  Coat: 'Chest',
  Gloves: 'Hands',
  Leggings: 'Legs',
  Boots: 'Feet',
  Backpack: 'Back',
  Accessory1: 'Accessory I',
  Accessory2: 'Accessory II',
  Ring1: 'Ring I',
  Ring2: 'Ring II',
  Amulet: 'Amulet',
  WeaponA1: 'Set I Main',
  WeaponA2: 'Set I Off',
  WeaponB1: 'Set II Main',
  WeaponB2: 'Set II Off',
  HelmAquatic: 'Aquatic Head',
  WeaponAquaticA: 'Aquatic I',
  WeaponAquaticB: 'Aquatic II'
};

const DISPLAY_SLOTS = Object.keys(SLOT_LABELS);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function Icon({ src, name }: { src?: string; name: string }) {
  return src ? <img className="icon" src={src} alt="" /> : <span className="icon icon-fallback">{name.slice(0, 1)}</span>;
}

function StatusPill({ payload }: { payload: BootstrapPayload }) {
  const connection = payload.connection;
  return (
    <span className={`status-pill status-${connection.status}`}>
      <span className="status-dot" />
      {connection.fixtureMode
        ? 'Fixture account'
        : connection.status === 'connected'
          ? connection.account?.name ?? 'Connected'
          : connection.status === 'error'
            ? 'Connection issue'
            : 'Not connected'}
    </span>
  );
}

function Header({
  payload,
  activeView,
  selecting,
  refreshing,
  onView,
  onSelect,
  onRefresh,
  onSettings
}: {
  payload: BootstrapPayload;
  activeView: WorkspaceView;
  selecting: boolean;
  refreshing: boolean;
  onView(view: WorkspaceView): void;
  onSelect(name: string): void;
  onRefresh(): void;
  onSettings(): void;
}) {
  const snapshot = payload.snapshot;
  return (
    <header className="app-header">
      <div className="brand-block">
        <span className="brand-wordmark"><strong>gw2cc</strong></span>
      </div>
      <nav className="primary-nav" role="tablist" aria-label="Workspace">
        <button role="tab" className={activeView === 'character' ? 'active' : ''} aria-selected={activeView === 'character'} onClick={() => onView('character')}>Character</button>
        <button role="tab" className={activeView === 'console' ? 'active' : ''} aria-selected={activeView === 'console'} onClick={() => onView('console')}>Console</button>
      </nav>
      <div className="character-heading">
        <select
          id="character-select"
          aria-label="Character"
          value={payload.connection.selectedCharacterName ?? ''}
          disabled={selecting || payload.connection.characterNames.length === 0}
          onChange={(event) => onSelect(event.target.value)}
        >
          {payload.connection.characterNames.map((name) => <option key={name}>{name}</option>)}
        </select>
        {snapshot ? (
          <p>Lv. {snapshot.character.level} {snapshot.eliteSpecialization ?? snapshot.character.profession} · {snapshot.character.race}</p>
        ) : <p>No character selected</p>}
      </div>
      <div className="header-actions">
        <StatusPill payload={payload} />
        <button className="icon-button" onClick={onRefresh} disabled={refreshing || !snapshot} aria-label="Refresh character">
          {refreshing ? 'Refreshing…' : '↻'}
        </button>
        <button className="icon-button settings-button" onClick={onSettings}>Settings</button>
      </div>
    </header>
  );
}

function EquipmentPanel({
  equipment,
  selectedId,
  onInspect
}: {
  equipment: EquippedItem[];
  selectedId?: number;
  onInspect(itemId: number): void;
}) {
  const bySlot = useMemo(() => new Map(equipment.map((item) => [item.slot, item])), [equipment]);
  return (
    <section className="panel equipment-panel" aria-labelledby="equipment-title">
      <div className="panel-heading">
        <div><span className="eyebrow">Active loadout</span><h2 id="equipment-title">Equipment</h2></div>
        <span className="count-badge">{equipment.length} equipped</span>
      </div>
      <div className="equipment-map">
        {DISPLAY_SLOTS.map((slot) => {
          const equipped = bySlot.get(slot);
          return equipped ? (
            <button
              key={slot}
              className={`equipment-slot rarity-${equipped.item.rarity?.toLowerCase() ?? 'basic'} ${selectedId === equipped.itemId ? 'selected' : ''}`}
              onClick={() => onInspect(equipped.itemId)}
              aria-label={`${SLOT_LABELS[slot]}: ${equipped.item.name}`}
              title={equipped.item.name}
            >
              <Icon src={equipped.item.icon} name={equipped.item.name} />
              <span className="slot-copy"><small>{SLOT_LABELS[slot]}</small><strong>{equipped.item.name}</strong></span>
              <span className="slot-meta">
                {equipped.statName ?? 'Stats unresolved'}
                {(equipped.upgrades.length + equipped.infusions.length) > 0 && ` · ${equipped.upgrades.length + equipped.infusions.length} mods`}
              </span>
            </button>
          ) : (
            <div key={slot} className="equipment-slot empty" aria-label={`${SLOT_LABELS[slot]} empty`}>
              <span className="empty-glyph">◇</span><span className="slot-copy"><small>{SLOT_LABELS[slot]}</small><strong>Empty</strong></span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AttributePanel({ payload }: { payload: BootstrapPayload }) {
  const report = payload.snapshot!.attributes;
  const primary = Object.entries(report.totals) as [AttributeKey, number][];
  const derived = [
    ['criticalChance', 'Critical Chance', report.derived.criticalChance, '%'],
    ['criticalDamage', 'Critical Damage', report.derived.criticalDamage, '%'],
    ['conditionDuration', 'Condition Duration', report.derived.conditionDuration, '%'],
    ['boonDuration', 'Boon Duration', report.derived.boonDuration, '%'],
    ...(report.derived.armor !== undefined ? [['armor', 'Armor', report.derived.armor, '']] : []),
    ...(report.derived.health !== undefined ? [['health', 'Health', report.derived.health, '']] : []),
    ...(report.derived.defense !== undefined ? [['defense', 'Defense', report.derived.defense, '']] : [])
  ] as [string, string, number, string][];

  return (
    <div className="attributes-view">
      <div className="quality-banner">
        <span className={`quality quality-${report.completeness}`}>
          {report.completeness === 'incomplete' ? 'Incomplete' : 'Calculated baseline'}
        </span>
        <p>Structured API reconstruction</p>
      </div>
      <div className="attribute-grid">
        {primary.map(([key, value]) => (
          <details className="attribute-card" key={key}>
            <summary><span>{ATTRIBUTE_LABELS[key]}</span><strong>{Math.round(value).toLocaleString()}</strong></summary>
            <div className="provenance-list">
              {report.sources.filter((source) => source.attribute === key).map((source, index) => (
                <div key={`${source.label}-${index}`}><span>{source.label}</span><b>+{source.amount}</b></div>
              ))}
              {!report.sources.some((source) => source.attribute === key) && <p>No structured contribution.</p>}
            </div>
          </details>
        ))}
      </div>
      <h3 className="subheading">Derived</h3>
      <div className="derived-grid">
        {derived.map(([key, label, value, suffix]) => (
          <details className="derived-card" key={key}>
            <summary><span>{label}</span><strong>{value.toFixed(suffix ? 1 : 0)}{suffix}</strong></summary>
            <p>{report.sources.find((source) => source.attribute === key)?.label ?? 'Derived from reconstructed totals.'}</p>
          </details>
        ))}
      </div>
      <details className="omissions">
        <summary>Calculation scope and omissions ({report.omissions.length})</summary>
        <ul>{report.omissions.map((omission) => <li key={omission}>{omission}</li>)}</ul>
      </details>
    </div>
  );
}

function SkillChip({ skill, kind }: { skill?: SkillSelection; kind: string }) {
  return skill ? (
    <div className="skill-chip"><Icon src={skill.icon} name={skill.name} /><span><small>{kind}</small><strong>{skill.name}</strong></span></div>
  ) : (
    <div className="skill-chip empty-skill"><span><small>{kind}</small><strong>Not selected</strong></span></div>
  );
}

function BuildPanel({ build }: { build?: BuildInspection }) {
  if (!build) return <div className="empty-state"><span>⌁</span><h3>Build unavailable</h3><p>Add the builds permission to the GW2 API key to inspect traits and skills.</p></div>;
  return (
    <div className="build-view">
      <div className="build-title"><span className="eyebrow">PvE build template · Tab {build.tab}</span><h3>{build.name}</h3></div>
      <div className="specializations">
        {build.specializations.map((specialization) => (
          <article className={`specialization ${specialization.elite ? 'elite' : ''}`} key={specialization.id}>
            <div className="specialization-title"><Icon src={specialization.icon} name={specialization.name} /><div><strong>{specialization.name}</strong><small>{specialization.elite ? 'Elite specialization' : 'Core specialization'}</small></div></div>
            <div className="trait-row">
              {specialization.traits.map((trait) => <div className="trait" key={trait.id} title={trait.description}><Icon src={trait.icon} name={trait.name} /><span>{trait.name}</span></div>)}
            </div>
          </article>
        ))}
      </div>
      <div className="skills-grid">
        <SkillChip skill={build.heal} kind="Heal" />
        {build.utilities.map((skill, index) => <SkillChip skill={skill} kind={`Utility ${index + 1}`} key={skill.id} />)}
        <SkillChip skill={build.elite} kind="Elite" />
      </div>
      {(build.aquatic.heal || build.aquatic.utilities.length > 0 || build.aquatic.elite) && (
        <details className="aquatic-skills"><summary>Aquatic skills</summary><div className="skills-grid"><SkillChip skill={build.aquatic.heal} kind="Heal" />{build.aquatic.utilities.map((skill, index) => <SkillChip skill={skill} kind={`Utility ${index + 1}`} key={skill.id} />)}<SkillChip skill={build.aquatic.elite} kind="Elite" /></div></details>
      )}
    </div>
  );
}

function InspectorCenter({ payload }: { payload: BootstrapPayload }) {
  const [tab, setTab] = useState<'attributes' | 'build'>('attributes');
  return (
    <section className="panel center-panel">
      <div className="tab-bar" role="tablist" aria-label="Character inspection">
        <button role="tab" aria-selected={tab === 'attributes'} onClick={() => setTab('attributes')}>Attributes</button>
        <button role="tab" aria-selected={tab === 'build'} onClick={() => setTab('build')}>Build</button>
        <span className="template-name">{payload.snapshot?.equipmentTemplate ?? 'No equipment template'}</span>
      </div>
      {tab === 'attributes' ? <AttributePanel payload={payload} /> : <BuildPanel build={payload.snapshot?.build} />}
    </section>
  );
}

function ItemInspector({ item, loading, onWiki }: { item?: EquippedItem; loading: boolean; onWiki(name: string): void }) {
  if (loading) return <section className="details-card loading-card">Resolving item details…</section>;
  if (!item) return <section className="details-card item-placeholder"><span>◇</span><h3>Item details</h3><p>Select equipment to inspect it.</p></section>;
  return (
    <section className="details-card item-details" aria-label="Item details">
      <div className="item-title"><Icon src={item.item.icon} name={item.item.name} /><div><span className={`rarity-text rarity-${item.item.rarity?.toLowerCase()}`}>{item.item.rarity ?? 'Unknown rarity'}</span><h3>{item.item.name}</h3><p>{item.item.type}{item.item.subtype ? ` · ${item.item.subtype}` : ''} · Level {item.item.level}</p></div></div>
      <dl className="item-facts">
        <div><dt>Item ID</dt><dd>{item.itemId}</dd></div>
        <div><dt>Slot</dt><dd>{SLOT_LABELS[item.slot] ?? item.slot}</dd></div>
        <div><dt>Stat set</dt><dd>{item.statName ?? 'Unresolved'} <small>({item.statSource})</small></dd></div>
        <div><dt>Binding</dt><dd>{item.binding ?? 'Unbound'}{item.boundTo ? ` · ${item.boundTo}` : ''}</dd></div>
        {item.item.defense !== undefined && <div><dt>Defense</dt><dd>{item.item.defense}</dd></div>}
        {item.item.minPower !== undefined && <div><dt>Weapon strength</dt><dd>{item.item.minPower}–{item.item.maxPower}</dd></div>}
      </dl>
      {item.attributes.length > 0 && <div className="detail-section"><h4>Direct attributes</h4><ul>{item.attributes.map((attribute) => <li key={attribute.attribute}><span>{ATTRIBUTE_LABELS[attribute.attribute]}</span><b>+{attribute.value}</b></li>)}</ul></div>}
      {item.skin && <div className="detail-section skin-row"><Icon src={item.skin.icon} name={item.skin.name} /><span><small>Applied skin</small><strong>{item.skin.name}</strong></span></div>}
      {(item.upgrades.length > 0 || item.infusions.length > 0) && <div className="detail-section"><h4>Upgrades & infusions</h4><ul>{[...item.upgrades, ...item.infusions].map((upgrade, index) => <li key={`${upgrade.id}-${index}`}><span>{upgrade.name}</span><b>{upgrade.attributes.map((entry) => `+${entry.value} ${ATTRIBUTE_LABELS[entry.attribute]}`).join(', ') || 'Effect not numerically modeled'}</b></li>)}</ul></div>}
      {item.item.description && <p className="item-description">{item.item.description}</p>}
      <button className="wiki-button" onClick={() => onWiki(item.item.name)}>Open GW2 Wiki search ↗</button>
    </section>
  );
}

function ContextColumn({
  payload,
  inspected,
  inspecting,
  onWiki
}: {
  payload: BootstrapPayload;
  inspected?: EquippedItem;
  inspecting: boolean;
  onWiki(name: string): void;
}) {
  const queryClient = useQueryClient();
  const [instructions, setInstructions] = useState(payload.globalInstructions);
  const [lore, setLore] = useState(payload.characterLore);
  useEffect(() => setInstructions(payload.globalInstructions), [payload.globalInstructions]);
  useEffect(() => setLore(payload.characterLore), [payload.characterLore, payload.connection.selectedCharacterName]);

  const instructionsMutation = useMutation({
    mutationFn: () => window.gw2cc.request('instructions.set', { value: instructions }),
    onSuccess: ({ value }) => queryClient.setQueryData<BootstrapPayload>(BOOTSTRAP_KEY, (current) => current ? { ...current, globalInstructions: value } : current)
  });
  const loreMutation = useMutation({
    mutationFn: () => window.gw2cc.request('characters.lore.set', { value: lore }),
    onSuccess: ({ value }) => queryClient.setQueryData<BootstrapPayload>(BOOTSTRAP_KEY, (current) => current ? { ...current, characterLore: value } : current)
  });

  return (
    <aside className="context-column">
      <NotesEditor id="global-instructions" eyebrow="Account-wide" title="Global instructions" value={instructions} placeholder="Standing preferences for future analysis…" dirty={instructions !== payload.globalInstructions} saving={instructionsMutation.isPending} onChange={setInstructions} onSave={() => instructionsMutation.mutate()} />
      <NotesEditor id="character-lore" eyebrow={payload.connection.selectedCharacterName ?? 'Per character'} title="Character lore & goals" value={lore} placeholder="Role-play background, build intentions, playstyle, and goals…" dirty={lore !== payload.characterLore} saving={loreMutation.isPending} onChange={setLore} onSave={() => loreMutation.mutate()} />
      {(instructionsMutation.error || loreMutation.error) && <div className="inline-error">{errorMessage(instructionsMutation.error ?? loreMutation.error)}</div>}
      <ItemInspector item={inspected} loading={inspecting} onWiki={onWiki} />
    </aside>
  );
}

function mergeEvent(payload: BootstrapPayload, event: Gw2ccEvent): BootstrapPayload {
  const conversation = payload.chat.conversation;
  const upsertMessage = (message: ConversationMessage) => {
    const existing = conversation.messages.some((entry) => entry.id === message.id);
    return existing
      ? conversation.messages.map((entry) => entry.id === message.id ? message : entry)
      : [...conversation.messages, message];
  };
  if (event.type === 'chat.started') {
    if (event.conversationId !== conversation.id) return payload;
    return {
      ...payload,
      chat: {
        ...payload.chat,
        conversation: {
          ...conversation,
          messages: upsertMessage(event.userMessage).some((entry) => entry.id === event.assistantMessage.id)
            ? upsertMessage(event.userMessage)
            : [...upsertMessage(event.userMessage), event.assistantMessage]
        }
      }
    };
  }
  if (event.type === 'chat.textDelta') {
    if (!conversation.messages.some((message) => message.id === event.messageId)) return payload;
    return {
      ...payload,
      chat: {
        ...payload.chat,
        conversation: {
          ...conversation,
          messages: conversation.messages.map((message) => message.id === event.messageId
            ? { ...message, content: message.content + event.delta }
            : message)
        }
      }
    };
  }
  if (event.type === 'chat.reasoningDelta') {
    if (!conversation.messages.some((message) => message.id === event.messageId)) return payload;
    return {
      ...payload,
      chat: {
        ...payload.chat,
        conversation: {
          ...conversation,
          messages: conversation.messages.map((message) => message.id === event.messageId
            ? {
                ...message,
                reasoningTrace: {
                  ...(message.reasoningTrace ?? { content: '' }),
                  content: `${message.reasoningTrace?.content ?? ''}${event.delta}`,
                  ...(event.truncated ? { truncated: true } : {})
                }
              }
            : message)
        }
      }
    };
  }
  if (event.type === 'chat.toolStarted' || event.type === 'chat.toolCompleted') {
    if (!conversation.messages.some((message) => message.id === event.messageId)) return payload;
    const exists = conversation.toolCalls.some((call) => call.id === event.toolCall.id);
    return {
      ...payload,
      chat: {
        ...payload.chat,
        conversation: {
          ...conversation,
          toolCalls: exists
            ? conversation.toolCalls.map((call) => call.id === event.toolCall.id ? event.toolCall : call)
            : [...conversation.toolCalls, event.toolCall]
        }
      }
    };
  }
  if (event.type === 'chat.completed' || event.type === 'chat.cancelled' || event.type === 'chat.failed') {
    if (event.message.conversationId !== conversation.id) return payload;
    return {
      ...payload,
      chat: {
        ...payload.chat,
        conversation: { ...conversation, messages: upsertMessage(event.message) }
      }
    };
  }
  return payload;
}

function ChatWorkspace({ payload, onSettings }: { payload: BootstrapPayload; onSettings(): void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
  const [runId, setRunId] = useState<string>();
  const conversation = payload.chat.conversation;
  const provider = payload.chat.provider;
  const activateConversation = (next: ConversationDetail) => {
    setDraft('');
    setAttachments([]);
    queryClient.setQueryData<BootstrapPayload>(BOOTSTRAP_KEY, (current) => current
      ? { ...current, chat: { ...current.chat, conversation: next } }
      : current);
  };

  useEffect(() => window.gw2cc.subscribe((event) => {
    queryClient.setQueryData<BootstrapPayload>(BOOTSTRAP_KEY, (current) => current ? mergeEvent(current, event) : current);
    if (event.type === 'chat.started') {
      setRunId(event.runId);
      void queryClient.invalidateQueries({ queryKey: ['gw2cc', 'conversations'] });
    }
    if (event.type === 'chat.completed' || event.type === 'chat.cancelled' || event.type === 'chat.failed') {
      setRunId((current) => current === event.runId ? undefined : current);
      void queryClient.invalidateQueries({ queryKey: ['gw2cc', 'conversations'] });
    }
  }), [queryClient]);

  const send = useMutation({
    mutationFn: () => window.gw2cc.request('chat.send', {
      content: draft,
      conversationId: conversation.id,
      ...(attachments.length ? { attachments } : {})
    }),
    onSuccess: (result) => {
      setRunId(result.runId);
      setDraft('');
      setAttachments([]);
    }
  });
  const cancel = useMutation({
    mutationFn: () => runId
      ? window.gw2cc.request('chat.cancel', { runId })
      : Promise.resolve({ cancelled: false })
  });
  const refreshActiveConversation = async (result: { runId: string; conversationId: string }) => {
    const next = await window.gw2cc.request('conversations.get', { id: result.conversationId });
    activateConversation(next);
    setRunId(result.runId);
  };
  const retry = useMutation({
    mutationFn: async (messageId: string) => {
      const result = await window.gw2cc.request('chat.retry', { messageId });
      await refreshActiveConversation(result);
    }
  });
  const edit = useMutation({
    mutationFn: async ({ messageId, content }: { messageId: string; content: string }) => {
      const result = await window.gw2cc.request('chat.edit', { messageId, content });
      await refreshActiveConversation(result);
    }
  });
  const fork = useMutation({
    mutationFn: (messageId: string) => window.gw2cc.request('conversations.fork', { id: conversation.id, messageId }),
    onSuccess: (next) => {
      activateConversation(next);
      void queryClient.invalidateQueries({ queryKey: ['gw2cc', 'conversations'] });
    }
  });
  const generating = Boolean(runId);

  return (
    <section className="chat-workspace" aria-label="Account-wide chat">
      <ConversationRail activeConversation={conversation} generating={generating} onActivate={activateConversation} />
      <div className="chat-main">
        <header className="chat-header">
          <h2>{conversation.title ?? 'Untitled conversation'}</h2>
          <button type="button" className="provider-indicator" onClick={onSettings} title="Assistant settings">
            <strong>{provider.configuration.providerId}</strong><span>{provider.configuration.model || 'No model selected'}</span><small className={provider.capabilities.tools ? 'tools-on' : 'tools-off'}>{provider.capabilities.tools ? 'tools on' : 'tools off'}</small>
          </button>
        </header>
        <MessageList
          conversation={conversation}
          generating={generating}
          onRetry={async (messageId) => { await retry.mutateAsync(messageId); }}
          onEdit={async (messageId, content) => { await edit.mutateAsync({ messageId, content }); }}
          onFork={async (messageId) => { await fork.mutateAsync(messageId); }}
        />
        {!provider.ready && (
          <button className="provider-warning" onClick={onSettings}>
            {provider.message ?? 'Configure an LLM provider and model to begin.'} Open Settings →
          </button>
        )}
        {!provider.capabilities.tools && provider.ready && (
          <div className="retrieval-warning">Ordinary chat is available, but this model is configured without live GW2 or web retrieval.</div>
        )}
        {(send.error || cancel.error || retry.error || edit.error || fork.error) && <div className="inline-error chat-inline-error">{errorMessage(send.error ?? cancel.error ?? retry.error ?? edit.error ?? fork.error)}</div>}
        <ChatComposer
          value={draft}
          ready={provider.ready}
          generating={generating}
          sending={send.isPending}
          attachments={attachments}
          focusedCharacter={payload.connection.selectedCharacterName}
          onChange={setDraft}
          onAttachmentsChange={setAttachments}
          onSend={() => send.mutate()}
          onCancel={() => cancel.mutate()}
        />
      </div>
    </section>
  );
}

function SettingsPanel({ payload, onClose, onPayload }: { payload: BootstrapPayload; onClose(): void; onPayload(payload: BootstrapPayload): void }) {
  const configuredProvider = payload.chat.provider.configuration.providerId === 'fixture'
    ? 'openrouter'
    : payload.chat.provider.configuration.providerId;
  const [view, setView] = useState<SettingsView>('assistant');
  const [apiKey, setApiKey] = useState('');
  const [providerId, setProviderId] = useState<ConfigurableProvider>(configuredProvider);
  const [model, setModel] = useState(payload.chat.provider.configuration.model);
  const [baseUrl, setBaseUrl] = useState(payload.chat.provider.configuration.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[configuredProvider]);
  const [providerKey, setProviderKey] = useState('');
  const [toolsEnabled, setToolsEnabled] = useState(payload.chat.provider.configuration.toolsEnabled);
  const [maxTokensEnabled, setMaxTokensEnabled] = useState(payload.chat.provider.configuration.maxTokensEnabled);
  const [maxTokens, setMaxTokens] = useState(payload.chat.provider.configuration.maxTokens);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [catalogNotice, setCatalogNotice] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const autoDiscoveryAttempted = useRef(false);
  const connection = payload.connection;

  const updateProviderPayload = (provider: ProviderSettingsView) => onPayload({
    ...payload,
    chat: { ...payload.chat, provider }
  });
  const connect = useMutation({
    mutationFn: () => window.gw2cc.request('gw2.connection.setKey', { apiKey }),
    onSuccess: (next) => { setApiKey(''); onPayload(next); }
  });
  const test = useMutation({ mutationFn: () => window.gw2cc.request('gw2.connection.test', {}), onSuccess: onPayload });
  const disconnect = useMutation({ mutationFn: () => window.gw2cc.request('gw2.connection.disconnect', {}), onSuccess: onPayload });
  const selectModel = useMutation({
    mutationFn: (nextModel: string) => window.gw2cc.request('provider.settings.update', {
      providerId,
      model: nextModel,
      baseUrl: baseUrl.trim(),
      toolsEnabled,
      maxTokensEnabled,
      maxTokens
    }),
    onSuccess: updateProviderPayload
  });
  const saveProvider = useMutation({
    mutationFn: async (override?: { providerId?: ConfigurableProvider; model?: string; baseUrl?: string; apiKey?: string }) => {
      const nextProviderId = override?.providerId ?? providerId;
      const nextBaseUrl = override?.baseUrl ?? baseUrl;
      const nextModel = override?.model ?? model;
      const nextKey = override?.apiKey ?? providerKey.trim();
      let provider = await window.gw2cc.request('provider.settings.update', {
        providerId: nextProviderId,
        model: nextModel,
        baseUrl: nextBaseUrl.trim(),
        toolsEnabled,
        maxTokensEnabled,
        maxTokens,
        ...(nextKey ? { apiKey: nextKey } : {})
      });
      if (provider.credentialRequired && !provider.credentialConfigured) {
        return { provider, models: [] as ProviderModel[], selectedModel: nextModel, notice: 'Add an API key to discover models.' };
      }
      try {
        const discovered = await window.gw2cc.request('provider.models', {});
        const selectedModel = resolveCatalogModel(nextModel, discovered);
        if (selectedModel && selectedModel !== provider.configuration.model) {
          provider = await window.gw2cc.request('provider.settings.update', {
            providerId: nextProviderId,
            model: selectedModel,
            baseUrl: nextBaseUrl.trim(),
            toolsEnabled,
            maxTokensEnabled,
            maxTokens
          });
        }
        return {
          provider,
          models: discovered,
          selectedModel,
          notice: discovered.length ? `${discovered.length} models found.` : 'This endpoint did not publish a model catalog.'
        };
      } catch (error) {
        return { provider, models: [] as ProviderModel[], selectedModel: nextModel, notice: `Provider saved. ${errorMessage(error)}` };
      }
    },
    onMutate: () => {
      autoDiscoveryAttempted.current = true;
      setCatalogState('loading');
      setCatalogNotice('Discovering models…');
    },
    onSuccess: (result) => {
      setProviderKey('');
      setModels(result.models);
      setModel(result.selectedModel);
      setCatalogState(result.models.length ? 'ready' : 'unavailable');
      setCatalogNotice(result.notice);
      updateProviderPayload(result.provider);
    },
    onError: (error) => {
      setCatalogState('unavailable');
      setCatalogNotice(errorMessage(error));
    }
  });
  const testProvider = useMutation({
    mutationFn: () => window.gw2cc.request('provider.test', {}),
    onSuccess: (result) => {
      setModels(result.models);
      setCatalogState(result.models.length ? 'ready' : 'unavailable');
      setCatalogNotice(result.message);
    }
  });
  const saveTavily = useMutation({
    mutationFn: () => window.gw2cc.request('research.settings.setKey', { apiKey: tavilyKey }),
    onSuccess: (research) => {
      setTavilyKey('');
      onPayload({ ...payload, research });
    }
  });
  const testResearch = useMutation({ mutationFn: () => window.gw2cc.request('research.settings.test', {}) });
  const clearTavily = useMutation({
    mutationFn: () => window.gw2cc.request('research.settings.clear', {}),
    onSuccess: (research) => onPayload({ ...payload, research })
  });

  useEffect(() => {
    if (connection.fixtureMode || autoDiscoveryAttempted.current || !payload.chat.provider.credentialConfigured) return;
    autoDiscoveryAttempted.current = true;
    saveProvider.mutate({ apiKey: '' });
  }, [connection.fixtureMode, payload.chat.provider.credentialConfigured, saveProvider]);

  const activeError = connect.error ?? test.error ?? disconnect.error ?? saveProvider.error ?? selectModel.error ?? testProvider.error ?? saveTavily.error ?? testResearch.error ?? clearTavily.error;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-heading"><div><span className="eyebrow">GW2CC</span><h2 id="settings-title">Settings</h2></div><button className="close-button" onClick={onClose} aria-label="Close settings">×</button></div>
        <nav className="settings-nav" aria-label="Settings sections">
          <button className={view === 'account' ? 'active' : ''} onClick={() => setView('account')}>Account</button>
          <button className={view === 'assistant' ? 'active' : ''} onClick={() => setView('assistant')}>Assistant</button>
          <button className={view === 'research' ? 'active' : ''} onClick={() => setView('research')}>Research</button>
        </nav>

        {view === 'account' && (
          <div className="settings-pane">
            <div className="settings-section">
              <div className="section-heading"><div><h3>Guild Wars 2</h3><small>{connection.account?.name ?? 'Not connected'}</small></div><StatusPill payload={payload} /></div>
              {connection.fixtureMode ? (
                <div className="fixture-notice"><strong>Fixture account active</strong><span>Production services are running against deterministic local data.</span></div>
              ) : (
                <label className="field-label">API key<input aria-label="Guild Wars 2 API key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste a GW2 API key" /></label>
              )}
              {!connection.fixtureMode && <div className="settings-actions"><button className="primary-button" onClick={() => connect.mutate()} disabled={!apiKey.trim() || connect.isPending}>{connect.isPending ? 'Validating…' : 'Save key'}</button>{connection.status !== 'disconnected' && <button onClick={() => test.mutate()} disabled={test.isPending}>Test</button>}{connection.status !== 'disconnected' && <button className="danger-button" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Disconnect</button>}</div>}
            </div>
            <div className="settings-grid">
              <div className="settings-section compact"><h3>Credential storage</h3><strong className={`strength-${connection.secretStorage.strength}`}>{connection.secretStorage.strength}</strong><small>{connection.secretStorage.backend ?? 'Unavailable'}</small></div>
              <div className="settings-section compact"><h3>Permissions</h3><strong>{connection.permissions.length}</strong><small>{connection.permissions.join(', ') || 'None detected'}</small></div>
            </div>
            <div className="capability-list"><span className={connection.permissions.includes('inventories') ? 'capability-ready' : 'capability-missing'}>Inventory</span><span className={connection.permissions.includes('wallet') ? 'capability-ready' : 'capability-missing'}>Wallet</span><span className={connection.permissions.includes('progression') ? 'capability-ready' : 'capability-missing'}>Progression</span></div>
            {connection.secretStorage.message && <div className="warning-banner">{connection.secretStorage.message}</div>}
          </div>
        )}

        {view === 'assistant' && (
          <div className="settings-pane provider-settings">
            {connection.fixtureMode ? (
              <div className="fixture-notice"><strong>Fixture assistant active</strong><span>Streaming and read-only tool rounds use the production orchestration path.</span></div>
            ) : (
              <>
                <div className="provider-fields">
                  <label className="field-label">Provider
                    <select
                      aria-label="LLM provider"
                      value={providerId}
                      onChange={(event) => {
                        const next = event.target.value as ConfigurableProvider;
                        const nextBaseUrl = PROVIDER_DEFAULT_BASE_URLS[next];
                        setProviderId(next);
                        setBaseUrl(nextBaseUrl);
                        setModel('');
                        setProviderKey('');
                        setModels([]);
                        saveProvider.mutate({ providerId: next, model: '', baseUrl: nextBaseUrl, apiKey: '' });
                      }}
                    >
                      <option value="openrouter">OpenRouter</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="ollama">Ollama</option>
                    </select>
                  </label>
                  <label className="field-label">Model
                    {catalogState === 'ready' ? (
                      <select aria-label="LLM model" value={model} onChange={(event) => { const next = event.target.value; setModel(next); selectModel.mutate(next); }}>
                        {models.map((entry) => <option value={entry.id} key={entry.id}>{entry.name && entry.name !== entry.id ? `${entry.name} · ${entry.id}` : entry.id}</option>)}
                      </select>
                    ) : catalogState === 'loading' ? (
                      <div className="model-catalog-state"><span className="catalog-spinner" />Discovering models…</div>
                    ) : catalogState === 'unavailable' ? (
                      <input aria-label="LLM model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model ID" />
                    ) : (
                      <div className="model-catalog-state">Connect to discover models</div>
                    )}
                  </label>
                </div>
                {(providerId === 'openai-compatible' || providerId === 'ollama') && (
                  <label className="field-label provider-base-url">Base URL<input aria-label="Provider base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
                )}
                <div className="provider-fields">
                  <label className="field-label">API key {providerId === 'ollama' || providerId === 'openai-compatible' ? '(optional)' : ''}
                    <input aria-label="Provider API key" type="password" autoComplete="off" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder={payload.chat.provider.credentialConfigured ? 'Saved credential configured' : 'Paste provider credential'} />
                  </label>
                  <div className={`output-limit-setting ${maxTokensEnabled ? 'enabled' : ''}`}>
                    <label className="output-limit-toggle"><input aria-label="Limit output tokens" type="checkbox" checked={maxTokensEnabled} onChange={(event) => setMaxTokensEnabled(event.target.checked)} /><span>Limit output tokens</span></label>
                    <input aria-label="Maximum output tokens" type="number" min={128} max={16384} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} disabled={!maxTokensEnabled} />
                    <small>{maxTokensEnabled ? 'GW2CC will stop generation at this cap.' : 'Off — use the provider-compatible default.'}</small>
                  </div>
                </div>
                <label className="tool-toggle"><input type="checkbox" checked={toolsEnabled} onChange={(event) => setToolsEnabled(event.target.checked)} /><span><strong>GW2 and research tools</strong><small>Disable only for models without tool calling.</small></span></label>
                <div className="settings-actions">
                  <button className="primary-button" onClick={() => saveProvider.mutate({})} disabled={saveProvider.isPending || (payload.chat.provider.credentialRequired && !payload.chat.provider.credentialConfigured && !providerKey.trim())}>{saveProvider.isPending ? 'Discovering…' : payload.chat.provider.credentialConfigured ? 'Save & refresh models' : 'Connect & discover'}</button>
                  <button onClick={() => testProvider.mutate()} disabled={!payload.chat.provider.ready || testProvider.isPending}>{testProvider.isPending ? 'Testing…' : 'Test model'}</button>
                </div>
                {catalogNotice && <div className={`catalog-notice catalog-${catalogState}`}>{catalogNotice}</div>}
                {testProvider.data && <div className="provider-test-success">✓ {testProvider.data.message}</div>}
              </>
            )}
          </div>
        )}

        {view === 'research' && (
          <div className="settings-pane research-settings">
            <div className="section-heading"><div><h3>Web and Wiki research</h3><small>Direct page fetch is always available.</small></div><span className={`research-chip ${payload.research.searchAvailable ? 'ready' : ''}`}>{payload.research.searchAvailable ? 'Search ready' : 'Fetch only'}</span></div>
            {payload.research.fixtureMode ? (
              <div className="fixture-notice"><strong>Research fixtures active</strong><span>Search, Wiki lookup, extraction, and source boundaries are deterministic.</span></div>
            ) : (
              <>
                <label className="field-label">Tavily API key<input aria-label="Tavily API key" type="password" autoComplete="off" value={tavilyKey} onChange={(event) => setTavilyKey(event.target.value)} placeholder={payload.research.credentialConfigured ? 'Saved Tavily credential configured' : 'Paste Tavily credential'} /></label>
                <div className="settings-actions"><button className="primary-button" onClick={() => saveTavily.mutate()} disabled={!tavilyKey.trim() || saveTavily.isPending}>{saveTavily.isPending ? 'Validating…' : payload.research.credentialConfigured ? 'Replace key' : 'Save key'}</button><button onClick={() => testResearch.mutate()} disabled={!payload.research.credentialConfigured || testResearch.isPending}>{testResearch.isPending ? 'Testing…' : 'Test search'}</button>{payload.research.credentialConfigured && <button className="danger-button" onClick={() => clearTavily.mutate()} disabled={clearTavily.isPending}>Clear key</button>}</div>
              </>
            )}
            <div className={`research-status ${payload.research.searchAvailable ? 'research-ready' : 'research-limited'}`}><strong>{payload.research.searchAvailable ? 'Tavily connected' : 'Tavily not configured'}</strong><span>{payload.research.message}</span></div>
            {testResearch.data && <div className="provider-test-success">✓ {testResearch.data.message}</div>}
          </div>
        )}
        {activeError && <div className="inline-error settings-error">{errorMessage(activeError)}</div>}
      </section>
    </div>
  );
}

function FirstRun({ onPayload }: { onPayload(payload: BootstrapPayload): void }) {
  const [apiKey, setApiKey] = useState('');
  const connect = useMutation({
    mutationFn: () => window.gw2cc.request('gw2.connection.setKey', { apiKey }),
    onSuccess: (next) => { setApiKey(''); onPayload(next); }
  });
  return (
    <main className="first-run">
      <section className="onboarding-card">
        <span className="onboarding-glyph">✦</span><span className="eyebrow">Live character inspector</span><h1>Connect your Guild Wars 2 account</h1><p>GW2CC uses ArenaNet’s read-only v2 API. Create a key with account, characters, and builds permissions to inspect active equipment, builds, and reconstructed attributes.</p>
        <label className="field-label">Guild Wars 2 API key<input aria-label="Guild Wars 2 API key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXXXXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" /></label>
        <button className="primary-button large" onClick={() => connect.mutate()} disabled={!apiKey.trim() || connect.isPending}>{connect.isPending ? 'Validating account…' : 'Securely save & connect'}</button>
        {connect.error && <div className="inline-error">{errorMessage(connect.error)}</div>}
        <div className="security-note"><span>◈</span><p><strong>Local and protected.</strong> The key is encrypted by your operating system in the Electron main process. It is never returned to the renderer.</p></div>
      </section>
    </main>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useState<WorkspaceView>('character');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspected, setInspected] = useState<EquippedItem>();
  const bootstrap = useQuery({ queryKey: BOOTSTRAP_KEY, queryFn: () => window.gw2cc.request('app.bootstrap', {}) });
  const setPayload = (payload: BootstrapPayload) => queryClient.setQueryData(BOOTSTRAP_KEY, payload);
  const select = useMutation({
    mutationFn: (name: string) => window.gw2cc.request('characters.select', { name }),
    onSuccess: (payload) => { setInspected(undefined); setPayload(payload); }
  });
  const refresh = useMutation({ mutationFn: () => window.gw2cc.request('characters.refresh', {}), onSuccess: setPayload });
  const inspect = useMutation({ mutationFn: (itemId: number) => window.gw2cc.request('equipment.inspectItem', { itemId }), onSuccess: setInspected });
  const openWiki = useMutation({ mutationFn: (name: string) => window.gw2cc.request('app.openExternal', { url: `https://wiki.guildwars2.com/wiki/Special:Search?search=${encodeURIComponent(name)}` }) });

  if (bootstrap.isLoading) return <div className="app-loading"><span className="loading-rune">✦</span><h1>GW2CC</h1><p>Opening the character console…</p></div>;
  if (bootstrap.error || !bootstrap.data) return <div className="fatal-state"><h1>GW2CC could not start</h1><p>{errorMessage(bootstrap.error)}</p><button onClick={() => bootstrap.refetch()}>Try again</button></div>;
  const payload = bootstrap.data;

  if (payload.connection.status === 'disconnected') {
    return <><Header payload={payload} activeView={activeView} selecting={false} refreshing={false} onView={setActiveView} onSelect={() => {}} onRefresh={() => {}} onSettings={() => setSettingsOpen(true)} /><FirstRun onPayload={setPayload} />{settingsOpen && <SettingsPanel payload={payload} onClose={() => setSettingsOpen(false)} onPayload={setPayload} />}</>;
  }

  return (
    <div className="app-shell">
      <Header payload={payload} activeView={activeView} selecting={select.isPending} refreshing={refresh.isPending} onView={setActiveView} onSelect={(name) => select.mutate(name)} onRefresh={() => refresh.mutate()} onSettings={() => setSettingsOpen(true)} />
      <div className="workspace-stage character-stage" role="tabpanel" aria-label="Character workspace" hidden={activeView !== 'character'}>
        {(payload.connection.message || payload.snapshotError || select.error || refresh.error) && <div className="top-error"><strong>Inspector notice</strong><span>{payload.snapshotError?.message ?? payload.connection.message ?? errorMessage(select.error ?? refresh.error)}</span></div>}
        {payload.snapshot?.warnings.map((warning) => <div className="permission-warning" key={warning}>{warning}</div>)}
        {payload.snapshot ? (
          <main className="inspector-layout">
            <EquipmentPanel equipment={payload.snapshot.equipment} selectedId={inspected?.itemId} onInspect={(itemId) => inspect.mutate(itemId)} />
            <InspectorCenter payload={payload} />
            <ContextColumn payload={payload} inspected={inspected} inspecting={inspect.isPending} onWiki={(name) => openWiki.mutate(name)} />
          </main>
        ) : <main className="empty-workspace"><h2>No character snapshot</h2><p>Review API permissions in Settings, then refresh the selected character.</p></main>}
      </div>
      <div className="workspace-stage console-stage" role="tabpanel" aria-label="Console workspace" hidden={activeView !== 'console'}>
        <ChatWorkspace payload={payload} onSettings={() => setSettingsOpen(true)} />
      </div>
      {settingsOpen && <SettingsPanel payload={payload} onClose={() => setSettingsOpen(false)} onPayload={setPayload} />}
    </div>
  );
}
