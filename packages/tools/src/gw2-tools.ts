import {
  Gw2ccError,
  toErrorPayload,
  type AccountRepository,
  type CharacterSnapshot,
  type Gw2Gateway,
  type LlmToolCall,
  type LlmToolDefinition,
  type QueryValue,
  type SecretStore,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolExecutor
} from '@gw2cc/core';
import { z } from 'zod';
import { boundToolResult } from './results';

const TOOL_TIMEOUT_MS = 75_000;
const GENERIC_PAGE_SIZE = 25;
const GENERIC_ID_BATCH_SIZE = 25;

const emptySchema = z.object({}).strict();
const characterSchema = z.object({ name: z.string().trim().min(1).max(128).optional() }).strict();
const itemSchema = z.object({ id: z.number().int().positive() }).strict();
const itemsSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(50) }).strict();
const pageSchema = z.object({
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(200).default(100)
}).strict();
const characterInventorySchema = characterSchema.extend({
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(200).default(100)
}).strict();
const queryValueSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([z.string().max(2_000), z.number().finite(), z.boolean()])).max(200)
]);
const v2Schema = z.object({
  path: z.string().min(4).max(400).refine((path) => (
    path.startsWith('/v2/') &&
    !path.includes('\\') &&
    !path.includes('?') &&
    !path.includes('#') &&
    !path.includes('\0') &&
    !path.split('/').some((segment) => segment === '.' || segment === '..')
  ), 'Path must be a clean absolute ArenaNet /v2/ path.'),
  query: z.record(z.string().regex(/^[a-zA-Z0-9_]+$/), queryValueSchema).default({}),
  pagination: z.object({
    mode: z.enum(['single', 'all']).default('single'),
    page: z.number().int().min(0).max(100_000).default(0),
    pageSize: z.number().int().min(1).max(200).default(GENERIC_PAGE_SIZE),
    maxPages: z.number().int().min(1).max(5).default(3)
  }).strict().default({ mode: 'single', page: 0, pageSize: GENERIC_PAGE_SIZE, maxPages: 3 })
}).strict();
const liveAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  world: z.number().int().optional(),
  access: z.array(z.string()).optional(),
  fractal_level: z.number().int().nonnegative().optional(),
  daily_ap: z.number().int().nonnegative().optional(),
  monthly_ap: z.number().int().nonnegative().optional(),
  commander: z.boolean().optional(),
  created: z.string().optional(),
  age: z.number().int().nonnegative().optional(),
  wvw: z.object({
    rank: z.number().int().nonnegative().optional(),
    team_id: z.number().int().nonnegative().optional()
  }).passthrough().optional(),
  guilds: z.array(z.string()).optional(),
  guild_leader: z.array(z.string()).optional(),
  build_storage_slots: z.number().int().nonnegative().optional()
}).passthrough();
const liveCharactersSchema = z.array(z.string());
const accountItemSchema = z.object({
  id: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  charges: z.number().int().optional(),
  skin: z.number().int().optional(),
  upgrades: z.array(z.number().int()).optional(),
  infusions: z.array(z.number().int()).optional(),
  binding: z.string().optional(),
  bound_to: z.string().optional(),
  stats: z.object({ id: z.number().int(), attributes: z.record(z.string(), z.number()).optional() }).passthrough().optional()
}).passthrough();
const accountSlotsSchema = z.array(accountItemSchema.nullable());
const materialSchema = z.object({
  id: z.number().int().positive(),
  category: z.number().int().optional(),
  count: z.number().int().nonnegative()
}).passthrough();
const walletSchema = z.object({ id: z.number().int().positive(), value: z.number().finite() }).passthrough();
const achievementSchema = z.object({
  id: z.number().int().positive(),
  current: z.number().optional(),
  max: z.number().optional(),
  done: z.boolean().optional(),
  repeated: z.number().optional(),
  bits: z.array(z.number().int()).optional()
}).passthrough();
const dailyAchievementSchema = z.object({ id: z.number().int().positive() }).passthrough();
const dailyAchievementsSchema = z.object({ pve: z.array(dailyAchievementSchema) }).passthrough();
const achievementDefinitionSchema = z.object({
  id: z.number().int().positive(),
  name: z.string()
}).passthrough();
const stringListSchema = z.array(z.string());
const characterBagsSchema = z.object({
  bags: z.array(z.object({
    id: z.number().int().positive(),
    size: z.number().int().nonnegative(),
    inventory: z.array(accountItemSchema.nullable())
  }).passthrough().nullable())
}).passthrough();

const characterInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string', description: 'Character name. Omit to use the focused character.' } }
};
const pageInputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }
  }
};
const characterInventoryInputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Character name. Omit to use the focused character.' },
    offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }
  }
};

const DEFINITIONS: readonly LlmToolDefinition[] = [
  {
    name: 'gw2_get_account',
    description: 'Get the connected GW2 account identity, detected API permissions, and raw ArenaNet account progression context such as access, AP, fractal level, WvW rank, guilds, and account age. The access array is verbatim and may under-report bundle-granted content; do not infer expansion ownership from it.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'gw2_list_characters',
    description: 'List characters on the connected GW2 account.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'gw2_get_character',
    description: 'Get the normalized summary for a character, defaulting to the currently focused character.',
    inputSchema: characterInputSchema
  },
  {
    name: 'gw2_get_character_equipment',
    description: 'Get normalized active equipment for a character with structured stat provenance.',
    inputSchema: characterInputSchema
  },
  {
    name: 'gw2_get_character_build',
    description: 'Get the normalized active PvE build inspection for a character.',
    inputSchema: characterInputSchema
  },
  {
    name: 'gw2_get_character_attributes',
    description: 'Get the deterministic AttributeReport baseline, completeness, provenance, and omissions for a character.',
    inputSchema: characterInputSchema
  },
  {
    name: 'gw2_get_item',
    description: 'Get one public ArenaNet GW2 item definition by numeric ID.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'integer', minimum: 1 } }
    }
  },
  {
    name: 'gw2_get_items',
    description: 'Batch-get up to 50 public ArenaNet GW2 item definitions by numeric ID.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['ids'],
      properties: { ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'integer', minimum: 1 } } }
    }
  },
  {
    name: 'gw2_get_bank',
    description: 'Get a bounded page of non-empty account bank slots. Requires the GW2 inventories permission.',
    inputSchema: pageInputSchema
  },
  {
    name: 'gw2_get_shared_inventory',
    description: 'Get a bounded page of non-empty account shared-inventory slots. Requires the GW2 inventories permission.',
    inputSchema: pageInputSchema
  },
  {
    name: 'gw2_get_character_inventory',
    description: 'Get a bounded flattened page of non-empty bag slots for a character. Requires the GW2 inventories permission.',
    inputSchema: characterInventoryInputSchema
  },
  {
    name: 'gw2_get_wallet',
    description: 'Get the account wallet currency IDs and values. Requires the GW2 wallet permission.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'gw2_get_achievements',
    description: 'Get a bounded page of account achievement progress. Requires the GW2 progression permission.',
    inputSchema: pageInputSchema
  },
  {
    name: 'gw2_get_daily_status',
    description: 'Get today\'s named PvE daily achievements with completion state plus today\'s completed world bosses, dungeons, daily crafting, raids, and map chests. Unavailable account sections are reported independently.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'gw2_get_materials',
    description: 'Get a bounded page of non-empty account material-storage entries. Requires the GW2 inventories permission.',
    inputSchema: pageInputSchema
  },
  {
    name: 'gw2_get_v2',
    description: 'Perform a bounded authenticated GET against the fixed ArenaNet host for a clean /v2/ path. Rich resources default to 25 records per page, ids arrays are transparently batched to 25, and every partial response reports how to continue. Omit query and pagination to get an endpoint catalog ID list. No arbitrary hosts, methods, headers, or credentials are accepted. gw2_get_v2 can reach any public or permission-authorized /v2/ path (account details, masteries, crafting, hero points, templates, commerce, etc.).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', pattern: '^/v2/' },
        query: {
          type: 'object',
          additionalProperties: {
            anyOf: [
              { type: 'string' }, { type: 'number' }, { type: 'boolean' },
              { type: 'array', maxItems: 200, items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } }
            ]
          }
        },
        pagination: {
          type: 'object', additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: ['single', 'all'], default: 'single' },
            page: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
            pageSize: { type: 'integer', minimum: 1, maximum: 200, default: GENERIC_PAGE_SIZE },
            maxPages: { type: 'integer', minimum: 1, maximum: 5, default: 3 }
          }
        }
      }
    }
  }
];

