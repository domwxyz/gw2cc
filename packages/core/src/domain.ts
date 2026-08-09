export const ATTRIBUTE_KEYS = [
  'Power',
  'Precision',
  'Toughness',
  'Vitality',
  'Ferocity',
  'ConditionDamage',
  'Expertise',
  'Concentration',
  'HealingPower',
  'AgonyResistance'
] as const;

export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export type CharacterAttributes = Record<AttributeKey, number>;

export interface DerivedAttributes {
  criticalChance: number;
  criticalDamage: number;
  conditionDuration: number;
  boonDuration: number;
  armor?: number;
  health?: number;
  defense?: number;
}

export type AttributeSourceCategory =
  | 'base'
  | 'equipment'
  | 'upgrades'
  | 'infusions'
  | 'derived';

export interface AttributeSourceBreakdown {
  attribute: AttributeKey | keyof DerivedAttributes;
  category: AttributeSourceCategory;
  label: string;
  amount: number;
  itemId?: number;
}

export type AttributeCompleteness = 'equipment_exact' | 'baseline_estimate' | 'incomplete';

export interface AttributeReport {
  totals: CharacterAttributes;
  derived: DerivedAttributes;
  sources: AttributeSourceBreakdown[];
  completeness: AttributeCompleteness;
  omissions: string[];
}

export interface ItemAttribute {
  attribute: AttributeKey;
  value: number;
}

export interface ItemSummary {
  id: number;
  name: string;
  icon?: string;
  rarity?: string;
  type?: string;
  subtype?: string;
  description?: string;
  attributes: ItemAttribute[];
}

export interface ItemDefinition extends ItemSummary {
  level: number;
  chatLink?: string;
  defense?: number;
  minPower?: number;
  maxPower?: number;
  attributeAdjustment?: number;
  statChoices?: number[];
}

export type EquipmentStatSource = 'selected' | 'fixed' | 'formula' | 'none';

export interface EquippedItem {
  slot: string;
  itemId: number;
  item: ItemDefinition;
  skin?: ItemSummary;
  statId?: number;
  statName?: string;
  statSource: EquipmentStatSource;
  attributes: ItemAttribute[];
  upgrades: ItemSummary[];
  infusions: ItemSummary[];
  binding?: string;
  boundTo?: string;
  location?: string;
}

export interface TraitSelection {
  id: number;
  name: string;
  icon?: string;
  description?: string;
  tier?: number;
  slot?: string;
}

export interface SpecializationSelection {
  id: number;
  name: string;
  icon?: string;
  background?: string;
  elite: boolean;
  traits: TraitSelection[];
}

export interface SkillSelection {
  id: number;
  name: string;
  icon?: string;
  description?: string;
  slot?: string;
}

export interface BuildInspection {
  tab: number;
  name: string;
  profession: string;
  mode: 'pve';
  specializations: SpecializationSelection[];
  heal?: SkillSelection;
  utilities: SkillSelection[];
  elite?: SkillSelection;
  aquatic: {
    heal?: SkillSelection;
    utilities: SkillSelection[];
    elite?: SkillSelection;
  };
}

export interface CharacterSummary {
  name: string;
  race: string;
  gender?: string;
  profession: string;
  level: number;
  ageSeconds?: number;
  deaths?: number;
  created?: string;
}

export interface CharacterSnapshot {
  character: CharacterSummary;
  eliteSpecialization?: string;
  equipmentTemplate?: string;
  equipment: EquippedItem[];
  build?: BuildInspection;
  attributes: AttributeReport;
  warnings: string[];
  loadedAt: number;
}

export interface AccountIdentity {
  id: string;
  name: string;
  worldId?: number;
}

export interface ConnectionCapabilities {
  characters: boolean;
  equipment: boolean;
  builds: boolean;
}

export interface SecretStorageStatus {
  configured: boolean;
  available: boolean;
  strength: 'strong' | 'weak' | 'unavailable';
  backend?: string;
  message?: string;
}

export interface ConnectionState {
  status: 'disconnected' | 'connected' | 'error';
  account?: AccountIdentity;
  permissions: string[];
  capabilities: ConnectionCapabilities;
  characterNames: string[];
  selectedCharacterName?: string;
  lastConnectedAt?: number;
  message?: string;
  secretStorage: SecretStorageStatus;
  fixtureMode: boolean;
}

export interface BootstrapPayload {
  connection: ConnectionState;
  snapshot?: CharacterSnapshot;
  snapshotError?: Gw2ccErrorPayload;
  globalInstructions: string;
  characterLore: string;
  chat: import('./chat-domain').ChatBootstrapPayload;
  research: import('./research-domain').ResearchSettingsView;
}

export type Gw2ccErrorCode =
  | 'GW2_KEY_INVALID'
  | 'GW2_PERMISSION_MISSING'
  | 'GW2_NOT_CONNECTED'
  | 'GW2_RATE_LIMITED'
  | 'GW2_UPSTREAM_UNAVAILABLE'
  | 'GW2_RESOURCE_NOT_FOUND'
  | 'ATTRIBUTE_DATA_INCOMPLETE'
  | 'LLM_KEY_MISSING'
  | 'LLM_AUTH_FAILED'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_TOOLS_UNSUPPORTED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_UPSTREAM_ERROR'
  | 'WEB_SEARCH_NOT_CONFIGURED'
  | 'WEB_AUTH_FAILED'
  | 'WEB_RATE_LIMITED'
  | 'WEB_FETCH_BLOCKED'
  | 'WEB_FETCH_FAILED'
  | 'WEB_CONTENT_UNSUPPORTED'
  | 'SECRET_STORAGE_UNAVAILABLE'
  | 'DATABASE_ERROR'
  | 'VALIDATION_ERROR'
  | 'CANCELLED';

export interface Gw2ccErrorPayload {
  code: Gw2ccErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface AccountStateRecord {
  account: AccountIdentity;
  permissions: string[];
  characterNames: string[];
  selectedCharacterName?: string;
  lastConnectedAt: number;
}

export interface ConnectionProfile {
  account: AccountIdentity;
  permissions: string[];
  characterNames: string[];
}
