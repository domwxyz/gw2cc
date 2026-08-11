import { describe, expect, it } from 'vitest';
import { normalizeItem, normalizeUpgrade, resolveEquippedItem } from './normalize';
import type { RawItem, RawItemStat } from './schemas';

const baseItem: RawItem = {
  id: 10,
  name: 'Selectable Sword',
  type: 'Weapon',
  rarity: 'Ascended',
  level: 80,
  details: {
    type: 'Sword',
    attribute_adjustment: 341.44,
    infix_upgrade: {
      id: 161,
      attributes: [{ attribute: 'Power', modifier: 50 }]
    }
  }
};

const stat: RawItemStat = {
  id: 161,
  name: "Berserker's",
  attributes: [{ attribute: 'Precision', multiplier: 0.25, value: 0 }]
};

describe('equipment normalization and precedence', () => {
  it('prioritizes equipped-instance selected attributes over fixed and formula values', () => {
    const result = resolveEquippedItem(
      { id: 10, slot: 'WeaponA1', stats: { id: 161, attributes: { Power: 125, CritDamage: 90 } } },
      baseItem,
      { items: new Map([[10, baseItem]]), itemStats: new Map([[161, stat]]), skins: new Map() }
    );
    expect(result.statSource).toBe('selected');
    expect(result.attributes).toEqual([
      { attribute: 'Power', value: 125 },
      { attribute: 'Ferocity', value: 90 }
    ]);
  });

  it('uses structured fixed attributes before formula fallback', () => {
    const fixed = resolveEquippedItem(
      { id: 10, slot: 'WeaponA1' },
      baseItem,
      { items: new Map([[10, baseItem]]), itemStats: new Map([[161, stat]]), skins: new Map() }
    );
    expect(fixed.statSource).toBe('fixed');
    expect(fixed.attributes).toEqual([{ attribute: 'Power', value: 50 }]);

    const formulaItem = { ...baseItem, details: { ...baseItem.details, infix_upgrade: { id: 161, attributes: [] } } };
    const formula = resolveEquippedItem(
      { id: 10, slot: 'WeaponA1' },
      formulaItem,
      { items: new Map([[10, formulaItem]]), itemStats: new Map([[161, stat]]), skins: new Map() }
    );
    expect(formula.statSource).toBe('formula');
    expect(formula.attributes).toEqual([{ attribute: 'Precision', value: 85 }]);
  });

  it('normalizes rune tiers, unconditional sigil text, and relic core attributes', () => {
    const rune: RawItem = {
      id: 24836,
      name: 'Superior Rune of the Scholar',
      type: 'UpgradeComponent',
      rarity: 'Exotic',
      level: 60,
      details: {
        type: 'Rune',
        bonuses: ['+25 Power', '+35 Ferocity', '+50 Power', '+65 Ferocity', '+100 Power', '+125 Ferocity'],
        infix_upgrade: { id: 112, attributes: [] }
      }
    };
    const sigil: RawItem = {
      id: 900,
      name: 'Static Test Sigil',
      type: 'UpgradeComponent',
      rarity: 'Exotic',
      level: 60,
      details: {
        type: 'Sigil',
        infix_upgrade: {
          id: 901,
          buff: { description: '+25 Power, +10 Precision, and +7% Critical Chance' },
          attributes: [{ attribute: 'Power', modifier: 25 }]
        }
      }
    };
    const relic: RawItem = {
      id: 1000,
      name: 'Static Test Relic',
      description: '+15 Vitality',
      type: 'Relic',
      rarity: 'Exotic',
      level: 60
    };

    expect(normalizeUpgrade(rune).attributeBonusTiers?.slice(0, 3)).toEqual([
      [{ attribute: 'Power', value: 25 }],
      [{ attribute: 'Ferocity', value: 35 }],
      [{ attribute: 'Power', value: 50 }]
    ]);
    expect(normalizeUpgrade(sigil).attributes).toEqual([
      { attribute: 'Power', value: 25 },
      { attribute: 'Precision', value: 10 }
    ]);
    expect(normalizeUpgrade(sigil).percentageModifiers).toEqual([
      { attribute: 'criticalChance', value: 7 }
    ]);
    expect(normalizeItem(relic).attributes).toEqual([{ attribute: 'Vitality', value: 15 }]);
  });
});
