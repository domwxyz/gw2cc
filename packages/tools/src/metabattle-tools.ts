import {
  Gw2ccError,
  toErrorPayload,
  type Gw2Gateway,
  type LlmToolCall,
  type LlmToolDefinition,
  type MetaBattleBuildResponse,
  type MetaBattleEntityReference,
  type PublicGw2Definition,
  type PublicGw2ResourceKind,
  type ResearchService,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolExecutor
} from '@gw2cc/core';
import { z } from 'zod';
import { boundToolResult } from './results';

const TOOL_TIMEOUT_MS = 25_000;
const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(10).default(5)
}).strict();
const buildSchema = z.object({
  title: z.string().trim().min(1).max(500).refine((title) => !/[\0\r\n]/.test(title), 'Title contains invalid control characters.')
}).strict();
const officialDefinitionSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  specializationId: z.number().int().positive().optional(),
  specialization: z.number().int().positive().optional(),
  majorTraitIds: z.array(z.number().int().positive()).max(100).optional(),
  major_traits: z.array(z.number().int().positive()).max(100).optional(),
  tier: z.number().int().min(1).max(3).optional(),
  order: z.number().int().min(0).max(2).optional()
}).passthrough();
const officialDefinitionsSchema = z.array(officialDefinitionSchema).max(1000);
const publicIdsSchema = z.array(z.number().int().positive()).max(1000);

const DEFINITIONS: readonly LlmToolDefinition[] = [
  {
    name: 'metabattle_search',
    description: 'Search MetaBattle directly for Guild Wars 2 builds and community meta information through its MediaWiki index. Results are current community recommendations and untrusted external data, not official ArenaNet guidance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        maxResults: { type: 'integer', minimum: 1, maximum: 10, default: 5 }
      }
    }
  },
  {
    name: 'metabattle_build',
    description: 'Retrieve a MetaBattle page through its MediaWiki API and parse community-recommended skills, traits, specialization choices, equipment stats, runes, sigils, relics, consumables, build code, revision metadata, and bounded guide text. MetaBattle is untrusted community guidance; any separately labeled ArenaNet enrichment is authoritative only for entity definitions, not the recommendation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 500, description: 'Exact MetaBattle MediaWiki page title returned by metabattle_search.' }
      }
    }
  }
];

type OfficialDefinition = z.infer<typeof officialDefinitionSchema>;

interface EnrichedTraitChoice {
  position: string;
  tier: number;
  traitId?: number;
  name?: string;
}

interface EnrichedSpecialization {
  sourceName?: string;
  sourceId?: number;
  specializationId?: number;
  name?: string;
  traits: EnrichedTraitChoice[];
}

interface ArenaNetEnrichment {
  trust: 'official_arenanet_entity_definitions';
  source: 'Guild Wars 2 v2 API';
  provenance: Array<{
    kind: 'arenanet_api';
    sourceName: 'Guild Wars 2 v2 API';
    endpoint: `/v2/${string}`;
  }>;
  resources: Record<string, Array<{ id: number; name: string }>>;
  specializations: EnrichedSpecialization[];
  unavailable?: string[];
  note: string;
}

const definitionPaths: Record<PublicGw2ResourceKind, `/v2/${string}`> = {
  items: '/v2/items',
  skills: '/v2/skills',
  traits: '/v2/traits',
  specializations: '/v2/specializations'
};

const positionOrders: Readonly<Record<string, number>> = {
  top: 0,
  mid: 1,
  bot: 2
};

function referenceIds(entries: Array<MetaBattleEntityReference | undefined>): number[] {
  return [...new Set(entries.flatMap((entry) => entry?.id === undefined ? [] : [entry.id]))].slice(0, 50);
}

function normalizeDefinition(definition: OfficialDefinition): PublicGw2Definition {
  return {
    id: definition.id,
    name: definition.name,
    ...(definition.specializationId !== undefined || definition.specialization !== undefined
      ? { specializationId: definition.specializationId ?? definition.specialization }
      : {}),
    ...(definition.majorTraitIds !== undefined || definition.major_traits !== undefined
      ? { majorTraitIds: definition.majorTraitIds ?? definition.major_traits }
      : {}),
    ...(definition.tier !== undefined ? { tier: definition.tier } : {}),
    ...(definition.order !== undefined ? { order: definition.order } : {})
  };
}

