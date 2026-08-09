import { describe, expect, it } from 'vitest';
import { resolveEquippedItem } from './normalize';
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
});
