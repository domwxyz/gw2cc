import type { ResearchDocument } from '@gw2cc/core';

const MAX_LINKS = 30;

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const numeric = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : '';
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function textOnly(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '') || undefined;
}

function resolveLink(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function extractHtmlDocument(input: {
  html: string;
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  maxTextCharacters: number;
  downloadedBytes: number;
  retrievedAt: number;
}): ResearchDocument {
  const base = new URL(input.finalUrl);
  const titleMatch = input.html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const canonicalTag = input.html.match(/<link\b[^>]*\brel\s*=\s*(?:["'][^"']*canonical[^"']*["']|canonical)[^>]*>/i)?.[0];
  const canonical = resolveLink(canonicalTag ? attribute(canonicalTag, 'href') : undefined, base);
  let body = input.html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z0-9]+)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden))[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const links: Array<{ text: string; url: string }> = [];
  body = body.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, (tag) => {
    const url = resolveLink(attribute(tag, 'href'), base);
    const text = textOnly(tag);
    if (url && text && links.length < MAX_LINKS && !links.some((entry) => entry.url === url)) links.push({ text, url });
    return url && text ? ` ${text} (${url}) ` : ` ${text} `;
  });
  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_tag, level: string, content: string) => `\n${'#'.repeat(Number(level))} ${textOnly(content)}\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|article|section|main|li|ul|ol|table|tr|blockquote|pre)\s*>/gi, '\n')
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<[^>]*>/g, ' ');
  let content = decodeEntities(body)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const truncated = content.length > input.maxTextCharacters;
  if (truncated) content = `${content.slice(0, input.maxTextCharacters).trimEnd()}\n\n[Document truncated by GW2CC]`;
  const finalUrl = input.finalUrl;
  const final = new URL(finalUrl);
  const wiki = final.hostname.toLowerCase() === 'wiki.guildwars2.com';
  return {
    trust: 'untrusted_external',
    title: textOnly(titleMatch?.[1] ?? '') || final.pathname.split('/').filter(Boolean).pop() || final.hostname,
    requestedUrl: input.requestedUrl,
    finalUrl,
    ...(canonical ? { canonicalUrl: canonical } : {}),
    domain: final.hostname.toLowerCase(),
    contentType: input.contentType,
    content,
    links,
    extractionMethod: 'direct_html',
    truncated,
    downloadedBytes: input.downloadedBytes,
    provenance: {
      trust: 'untrusted_external',
      sourceKind: wiki ? 'gw2_wiki_page' : 'live_webpage',
      sourceName: wiki ? 'Guild Wars 2 Wiki page' : 'Live webpage',
      url: finalUrl,
      domain: final.hostname.toLowerCase(),
      retrievedAt: input.retrievedAt
    }
  };
}

export function extractTextDocument(input: {
  text: string;
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  maxTextCharacters: number;
  downloadedBytes: number;
  retrievedAt: number;
}): ResearchDocument {
  const url = new URL(input.finalUrl);
  let content = input.text.replace(/\0/g, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = content.length > input.maxTextCharacters;
  if (truncated) content = `${content.slice(0, input.maxTextCharacters).trimEnd()}\n\n[Document truncated by GW2CC]`;
  const wiki = url.hostname.toLowerCase() === 'wiki.guildwars2.com';
  return {
    trust: 'untrusted_external',
    title: url.pathname.split('/').filter(Boolean).pop() || url.hostname,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    domain: url.hostname.toLowerCase(),
    contentType: input.contentType,
    content,
    links: [],
    extractionMethod: 'direct_text',
    truncated,
    downloadedBytes: input.downloadedBytes,
    provenance: {
      trust: 'untrusted_external',
      sourceKind: wiki ? 'gw2_wiki_page' : 'live_webpage',
      sourceName: wiki ? 'Guild Wars 2 Wiki page' : 'Live webpage',
      url: input.finalUrl,
      domain: url.hostname.toLowerCase(),
      retrievedAt: input.retrievedAt
    }
  };
}
