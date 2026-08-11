import {
  Gw2ccError,
  type CharacterSnapshot,
  type ConnectionProfile,
  type EquippedItem,
  type Gw2Gateway,
  type ItemAttribute,
  type ItemSummary,
  type QueryValue
} from '@gw2cc/core';
import { validateGw2V2Path } from './client';
import { calculateAttributes } from './stats';

const rune: ItemSummary = {
  id: 9001,
  name: 'Structured Scholar Rune',
  rarity: 'Exotic',
  type: 'UpgradeComponent',
  subtype: 'Rune',
  description: 'Fixture rune with one structured unconditional contribution.',
  attributes: [{ attribute: 'Power', value: 25 }]
};

const infusion: ItemSummary = {
  id: 9002,
  name: '+5 Power +9 Agony Infusion',
  rarity: 'Ascended',
  type: 'UpgradeComponent',
  subtype: 'Infusion',
  attributes: [
    { attribute: 'Power', value: 5 },
    { attribute: 'AgonyResistance', value: 9 }
  ]
};

function equipped(
  id: number,
  slot: string,
  name: string,
  attributes: ItemAttribute[],
  options: {
    statSource?: EquippedItem['statSource'];
    statName?: string;
    type?: string;
    subtype?: string;
    defense?: number;
    upgrades?: ItemSummary[];
    infusions?: ItemSummary[];
    rarity?: string;
  } = {}
): EquippedItem {
  return {
    slot,
    itemId: id,
    item: {
      id,
      name,
      rarity: options.rarity ?? 'Ascended',
      type: options.type ?? (slot.startsWith('Weapon') ? 'Weapon' : 'Armor'),
      subtype: options.subtype ?? (slot.startsWith('Weapon') ? 'Sword' : 'HeavyArmor'),
      level: 80,
      description: `${name} is deterministic fixture equipment used for offline inspection.`,
      attributes,
      ...(options.defense !== undefined ? { defense: options.defense } : {})
    },
    statId: 584,
    statName: options.statName ?? "Berserker's",
    statSource: options.statSource ?? 'selected',
    attributes,
    upgrades: options.upgrades ?? [],
    infusions: options.infusions ?? [],
    binding: 'Account',
    location: 'Equipped'
  };
}

