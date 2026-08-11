import {
  Gw2ccError,
  type BuildInspection,
  type CharacterSnapshot,
  type ConnectionProfile,
  type Gw2Gateway,
  type QueryValue,
  type ResourceCache,
  type SkillSelection,
  type SpecializationSelection
} from '@gw2cc/core';
import { z } from 'zod';
import { GW2_SCHEMA_VERSION, Gw2HttpClient } from './client';
import { resolveEquippedItem } from './normalize';
import {
  accountSchema,
  buildTabSchema,
  characterCoreSchema,
  equipmentEndpointSchema,
  equipmentTabSchema,
  itemSchema,
  itemStatSchema,
  skillSchema,
  skinSchema,
  specializationSchema,
  tokenInfoSchema,
  traitSchema,
  type RawBuildTab,
  type RawEquippedRecord
} from './schemas';
import { calculateAttributes, isLandAttributeEquipmentSlot } from './stats';

const PUBLIC_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 200;

export class LiveGw2Gateway implements Gw2Gateway {
  readonly fixtureMode = false;
  private permissions: string[] = [];

  constructor(
    private readonly client: Gw2HttpClient,
    private readonly cache: ResourceCache,
    private readonly now: () => number = () => Date.now()
  ) {}

  async validateKey(apiKey: string): Promise<ConnectionProfile> {
    const [token, account] = await Promise.all([
      this.client.getParsed('/v2/tokeninfo', tokenInfoSchema, apiKey),
      this.client.getParsed('/v2/account', accountSchema, apiKey)
    ]);
    this.permissions = [...token.permissions];
    const characterNames = this.hasPermissions('account', 'characters')
      ? await this.client.getParsed('/v2/characters', z.array(z.string()), apiKey)
      : [];
    return {
      account: {
        id: account.id,
        name: account.name,
        ...(account.world !== undefined ? { worldId: account.world } : {})
      },
      permissions: this.permissions,
      characterNames
    };
  }

