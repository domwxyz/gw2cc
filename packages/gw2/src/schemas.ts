import { z } from 'zod';

export const tokenInfoSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  permissions: z.array(z.string()).default([])
}).passthrough();

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  world: z.number().optional()
}).passthrough();

export const characterCoreSchema = z.object({
  name: z.string(),
  race: z.string(),
  gender: z.string().optional(),
  profession: z.string(),
  level: z.number(),
  age: z.number().optional(),
  deaths: z.number().optional(),
  created: z.string().optional()
}).passthrough();

export const equippedRecordSchema = z.object({
  id: z.number(),
  slot: z.string().optional(),
  skin: z.number().optional(),
  upgrades: z.array(z.number()).optional(),
  infusions: z.array(z.number()).optional(),
  binding: z.string().optional(),
  bound_to: z.string().optional(),
  location: z.string().optional(),
  stats: z.object({
    id: z.number().optional(),
    attributes: z.record(z.string(), z.number()).optional()
  }).optional()
}).passthrough();

export const equipmentTabSchema = z.object({
  tab: z.number().default(1),
  name: z.string().default('Active equipment'),
  is_active: z.boolean().optional(),
  equipment: z.array(equippedRecordSchema).default([])
}).passthrough();

export const equipmentEndpointSchema = z.object({
  equipment: z.array(equippedRecordSchema).default([])
}).passthrough();

const skillsSelectionSchema = z.object({
  heal: z.number().nullable().optional(),
  utilities: z.array(z.number().nullable()).default([]),
  elite: z.number().nullable().optional()
}).passthrough();

export const buildTabSchema = z.object({
  tab: z.number().default(1),
  is_active: z.boolean().optional(),
  build: z.object({
    name: z.string().default('Active build'),
    profession: z.string(),
    specializations: z.array(z.object({
      id: z.number().nullable(),
      traits: z.array(z.number().nullable()).default([])
    }).passthrough()).default([]),
    skills: skillsSelectionSchema.optional(),
    aquatic_skills: skillsSelectionSchema.optional()
  }).passthrough()
}).passthrough();

const infixAttributeSchema = z.object({
  attribute: z.string(),
  modifier: z.number()
}).passthrough();

export const itemSchema = z.object({
  id: z.number(),
  name: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
  type: z.string(),
  rarity: z.string(),
  level: z.number(),
  chat_link: z.string().optional(),
  details: z.object({
    type: z.string().optional(),
    defense: z.number().optional(),
    min_power: z.number().optional(),
    max_power: z.number().optional(),
    attribute_adjustment: z.number().optional(),
    stat_choices: z.array(z.number()).optional(),
    bonuses: z.array(z.string()).optional(),
    infix_upgrade: z.object({
      id: z.number().optional(),
      buff: z.object({
        skill_id: z.number().optional(),
        description: z.string().optional()
      }).passthrough().optional(),
      attributes: z.array(infixAttributeSchema).optional()
    }).passthrough().optional()
  }).passthrough().optional()
}).passthrough();

export const itemStatSchema = z.object({
  id: z.number(),
  name: z.string(),
  attributes: z.array(z.object({
    attribute: z.string(),
    multiplier: z.number(),
    value: z.number()
  }).passthrough()).default([])
}).passthrough();

export const skinSchema = z.object({
  id: z.number(),
  name: z.string(),
  icon: z.string().optional(),
  type: z.string().optional(),
  rarity: z.string().optional(),
  description: z.string().optional()
}).passthrough();

export const specializationSchema = z.object({
  id: z.number(),
  name: z.string(),
  profession: z.string(),
  elite: z.boolean().default(false),
  icon: z.string().optional(),
  background: z.string().optional(),
  major_traits: z.array(z.number()).default([])
}).passthrough();

export const traitSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  tier: z.number().optional(),
  order: z.number().optional(),
  slot: z.string().optional(),
  specialization: z.number().optional()
}).passthrough();

export const skillSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  slot: z.string().optional(),
  profession: z.string().optional()
}).passthrough();

export type RawEquippedRecord = z.infer<typeof equippedRecordSchema>;
export type RawItem = z.infer<typeof itemSchema>;
export type RawItemStat = z.infer<typeof itemStatSchema>;
export type RawSkin = z.infer<typeof skinSchema>;
export type RawSpecialization = z.infer<typeof specializationSchema>;
export type RawTrait = z.infer<typeof traitSchema>;
export type RawSkill = z.infer<typeof skillSchema>;
export type RawBuildTab = z.infer<typeof buildTabSchema>;