function guardianSnapshot(now: number): CharacterSnapshot {
  const equipment = [
    equipped(1001, 'Helm', 'Vigilant Dragon Helm', [
      { attribute: 'Power', value: 63 }, { attribute: 'Precision', value: 45 }, { attribute: 'Ferocity', value: 45 }
    ], { defense: 127, statSource: 'selected', upgrades: [rune], infusions: [infusion] }),
    equipped(1002, 'Shoulders', 'Vigilant Dragon Pauldrons', [
      { attribute: 'Power', value: 47 }, { attribute: 'Precision', value: 34 }, { attribute: 'Ferocity', value: 34 }
    ], { defense: 95, statSource: 'fixed' }),
    equipped(1003, 'Coat', 'Vigilant Dragon Breastplate', [
      { attribute: 'Power', value: 141 }, { attribute: 'Precision', value: 101 }, { attribute: 'Ferocity', value: 101 }
    ], { defense: 381, statSource: 'formula', upgrades: [rune], infusions: [infusion] }),
    equipped(1004, 'Gloves', 'Vigilant Dragon Gauntlets', [
      { attribute: 'Power', value: 47 }, { attribute: 'Precision', value: 34 }, { attribute: 'Ferocity', value: 34 }
    ], { defense: 191, statSource: 'fixed' }),
    equipped(1005, 'Leggings', 'Vigilant Dragon Legplates', [
      { attribute: 'Power', value: 94 }, { attribute: 'Precision', value: 67 }, { attribute: 'Ferocity', value: 67 }
    ], { defense: 254 }),
    equipped(1006, 'Boots', 'Vigilant Dragon Greaves', [
      { attribute: 'Power', value: 47 }, { attribute: 'Precision', value: 34 }, { attribute: 'Ferocity', value: 34 }
    ], { defense: 191 }),
    equipped(1010, 'WeaponA1', 'Dawnward Blade', [
      { attribute: 'Power', value: 125 }, { attribute: 'Precision', value: 90 }, { attribute: 'Ferocity', value: 90 }
    ], { subtype: 'Sword', infusions: [infusion] }),
    equipped(1011, 'WeaponA2', 'Aegis of the Console', [
      { attribute: 'Power', value: 125 }, { attribute: 'Precision', value: 90 }, { attribute: 'Ferocity', value: 90 }
    ], { subtype: 'Shield', statSource: 'formula', infusions: [infusion] }),
    equipped(1012, 'Backpack', 'Astral Field Pack', [
      { attribute: 'Power', value: 63 }, { attribute: 'Precision', value: 40 }, { attribute: 'Ferocity', value: 40 }
    ], { type: 'Back', subtype: 'BackItem', infusions: [infusion] }),
    equipped(1013, 'Amulet', 'Mists-Forged Pendant', [
      { attribute: 'Power', value: 157 }, { attribute: 'Precision', value: 108 }, { attribute: 'Ferocity', value: 108 }
    ], { type: 'Trinket', subtype: 'Amulet' }),
    equipped(1014, 'Ring1', 'Loop of Quiet Resolve', [
      { attribute: 'Power', value: 126 }, { attribute: 'Precision', value: 85 }, { attribute: 'Ferocity', value: 85 }
    ], { type: 'Trinket', subtype: 'Ring', infusions: [infusion] }),
    equipped(1015, 'Ring2', 'Band of Emberlight', [
      { attribute: 'Power', value: 126 }, { attribute: 'Precision', value: 85 }, { attribute: 'Ferocity', value: 85 }
    ], { type: 'Trinket', subtype: 'Ring', infusions: [infusion] })
  ];
  return {
    character: { name: 'Aurelia Ward', race: 'Human', gender: 'Female', profession: 'Guardian', level: 80 },
    eliteSpecialization: 'Firebrand',
    equipmentTemplate: 'Open World Firebrand',
    equipment,
    build: {
      tab: 1,
      name: 'Tomekeeper',
      profession: 'Guardian',
      mode: 'pve',
      specializations: [
        { id: 42, name: 'Valor', elite: false, traits: [{ id: 201, name: 'Smiter’s Boon', tier: 1 }] },
        { id: 46, name: 'Radiance', elite: false, traits: [{ id: 202, name: 'Righteous Instincts', tier: 3 }] },
        { id: 62, name: 'Firebrand', elite: true, traits: [{ id: 203, name: 'Loremaster', tier: 3 }] }
      ],
      heal: { id: 5501, name: 'Mantra of Solace', slot: 'Heal' },
      utilities: [
        { id: 5502, name: 'Mantra of Potence', slot: 'Utility' },
        { id: 5503, name: 'Sword of Justice', slot: 'Utility' },
        { id: 5504, name: 'Stand Your Ground!', slot: 'Utility' }
      ],
      elite: { id: 5505, name: 'Mantra of Liberation', slot: 'Elite' },
      aquatic: { utilities: [] }
    },
    attributes: calculateAttributes({ level: 80, profession: 'Guardian', equipment }),
    warnings: [],
    loadedAt: now
  };
}

