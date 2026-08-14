import type {
  MetaBattleBuildData,
  MetaBattleBuildSections,
  MetaBattleEntityReference,
  MetaBattleSpecialization
} from '@gw2cc/core';

interface ParsedTemplate {
  name: string;
  displayName: string;
  positional: string[];
  named: Record<string, string>;
  start: number;
  end: number;
  depth: number;
}

interface Heading {
  title: string;
  normalizedTitle: string;
  level: number;
  start: number;
  contentStart: number;
  contentEnd: number;
}

const MAX_SECTION_CHARACTERS = 8_000;
const EQUIPMENT_TEMPLATES = new Set(['pve equipment', 'pvp equipment', 'wvw equipment', 'equipment']);
const ITEM_TEMPLATES = new Set(['item', 'amulet', 'ring', 'accessory', 'back item', 'backpiece']);
const KNOWN_TEMPLATES = new Set([
  'build', 'skill bar', 'skill', 'trait', 'specialization', 'rune', 'sigil', 'relic',
  'food', 'utility', 'templatecode', 'template code', 'build template', 'build template code',
  'tooltip', ...EQUIPMENT_TEMPLATES, ...ITEM_TEMPLATES
]);
const TEXT_VALUE_TEMPLATES = new Set([
  'skill', 'trait', 'specialization', 'rune', 'sigil', 'relic', 'food', 'utility',
  'tooltip', ...ITEM_TEMPLATES
]);

function normalizeName(value: string): string {
  return value.replace(/^template\s*:/i, '').replace(/[_\s]+/g, ' ').trim().toLowerCase();
}

function splitTopLevel(value: string, delimiter: '|' | '='): string[] {
  const output: string[] = [];
  let start = 0;
  let templateDepth = 0;
  let linkDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const pair = value.slice(index, index + 2);
    if (pair === '{{') {
      templateDepth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}' && templateDepth > 0) {
      templateDepth -= 1;
      index += 1;
      continue;
    }
    if (pair === '[[') {
      linkDepth += 1;
      index += 1;
      continue;
    }
    if (pair === ']]' && linkDepth > 0) {
      linkDepth -= 1;
      index += 1;
      continue;
    }
    if (value[index] === delimiter && templateDepth === 0 && linkDepth === 0) {
      output.push(value.slice(start, index));
      start = index + 1;
      if (delimiter === '=') return [output[0]!, value.slice(start)];
    }
  }
  output.push(value.slice(start));
  return output;
}

function parseTemplate(raw: string, start: number, end: number, depth: number): ParsedTemplate | undefined {
  const parts = splitTopLevel(raw.slice(2, -2), '|');
  const displayName = (parts.shift() ?? '').replace(/[_\s]+/g, ' ').trim().slice(0, 120);
  const name = normalizeName(displayName);
  if (!name) return undefined;
  const positional: string[] = [];
  const named = Object.create(null) as Record<string, string>;
  for (const part of parts) {
    const assignment = splitTopLevel(part, '=');
    const candidateKey = assignment.length === 2 ? assignment[0]!.trim() : '';
    if (assignment.length === 2 && /^[a-zA-Z0-9 _-]{1,60}$/.test(candidateKey)) {
      named[normalizeName(candidateKey)] = assignment[1]!.trim();
    } else {
      positional.push(part.trim());
    }
  }
  return { name, displayName, positional, named, start, end, depth };
}

export function scanMetaBattleTemplates(wikitext: string): ParsedTemplate[] {
  const stack: number[] = [];
  const output: ParsedTemplate[] = [];
  for (let index = 0; index < wikitext.length - 1; index += 1) {
    const pair = wikitext.slice(index, index + 2);
    if (pair === '{{') {
      stack.push(index);
      index += 1;
    } else if (pair === '}}' && stack.length > 0) {
      const start = stack.pop()!;
      const parsed = parseTemplate(wikitext.slice(start, index + 2), start, index + 2, stack.length);
      if (parsed) output.push(parsed);
      index += 1;
    }
  }
  return output.sort((left, right) => left.start - right.start || right.end - left.end);
}

function topLevelTemplates(value: string): ParsedTemplate[] {
  return scanMetaBattleTemplates(value).filter((template) => template.depth === 0);
}

