import { describe, expect, it } from 'vitest';
import type { EquippedItem } from '@gw2cc/core';
import {
  attributesFromFormula,
  calculateAttributes,
  calculateItemStatFormula
} from './stats';

describe('GW2 attribute calculation', () => {
  it('uses the documented rounded itemstat formula', () => {
    expect(calculateItemStatFormula(341.44, 0.25, 0)).toBe(85);
    expect(attributesFromFormula(358.512, {
      id: 584,
      name: "Berserker's",
      attributes: [
        { attribute: 'Power', multiplier: 0.35, value: 32 },
        { attribute: 'CritDamage', multiplier: 0.25, value: 18 }
      ]
    })).toEqual([
      { attribute: 'Power', value: 157 },
      { attribute: 'Ferocity', value: 108 }
    ]);
  });

  it('produces golden level-80 totals, derived values, and provenance', () => {
    const item: EquippedItem = {
      slot: 'Coat',
      itemId: 100,
      item: {
        id: 100,
        name: 'Golden Coat',
        type: 'Armor',
        subtype: 'Coat',
        rarity: 'Ascended',
        level: 80,
        defense: 338,
        attributes: [{ attribute: 'Power', value: 100 }]
      },
      statName: "Berserker's",
      statSource: 'selected',
      attributes: [
        { attribute: 'Power', value: 100 },
        { attribute: 'Precision', value: 70 },
        { attribute: 'Ferocity', value: 70 }
      ],
      upgrades: [{
        id: 200,
        name: 'Structured Rune',
        attributes: [{ attribute: 'Power', value: 25 }]
      }],
      infusions: [{
        id: 300,
        name: 'Power Agony Infusion',
        attributes: [
          { attribute: 'Power', value: 5 },
          { attribute: 'AgonyResistance', value: 9 }
        ]
      }]
    };
    const report = calculateAttributes({ level: 80, profession: 'Guardian', equipment: [item] });
    expect(report.totals).toMatchObject({
      Power: 1130,
      Precision: 1070,
      Toughness: 1000,
      Vitality: 1000,
      Ferocity: 70,
      AgonyResistance: 9
    });
    expect(report.derived.criticalChance).toBeCloseTo(8.333, 3);
    expect(report.derived.criticalDamage).toBeCloseTo(154.667, 3);
    expect(report.derived.armor).toBe(1338);
    expect(report.derived.health).toBe(11645);
    expect(report.completeness).toBe('baseline_estimate');
    expect(report.sources.filter((source) => source.attribute === 'Power')).toEqual([
      { attribute: 'Power', category: 'base', label: 'Level 80 base', amount: 1000 },
      { attribute: 'Power', category: 'equipment', label: 'Golden Coat (Coat)', amount: 100, itemId: 100 },
      { attribute: 'Power', category: 'upgrades', label: 'Structured Rune', amount: 25, itemId: 200 },
      { attribute: 'Power', category: 'infusions', label: 'Power Agony Infusion', amount: 5, itemId: 300 }
    ]);
  });

  it('excludes aquatic equipment and the secondary weapon set from land attributes', () => {
    const item = (slot: string, itemId: number, power: number, defense = 0): EquippedItem => ({
      slot,
      itemId,
      item: {
        id: itemId,
        name: slot,
        type: slot.startsWith('Weapon') ? 'Weapon' : 'Armor',
        level: 80,
        defense,
        attributes: [{ attribute: 'Power', value: power }]
      },
      statSource: 'selected',
      attributes: [{ attribute: 'Power', value: power }],
      upgrades: [{
        id: itemId + 100,
        name: `${slot} upgrade`,
        attributes: [{ attribute: 'Power', value: 1 }]
      }],
      infusions: [{
        id: itemId + 200,
        name: `${slot} infusion`,
        attributes: [{ attribute: 'Power', value: 1 }]
      }]
    });
    const equipment = [
      item('Coat', 1, 10, 100),
      item('WeaponA1', 2, 20),
      item('WeaponA2', 3, 30),
      item('HelmAquatic', 4, 100, 500),
      item('WeaponAquaticA', 5, 200),
      item('WeaponAquaticB', 6, 300),
      item('WeaponB1', 7, 400),
      item('WeaponB2', 8, 500)
    ];

    const report = calculateAttributes({ level: 80, profession: 'Guardian', equipment });

    expect(report.totals.Power).toBe(1066);
    expect(report.derived.defense).toBe(100);
    expect(report.sources.some((source) =>
      ['HelmAquatic', 'WeaponAquaticA', 'WeaponAquaticB', 'WeaponB1', 'WeaponB2']
        .some((slot) => source.label.includes(slot))
    )).toBe(false);
    expect(report.omissions).toContain(
      'Aquatic equipment and the secondary land weapon set are excluded from land attribute totals.'
    );
  });

  it('applies matching rune tiers and unconditional sigil and relic attributes', () => {
    const rune = {
      id: 24836,
      name: 'Superior Rune of the Scholar',
      type: 'UpgradeComponent',
      subtype: 'Rune',
      attributes: [],
      attributeBonusTiers: [
        [{ attribute: 'Power' as const, value: 25 }],
        [{ attribute: 'Ferocity' as const, value: 35 }],
        [{ attribute: 'Power' as const, value: 50 }]
      ]
    };
    const sigil = {
      id: 24600,
      name: 'Static Test Sigil',
      type: 'UpgradeComponent',
      subtype: 'Sigil',
      attributes: [{ attribute: 'Precision' as const, value: 25 }],
      percentageModifiers: [{ attribute: 'criticalChance' as const, value: 7 }]
    };
    const item = (
      slot: string,
      itemId: number,
      upgrades: EquippedItem['upgrades'] = [rune],
      attributes: EquippedItem['attributes'] = []
    ): EquippedItem => ({
      slot,
      itemId,
      item: {
        id: itemId,
        name: slot,
        type: slot === 'Relic' ? 'Relic' : slot.startsWith('Weapon') ? 'Weapon' : 'Armor',
        level: 80,
        attributes
      },
      statSource: attributes.length > 0 ? 'fixed' : 'none',
      attributes,
      upgrades,
      infusions: []
    });
    const equipment = [
      item('HelmAquatic', 1),
      item('Helm', 2),
      item('Coat', 3),
      item('Boots', 4),
      item('WeaponA1', 5, [sigil]),
      item('WeaponB1', 6, [sigil]),
      item('Relic', 7, [], [{ attribute: 'Vitality', value: 15 }])
    ];

    const report = calculateAttributes({ level: 80, profession: 'Guardian', equipment });

    expect(report.totals).toMatchObject({
      Power: 1075,
      Precision: 1025,
      Vitality: 1015,
      Ferocity: 35
    });
    expect(report.derived.criticalChance).toBeCloseTo(13.19, 2);
    expect(report.sources.filter((source) => source.itemId === rune.id).map((source) => source.label)).toEqual([
      'Superior Rune of the Scholar (1-piece bonus)',
      'Superior Rune of the Scholar (2-piece bonus)',
      'Superior Rune of the Scholar (3-piece bonus)'
    ]);
    expect(report.omissions).toContain(
      'Conditional and unsupported rune, sigil, and relic effects are not included.'
    );
  });

  it('marks lower-level and unresolved equipment totals incomplete', () => {
    const report = calculateAttributes({ level: 42, profession: 'Ranger', equipment: [], unresolved: true });
    expect(report.completeness).toBe('incomplete');
    expect(report.omissions[0]).toContain('lower-level');
    expect(report.totals.Power).toBe(0);
  });
});