function rangerSnapshot(now: number): CharacterSnapshot {
  const equipment = [
    equipped(2001, 'Coat', 'Canopy Stalker Coat', [
      { attribute: 'ConditionDamage', value: 141 }, { attribute: 'Precision', value: 101 }, { attribute: 'Expertise', value: 101 }
    ], { type: 'Armor', subtype: 'MediumArmor', defense: 338, statName: "Viper's", statSource: 'selected' }),
    equipped(2002, 'Leggings', 'Canopy Stalker Leggings', [
      { attribute: 'ConditionDamage', value: 94 }, { attribute: 'Precision', value: 67 }, { attribute: 'Expertise', value: 67 }
    ], { type: 'Armor', subtype: 'MediumArmor', defense: 229, statName: "Viper's", statSource: 'fixed' }),
    equipped(2010, 'WeaponA1', 'Verdant Longbow', [
      { attribute: 'ConditionDamage', value: 251 }, { attribute: 'Precision', value: 179 }, { attribute: 'Expertise', value: 179 }
    ], { subtype: 'LongBow', statName: "Viper's", statSource: 'formula', infusions: [infusion] }),
    equipped(2011, 'WeaponB1', 'Rootbound Axe', [
      { attribute: 'ConditionDamage', value: 125 }, { attribute: 'Precision', value: 90 }, { attribute: 'Expertise', value: 90 }
    ], { subtype: 'Axe', statName: "Viper's" }),
    equipped(2012, 'Amulet', 'Wayfinder’s Compass', [
      { attribute: 'ConditionDamage', value: 157 }, { attribute: 'Precision', value: 108 }, { attribute: 'Expertise', value: 108 }
    ], { type: 'Trinket', subtype: 'Amulet', statName: "Viper's" })
  ];
  return {
    character: { name: 'Sylvari Ranger', race: 'Sylvari', gender: 'Male', profession: 'Ranger', level: 80 },
    eliteSpecialization: 'Soulbeast',
    equipmentTemplate: 'Condition Trailblazer',
    equipment,
    build: {
      tab: 2,
      name: 'Wild Hunt',
      profession: 'Ranger',
      mode: 'pve',
      specializations: [
        { id: 30, name: 'Skirmishing', elite: false, traits: [{ id: 301, name: 'Sharpened Edges', tier: 1 }] },
        { id: 33, name: 'Wilderness Survival', elite: false, traits: [{ id: 302, name: 'Ambidexterity', tier: 2 }] },
        { id: 55, name: 'Soulbeast', elite: true, traits: [{ id: 303, name: 'Leader of the Pack', tier: 3 }] }
      ],
      heal: { id: 5601, name: 'We Heal As One!', slot: 'Heal' },
      utilities: [{ id: 5602, name: 'Vulture Stance', slot: 'Utility' }],
      elite: { id: 5603, name: 'One Wolf Pack', slot: 'Elite' },
      aquatic: { utilities: [] }
    },
    attributes: calculateAttributes({ level: 80, profession: 'Ranger', equipment }),
    warnings: [],
    loadedAt: now
  };
}

export class FixtureGw2Gateway implements Gw2Gateway {
  readonly fixtureMode = true;

  async validateKey(apiKey: string): Promise<ConnectionProfile> {
    if (apiKey !== 'fixture-key') throw new Gw2ccError('GW2_KEY_INVALID', 'Fixture mode expects its built-in key.');
    return {
      account: { id: 'fixture-account-001', name: 'Fixture Commander.1234', worldId: 1001 },
      permissions: ['account', 'characters', 'builds', 'inventories', 'wallet', 'progression'],
      characterNames: ['Aurelia Ward', 'Sylvari Ranger']
    };
  }