function renderInline(value: string, depth = 0): string {
  if (depth > 8) return '[nested content omitted]';
  let output = value;
  for (const template of topLevelTemplates(value).sort((left, right) => right.start - left.start)) {
    const primary = TEXT_VALUE_TEMPLATES.has(template.name)
      ? template.positional[0] ?? template.named.name ?? template.named.value ?? template.named.text ?? ''
      : '';
    const replacement = primary ? renderInline(primary, depth + 1) : '';
    output = `${output.slice(0, template.start)}${replacement}${output.slice(template.end)}`;
  }
  return output
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'{2,5}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function renderSection(value: string): string {
  const rendered = renderInline(value)
    .replace(/^={2,6}.*?={2,6}\s*$/gm, '')
    .replace(/^\*+/gm, '- ')
    .replace(/\r/g, '')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return rendered.length > MAX_SECTION_CHARACTERS
    ? `${rendered.slice(0, MAX_SECTION_CHARACTERS).trimEnd()}\n\n[Section truncated by GW2CC]`
    : rendered;
}

function parseHeadings(wikitext: string): Heading[] {
  const raw: Array<Omit<Heading, 'contentEnd'>> = [];
  const pattern = /^(={2,6})\s*(.*?)\s*\1\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(wikitext)) !== null) {
    raw.push({
      title: renderInline(match[2] ?? ''),
      normalizedTitle: normalizeName(match[2] ?? ''),
      level: match[1]!.length,
      start: match.index,
      contentStart: pattern.lastIndex
    });
  }
  return raw.map((heading, index) => {
    const next = raw.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return { ...heading, contentEnd: next?.start ?? wikitext.length };
  });
}

function contextForPosition(headings: Heading[], position: number): string | undefined {
  return [...headings].reverse().find((heading) => heading.contentStart <= position)?.title;
}

function collectSections(wikitext: string, headings: Heading[]): MetaBattleBuildSections {
  const collect = (...names: string[]): string | undefined => {
    const matches = headings.filter((heading) => names.includes(heading.normalizedTitle));
    const content = matches.map((heading) => renderSection(wikitext.slice(heading.contentStart, heading.contentEnd))).filter(Boolean);
    return content.length ? content.join('\n\n---\n\n') : undefined;
  };
  return {
    ...(collect('overview') ? { overview: collect('overview') } : {}),
    ...(collect('usage') ? { usage: collect('usage') } : {}),
    ...(collect('rotation', 'rotations') ? { rotation: collect('rotation', 'rotations') } : {}),
    ...(collect('defense', 'defence') ? { defense: collect('defense', 'defence') } : {}),
    ...(collect('cc', 'crowd control') ? { crowdControl: collect('cc', 'crowd control') } : {}),
    ...(collect('variants', 'variant') ? { variants: collect('variants', 'variant') } : {}),
    ...(collect('notes', 'note') ? { notes: collect('notes', 'note') } : {})
  };
}

function cleaned(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return renderInline(value).replace(/\s+/g, ' ').trim().slice(0, 500) || undefined;
}

function positiveId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function reference(value: string | undefined, template: ParsedTemplate, context?: string): MetaBattleEntityReference | undefined {
  const explicitId = positiveId(template.named.id);
  const candidate = cleaned(value ?? template.named.name);
  const positionalId = positiveId(candidate);
  const name = positionalId === undefined ? candidate : cleaned(template.named.name ?? template.positional[1]);
  const id = explicitId ?? positionalId;
  if (!name && id === undefined) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(id !== undefined ? { id } : {}),
    sourceTemplate: template.displayName,
    ...(context ? { context } : {})
  };
}

function referenceFromValue(value: string | undefined, sourceTemplate: string, context?: string): MetaBattleEntityReference | undefined {
  const name = cleaned(value);
  if (!name) return undefined;
  const id = positiveId(name);
  return {
    ...(id === undefined ? { name } : {}),
    ...(id !== undefined ? { id } : {}),
    sourceTemplate,
    ...(context ? { context } : {})
  };
}

