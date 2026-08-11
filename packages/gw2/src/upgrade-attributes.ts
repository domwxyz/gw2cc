import type {
  AttributeKey,
  ItemAttribute,
  PercentageModifier,
  PercentageModifierKey
} from '@gw2cc/core';

const MAX_PARSED_ATTRIBUTE_VALUE = 1000;
const MAX_ATTRIBUTE_TEXT_LENGTH = 512;

const ATTRIBUTE_LABELS: ReadonlyArray<readonly [string, AttributeKey]> = [
  ['Condition Damage', 'ConditionDamage'],
  ['Agony Resistance', 'AgonyResistance'],
  ['Healing Power', 'HealingPower'],
  ['Concentration', 'Concentration'],
  ['Healing', 'HealingPower'],
  ['Precision', 'Precision'],
  ['Toughness', 'Toughness'],
  ['Vitality', 'Vitality'],
  ['Ferocity', 'Ferocity'],
  ['Expertise', 'Expertise'],
  ['Power', 'Power']
];

const ALL_STATS_ATTRIBUTES: AttributeKey[] = [
  'Power',
  'Precision',
  'Toughness',
  'Vitality',
  'Ferocity',
  'ConditionDamage',
  'HealingPower'
];

const ATTRIBUTE_PATTERN = ATTRIBUTE_LABELS.map(([label]) => label.replace(' ', '\\s+')).join('|');
const PREFIX_ATTRIBUTE_PATTERN = new RegExp(`^\\+\\s*(\\d{1,4})\\s+(${ATTRIBUTE_PATTERN})$`, 'i');
const SUFFIX_ATTRIBUTE_PATTERN = new RegExp(`^(${ATTRIBUTE_PATTERN})\\s+\\+\\s*(\\d{1,4})$`, 'i');
const ALL_STATS_PATTERN = /^\+\s*(\d{1,4})\s+to\s+All\s+Stats$/i;
const PERCENTAGE_PATTERN = /^\+\s*(\d{1,3}(?:\.\d+)?)\s*%\s+(Critical Chance|Condition Duration|Boon Duration)$/i;

const PERCENTAGE_LABELS: ReadonlyArray<readonly [string, PercentageModifierKey]> = [
  ['Critical Chance', 'criticalChance'],
  ['Condition Duration', 'conditionDuration'],
  ['Boon Duration', 'boonDuration']
];

export interface ParsedUpgradeBonuses {
  attributes: ItemAttribute[];
  percentageModifiers: PercentageModifier[];
}

const NO_BONUSES: ParsedUpgradeBonuses = { attributes: [], percentageModifiers: [] };

function attributeForLabel(label: string): AttributeKey | undefined {
  return ATTRIBUTE_LABELS.find(([candidate]) => candidate.toLowerCase() === label.toLowerCase())?.[1];
}

function validValue(rawValue: string): number | undefined {
  const value = Number.parseInt(rawValue, 10);
  return value > 0 && value <= MAX_PARSED_ATTRIBUTE_VALUE ? value : undefined;
}

function percentageModifierForLabel(label: string): PercentageModifierKey | undefined {
  return PERCENTAGE_LABELS.find(([candidate]) => candidate.toLowerCase() === label.toLowerCase())?.[1];
}

function validPercentage(rawValue: string): number | undefined {
  const value = Number.parseFloat(rawValue);
  return value > 0 && value <= 100 ? value : undefined;
}

function mergeAttributes(attributes: ItemAttribute[]): ItemAttribute[] {
  const totals = new Map<AttributeKey, number>();
  for (const entry of attributes) {
    totals.set(entry.attribute, (totals.get(entry.attribute) ?? 0) + entry.value);
  }
  return [...totals].map(([attribute, value]) => ({ attribute, value }));
}

/**
 * Parses only complete, unconditional English core-attribute clauses and the
 * three supported percentage modifiers returned by the GW2 API. Any trigger,
 * duration, or other prose makes the entire string unsupported rather than
 * producing a speculative contribution.
 */
export function parseUnconditionalUpgradeBonuses(text: string | undefined): ParsedUpgradeBonuses {
  if (!text || text.length > MAX_ATTRIBUTE_TEXT_LENGTH) return NO_BONUSES;

  const clauses = text
    .trim()
    .replace(/,\s+and\s+/gi, ',')
    .replace(/\s+and\s+/gi, ',')
    .split(/\s*,\s*/);
  if (clauses.length === 0 || clauses.some((clause) => clause.length === 0)) return NO_BONUSES;

  const parsed: ItemAttribute[] = [];
  const percentageModifiers: PercentageModifier[] = [];
  for (const clause of clauses) {
    const allStatsMatch = ALL_STATS_PATTERN.exec(clause);
    if (allStatsMatch) {
      const value = validValue(allStatsMatch[1]!);
      if (value === undefined) return NO_BONUSES;
      parsed.push(...ALL_STATS_ATTRIBUTES.map((attribute) => ({ attribute, value })));
      continue;
    }

    const percentageMatch = PERCENTAGE_PATTERN.exec(clause);
    if (percentageMatch) {
      const value = validPercentage(percentageMatch[1]!);
      const attribute = percentageModifierForLabel(percentageMatch[2]!);
      if (value === undefined || attribute === undefined) return NO_BONUSES;
      percentageModifiers.push({ attribute, value });
      continue;
    }

    const prefixMatch = PREFIX_ATTRIBUTE_PATTERN.exec(clause);
    const suffixMatch = prefixMatch ? undefined : SUFFIX_ATTRIBUTE_PATTERN.exec(clause);
    const rawValue = prefixMatch?.[1] ?? suffixMatch?.[2];
    const rawLabel = prefixMatch?.[2] ?? suffixMatch?.[1];
    const value = rawValue === undefined ? undefined : validValue(rawValue);
    const attribute = rawLabel === undefined ? undefined : attributeForLabel(rawLabel.replace(/\s+/g, ' '));
    if (value === undefined || attribute === undefined) return NO_BONUSES;
    parsed.push({ attribute, value });
  }

  return { attributes: mergeAttributes(parsed), percentageModifiers };
}

export function parseUnconditionalCoreAttributes(text: string | undefined): ItemAttribute[] {
  return parseUnconditionalUpgradeBonuses(text).attributes;
}

export function mergeStructuredAndParsedAttributes(
  structured: ItemAttribute[],
  parsed: ItemAttribute[]
): ItemAttribute[] {
  const structuredPairs = new Set(structured.map((entry) => `${entry.attribute}:${entry.value}`));
  return mergeAttributes([
    ...structured,
    ...parsed.filter((entry) => !structuredPairs.has(`${entry.attribute}:${entry.value}`))
  ]);
}