  async getCharacterSnapshot(
    apiKey: string,
    characterName: string,
    forceRefresh = false,
    signal?: AbortSignal
  ): Promise<CharacterSnapshot> {
    if (this.permissions.length === 0) {
      const token = await this.client.getParsed('/v2/tokeninfo', tokenInfoSchema, apiKey, {}, signal);
      this.permissions = [...token.permissions];
    }
    if (!this.hasPermissions('account', 'characters')) {
      throw new Gw2ccError(
        'GW2_PERMISSION_MISSING',
        'Character inspection requires the account and characters API key permissions.'
      );
    }

    const encodedName = encodeURIComponent(characterName);
    const core = await this.client.getParsed(
      `/v2/characters/${encodedName}/core`,
      characterCoreSchema,
      apiKey,
      {},
      signal
    );
    const warnings: string[] = [];
    let equipmentName: string | undefined;
    let equipmentRecords: RawEquippedRecord[] = [];
    let buildTab: RawBuildTab | undefined;

    if (this.hasPermissions('account', 'characters', 'builds')) {
      const [equipmentResult, buildResult] = await Promise.allSettled([
        this.client.getParsed(
          `/v2/characters/${encodedName}/equipmenttabs/active`,
          equipmentTabSchema,
          apiKey,
          {},
          signal
        ),
        this.client.getParsed(
          `/v2/characters/${encodedName}/buildtabs/active`,
          buildTabSchema,
          apiKey,
          {},
          signal
        )
      ]);
      if (equipmentResult.status === 'fulfilled') {
        equipmentName = equipmentResult.value.name;
        equipmentRecords = equipmentResult.value.equipment;
      } else {
        warnings.push('The active equipment template could not be loaded.');
      }
      if (buildResult.status === 'fulfilled') {
        buildTab = buildResult.value;
      } else {
        warnings.push('The active build template could not be loaded.');
      }
    } else if (this.hasPermissions('account', 'characters', 'inventories')) {
      try {
        const equipment = await this.client.getParsed(
          `/v2/characters/${encodedName}/equipment`,
          equipmentEndpointSchema,
          apiKey,
          {},
          signal
        );
        equipmentName = 'Equipped items';
        equipmentRecords = equipment.equipment;
        warnings.push('Add the builds permission to inspect the active equipment template and build.');
      } catch {
        warnings.push('Equipment requires the builds or inventories API key permission.');
      }
    } else {
      warnings.push('Equipment and build inspection require the builds API key permission.');
    }

    const itemIds = new Set<number>();
    const attributeItemIds = new Set<number>();
    const skinIds = new Set<number>();
    for (const record of equipmentRecords) {
      itemIds.add(record.id);
      for (const id of record.upgrades ?? []) itemIds.add(id);
      for (const id of record.infusions ?? []) itemIds.add(id);
      if (record.skin !== undefined) skinIds.add(record.skin);

      if (isLandAttributeEquipmentSlot(record.slot)) {
        attributeItemIds.add(record.id);
        for (const id of record.upgrades ?? []) attributeItemIds.add(id);
        for (const id of record.infusions ?? []) attributeItemIds.add(id);
      }
    }
    const [items, skins] = await Promise.all([
      this.loadMany('items', '/v2/items', itemIds, itemSchema, forceRefresh, signal),
      this.loadMany('skins', '/v2/skins', skinIds, skinSchema, forceRefresh, signal)
    ]);
    const statIds = new Set<number>();
    for (const record of equipmentRecords) {
      const item = items.get(record.id);
      const statId = record.stats?.id ?? item?.details?.infix_upgrade?.id;
      if (statId !== undefined) statIds.add(statId);
    }
    const itemStats = await this.loadMany(
      'itemstats',
      '/v2/itemstats',
      statIds,
      itemStatSchema,
      forceRefresh,
      signal
    );

    const missingAttributeItemIds = [...attributeItemIds].filter((id) => !items.has(id));
    const equipment = equipmentRecords.flatMap((record) => {
      const item = items.get(record.id);
      return item ? [resolveEquippedItem(record, item, { itemStats, items, skins })] : [];
    });
    const statBearingTypes = new Set(['Armor', 'Weapon', 'Trinket', 'Back']);
    const unresolvedStats = equipment.some(
      (entry) => isLandAttributeEquipmentSlot(entry.slot)
        && entry.item.level > 0
        && statBearingTypes.has(entry.item.type ?? '')
        && entry.statSource === 'none'
    );
    const omissions: string[] = [];
    if (missingAttributeItemIds.length > 0) {
      omissions.push(`${missingAttributeItemIds.length} attribute-contributing item definition(s) could not be resolved.`);
    }
    if (unresolvedStats) omissions.push('At least one equipped item had no resolvable structured stat data.');

    const build = buildTab
      ? await this.normalizeBuild(buildTab, forceRefresh, signal)
      : undefined;
    const eliteSpecialization = build
      ? [...build.specializations].reverse().find((entry) => entry.elite)?.name
      : undefined;
    const attributes = calculateAttributes({
      level: core.level,
      profession: core.profession,
      equipment,
      omissions,
      unresolved: missingAttributeItemIds.length > 0 || unresolvedStats || attributeItemIds.size === 0
    });

    return {
      character: {
        name: core.name,
        race: core.race,
        ...(core.gender ? { gender: core.gender } : {}),
        profession: core.profession,
        level: core.level,
        ...(core.age !== undefined ? { ageSeconds: core.age } : {}),
        ...(core.deaths !== undefined ? { deaths: core.deaths } : {}),
        ...(core.created ? { created: core.created } : {})
      },
      ...(eliteSpecialization ? { eliteSpecialization } : {}),
      ...(equipmentName ? { equipmentTemplate: equipmentName } : {}),
      equipment,
      ...(build ? { build } : {}),
      attributes,
      warnings,
      loadedAt: this.now()
    };
  }

  async get<T>(apiKey: string | undefined, path: `/v2/${string}`, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
    return this.client.get<T>(path, apiKey, query, signal);
  }

  private hasPermissions(...required: string[]): boolean {
    const permissions = new Set(this.permissions);
    return required.every((permission) => permissions.has(permission));
  }

