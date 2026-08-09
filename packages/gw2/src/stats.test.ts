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

  it('marks lower-level and unresolved equipment totals incomplete', () => {
    const report = calculateAttributes({ level: 42, profession: 'Ranger', equipment: [], unresolved: true });
    expect(report.completeness).toBe('incomplete');
    expect(report.omissions[0]).toContain('lower-level');
    expect(report.totals.Power).toBe(0);
  });
});

