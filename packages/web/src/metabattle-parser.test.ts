import { describe, expect, it } from 'vitest';
import { FIXTURE_METABATTLE_TITLE, FIXTURE_METABATTLE_WIKITEXT } from './fixture';
import { parseMetaBattleWikitext, scanMetaBattleTemplates } from './metabattle-parser';

describe('focused MetaBattle wikitext parser', () => {
  it('recovers template/icon-backed build selections with whitespace, casing, named arguments, and repeats', () => {
    const result = parseMetaBattleWikitext(FIXTURE_METABATTLE_TITLE, FIXTURE_METABATTLE_WIKITEXT);
    expect(result.build).toMatchObject({
      name: 'Scrapper - Power Scrapper',
      profession: 'engineer',
      specialization: 'scrapper',
      modes: ['open world', 'pve'],
      focus: ['strike damage', 'quickness'],
      meta: true,
      equipment: {
        defaultStats: 'Berserker',
        weight: 'Medium',
        statOverrides: [{ slot: 'legs', stats: 'Dragon' }, { slot: 'backpiece', stats: 'Dragon' }],
        weapons: [{ name: 'Hammer' }],
        runes: expect.arrayContaining([
          expect.objectContaining({ name: 'Superior Rune of the Scholar' }),
          expect.objectContaining({ name: 'Superior Rune of Durability' })
        ]),
        sigils: expect.arrayContaining([
          expect.objectContaining({ name: 'Superior Sigil of Force' }),
          expect.objectContaining({ name: 'Superior Sigil of Impact' }),
          expect.objectContaining({ name: 'Superior Sigil of Energy' })
        ]),
        relics: expect.arrayContaining([
          expect.objectContaining({ name: 'Relic of Fireworks' }),
          expect.objectContaining({ name: 'Relic of Zakiros' })
        ]),
        otherItems: [expect.objectContaining({ name: 'Birthday Blaster' })]
      },
      skills: {
        heal: { name: 'Healing Turret' },
        utilities: [{ name: 'Throw Mine' }, { name: 'Blast Gyro' }, { name: 'Shredder Gyro' }],
        elite: { name: 'Elite Mortar Kit' },
        other: expect.arrayContaining([
          expect.objectContaining({ name: 'Rocket Boots' }),
          expect.objectContaining({ name: 'Grenade Kit', id: 5806 })
        ])
      },
      specializations: expect.arrayContaining([
        expect.objectContaining({ name: 'Explosives', traitChoices: ['bot', 'mid', 'bot'] }),
        expect.objectContaining({ name: 'Scrapper', id: 43, traitChoices: ['top', 'bot', 'mid'] })
      ]),
      mentionedTraits: expect.arrayContaining([
        expect.objectContaining({ name: 'Impact Savant', id: 1877 }),
        expect.objectContaining({ name: 'Kinetic Accelerators', id: 2052 }),
        expect.objectContaining({ name: 'System Shocker' })
      ]),
      consumables: {
        food: [expect.objectContaining({ name: 'Plate of Spicy Moa Wings' })],
        utility: [expect.objectContaining({ name: 'Superior Sharpening Stone' })]
      },
      buildTemplateCode: '[&DQMmLwY7Ky0oAYQAJgEmAScTJxOuEq4S+RKJAQAAAAAAAAAAAAAAAAAAAAACVQAzAAA=]',
      unrecognizedTemplates: ['Unknown presentation']
    });
    expect(result.sections.overview).toContain('Impact Savant');
    expect(result.sections.usage).toContain('Rocket Charge');
    expect(result.sections.defense).toContain('Shock Shield');
    expect(result.sections.crowdControl).toContain('Thunderclap');
    expect(result.sections.variants).toContain('System Shocker');
    expect(result.sections.notes).toContain('Incomplete fields must remain omitted');
  });

  it('scans nested templates without a giant regular expression and preserves the outer value safely', () => {
    const templates = scanMetaBattleTemplates('{{Item|{{Tooltip|Birthday Blaster}}}} {{Skill|One}} {{Skill | Two | id=2}}');
    expect(templates.map((entry) => ({ name: entry.name, depth: entry.depth }))).toEqual([
      { name: 'item', depth: 0 },
      { name: 'tooltip', depth: 1 },
      { name: 'skill', depth: 0 },
      { name: 'skill', depth: 0 }
    ]);
    const result = parseMetaBattleWikitext('Build:Nested', '==Equipment==\n{{Item|{{Tooltip|Birthday Blaster}}}}');
    expect(result.build.equipment.otherItems).toMatchObject([{ name: 'Birthday Blaster' }]);
  });

  it('returns accurate partial data for incomplete pages without inventing selections', () => {
    const result = parseMetaBattleWikitext('Build:Incomplete', '==Overview==\nA community note. {{Unknown|value}}');
    expect(result.build).toMatchObject({
      name: 'Incomplete',
      modes: [],
      focus: [],
      equipment: { statOverrides: [], weapons: [], runes: [], sigils: [], relics: [], otherItems: [] },
      skills: { utilities: [], other: [] },
      specializations: [],
      mentionedTraits: [],
      consumables: { food: [], utility: [] },
      unrecognizedTemplates: ['Unknown']
    });
    expect(result.build).not.toHaveProperty('profession');
    expect(result.build).not.toHaveProperty('buildTemplateCode');
    expect(result.sections.overview).toBe('A community note.');
  });
});