function uniqueReferences(entries: Array<MetaBattleEntityReference | undefined>): MetaBattleEntityReference[] {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (!entry) return [];
    const key = entry.id !== undefined ? `id:${entry.id}` : `name:${entry.name?.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [entry];
  }).slice(0, 200);
}

function commaList(value: string | undefined): string[] {
  return (cleaned(value) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 20);
}

function booleanValue(value: string | undefined): boolean | undefined {
  const normalized = cleaned(value)?.toLowerCase();
  if (['yes', 'true', '1'].includes(normalized ?? '')) return true;
  if (['no', 'false', '0'].includes(normalized ?? '')) return false;
  return undefined;
}

export function parseMetaBattleWikitext(title: string, wikitext: string): {
  build: MetaBattleBuildData;
  sections: MetaBattleBuildSections;
} {
  const templates = scanMetaBattleTemplates(wikitext);
  const headings = parseHeadings(wikitext);
  const topLevel = templates.filter((template) => template.depth === 0);
  const buildTemplate = topLevel.find((template) => template.name === 'build');
  const skillBar = topLevel.find((template) => template.name === 'skill bar');
  const equipmentTemplates = topLevel.filter((template) => EQUIPMENT_TEMPLATES.has(template.name));
  const mainEquipment = equipmentTemplates[0];
  const templateContext = (template: ParsedTemplate) => contextForPosition(headings, template.start);

  const heal = skillBar
    ? referenceFromValue(skillBar.named.healing ?? skillBar.named.heal, skillBar.displayName, 'Skill Bar')
    : undefined;
  const utilities = skillBar
    ? uniqueReferences(Object.entries(skillBar.named)
        .filter(([key]) => /^utilit(?:y|ies)\d*$/.test(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => referenceFromValue(value, skillBar.displayName, 'Skill Bar')))
    : [];
  const elite = skillBar ? referenceFromValue(skillBar.named.elite, skillBar.displayName, 'Skill Bar') : undefined;
  const selectedSkillKeys = new Set([heal, elite, ...utilities].flatMap((entry) => entry?.id !== undefined
    ? [`id:${entry.id}`]
    : entry?.name ? [`name:${entry.name.toLowerCase()}`] : []));
  const mentionedSkills = uniqueReferences(templates.filter((template) => template.name === 'skill').map((template) => (
    reference(template.positional[0], template, templateContext(template))
  ))).filter((entry) => !selectedSkillKeys.has(entry.id !== undefined ? `id:${entry.id}` : `name:${entry.name?.toLowerCase()}`));

  const specializations: MetaBattleSpecialization[] = topLevel
    .filter((template) => template.name === 'specialization')
    .map((template) => {
      const entry = reference(template.positional[0], template, templateContext(template));
      return {
        ...(entry?.name ? { name: entry.name } : {}),
        ...(entry?.id !== undefined ? { id: entry.id } : {}),
        traitChoices: template.positional.slice(1, 4).map((choice) => cleaned(choice)).filter((choice): choice is string => Boolean(choice))
      };
    })
    .filter((entry) => entry.name || entry.id !== undefined)
    .slice(0, 50);
  const mentionedTraits = uniqueReferences(templates.filter((template) => template.name === 'trait').map((template) => (
    reference(template.positional[0], template, templateContext(template))
  )));

  const weapons = uniqueReferences(equipmentTemplates.flatMap((template) => Object.entries(template.named)
    .filter(([key]) => /^weapon\d*$/.test(key))
    .map(([, value]) => referenceFromValue(value, template.displayName, templateContext(template)))));
  const runes = uniqueReferences([
    ...equipmentTemplates.map((template) => referenceFromValue(template.named.rune, template.displayName, templateContext(template))),
    ...templates.filter((template) => template.name === 'rune').map((template) => reference(template.positional[0], template, templateContext(template)))
  ]);
  const sigils = uniqueReferences([
    ...equipmentTemplates.flatMap((template) => Object.entries(template.named).filter(([key]) => /^sigil\d*$/.test(key))
      .map(([, value]) => referenceFromValue(value, template.displayName, templateContext(template)))),
    ...templates.filter((template) => template.name === 'sigil').map((template) => reference(template.positional[0], template, templateContext(template)))
  ]);
  const relics = uniqueReferences([
    ...equipmentTemplates.map((template) => referenceFromValue(template.named.relic, template.displayName, templateContext(template))),
    ...templates.filter((template) => template.name === 'relic').map((template) => reference(template.positional[0], template, templateContext(template)))
  ]);
  const otherItems = uniqueReferences(templates.filter((template) => ITEM_TEMPLATES.has(template.name)).map((template) => (
    reference(template.positional[0], template, templateContext(template))
  )));
  const statOverrides = mainEquipment
    ? Object.entries(mainEquipment.named)
        .filter(([key, value]) => !['stats', 'weight', 'rune', 'rune-qt', 'relic'].includes(key) &&
          !/^weapon\d*$/.test(key) && !/^sigil\d*$/.test(key) && Boolean(cleaned(value)))
        .filter(([key]) => /^(head|shoulders|chest|hands|legs|feet|backpiece|back|accessory\d*|amulet|ring\d*)$/.test(key))
        .map(([slot, stats]) => ({ slot, stats: cleaned(stats)! }))
        .slice(0, 50)
    : [];

  const food = uniqueReferences(templates.filter((template) => template.name === 'food').map((template) => (
    reference(template.positional[0], template, templateContext(template))
  )));
  const utility = uniqueReferences(templates.filter((template) => template.name === 'utility').map((template) => (
    reference(template.positional[0], template, templateContext(template))
  )));
  const codeTemplate = templates.find((template) => ['templatecode', 'template code', 'build template', 'build template code'].includes(template.name));
  const buildTemplateCode = cleaned(codeTemplate?.named.code ?? codeTemplate?.positional.find((value) => value.includes('[&')))
    ?? wikitext.match(/\[&[A-Za-z0-9+/]+={0,2}\]/)?.[0];
  const updatedForPatch = cleaned(buildTemplate?.named['updated for patch'] ?? buildTemplate?.named.patch)
    ?? renderSection(wikitext).match(/up to date for the ([^.\n]+ patch)/i)?.[1];
  const meta = booleanValue(buildTemplate?.named.meta);
  const unrecognizedTemplates = [...new Set(templates.filter((template) => !KNOWN_TEMPLATES.has(template.name))
    .map((template) => template.displayName))].slice(0, 40);

  return {
    build: {
      name: title.replace(/^Build\s*:\s*/i, '').trim(),
      ...(cleaned(buildTemplate?.named.profession ?? skillBar?.named.profession) ? { profession: cleaned(buildTemplate?.named.profession ?? skillBar?.named.profession) } : {}),
      ...(cleaned(buildTemplate?.named.specialization ?? skillBar?.named.specialization) ? { specialization: cleaned(buildTemplate?.named.specialization ?? skillBar?.named.specialization) } : {}),
      modes: commaList(buildTemplate?.named['designed for']),
      focus: commaList(buildTemplate?.named.focus),
      ...(cleaned(buildTemplate?.named.rating) ? { rating: cleaned(buildTemplate?.named.rating) } : {}),
      ...(meta !== undefined ? { meta } : {}),
      ...(cleaned(buildTemplate?.named.xpac ?? buildTemplate?.named.expansion) ? { expansion: cleaned(buildTemplate?.named.xpac ?? buildTemplate?.named.expansion) } : {}),
      ...(cleaned(buildTemplate?.named.difficulty) ? { difficulty: cleaned(buildTemplate?.named.difficulty) } : {}),
      ...(updatedForPatch ? { updatedForPatch } : {}),
      equipment: {
        ...(cleaned(mainEquipment?.named.stats) ? { defaultStats: cleaned(mainEquipment?.named.stats) } : {}),
        ...(cleaned(mainEquipment?.named.weight) ? { weight: cleaned(mainEquipment?.named.weight) } : {}),
        statOverrides,
        weapons,
        runes,
        sigils,
        relics,
        otherItems
      },
      skills: {
        ...(heal ? { heal } : {}),
        utilities,
        ...(elite ? { elite } : {}),
        other: mentionedSkills
      },
      specializations,
      mentionedTraits,
      consumables: { food, utility },
      ...(buildTemplateCode ? { buildTemplateCode } : {}),
      unrecognizedTemplates
    },
    sections: collectSections(wikitext, headings)
  };
}