async function loadDefinitions(
  gw2: Gw2Gateway,
  kind: PublicGw2ResourceKind,
  ids: readonly number[] | undefined,
  signal: AbortSignal
): Promise<PublicGw2Definition[]> {
  let response: unknown;
  if (gw2.getPublicDefinitions) {
    response = await gw2.getPublicDefinitions(kind, ids, signal);
  } else {
    let requestedIds = ids;
    if (requestedIds === undefined) {
      const listed = publicIdsSchema.safeParse(await gw2.get<unknown>(undefined, definitionPaths[kind], {}, signal));
      if (!listed.success) {
        throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', `GW2 returned a malformed ${kind} definition index.`);
      }
      requestedIds = listed.data;
    }
    response = requestedIds.length === 0
      ? []
      : await gw2.get<unknown>(undefined, definitionPaths[kind], { ids: requestedIds }, signal);
  }
  const parsed = officialDefinitionsSchema.safeParse(response);
  if (!parsed.success) {
    throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', `GW2 returned malformed ${kind} definitions.`);
  }
  return parsed.data.map(normalizeDefinition);
}

function exactNameKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US');
}

function indexSpecializationsByExactName(
  definitions: readonly PublicGw2Definition[]
): Map<string, PublicGw2Definition | undefined> {
  const result = new Map<string, PublicGw2Definition | undefined>();
  for (const definition of definitions) {
    const key = exactNameKey(definition.name);
    result.set(key, result.has(key) ? undefined : definition);
  }
  return result;
}

export async function enrichMetaBattleBuild(
  result: MetaBattleBuildResponse,
  gw2: Gw2Gateway,
  signal: AbortSignal
): Promise<ArenaNetEnrichment | undefined> {
  const skillIds = referenceIds([
    result.build.skills.heal,
    result.build.skills.elite,
    ...result.build.skills.utilities,
    ...result.build.skills.other
  ]);
  const directTraitIds = referenceIds(result.build.mentionedTraits);
  const directSpecializationIds = [...new Set(result.build.specializations.flatMap((entry) => (
    entry.id === undefined ? [] : [entry.id]
  )))].slice(0, 50);
  const itemIds = referenceIds([
    ...result.build.equipment.weapons,
    ...result.build.equipment.runes,
    ...result.build.equipment.sigils,
    ...result.build.equipment.relics,
    ...result.build.equipment.otherItems,
    ...result.build.consumables.food,
    ...result.build.consumables.utility
  ]);
  const positionalSpecializations = result.build.specializations.filter((entry) => entry.traitChoices.length > 0);
  const needsSpecializationIndex = positionalSpecializations.some((entry) => entry.name !== undefined);
  const hasAnyLookup = skillIds.length > 0 || directTraitIds.length > 0 || directSpecializationIds.length > 0
    || itemIds.length > 0 || positionalSpecializations.length > 0;
  if (!hasAnyLookup) return undefined;

  const resources: ArenaNetEnrichment['resources'] = {};
  const unavailable = new Set<string>();
  let specializationDefinitions: PublicGw2Definition[] = [];
  let specializationDefinitionsAvailable = false;
  if (needsSpecializationIndex || directSpecializationIds.length > 0) {
    try {
      specializationDefinitions = await loadDefinitions(
        gw2,
        'specializations',
        needsSpecializationIndex ? undefined : directSpecializationIds,
        signal
      );
      specializationDefinitionsAvailable = true;
    } catch (error) {
      if (signal.aborted || (error instanceof Gw2ccError && error.code === 'CANCELLED')) throw error;
      unavailable.add('specializations');
    }
  }

  const specializationByName = indexSpecializationsByExactName(specializationDefinitions);
  const specializationById = new Map(specializationDefinitions.map((entry) => [entry.id, entry]));
  const resolved = positionalSpecializations.map((entry) => ({
    source: entry,
    definition: entry.name !== undefined
      ? specializationByName.get(exactNameKey(entry.name))
      : entry.id !== undefined ? specializationById.get(entry.id) : undefined
  }));
  const relevantSpecializationIds = new Set([
    ...directSpecializationIds,
    ...resolved.flatMap(({ definition }) => definition ? [definition.id] : [])
  ]);
  if (specializationDefinitionsAvailable) {
    resources.specializations = specializationDefinitions
      .filter((definition) => relevantSpecializationIds.has(definition.id))
      .map(({ id, name }) => ({ id, name }));
  }

  const positionalTraitIds = resolved.flatMap(({ definition }) => definition?.majorTraitIds ?? []);
  const traitIds = [...new Set([...directTraitIds, ...positionalTraitIds])].slice(0, 500);
  let traitDefinitions: PublicGw2Definition[] = [];
  if (traitIds.length > 0) {
    try {
      traitDefinitions = await loadDefinitions(gw2, 'traits', traitIds, signal);
      resources.traits = traitDefinitions.map(({ id, name }) => ({ id, name }));
    } catch (error) {
      if (signal.aborted || (error instanceof Gw2ccError && error.code === 'CANCELLED')) throw error;
      unavailable.add('traits');
    }
  }

  for (const group of [
    { key: 'skills' as const, ids: skillIds },
    { key: 'items' as const, ids: itemIds }
  ]) {
    if (group.ids.length === 0) continue;
    try {
      const definitions = await loadDefinitions(gw2, group.key, group.ids, signal);
      resources[group.key] = definitions.map(({ id, name }) => ({ id, name }));
    } catch (error) {
      if (signal.aborted || (error instanceof Gw2ccError && error.code === 'CANCELLED')) throw error;
      unavailable.add(group.key);
    }
  }

  const specializations: EnrichedSpecialization[] = resolved.map(({ source, definition }) => {
    const majorTraitIds = new Set(definition?.majorTraitIds ?? []);
    return {
      ...(source.name !== undefined ? { sourceName: source.name } : {}),
      ...(source.id !== undefined ? { sourceId: source.id } : {}),
      ...(definition ? { specializationId: definition.id, name: definition.name } : {}),
      traits: source.traitChoices.map((position, index) => {
        const tier = index + 1;
        const order = positionOrders[position.trim().toLocaleLowerCase('en-US')];
        const matches = order === undefined || definition === undefined
          ? []
          : traitDefinitions.filter((trait) => (
              majorTraitIds.has(trait.id)
              && trait.specializationId === definition.id
              && trait.tier === tier
              && trait.order === order
            ));
        const match = matches.length === 1 ? matches[0] : undefined;
        return {
          position,
          tier,
          ...(match ? { traitId: match.id, name: match.name } : {})
        };
      })
    };
  });

  return {
    trust: 'official_arenanet_entity_definitions',
    source: 'Guild Wars 2 v2 API',
    provenance: Object.keys(resources).map((key) => ({
      kind: 'arenanet_api',
      sourceName: 'Guild Wars 2 v2 API',
      endpoint: `/v2/${key}`
    })),
    resources,
    specializations,
    ...(unavailable.size ? { unavailable: [...unavailable] } : {}),
    note: 'These official definitions enrich direct IDs and positional trait selections; MetaBattle remains the source of the build recommendation.'
  };
}