  private async loadMany<T extends { id: number }>(
    source: string,
    path: `/v2/${string}`,
    ids: ReadonlySet<number>,
    schema: z.ZodType<T>,
    forceRefresh: boolean,
    signal?: AbortSignal
  ): Promise<Map<number, T>> {
    const result = new Map<number, T>();
    const missing: number[] = [];
    const now = this.now();
    for (const id of ids) {
      const key = `${source}:${id}:en:${GW2_SCHEMA_VERSION}`;
      const cached = forceRefresh ? null : await this.cache.get<unknown>(key);
      const parsed = cached && (cached.expiresAt === undefined || cached.expiresAt > now)
        ? schema.safeParse(cached.payload)
        : undefined;
      if (parsed?.success) result.set(id, parsed.data);
      else missing.push(id);
    }

    for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
      const batchIds = missing.slice(offset, offset + BATCH_SIZE);
      const batch = await this.client.getParsed(path, z.array(schema), undefined, { ids: batchIds }, signal);
      for (const resource of batch) {
        result.set(resource.id, resource);
        await this.cache.set({
          key: `${source}:${resource.id}:en:${GW2_SCHEMA_VERSION}`,
          source,
          schemaVersion: GW2_SCHEMA_VERSION,
          payload: resource,
          fetchedAt: now,
          expiresAt: now + PUBLIC_CACHE_TTL_MS
        });
      }
    }
    return result;
  }

  private async normalizeBuild(tab: RawBuildTab, forceRefresh: boolean, signal?: AbortSignal): Promise<BuildInspection> {
    const specializationIds = new Set<number>();
    const traitIds = new Set<number>();
    for (const selected of tab.build.specializations) {
      if (selected.id !== null) specializationIds.add(selected.id);
      for (const id of selected.traits) if (id !== null) traitIds.add(id);
    }
    const skillIds = new Set<number>();
    const collectSkills = (selection: RawBuildTab['build']['skills']) => {
      if (!selection) return;
      if (selection.heal != null) skillIds.add(selection.heal);
      if (selection.elite != null) skillIds.add(selection.elite);
      for (const id of selection.utilities) if (id !== null) skillIds.add(id);
    };
    collectSkills(tab.build.skills);
    collectSkills(tab.build.aquatic_skills);
    const [specializations, traits, skills] = await Promise.all([
      this.loadMany('specializations', '/v2/specializations', specializationIds, specializationSchema, forceRefresh, signal),
      this.loadMany('traits', '/v2/traits', traitIds, traitSchema, forceRefresh, signal),
      this.loadMany('skills', '/v2/skills', skillIds, skillSchema, forceRefresh, signal)
    ]);

    const normalizedSpecializations: SpecializationSelection[] = tab.build.specializations.flatMap((selected) => {
      if (selected.id === null) return [];
      const definition = specializations.get(selected.id);
      if (!definition) return [];
      return [{
        id: definition.id,
        name: definition.name,
        ...(definition.icon ? { icon: definition.icon } : {}),
        ...(definition.background ? { background: definition.background } : {}),
        elite: definition.elite,
        traits: selected.traits.flatMap((traitId) => {
          if (traitId === null) return [];
          const trait = traits.get(traitId);
          return trait ? [{
            id: trait.id,
            name: trait.name,
            ...(trait.icon ? { icon: trait.icon } : {}),
            ...(trait.description ? { description: trait.description } : {}),
            ...(trait.tier !== undefined ? { tier: trait.tier } : {}),
            ...(trait.slot ? { slot: trait.slot } : {})
          }] : [];
        })
      }];
    });
    const normalizeSkill = (id: number | null | undefined): SkillSelection | undefined => {
      if (id == null) return undefined;
      const skill = skills.get(id);
      return skill ? {
        id: skill.id,
        name: skill.name,
        ...(skill.icon ? { icon: skill.icon } : {}),
        ...(skill.description ? { description: skill.description } : {}),
        ...(skill.slot ? { slot: skill.slot } : {})
      } : undefined;
    };
    const normalizeUtilities = (ids: (number | null)[] | undefined): SkillSelection[] =>
      (ids ?? []).flatMap((id) => {
        const skill = normalizeSkill(id);
        return skill ? [skill] : [];
      });

    return {
      tab: tab.tab,
      name: tab.build.name,
      profession: tab.build.profession,
      mode: 'pve',
      specializations: normalizedSpecializations,
      ...(normalizeSkill(tab.build.skills?.heal) ? { heal: normalizeSkill(tab.build.skills?.heal) } : {}),
      utilities: normalizeUtilities(tab.build.skills?.utilities),
      ...(normalizeSkill(tab.build.skills?.elite) ? { elite: normalizeSkill(tab.build.skills?.elite) } : {}),
      aquatic: {
        ...(normalizeSkill(tab.build.aquatic_skills?.heal)
          ? { heal: normalizeSkill(tab.build.aquatic_skills?.heal) }
          : {}),
        utilities: normalizeUtilities(tab.build.aquatic_skills?.utilities),
        ...(normalizeSkill(tab.build.aquatic_skills?.elite)
          ? { elite: normalizeSkill(tab.build.aquatic_skills?.elite) }
          : {})
      }
    };
  }
}
