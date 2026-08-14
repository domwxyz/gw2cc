import {
  Gw2ccError,
  type ExternalProvenance,
  type MetaBattleBuildData,
  type MetaBattleBuildResponse,
  type MetaBattleBuildSections,
  type MetaBattleSearchInput,
  type MetaBattleSearchResponse,
  type ResourceCache,
  type ResearchJsonDocument
} from '@gw2cc/core';
import { z } from 'zod';
import { SafePageFetcher } from './fetcher';
import { parseMetaBattleWikitext } from './metabattle-parser';

const METABATTLE_API_URL = 'https://metabattle.com/wiki/api.php';
const METABATTLE_ORIGIN = 'https://metabattle.com';
const METABATTLE_DOMAIN = 'metabattle.com';
const PARSER_VERSION = 'metabattle-wikitext-v1';

const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), info: z.string().optional() }).passthrough()
}).passthrough();

const searchResponseSchema = z.object({
  query: z.object({
    search: z.array(z.object({
      ns: z.number().int(),
      title: z.string(),
      pageid: z.number().int().positive(),
      snippet: z.string().optional(),
      timestamp: z.string().optional()
    }).passthrough())
  }).passthrough()
}).passthrough();

const parseResponseSchema = z.object({
  parse: z.object({
    title: z.string(),
    pageid: z.number().int().positive(),
    revid: z.number().int().positive(),
    wikitext: z.string()
  }).passthrough()
}).passthrough();

interface CachedParsedBuild {
  build: MetaBattleBuildData;
  sections: MetaBattleBuildSections;
}

function apiUrl(parameters: Record<string, string | number>): string {
  const url = new URL(METABATTLE_API_URL);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  return url.toString();
}

export function metaBattlePageUrl(title: string): string {
  return `${METABATTLE_ORIGIN}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function cleanSnippet(value: string | undefined): string {
  return (value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_500);
}

function assertMetaBattleDocument(document: ResearchJsonDocument): void {
  if (new URL(document.finalUrl).origin !== METABATTLE_ORIGIN) {
    throw new Gw2ccError('METABATTLE_API_ERROR', 'MetaBattle redirected its API request to an unexpected origin.');
  }
  if (document.bounding.truncated) {
    throw new Gw2ccError('METABATTLE_API_ERROR', 'The MetaBattle API response exceeded the structured JSON safety limits.');
  }
}

function throwApiError(data: unknown): void {
  const error = apiErrorSchema.safeParse(data);
  if (!error.success) return;
  const code = error.data.error.code;
  if (['missingtitle', 'nosuchpageid', 'invalidtitle'].includes(code)) {
    throw new Gw2ccError('METABATTLE_PAGE_NOT_FOUND', 'The requested MetaBattle page was not found.', {
      details: { apiCode: code }
    });
  }
  throw new Gw2ccError('METABATTLE_API_ERROR', 'MetaBattle returned an API error.', {
    retryable: code === 'readonly' || code === 'maxlag',
    details: { apiCode: code }
  });
}

function provenance(
  sourceKind: ExternalProvenance['sourceKind'],
  sourceName: string,
  url: string,
  retrievedAt: number
): ExternalProvenance {
  return {
    trust: 'untrusted_external',
    sourceKind,
    sourceName,
    url,
    domain: METABATTLE_DOMAIN,
    retrievedAt
  };
}

function isCachedParsedBuild(value: unknown): value is CachedParsedBuild {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CachedParsedBuild>;
  return Boolean(candidate.build && typeof candidate.build === 'object' && candidate.sections && typeof candidate.sections === 'object');
}

export class MetaBattleClient {
  constructor(
    private readonly pages: SafePageFetcher,
    private readonly cache?: ResourceCache
  ) {}

  async search(input: MetaBattleSearchInput, signal?: AbortSignal): Promise<MetaBattleSearchResponse> {
    const document = await this.pages.fetchJson(apiUrl({
      action: 'query',
      list: 'search',
      srsearch: input.query,
      srnamespace: '3000|0|3002',
      srlimit: input.maxResults,
      srprop: 'snippet|timestamp',
      format: 'json',
      formatversion: 2
    }), signal);
    assertMetaBattleDocument(document);
    throwApiError(document.data);
    const parsed = searchResponseSchema.safeParse(document.data);
    if (!parsed.success) {
      throw new Gw2ccError('METABATTLE_API_ERROR', 'MetaBattle returned a malformed search response.');
    }
    const results = parsed.data.query.search.slice(0, input.maxResults).map((entry, index) => {
      const url = metaBattlePageUrl(entry.title);
      return {
        rank: index + 1,
        title: entry.title,
        pageId: entry.pageid,
        url,
        snippet: cleanSnippet(entry.snippet),
        namespace: entry.ns,
        ...(entry.timestamp ? { updatedAt: entry.timestamp } : {}),
        provenance: provenance('metabattle_search_result', 'MetaBattle MediaWiki search result', url, document.retrievedAt)
      };
    });
    return {
      trust: 'untrusted_external',
      source: 'metabattle_search',
      query: input.query,
      results,
      retrievedAt: document.retrievedAt
    };
  }

  async fetchBuild(title: string, signal?: AbortSignal): Promise<MetaBattleBuildResponse> {
    const document = await this.pages.fetchJson(apiUrl({
      action: 'parse',
      page: title,
      prop: 'wikitext|sections|displaytitle|revid',
      format: 'json',
      formatversion: 2
    }), signal);
    assertMetaBattleDocument(document);
    throwApiError(document.data);
    const parsed = parseResponseSchema.safeParse(document.data);
    if (!parsed.success) {
      throw new Gw2ccError('METABATTLE_API_ERROR', 'MetaBattle returned a malformed build-page response.');
    }
    const page = parsed.data.parse;
    const cacheKey = `metabattle:build:${page.pageid}:${PARSER_VERSION}`;
    const cached = await this.cache?.get<unknown>(cacheKey);
    let normalized: CachedParsedBuild;
    if (cached?.schemaVersion === String(page.revid) && isCachedParsedBuild(cached.payload)) {
      normalized = cached.payload;
    } else {
      normalized = parseMetaBattleWikitext(page.title, page.wikitext);
      await this.cache?.set({
        key: cacheKey,
        source: 'metabattle',
        schemaVersion: String(page.revid),
        payload: normalized,
        fetchedAt: document.retrievedAt
      });
    }
    const url = metaBattlePageUrl(page.title);
    const wikitextProvenance = provenance(
      'metabattle_wikitext',
      'MetaBattle MediaWiki build wikitext',
      url,
      document.retrievedAt
    );
    return {
      trust: 'untrusted_external',
      source: {
        title: page.title,
        url,
        pageId: page.pageid,
        revisionId: page.revid,
        retrievedAt: document.retrievedAt,
        provenance: wikitextProvenance
      },
      build: normalized.build,
      sections: normalized.sections,
      provenance: provenance(
        'metabattle_build',
        'GW2CC structured MetaBattle community build',
        url,
        document.retrievedAt
      )
    };
  }
}
