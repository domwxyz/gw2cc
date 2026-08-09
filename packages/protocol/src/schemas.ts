import { z } from 'zod';

const itemAttributeSchema = z.object({
  attribute: z.enum([
    'Power', 'Precision', 'Toughness', 'Vitality', 'Ferocity', 'ConditionDamage',
    'Expertise', 'Concentration', 'HealingPower', 'AgonyResistance'
  ]),
  value: z.number()
});

const itemSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  icon: z.string().optional(),
  rarity: z.string().optional(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  description: z.string().optional(),
  attributes: z.array(itemAttributeSchema)
});

export const equippedItemSchema = z.object({
  slot: z.string(),
  itemId: z.number(),
  item: itemSummarySchema.extend({
    level: z.number(),
    chatLink: z.string().optional(),
    defense: z.number().optional(),
    minPower: z.number().optional(),
    maxPower: z.number().optional(),
    attributeAdjustment: z.number().optional(),
    statChoices: z.array(z.number()).optional()
  }),
  skin: itemSummarySchema.optional(),
  statId: z.number().optional(),
  statName: z.string().optional(),
  statSource: z.enum(['selected', 'fixed', 'formula', 'none']),
  attributes: z.array(itemAttributeSchema),
  upgrades: z.array(itemSummarySchema),
  infusions: z.array(itemSummarySchema),
  binding: z.string().optional(),
  boundTo: z.string().optional(),
  location: z.string().optional()
});

const skillSchema = z.object({
  id: z.number(),
  name: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
  slot: z.string().optional()
});

const traitSchema = z.object({
  id: z.number(),
  name: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
  tier: z.number().optional(),
  slot: z.string().optional()
});

const attributesSchema = z.object({
  totals: z.record(z.string(), z.number()),
  derived: z.object({
    criticalChance: z.number(),
    criticalDamage: z.number(),
    conditionDuration: z.number(),
    boonDuration: z.number(),
    armor: z.number().optional(),
    health: z.number().optional(),
    defense: z.number().optional()
  }),
  sources: z.array(z.object({
    attribute: z.string(),
    category: z.enum(['base', 'equipment', 'upgrades', 'infusions', 'derived']),
    label: z.string(),
    amount: z.number(),
    itemId: z.number().optional()
  })),
  completeness: z.enum(['equipment_exact', 'baseline_estimate', 'incomplete']),
  omissions: z.array(z.string())
});

export const characterSnapshotSchema = z.object({
  character: z.object({
    name: z.string(),
    race: z.string(),
    gender: z.string().optional(),
    profession: z.string(),
    level: z.number(),
    ageSeconds: z.number().optional(),
    deaths: z.number().optional(),
    created: z.string().optional()
  }),
  eliteSpecialization: z.string().optional(),
  equipmentTemplate: z.string().optional(),
  equipment: z.array(equippedItemSchema),
  build: z.object({
    tab: z.number(),
    name: z.string(),
    profession: z.string(),
    mode: z.literal('pve'),
    specializations: z.array(z.object({
      id: z.number(),
      name: z.string(),
      icon: z.string().optional(),
      background: z.string().optional(),
      elite: z.boolean(),
      traits: z.array(traitSchema)
    })),
    heal: skillSchema.optional(),
    utilities: z.array(skillSchema),
    elite: skillSchema.optional(),
    aquatic: z.object({
      heal: skillSchema.optional(),
      utilities: z.array(skillSchema),
      elite: skillSchema.optional()
    })
  }).optional(),
  attributes: attributesSchema,
  warnings: z.array(z.string()),
  loadedAt: z.number()
});

