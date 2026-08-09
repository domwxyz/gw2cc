export type ExternalSourceKind =
  | 'tavily_search_snippet'
  | 'gw2_wiki_search_snippet'
  | 'live_webpage'
  | 'gw2_wiki_page';

export interface ExternalProvenance {
  trust: 'untrusted_external';
  sourceKind: ExternalSourceKind;
  sourceName: string;
  url: string;
  domain: string;
  retrievedAt: number;
}

export interface ResearchSearchInput {
  query: string;
  maxResults: number;
  includeDomains?: string[];
}

export interface ResearchSearchResult {
  rank: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  score?: number;
  publishedDate?: string;
  provenance: ExternalProvenance;
}

export interface ResearchSearchResponse {
  trust: 'untrusted_external';
  source: 'tavily_search' | 'gw2_wiki_search';
  query: string;
  results: ResearchSearchResult[];
  retrievedAt: number;
}

export interface ResearchFetchInput {
  url: string;
  query?: string;
}

export interface ResearchDocument {
  trust: 'untrusted_external';
  title: string;
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  domain: string;
  contentType: string;
  content: string;
  links: Array<{ text: string; url: string }>;
  extractionMethod: 'direct_html' | 'direct_text' | 'tavily_extract' | 'fixture';
  truncated: boolean;
  downloadedBytes?: number;
  provenance: ExternalProvenance;
}

export interface ResearchSettingsView {
  credentialConfigured: boolean;
  searchAvailable: boolean;
  directFetchAvailable: true;
  fixtureMode: boolean;
  message: string;
}

export interface ResearchTestResult {
  ok: true;
  resultCount: number;
  message: string;
}
