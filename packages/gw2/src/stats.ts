import {
  ATTRIBUTE_KEYS,
  type AttributeKey,
  type AttributeReport,
  type AttributeSourceBreakdown,
  type CharacterAttributes,
  type EquippedItem,
  type ItemAttribute
} from '@gw2cc/core';

export interface ItemStatFormulaAttribute {
  attribute: string;
  multiplier: number;
  value: number;
}

export interface ItemStatFormulaDefinition {
  id: number;
  name: string;
  attributes: ItemStatFormulaAttribute[];
}

export function normalizeAttributeName(attribute: string): AttributeKey | undefined {
  const mapping: Record<string, AttributeKey> = {
    Power: 'Power',
    Precision: 'Precision',
    Toughness: 'Toughness',
    Vitality: 'Vitality',
    CritDamage: 'Ferocity',
    Ferocity: 'Ferocity',
    ConditionDamage: 'ConditionDamage',
    ConditionDuration: 'Expertise',
    Expertise: 'Expertise',
    BoonDuration: 'Concentration',
    Concentration: 'Concentration',
    Healing: 'HealingPower',
    HealingPower: 'HealingPower',
    AgonyResistance: 'AgonyResistance'
  };
  return mapping[attribute];
}

export function calculateItemStatFormula(
  attributeAdjustment: number,
  multiplier: number,
  value: number
): number {
  return Math.round(attributeAdjustment * multiplier + value);
}

export function attributesFromFormula(
  attributeAdjustment: number,
  definition: ItemStatFormulaDefinition
): ItemAttribute[] {
  return definition.attributes.flatMap((entry) => {
    const attribute = normalizeAttributeName(entry.attribute);
    return attribute
      ? [{ attribute, value: calculateItemStatFormula(attributeAdjustment, entry.multiplier, entry.value) }]
      : [];
  });
}

function emptyAttributes(): CharacterAttributes {
  return Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, 0])) as CharacterAttributes;
}

const PROFESSION_BASE_HEALTH: Record<string, number> = {
  Elementalist: 1645,
  Guardian: 1645,
  Thief: 1645,
  Engineer: 5922,
  Mesmer: 5922,
  Ranger: 5922,
  Revenant: 5922,
  Necromancer: 9212,
  Warrior: 9212
};

export function calculateAttributes(input: {
  level: number;
  profession: string;
  equipment: EquippedItem[];
  omissions?: string[];
  unresolved?: boolean;
}): AttributeReport {
  const totals = emptyAttributes();
  const sources: AttributeSourceBreakdown[] = [];
  const omissions = [...(input.omissions ?? [])];

  if (input.level === 80) {
    for (const attribute of ['Power', 'Precision', 'Toughness', 'Vitality'] as const) {
      totals[attribute] = 1000;
      sources.push({ attribute, category: 'base', label: 'Level 80 base', amount: 1000 });
    }
  } else {
    omissions.push('Verified lower-level base attribute progression is not implemented; totals are equipment-only.');
  }

  let defense = 0;
  for (const equipped of input.equipment) {
    defense += equipped.item.defense ?? 0;
    for (const contribution of equipped.attributes) {
      totals[contribution.attribute] += contribution.value;
      sources.push({
        attribute: contribution.attribute,
        category: 'equipment',
        label: `${equipped.item.name} (${equipped.slot})`,
        amount: contribution.value,
        itemId: equipped.itemId
      });
    }
    for (const upgrade of equipped.upgrades) {
      for (const contribution of upgrade.attributes) {
        totals[contribution.attribute] += contribution.value;
        sources.push({
          attribute: contribution.attribute,
          category: 'upgrades',
          label: upgrade.name,
          amount: contribution.value,
          itemId: upgrade.id
        });
      }
    }
    for (const infusion of equipped.infusions) {
      for (const contribution of infusion.attributes) {
        totals[contribution.attribute] += contribution.value;
        sources.push({
          attribute: contribution.attribute,
          category: 'infusions',
          label: infusion.name,
          amount: contribution.value,
          itemId: infusion.id
        });
      }
    }
  }

  const professionBaseHealth = PROFESSION_BASE_HEALTH[input.profession];
  const derived = {
    criticalChance: input.level === 80 ? 5 + Math.max(0, totals.Precision - 1000) / 21 : 0,
    criticalDamage: 150 + totals.Ferocity / 15,
    conditionDuration: totals.Expertise / 15,
    boonDuration: totals.Concentration / 15,
    ...(defense > 0 ? { defense, armor: totals.Toughness + defense } : {}),
    ...(input.level === 80 && professionBaseHealth !== undefined
      ? { health: professionBaseHealth + totals.Vitality * 10 }
      : {})
  };

  sources.push(
    { attribute: 'criticalChance', category: 'derived', label: '5% + (Precision − 1000) / 21', amount: derived.criticalChance },
    { attribute: 'criticalDamage', category: 'derived', label: '150% + Ferocity / 15', amount: derived.criticalDamage },
    { attribute: 'conditionDuration', category: 'derived', label: 'Expertise / 15', amount: derived.conditionDuration },
    { attribute: 'boonDuration', category: 'derived', label: 'Concentration / 15', amount: derived.boonDuration }
  );
  if (derived.armor !== undefined) {
    sources.push({ attribute: 'armor', category: 'derived', label: 'Toughness + resolved defense', amount: derived.armor });
  }
  if (derived.health !== undefined) {
    sources.push({ attribute: 'health', category: 'derived', label: 'Profession base health + Vitality × 10', amount: derived.health });
  }

  const standardOmissions = [
    'Conditional and combat-state trait effects are not included.',
    'Food, utility consumables, boons, map effects, and temporary buffs are not available from the API.',
    'Rune, sigil, and relic prose is not converted into numeric attributes.'
  ];
  for (const omission of standardOmissions) {
    if (!omissions.includes(omission)) omissions.push(omission);
  }

  return {
    totals,
    derived,
    sources,
    completeness: input.level !== 80 || input.unresolved ? 'incomplete' : 'baseline_estimate',
    omissions
  };
}
