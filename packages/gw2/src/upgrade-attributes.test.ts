import { describe, expect, it } from 'vitest';
import {
  mergeStructuredAndParsedAttributes,
  parseUnconditionalCoreAttributes,
  parseUnconditionalUpgradeBonuses
} from './upgrade-attributes';

describe('upgrade attribute text parsing', () => {
  it('parses complete unconditional core-stat clauses', () => {
    expect(parseUnconditionalCoreAttributes('+25 Power')).toEqual([
      { attribute: 'Power', value: 25 }
    ]);
    expect(parseUnconditionalCoreAttributes('Power +25')).toEqual([
      { attribute: 'Power', value: 25 }
    ]);
    expect(parseUnconditionalCoreAttributes('+10 Power and +10 Condition Damage')).toEqual([
      { attribute: 'Power', value: 10 },
      { attribute: 'ConditionDamage', value: 10 }
    ]);
  });

  it('expands the API all-stats wording to the supported core attributes', () => {
    expect(parseUnconditionalCoreAttributes('+8 to All Stats')).toEqual([
      { attribute: 'Power', value: 8 },
      { attribute: 'Precision', value: 8 },
      { attribute: 'Toughness', value: 8 },
      { attribute: 'Vitality', value: 8 },
      { attribute: 'Ferocity', value: 8 },
      { attribute: 'ConditionDamage', value: 8 },
      { attribute: 'HealingPower', value: 8 }
    ]);
  });

  it('parses supported percentages and rejects triggers, durations, and partial prose', () => {
    expect(parseUnconditionalUpgradeBonuses('+7% Critical Chance')).toEqual({
      attributes: [],
      percentageModifiers: [{ attribute: 'criticalChance', value: 7 }]
    });
    expect(parseUnconditionalUpgradeBonuses('+10% Condition Duration')).toEqual({
      attributes: [],
      percentageModifiers: [{ attribute: 'conditionDuration', value: 10 }]
    });
    expect(parseUnconditionalCoreAttributes('Gain +250 Power after killing a foe.')).toEqual([]);
    expect(parseUnconditionalCoreAttributes('+25 Power for 10 seconds')).toEqual([]);
    expect(parseUnconditionalCoreAttributes('+25 Power and +5% Damage')).toEqual([]);
  });

  it('does not double count an API attribute repeated by buff text', () => {
    expect(mergeStructuredAndParsedAttributes(
      [{ attribute: 'Power', value: 25 }],
      [{ attribute: 'Power', value: 25 }, { attribute: 'Precision', value: 10 }]
    )).toEqual([
      { attribute: 'Power', value: 25 },
      { attribute: 'Precision', value: 10 }
    ]);
  });
});