export const errorSchema = z.object({
  code: z.enum([
    'GW2_KEY_INVALID', 'GW2_PERMISSION_MISSING', 'GW2_NOT_CONNECTED', 'GW2_RATE_LIMITED',
    'GW2_UPSTREAM_UNAVAILABLE', 'GW2_RESOURCE_NOT_FOUND', 'ATTRIBUTE_DATA_INCOMPLETE',
    'LLM_KEY_MISSING', 'LLM_AUTH_FAILED', 'LLM_MODEL_NOT_FOUND', 'LLM_TOOLS_UNSUPPORTED',
    'LLM_RATE_LIMITED', 'LLM_UPSTREAM_ERROR',
    'WEB_SEARCH_NOT_CONFIGURED', 'WEB_AUTH_FAILED', 'WEB_RATE_LIMITED', 'WEB_FETCH_BLOCKED',
    'WEB_FETCH_FAILED', 'WEB_CONTENT_UNSUPPORTED',
    'SECRET_STORAGE_UNAVAILABLE', 'DATABASE_ERROR', 'VALIDATION_ERROR', 'CANCELLED'
  ]),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const providerIdSchema = z.enum([
  'openrouter', 'openai-compatible', 'anthropic', 'ollama', 'fixture'
]);

export const providerConfigurationSchema = z.object({
  providerId: providerIdSchema,
  model: z.string(),
  baseUrl: z.string().optional(),
  toolsEnabled: z.boolean(),
  maxTokensEnabled: z.boolean(),
  maxTokens: z.number().int(),
  temperature: z.number().optional()
});

export const providerSettingsSchema = z.object({
  configuration: providerConfigurationSchema,
  credentialConfigured: z.boolean(),
  credentialRequired: z.boolean(),
  ready: z.boolean(),
  capabilities: z.object({ streaming: z.literal(true), tools: z.boolean() }),
  availableProviders: z.array(z.enum(['openrouter', 'openai-compatible', 'anthropic', 'ollama'])),
  message: z.string().optional()
});

export const researchSettingsSchema = z.object({
  credentialConfigured: z.boolean(),
  searchAvailable: z.boolean(),
  directFetchAvailable: z.literal(true),
  fixtureMode: z.boolean(),
  message: z.string()
});

export const reasoningTraceSchema = z.object({
  content: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  finishReason: z.string().optional(),
  truncated: z.boolean().optional()
});

export const conversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  focusedCharacterName: z.string().optional(),
  providerId: providerIdSchema.optional(),
  modelId: z.string().optional(),
  createdAt: z.number(),
  status: z.enum(['streaming', 'complete', 'failed', 'cancelled']),
  reasoningTrace: reasoningTraceSchema.optional(),
  error: errorSchema.optional()
});

export const persistedToolCallSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  toolName: z.string(),
  arguments: z.unknown(),
  result: z.unknown().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  contentOffset: z.number().int().nonnegative().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional()
});

export const conversationSummarySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  isPinned: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
});

export const conversationDetailSchema = conversationSummarySchema.extend({
  messages: z.array(conversationMessageSchema),
  toolCalls: z.array(persistedToolCallSchema)
});

export const chatBootstrapSchema = z.object({
  conversation: conversationDetailSchema,
  provider: providerSettingsSchema
});

export const bootstrapSchema = z.object({
  connection: z.object({
    status: z.enum(['disconnected', 'connected', 'error']),
    account: z.object({ id: z.string(), name: z.string(), worldId: z.number().optional() }).optional(),
    permissions: z.array(z.string()),
    capabilities: z.object({ characters: z.boolean(), equipment: z.boolean(), builds: z.boolean() }),
    characterNames: z.array(z.string()),
    selectedCharacterName: z.string().optional(),
    lastConnectedAt: z.number().optional(),
    message: z.string().optional(),
    secretStorage: z.object({
      configured: z.boolean(),
      available: z.boolean(),
      strength: z.enum(['strong', 'weak', 'unavailable']),
      backend: z.string().optional(),
      message: z.string().optional()
    }),
    fixtureMode: z.boolean()
  }),
  snapshot: characterSnapshotSchema.optional(),
  snapshotError: errorSchema.optional(),
  globalInstructions: z.string(),
  characterLore: z.string(),
  chat: chatBootstrapSchema,
  research: researchSettingsSchema
});
