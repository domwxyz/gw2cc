import {
  Gw2ccError,
  type MetaBattleBuildResponse,
  type MetaBattleSearchInput,
  type MetaBattleSearchResponse,
  type ResearchDocument,
  type ResearchFetchInput,
  type ResearchGateway,
  type ResearchJsonDocument,
  type ResearchJsonFetchInput,
  type ResearchSearchInput,
  type ResearchSearchResponse
} from '@gw2cc/core';
import { SafePageFetcher } from './fetcher';
import { MetaBattleClient } from './metabattle';
import { TavilyClient } from './tavily';

const MAX_EXTERNAL_CONTENT = 36_000;

function safeExternalUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

export class LiveResearchGateway implements ResearchGateway {
  readonly fixtureMode = false;
  private readonly metabattle: MetaBattleClient;

  constructor(
    private readonly tavily: TavilyClient,
    private readonly pages: SafePageFetcher,
    private readonly now: () => number = () => Date.now(),
    metabattle?: MetaBattleClient
  ) {
    this.metabattle = metabattle ?? new MetaBattleClient(pages);
  }

  async search(apiKey: string, input: ResearchSearchInput, signal?: AbortSignal): Promise<ResearchSearchResponse> {
    const response = await this.tavily.search(apiKey, input, signal);
    const retrievedAt = this.now();
    const results = response.results.flatMap((entry, index) => {
      const url = safeExternalUrl(entry.url);
      if (!url) return [];
      const snippet = entry.content.replace(/\s+/g, ' ').trim().slice(0, 2_500);
      return [{
        rank: index + 1,
        title: entry.title.trim().slice(0, 500),
        url: url.toString(),
        domain: url.hostname.toLowerCase(),
        snippet,
        ...(entry.score !== undefined ? { score: entry.score } : {}),
        ...(entry.published_date ? { publishedDate: entry.published_date } : {}),
        provenance: {
          trust: 'untrusted_external' as const,
          sourceKind: 'tavily_search_snippet' as const,
          sourceName: 'Tavily search-result snippet',
          url: url.toString(),
          domain: url.hostname.toLowerCase(),
          retrievedAt
        }
      }];
    });
    return {
      trust: 'untrusted_external',
      source: 'tavily_search',
      query: response.query,
      results,
      retrievedAt
    };
  }

  async fetchUrl(
    input: ResearchFetchInput,
    options: { tavilyApiKey?: string },
    signal?: AbortSignal
  ): Promise<ResearchDocument> {
    try {
      return await this.pages.fetch(input.url, signal);
    } catch (error) {
      if (!(error instanceof Gw2ccError) ||
          error.code === 'WEB_FETCH_BLOCKED' ||
          error.code === 'WEB_CONTENT_UNSUPPORTED' ||
          error.code === 'WEB_RATE_LIMITED' ||
          error.code === 'CANCELLED' ||
          !options.tavilyApiKey) throw error;
      const safe = await this.pages.validate(input.url, signal);
      const extracted = await this.tavily.extract(options.tavilyApiKey, safe.toString(), input.query, signal);
      const first = extracted.results[0];
      if (!first) throw error;
      const candidateUrl = safeExternalUrl(first.url);
      const resultUrl = candidateUrl?.origin === safe.origin ? candidateUrl : safe;
      let content = first.raw_content.replace(/\0/g, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
      const truncated = content.length > MAX_EXTERNAL_CONTENT;
      if (truncated) content = `${content.slice(0, MAX_EXTERNAL_CONTENT).trimEnd()}\n\n[Document truncated by GW2CC]`;
      const wiki = resultUrl.hostname.toLowerCase() === 'wiki.guildwars2.com';
      return {
        trust: 'untrusted_external',
        title: resultUrl.pathname.split('/').filter(Boolean).pop() || resultUrl.hostname,
        requestedUrl: input.url,
        finalUrl: resultUrl.toString(),
        domain: resultUrl.hostname.toLowerCase(),
        contentType: 'text/markdown',
        content,
        links: [],
        extractionMethod: 'tavily_extract',
        truncated,
        provenance: {
          trust: 'untrusted_external',
          sourceKind: wiki ? 'gw2_wiki_page' : 'live_webpage',
          sourceName: wiki ? 'Guild Wars 2 Wiki page via Tavily Extract' : 'Live webpage via Tavily Extract',
          url: resultUrl.toString(),
          domain: resultUrl.hostname.toLowerCase(),
          retrievedAt: this.now()
        }
      };
    }
  }

  fetchJson(input: ResearchJsonFetchInput, signal?: AbortSignal): Promise<ResearchJsonDocument> {
    return this.pages.fetchJson(input.url, signal);
  }

  searchMetaBattle(input: MetaBattleSearchInput, signal?: AbortSignal): Promise<MetaBattleSearchResponse> {
    return this.metabattle.search(input, signal);
  }

  fetchMetaBattleBuild(title: string, signal?: AbortSignal): Promise<MetaBattleBuildResponse> {
    return this.metabattle.fetchBuild(title, signal);
  }
}