function compactEquipment(snapshot: CharacterSnapshot): unknown {
  return snapshot.equipment.map((entry) => ({
    slot: entry.slot,
    itemId: entry.itemId,
    name: entry.item.name,
    type: entry.item.type,
    subtype: entry.item.subtype,
    rarity: entry.item.rarity,
    statId: entry.statId,
    statName: entry.statName,
    statSource: entry.statSource,
    attributes: entry.attributes,
    upgrades: entry.upgrades.map((upgrade) => ({ id: upgrade.id, name: upgrade.name, attributes: upgrade.attributes })),
    infusions: entry.infusions.map((infusion) => ({ id: infusion.id, name: infusion.name, attributes: infusion.attributes }))
  }));
}

function arenaNetProvenance(endpoint: string): Record<string, unknown> {
  return { kind: 'arenanet_api', sourceName: 'Guild Wars 2 v2 API', endpoint };
}

function pageResult<T>(entries: T[], offset: number, limit: number): { entries: T[]; pagination: Record<string, unknown> } {
  const page = entries.slice(offset, offset + limit);
  return {
    entries: page,
    pagination: {
      offset,
      limit,
      returned: page.length,
      totalAvailable: entries.length,
      hasMore: offset + page.length < entries.length
    }
  };
}

function normalizeSlots(slots: Array<z.infer<typeof accountItemSchema> | null>): Array<Record<string, unknown>> {
  return slots.flatMap((entry, slot) => entry ? [{ slot, ...entry }] : []);
}

type DailyStatusSection =
  | 'pve'
  | 'worldBossesKilled'
  | 'dungeonsCompleted'
  | 'dailyCraftingDone'
  | 'raidsCleared'
  | 'mapChests';

interface DailySectionResult<T> {
  data?: T;
  note?: {
    section: DailyStatusSection;
    endpoint: string;
    error: ReturnType<typeof toErrorPayload>;
  };
}

type DailyStatusNote = NonNullable<DailySectionResult<unknown>['note']>;

async function captureDailySection<T>(
  section: DailyStatusSection,
  endpoint: `/v2/${string}`,
  load: () => Promise<T>
): Promise<DailySectionResult<T>> {
  try {
    return { data: await load() };
  } catch (error) {
    return { note: { section, endpoint, error: toErrorPayload(error) } };
  }
}

function missingProgressionSection<T>(
  section: DailyStatusSection,
  endpoint: `/v2/${string}`
): Promise<DailySectionResult<T>> {
  return Promise.resolve({
    note: {
      section,
      endpoint,
      error: toErrorPayload(new Gw2ccError(
        'GW2_PERMISSION_MISSING',
        `${section} requires the progression GW2 API key permission.`,
        { details: { feature: section, requiredPermissions: ['progression'], missingPermissions: ['progression'] } }
      ))
    }
  });
}

export class Gw2ToolExecutor implements ToolExecutor {
  constructor(
    private readonly gateway: Gw2Gateway,
    private readonly secrets: SecretStore,
    private readonly accounts: AccountRepository
  ) {}

  definitions(): readonly LlmToolDefinition[] {
    return DEFINITIONS;
  }

