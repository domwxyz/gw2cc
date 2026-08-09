import { Gw2ccError } from './errors';
import type { ResearchGateway, SecretStore } from './ports';
import type {
  ResearchDocument,
  ResearchSearchResponse,
  ResearchSettingsView,
  ResearchTestResult
} from './research-domain';

const GW2_WIKI_DOMAIN = 'wiki.guildwars2.com';

export class ResearchService {
  constructor(
    private readonly gateway: ResearchGateway,
    private readonly secrets: SecretStore
  ) {}

  async getView(): Promise<ResearchSettingsView> {
    const configured = this.gateway.fixtureMode || (await this.secrets.status('tavily-api-key')).configured;
    return {
      credentialConfigured: configured,
      searchAvailable: configured,
      directFetchAvailable: true,
      fixtureMode: this.gateway.fixtureMode,
      message: configured
        ? 'Web search, safe page fetching, and GW2 Wiki research are available.'
        : 'Direct page fetching is available. Add a Tavily key to enable web and GW2 Wiki search.'
    };
  }

  async setCredential(apiKey: string, signal?: AbortSignal): Promise<ResearchSettingsView> {
    if (this.gateway.fixtureMode) return this.getView();
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Gw2ccError('VALIDATION_ERROR', 'Enter a Tavily API key.');
    await this.gateway.search(trimmed, {
      query: 'Guild Wars 2 official website',
      maxResults: 1,
      includeDomains: ['guildwars2.com']
    }, signal);
    await this.secrets.set('tavily-api-key', trimmed);
    return this.getView();
  }

  async clearCredential(): Promise<ResearchSettingsView> {
    if (!this.gateway.fixtureMode) await this.secrets.delete('tavily-api-key');
    return this.getView();
  }

  async test(signal?: AbortSignal): Promise<ResearchTestResult> {
    const result = await this.search('Guild Wars 2 official website', 1, signal);
    return {
      ok: true,
      resultCount: result.results.length,
      message: `Connected to Tavily and received ${result.results.length} bounded search result${result.results.length === 1 ? '' : 's'}.`
    };
  }

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<ResearchSearchResponse> {
    const apiKey = await this.requireTavilyCredential();
    return this.gateway.search(apiKey, { query, maxResults }, signal);
  }

  async searchGw2Wiki(query: string, maxResults: number, signal?: AbortSignal): Promise<ResearchSearchResponse> {
    const apiKey = await this.requireTavilyCredential();
    const result = await this.gateway.search(apiKey, {
      query: `${query} Guild Wars 2 Wiki`,
      maxResults,
      includeDomains: [GW2_WIKI_DOMAIN]
    }, signal);
    return {
      ...result,
      source: 'gw2_wiki_search',
      results: result.results
        .filter((entry) => entry.domain === GW2_WIKI_DOMAIN || entry.domain.endsWith(`.${GW2_WIKI_DOMAIN}`))
        .map((entry) => ({
          ...entry,
          provenance: { ...entry.provenance, sourceKind: 'gw2_wiki_search_snippet', sourceName: 'Guild Wars 2 Wiki search result' }
        }))
    };
  }

  async fetchUrl(url: string, query: string | undefined, signal?: AbortSignal): Promise<ResearchDocument> {
    const tavilyApiKey = this.gateway.fixtureMode ? undefined : await this.secrets.get('tavily-api-key');
    return this.gateway.fetchUrl({ url, ...(query ? { query } : {}) }, { tavilyApiKey: tavilyApiKey ?? undefined }, signal);
  }

  private async requireTavilyCredential(): Promise<string> {
    if (this.gateway.fixtureMode) return '';
    const apiKey = await this.secrets.get('tavily-api-key');
    if (!apiKey) {
      throw new Gw2ccError(
        'WEB_SEARCH_NOT_CONFIGURED',
        'Configure a Tavily API key in Settings before using web or GW2 Wiki search.'
      );
    }
    return apiKey;
  }
}