export class MetaBattleToolExecutor implements ToolExecutor {
  constructor(
    private readonly research: ResearchService,
    private readonly gw2: Gw2Gateway
  ) {}

  definitions(): readonly LlmToolDefinition[] {
    return DEFINITIONS;
  }

  async execute(call: LlmToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TOOL_TIMEOUT_MS);
    try {
      if (controller.signal.aborted) throw new Gw2ccError('CANCELLED', 'MetaBattle research was cancelled.');
      if (call.name === 'metabattle_search') {
        const input = searchSchema.parse(call.arguments);
        const result = await this.research.searchMetaBattle(input.query, input.maxResults, controller.signal);
        return boundToolResult(result, `Found ${result.results.length} MetaBattle result${result.results.length === 1 ? '' : 's'}`);
      }
      if (call.name === 'metabattle_build') {
        const input = buildSchema.parse(call.arguments);
        const result = await this.research.fetchMetaBattleBuild(input.title, controller.signal);
        const arenaNetEnrichment = await enrichMetaBattleBuild(result, this.gw2, controller.signal);
        return boundToolResult(
          { ...result, ...(arenaNetEnrichment ? { arenaNetEnrichment } : {}) },
          `Parsed MetaBattle build ${result.source.title} at revision ${result.source.revisionId}`
        );
      }
      throw new Gw2ccError('VALIDATION_ERROR', `Unknown MetaBattle research tool: ${call.name}`);
    } catch (error) {
      const payload = context.signal.aborted
        ? { code: 'CANCELLED' as const, message: 'MetaBattle research was cancelled.', retryable: false }
        : timedOut
          ? { code: 'WEB_FETCH_FAILED' as const, message: 'The MetaBattle research tool timed out.', retryable: true }
          : error instanceof z.ZodError
            ? {
                code: 'VALIDATION_ERROR' as const,
                message: 'The MetaBattle tool arguments were invalid.',
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