  async execute(call: LlmToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TOOL_TIMEOUT_MS);
    try {
      if (context.signal.aborted) throw new Gw2ccError('CANCELLED', 'Tool execution was cancelled.');
      const apiKey = await this.secrets.get('gw2-api-key');
      if (!apiKey) throw new Gw2ccError('GW2_NOT_CONNECTED', 'Connect a Guild Wars 2 API key before using GW2 tools.');
      const account = await this.accounts.getActive();
      if (!account) throw new Gw2ccError('GW2_NOT_CONNECTED', 'No active Guild Wars 2 account is connected.');
      const resolveName = (input: { name?: string }): string => {
        const name = input.name ?? context.focusedCharacterName ?? account.selectedCharacterName;
        if (!name) throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', 'No focused character is available for this tool call.');
        if (!account.characterNames.includes(name)) {
          throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', `Character “${name}” is not available on the connected account.`);
        }
        return name;
      };
      const requirePermission = (feature: string, ...permissions: string[]) => {
        const available = new Set(account.permissions);
        const missing = permissions.filter((permission) => !available.has(permission));
        if (missing.length > 0) {
          throw new Gw2ccError(
            'GW2_PERMISSION_MISSING',
            `${feature} requires the ${missing.join(' and ')} GW2 API key permission${missing.length === 1 ? '' : 's'}.`,
            { details: { feature, requiredPermissions: permissions, missingPermissions: missing } }
          );
        }
      };
      const snapshot = async (input: { name?: string }) => this.gateway.getCharacterSnapshot(
        apiKey,
        resolveName(input),
        false,
        controller.signal
      );

      switch (call.name) {
        case 'gw2_get_account': {
          emptySchema.parse(call.arguments);
          const liveAccount = liveAccountSchema.parse(
            await this.gateway.get<unknown>(apiKey, '/v2/account', {}, controller.signal)
          );
          return boundToolResult({
            source: 'Live ArenaNet /v2/account normalized by the GW2 tool plus detected token permissions',
            provenance: arenaNetProvenance('/v2/account'),
            account: {
              id: liveAccount.id,
              name: liveAccount.name,
              ...(liveAccount.world !== undefined ? { worldId: liveAccount.world } : {}),
              ...(liveAccount.access !== undefined ? { access: liveAccount.access } : {}),
              ...(liveAccount.fractal_level !== undefined ? { fractal_level: liveAccount.fractal_level } : {}),
              ...(liveAccount.daily_ap !== undefined ? { daily_ap: liveAccount.daily_ap } : {}),
              ...(liveAccount.monthly_ap !== undefined ? { monthly_ap: liveAccount.monthly_ap } : {}),
              ...(liveAccount.commander !== undefined ? { commander: liveAccount.commander } : {}),
              ...(liveAccount.created !== undefined ? { created: liveAccount.created } : {}),
              ...(liveAccount.age !== undefined ? { age: liveAccount.age } : {}),
              ...(liveAccount.wvw !== undefined ? {
                wvw: {
                  ...(liveAccount.wvw.rank !== undefined ? { rank: liveAccount.wvw.rank } : {}),
                  ...(liveAccount.wvw.team_id !== undefined ? { team_id: liveAccount.wvw.team_id } : {})
                }
              } : {}),
              ...(liveAccount.guilds !== undefined ? { guilds: liveAccount.guilds } : {}),
              ...(liveAccount.guild_leader !== undefined ? { guild_leader: liveAccount.guild_leader } : {}),
              ...(liveAccount.build_storage_slots !== undefined ? { build_storage_slots: liveAccount.build_storage_slots } : {})
            },
            permissions: account.permissions,
            selectedCharacterName: account.selectedCharacterName
          }, 'Loaded live GW2 account');
        }
        case 'gw2_list_characters': {
          emptySchema.parse(call.arguments);
          const liveCharacters = liveCharactersSchema.parse(
            await this.gateway.get<unknown>(apiKey, '/v2/characters', {}, controller.signal)
          );
          return boundToolResult({
            source: 'Live ArenaNet /v2/characters through the existing GW2 gateway',
            provenance: arenaNetProvenance('/v2/characters'),
            characters: liveCharacters,
            selectedCharacterName: account.selectedCharacterName
          }, `Loaded ${liveCharacters.length} live characters`);
        }
        case 'gw2_get_character': {
          const input = characterSchema.parse(call.arguments);
          const data = await snapshot(input);
          return boundToolResult({
            source: 'Normalized GW2CC CharacterSnapshot',
            provenance: { kind: 'arenanet_normalized', sourceName: 'GW2CC CharacterSnapshot' },
            character: data.character,
            eliteSpecialization: data.eliteSpecialization,
            equipmentTemplate: data.equipmentTemplate,
            warnings: data.warnings,
            loadedAt: data.loadedAt
          }, `Loaded ${data.character.name}`);
        }
        case 'gw2_get_character_equipment': {
          const data = await snapshot(characterSchema.parse(call.arguments));
          return boundToolResult({
            source: 'Normalized GW2CC CharacterSnapshot equipment',
            characterName: data.character.name,
            equipmentTemplate: data.equipmentTemplate,
            equipment: compactEquipment(data)
          }, `Loaded equipment for ${data.character.name}`);
        }
        case 'gw2_get_character_build': {
          const data = await snapshot(characterSchema.parse(call.arguments));
          return boundToolResult({
            source: 'Normalized GW2CC CharacterSnapshot build',
            characterName: data.character.name,
            build: data.build ?? null,
            warnings: data.warnings
          }, `Loaded build for ${data.character.name}`);
        }
        case 'gw2_get_character_attributes': {
          const data = await snapshot(characterSchema.parse(call.arguments));
          return boundToolResult({
            source: 'GW2CC deterministic AttributeReport; baseline only',
            characterName: data.character.name,
            ...data.attributes
          }, `Loaded baseline attributes for ${data.character.name}`);
        }
        case 'gw2_get_item': {
          const input = itemSchema.parse(call.arguments);
          const data = await this.gateway.get<unknown>(apiKey, `/v2/items/${input.id}`, {}, controller.signal);
          return boundToolResult({ source: 'ArenaNet GW2 v2 item definition', provenance: arenaNetProvenance(`/v2/items/${input.id}`), item: data }, `Loaded item ${input.id}`);
        }
        case 'gw2_get_items': {
          const input = itemsSchema.parse(call.arguments);
          const data = await this.gateway.get<unknown>(apiKey, '/v2/items', { ids: input.ids }, controller.signal);
          return boundToolResult({ source: 'ArenaNet GW2 v2 batched item definitions', provenance: arenaNetProvenance('/v2/items'), items: data }, `Loaded ${input.ids.length} items`);
        }
        case 'gw2_get_bank': {
          requirePermission('Account bank', 'inventories');
          const input = pageSchema.parse(call.arguments);
          const slots = accountSlotsSchema.parse(await this.gateway.get<unknown>(apiKey, '/v2/account/bank', {}, controller.signal));
          const paged = pageResult(normalizeSlots(slots), input.offset, input.limit);
          return boundToolResult({ source: 'Live ArenaNet account bank', provenance: arenaNetProvenance('/v2/account/bank'), ...paged }, `Loaded ${paged.entries.length} bank slots`);
        }
        case 'gw2_get_shared_inventory': {
          requirePermission('Shared inventory', 'inventories');
          const input = pageSchema.parse(call.arguments);
          const slots = accountSlotsSchema.parse(await this.gateway.get<unknown>(apiKey, '/v2/account/inventory', {}, controller.signal));
          const paged = pageResult(normalizeSlots(slots), input.offset, input.limit);
          return boundToolResult({ source: 'Live ArenaNet shared inventory', provenance: arenaNetProvenance('/v2/account/inventory'), ...paged }, `Loaded ${paged.entries.length} shared inventory slots`);
        }
        case 'gw2_get_character_inventory': {
          requirePermission('Character inventory', 'inventories');
          const input = characterInventorySchema.parse(call.arguments);
          const name = resolveName(input);
          const path = `/v2/characters/${encodeURIComponent(name)}/inventory` as `/v2/${string}`;
          const bags = characterBagsSchema.parse(await this.gateway.get<unknown>(apiKey, path, {}, controller.signal));
          const flattened = bags.bags.flatMap((bag, bagIndex) => bag
            ? bag.inventory.flatMap((entry, slot) => entry ? [{ bag: bagIndex, bagId: bag.id, slot, ...entry }] : [])
            : []);
          const paged = pageResult(flattened, input.offset, input.limit);
          return boundToolResult({ source: 'Live ArenaNet character inventory', provenance: arenaNetProvenance(path), characterName: name, ...paged }, `Loaded ${paged.entries.length} inventory slots for ${name}`);
        }
        case 'gw2_get_wallet': {
          emptySchema.parse(call.arguments);
          requirePermission('Account wallet', 'wallet');
          const entries = z.array(walletSchema).parse(await this.gateway.get<unknown>(apiKey, '/v2/account/wallet', {}, controller.signal));
          return boundToolResult({ source: 'Live ArenaNet account wallet', provenance: arenaNetProvenance('/v2/account/wallet'), entries }, `Loaded ${entries.length} wallet currencies`);
        }
        case 'gw2_get_achievements': {
          requirePermission('Account achievements', 'progression');
          const input = pageSchema.parse(call.arguments);
          const entries = z.array(achievementSchema).parse(await this.gateway.get<unknown>(apiKey, '/v2/account/achievements', {}, controller.signal));
          const paged = pageResult(entries, input.offset, input.limit);
          return boundToolResult({ source: 'Live ArenaNet account achievements', provenance: arenaNetProvenance('/v2/account/achievements'), ...paged }, `Loaded ${paged.entries.length} achievement records`);
        }
        case 'gw2_get_daily_status': {
          emptySchema.parse(call.arguments);
          const hasProgression = account.permissions.includes('progression');
          const dailyPromise = captureDailySection(
            'pve',
            '/v2/achievements/daily',
            async () => dailyAchievementsSchema.parse(
              await this.gateway.get<unknown>(apiKey, '/v2/achievements/daily', {}, controller.signal)
            )
          );
          const achievementProgressPromise = hasProgression
            ? captureDailySection(
                'pve',
                '/v2/account/achievements',
                async () => z.array(achievementSchema).parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/account/achievements', {}, controller.signal)
                )
              )
            : missingProgressionSection<z.infer<typeof achievementSchema>[]>('pve', '/v2/account/achievements');
          const worldBossesPromise = hasProgression
            ? captureDailySection(
                'worldBossesKilled',
                '/v2/account/worldbosses',
                async () => stringListSchema.parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/account/worldbosses', {}, controller.signal)
                )
              )
            : missingProgressionSection<string[]>('worldBossesKilled', '/v2/account/worldbosses');
          const dungeonsPromise = hasProgression
            ? captureDailySection(
                'dungeonsCompleted',
                '/v2/account/dungeons',
                async () => stringListSchema.parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/account/dungeons', {}, controller.signal)
                )
              )
            : missingProgressionSection<string[]>('dungeonsCompleted', '/v2/account/dungeons');
          const dailyCraftingPromise = hasProgression
            ? captureDailySection(
                'dailyCraftingDone',
                '/v2/account/dailycrafting',
                async () => stringListSchema.parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/account/dailycrafting', {}, controller.signal)
                )
              )
            : missingProgressionSection<string[]>('dailyCraftingDone', '/v2/account/dailycrafting');
          const raidsPromise = hasProgression
            ? captureDailySection(
                'raidsCleared',
                '/v2/account/raids',
                async () => stringListSchema.parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/account/raids', {}, controller.signal)
                )
              )
            : missingProgressionSection<string[]>('raidsCleared', '/v2/account/raids');
          const mapChestsPromise = hasProgression
            ? captureDailySection(
                'mapChests',
                '/v2/account/mapchests',
                async () => stringListSchema.parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/account/mapchests', {}, controller.signal)
                )
              )
            : missingProgressionSection<string[]>('mapChests', '/v2/account/mapchests');

          const [daily, achievementProgress, worldBosses, dungeons, dailyCrafting, raids, mapChests] = await Promise.all([
            dailyPromise,
            achievementProgressPromise,
            worldBossesPromise,
            dungeonsPromise,
            dailyCraftingPromise,
            raidsPromise,
            mapChestsPromise
          ]);
          if (controller.signal.aborted) throw new Gw2ccError('CANCELLED', 'Tool execution was cancelled.');

          const notes: DailyStatusNote[] = [];
          for (const result of [daily, achievementProgress, worldBosses, dungeons, dailyCrafting, raids, mapChests]) {
            if (result.note) notes.push(result.note);
          }

          let pve: Array<{ id: number; name: string; done: boolean }> = [];
          if (daily.data && achievementProgress.data) {
            const ids = [...new Set(daily.data.pve.map((entry) => entry.id))];
            const definitions = await captureDailySection(
              'pve',
              '/v2/achievements',
              async () => {
                const batches: number[][] = [];
                for (let offset = 0; offset < ids.length; offset += GENERIC_ID_BATCH_SIZE) {
                  batches.push(ids.slice(offset, offset + GENERIC_ID_BATCH_SIZE));
                }
                const responses = await Promise.all(batches.map(async (batch) => z.array(achievementDefinitionSchema).parse(
                  await this.gateway.get<unknown>(apiKey, '/v2/achievements', { ids: batch }, controller.signal)
                )));
                const entries = responses.flat();
                const returnedIds = new Set(entries.map((entry) => entry.id));
                const missingIds = ids.filter((id) => !returnedIds.has(id));
                if (missingIds.length > 0) {
                  throw new Gw2ccError(
                    'GW2_UPSTREAM_UNAVAILABLE',
                    'ArenaNet did not return every requested daily achievement definition.',
                    { retryable: true, details: { missingIds } }
                  );
                }
                return entries;
              }
            );
            if (controller.signal.aborted) throw new Gw2ccError('CANCELLED', 'Tool execution was cancelled.');
            if (definitions.note) {
              notes.push(definitions.note);
            } else if (definitions.data) {
              const names = new Map(definitions.data.map((entry) => [entry.id, entry.name]));
              const doneIds = new Set(
                achievementProgress.data.filter((entry) => entry.done === true).map((entry) => entry.id)
              );
              pve = daily.data.pve.map((entry) => ({
                id: entry.id,
                name: names.get(entry.id)!,
                done: doneIds.has(entry.id)
              }));
            }
          }

          return boundToolResult({
            source: 'Live ArenaNet daily account status joined by the GW2 tool',
            provenance: {
              kind: 'arenanet_api',
              sourceName: 'Guild Wars 2 v2 API',
              endpoints: [
                '/v2/achievements/daily',
                '/v2/achievements',
                '/v2/account/achievements',
                '/v2/account/worldbosses',
                '/v2/account/dungeons',
                '/v2/account/dailycrafting',
                '/v2/account/raids',
                '/v2/account/mapchests'
              ]
            },
            pve,
            worldBossesKilled: worldBosses.data ?? [],
            dungeonsCompleted: dungeons.data ?? [],
            dailyCraftingDone: dailyCrafting.data ?? [],
            raidsCleared: raids.data ?? [],
            mapChests: mapChests.data ?? [],
            notes
          }, notes.length > 0
            ? `Loaded daily GW2 status with ${notes.length} unavailable section${notes.length === 1 ? '' : 's'}`
            : 'Loaded complete daily GW2 status');
        }
        case 'gw2_get_materials': {
          requirePermission('Material storage', 'inventories');
          const input = pageSchema.parse(call.arguments);
          const entries = z.array(materialSchema).parse(await this.gateway.get<unknown>(apiKey, '/v2/account/materials', {}, controller.signal));
          const nonEmpty = entries.filter((entry) => entry.count > 0);
          const paged = pageResult(nonEmpty, input.offset, input.limit);
          return boundToolResult({ source: 'Live ArenaNet material storage', provenance: arenaNetProvenance('/v2/account/materials'), ...paged }, `Loaded ${paged.entries.length} material records`);
        }
        case 'gw2_get_v2': {
          const paginationWasRequested = Boolean(
            call.arguments &&
            typeof call.arguments === 'object' &&
            !Array.isArray(call.arguments) &&
            Object.prototype.hasOwnProperty.call(call.arguments, 'pagination')
          );
          const input = v2Schema.parse(call.arguments);
          if ('page' in input.query || 'page_size' in input.query) {
            throw new Gw2ccError('VALIDATION_ERROR', 'Use the pagination object instead of page/page_size query keys.');
          }
          const path = input.path as `/v2/${string}`;
          const requestedIds = Array.isArray(input.query.ids) ? input.query.ids : undefined;
          const requestedAllIds = input.query.ids === 'all';
          const effectiveQuery = { ...input.query } as Record<string, QueryValue>;
          if (requestedAllIds) delete effectiveQuery.ids;
          if (requestedIds) {
            const batchSize = Math.min(input.pagination.pageSize, GENERIC_ID_BATCH_SIZE);
            const batchPage = paginationWasRequested ? input.pagination.page : 0;
            const batchOffset = batchPage * batchSize;
            const executedIds = requestedIds.slice(batchOffset, batchOffset + batchSize);
            effectiveQuery.ids = executedIds;
            const remainingIds = requestedIds.slice(batchOffset + executedIds.length);
            const data = executedIds.length > 0
              ? await this.gateway.get<unknown>(apiKey, path, effectiveQuery, controller.signal)
              : [];
            const outcome = boundToolResult({
              source: `ArenaNet GW2 API ${input.path}`,
              provenance: arenaNetProvenance(input.path),
              query: effectiveQuery,
              batching: {
                requested: requestedIds.length,
                executed: executedIds.length,
                batchPage,
                batchSize,
                skippedBefore: batchOffset,
                remainingIds,
                hasMore: remainingIds.length > 0,
                nextBatchPage: remainingIds.length > 0 ? batchPage + 1 : undefined
              },
              result: data
            }, `Loaded ${input.path} for ${executedIds.length} explicitly requested ID${executedIds.length === 1 ? '' : 's'}`);
            return outcome.truncated
              ? {
                  ...outcome,
                  summary: `${outcome.summary}. Retry these IDs in a smaller batch before continuing with remainingIds.`
                }
              : outcome;
          }
          if (input.pagination.mode === 'all') {
            const entries: unknown[] = [];
            let pagesFetched = 0;
            let complete = false;
            for (let cursor = 0; cursor < input.pagination.maxPages; cursor += 1) {
              const page = await this.gateway.get<unknown>(apiKey, path, {
                ...effectiveQuery,
                page: input.pagination.page + cursor,
                page_size: input.pagination.pageSize
              }, controller.signal);
              if (!Array.isArray(page)) {
                throw new Gw2ccError('VALIDATION_ERROR', 'Multi-page mode can only be used with array-returning GW2 endpoints.');
              }
              entries.push(...page);
              pagesFetched += 1;
              if (page.length < input.pagination.pageSize) {
                complete = true;
                break;
              }
            }
            const outcome = boundToolResult({
              source: `ArenaNet GW2 API ${input.path}`,
              provenance: arenaNetProvenance(input.path),
              query: effectiveQuery,
              pagination: {
                ...input.pagination,
                pagesFetched,
                complete,
                returned: entries.length,
                nextPage: complete ? undefined : input.pagination.page + pagesFetched
              },
              result: entries
            }, `Loaded ${input.path} across ${pagesFetched} bounded page${pagesFetched === 1 ? '' : 's'}`);
            return outcome.truncated
              ? {
                  ...outcome,
                  summary: `${outcome.summary}. Use single-page mode with a smaller pageSize so no records are skipped.`
                }
              : outcome;
          }
          const shouldPaginate = paginationWasRequested || requestedAllIds;
          const query = {
            ...effectiveQuery,
            ...(shouldPaginate ? {
              page: input.pagination.page,
              page_size: input.pagination.pageSize
            } : {})
          };
          const data = await this.gateway.get<unknown>(apiKey, path, query, controller.signal);
          if (shouldPaginate && !Array.isArray(data)) {
            throw new Gw2ccError('VALIDATION_ERROR', 'Pagination can only be used with array-returning GW2 endpoints.');
          }
          const outcome = boundToolResult({
            source: `ArenaNet GW2 API ${input.path}`,
            provenance: arenaNetProvenance(input.path),
            query,
            ...(shouldPaginate ? {
              pagination: {
                mode: 'single',
                page: input.pagination.page,
                pageSize: input.pagination.pageSize,
                returned: (data as unknown[]).length,
                reachedEnd: (data as unknown[]).length < input.pagination.pageSize,
                nextPage: (data as unknown[]).length < input.pagination.pageSize
                  ? undefined
                  : input.pagination.page + 1,
                ...(requestedAllIds ? { translatedFromIdsAll: true } : {}),
                retrySamePageWithPageSize: Math.max(1, Math.floor(input.pagination.pageSize / 2))
              }
            } : {}),
            result: data
          }, shouldPaginate
            ? `Loaded ${input.path} page ${input.pagination.page} with ${input.pagination.pageSize} records requested`
            : `Loaded ${input.path}`);
          return outcome.truncated && shouldPaginate
            ? {
                ...outcome,
                summary: `${outcome.summary}. Retry page ${input.pagination.page} with pageSize ${Math.max(1, Math.floor(input.pagination.pageSize / 2))} before advancing.`
              }
            : outcome;
        }
        default:
          throw new Gw2ccError('VALIDATION_ERROR', `Unknown read-only tool: ${call.name}`);
      }
    } catch (error) {
      const cancelled = context.signal.aborted;
      const payload = cancelled
        ? { code: 'CANCELLED' as const, message: 'Tool execution was cancelled.', retryable: false }
        : timedOut
          ? { code: 'GW2_UPSTREAM_UNAVAILABLE' as const, message: 'The GW2 tool request timed out.', retryable: true }
        : error instanceof z.ZodError
          ? {
              code: 'VALIDATION_ERROR' as const,
              message: 'The tool arguments were invalid.',
              retryable: false,
              details: { issues: error.issues.slice(0, 5).map((issue) => issue.message) }
            }
        : toErrorPayload(error);
      return {
        ok: false,
        value: { ok: false, error: payload },
        summary: payload.message,
        truncated: false
      };
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
    }
  }
}