  async getCharacterSnapshot(_apiKey: string, characterName: string, _forceRefresh?: boolean, signal?: AbortSignal): Promise<CharacterSnapshot> {
    if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'Fixture GW2 request was cancelled.');
    if (characterName === 'Aurelia Ward') return guardianSnapshot(Date.now());
    if (characterName === 'Sylvari Ranger') return rangerSnapshot(Date.now());
    throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', `No fixture character named ${characterName}.`);
  }

  async get<T>(apiKey: string | undefined, path: `/v2/${string}`, query: Record<string, QueryValue> = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'Fixture GW2 request was cancelled.');
    validateGw2V2Path(path);
    if (
      !apiKey &&
      (path === '/v2/tokeninfo' || path === '/v2/characters' || path.startsWith('/v2/characters/') ||
        path === '/v2/account' || path.startsWith('/v2/account/'))
    ) {
      throw new Gw2ccError('GW2_NOT_CONNECTED', 'This GW2 API endpoint requires a connected API key.');
    }
    const guardian = guardianSnapshot(Date.now());
    const ranger = rangerSnapshot(Date.now());
    const allItems = [...guardian.equipment, ...ranger.equipment].map((entry) => entry.item);
    if (path === '/v2/items') {
      const ids = Array.isArray(query.ids) ? query.ids.map(Number) : String(query.ids ?? '').split(',').filter(Boolean).map(Number);
      return allItems.filter((item) => ids.includes(item.id)) as T;
    }
    const itemMatch = path.match(/^\/v2\/items\/(\d+)$/);
    if (itemMatch) {
      const item = allItems.find((entry) => entry.id === Number(itemMatch[1]));
      if (!item) throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', `No fixture item ${itemMatch[1]}.`);
      return item as T;
    }
    const fixtures: Record<string, unknown> = {
      '/v2/account': {
        id: 'fixture-account-001',
        name: 'Fixture Commander.1234',
        world: 1001,
        access: ['GuildWars2', 'HeartOfThorns'],
        fractal_level: 32,
        daily_ap: 12_345,
        monthly_ap: 500,
        commander: true,
        created: '2012-08-25T00:00:00Z',
        age: 3_600_000,
        wvw: { rank: 145, team_id: 11001 },
        guilds: ['fixture-guild-001'],
        guild_leader: ['fixture-guild-001'],
        build_storage_slots: 8
      },
      '/v2/characters': ['Aurelia Ward', 'Sylvari Ranger'],
      '/v2/characters/Aurelia%20Ward': guardian.character,
      '/v2/characters/Sylvari%20Ranger': ranger.character,
      '/v2/account/bank': [
        { id: 1001, count: 1, binding: 'Account' },
        null,
        { id: 2010, count: 2 }
      ],
      '/v2/account/inventory': [{ id: 9002, count: 5 }, null],
      '/v2/account/wallet': [{ id: 1, value: 245000 }, { id: 2, value: 1875 }],
      '/v2/account/achievements': [
        { id: 101, current: 10, max: 10, done: true },
        { id: 102, current: 4, max: 20, done: false }
      ],
      '/v2/achievements/daily': { pve: [{ id: 101 }, { id: 102 }] },
      '/v2/achievements': [
        { id: 101, name: 'Fixture Daily Kryta Vista Viewer' },
        { id: 102, name: 'Fixture Daily Fractal Adept' }
      ],
      '/v2/account/worldbosses': ['fixture_behemoth'],
      '/v2/account/dungeons': ['fixture_ac_story'],
      '/v2/account/dailycrafting': ['fixture_charged_quartz_crystal'],
      '/v2/account/raids': ['fixture_vale_guardian'],
      '/v2/account/mapchests': ['fixture_auric_basin_heros_choice_chest'],
      '/v2/account/materials': [
        { id: 46731, category: 5, count: 250 },
        { id: 19721, category: 6, count: 0 }
      ],
      '/v2/characters/Aurelia%20Ward/inventory': {
        bags: [{ id: 9585, size: 20, inventory: [{ id: 1002, count: 1 }, null, { id: 9002, count: 3 }] }]
      },
      '/v2/characters/Sylvari%20Ranger/inventory': {
        bags: [{ id: 9585, size: 20, inventory: [{ id: 2001, count: 1 }, null] }]
      }
    };
    if (!(path in fixtures)) throw new Gw2ccError('GW2_RESOURCE_NOT_FOUND', `No generic fixture for ${path}.`);
    return fixtures[path] as T;
  }
}
