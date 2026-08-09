import type { EquippedItem, ItemAttribute, ItemDefinition, ItemSummary } from '@gw2cc/core';
import type { RawEquippedRecord, RawItem, RawItemStat, RawSkin } from './schemas';
import { attributesFromFormula, normalizeAttributeName } from './stats';

function plainText(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function structuredAttributes(item: RawItem): ItemAttribute[] {
  return (item.details?.infix_upgrade?.attributes ?? []).flatMap((entry) => {
    const attribute = normalizeAttributeName(entry.attribute);
    return attribute ? [{ attribute, value: entry.modifier }] : [];
  });
}

export function normalizeItem(item: RawItem): ItemDefinition {
  return {
    id: item.id,
    name: item.name,
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.rarity ? { rarity: item.rarity } : {}),
    type: item.type,
    ...(item.details?.type ? { subtype: item.details.type } : {}),
    ...(plainText(item.description) ? { description: plainText(item.description) } : {}),
    attributes: structuredAttributes(item),
    level: item.level,
    ...(item.chat_link ? { chatLink: item.chat_link } : {}),
    ...(item.details?.defense !== undefined ? { defense: item.details.defense } : {}),
    ...(item.details?.min_power !== undefined ? { minPower: item.details.min_power } : {}),
    ...(item.details?.max_power !== undefined ? { maxPower: item.details.max_power } : {}),
    ...(item.details?.attribute_adjustment !== undefined
      ? { attributeAdjustment: item.details.attribute_adjustment }
      : {}),
    ...(item.details?.stat_choices ? { statChoices: item.details.stat_choices } : {})
  };
}

export function normalizeUpgrade(item: RawItem): ItemSummary {
  const definition = normalizeItem(item);
  return {
    id: definition.id,
    name: definition.name,
    ...(definition.icon ? { icon: definition.icon } : {}),
    ...(definition.rarity ? { rarity: definition.rarity } : {}),
    ...(definition.type ? { type: definition.type } : {}),
    ...(definition.subtype ? { subtype: definition.subtype } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    attributes: definition.attributes
  };
}

export function normalizeSkin(skin: RawSkin): ItemSummary {
  return {
    id: skin.id,
    name: skin.name,
    ...(skin.icon ? { icon: skin.icon } : {}),
    ...(skin.rarity ? { rarity: skin.rarity } : {}),
    ...(skin.type ? { type: skin.type } : {}),
    ...(plainText(skin.description) ? { description: plainText(skin.description) } : {}),
    attributes: []
  };
}

export function resolveEquippedItem(
  record: RawEquippedRecord,
  item: RawItem,
  resources: {
    itemStats: ReadonlyMap<number, RawItemStat>;
    items: ReadonlyMap<number, RawItem>;
    skins: ReadonlyMap<number, RawSkin>;
  }
): EquippedItem {
  const definition = normalizeItem(item);
  let attributes: ItemAttribute[] = [];
  let statSource: EquippedItem['statSource'] = 'none';
  const selectedAttributes = record.stats?.attributes;
  if (selectedAttributes && Object.keys(selectedAttributes).length > 0) {
    attributes = Object.entries(selectedAttributes).flatMap(([rawName, value]) => {
      const attribute = normalizeAttributeName(rawName);
      return attribute ? [{ attribute, value }] : [];
    });
    statSource = 'selected';
  } else if (definition.attributes.length > 0) {
    attributes = definition.attributes;
    statSource = 'fixed';
  } else {
    const statId = record.stats?.id ?? item.details?.infix_upgrade?.id;
    const stat = statId === undefined ? undefined : resources.itemStats.get(statId);
    if (stat && definition.attributeAdjustment !== undefined) {
      attributes = attributesFromFormula(definition.attributeAdjustment, stat);
      statSource = attributes.length > 0 ? 'formula' : 'none';
    }
  }
  const statId = record.stats?.id ?? item.details?.infix_upgrade?.id;
  const statName = statId === undefined ? undefined : resources.itemStats.get(statId)?.name;
  const skin = record.skin === undefined ? undefined : resources.skins.get(record.skin);

  return {
    slot: record.slot ?? 'Unknown',
    itemId: record.id,
    item: definition,
    ...(skin ? { skin: normalizeSkin(skin) } : {}),
    ...(statId !== undefined ? { statId } : {}),
    ...(statName ? { statName } : {}),
    statSource,
    attributes,
    upgrades: (record.upgrades ?? []).flatMap((id) => {
      const upgrade = resources.items.get(id);
      return upgrade ? [normalizeUpgrade(upgrade)] : [];
    }),
    infusions: (record.infusions ?? []).flatMap((id) => {
      const infusion = resources.items.get(id);
      return infusion ? [normalizeUpgrade(infusion)] : [];
    }),
    ...(record.binding ? { binding: record.binding } : {}),
    ...(record.bound_to ? { boundTo: record.bound_to } : {}),
    ...(record.location ? { location: record.location } : {})
  };
}
