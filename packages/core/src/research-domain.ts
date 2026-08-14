export type ExternalSourceKind =
  | 'tavily_search_snippet'
  | 'gw2_wiki_search_snippet'
  | 'live_webpage'
  | 'gw2_wiki_page'
  | 'live_json'
  | 'metabattle_search_result'
  | 'metabattle_wikitext'
  | 'metabattle_build';

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

export interface ResearchJsonFetchInput {
  url: string;
}

export type ResearchJsonValue =
  | null
  | boolean
  | number
  | string
  | ResearchJsonValue[]
  | { [key: string]: ResearchJsonValue };

export interface ResearchJsonDocument {
  trust: 'untrusted_external';
  requestedUrl: string;
  finalUrl: string;
  domain: string;
  contentType: string;
  data: ResearchJsonValue;
  downloadedBytes: number;
  retrievedAt: number;
  bounding: {
    truncated: boolean;
    maxDepth: number;
    maxArrayEntries: number;
    maxObjectEntries: number;
    maxStringCharacters: number;
    maxNodes: number;
  };
  provenance: ExternalProvenance;
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

export interface MetaBattleSearchInput {
  query: string;
  maxResults: number;
}

export interface MetaBattleSearchResult {
  rank: number;
  title: string;
  pageId: number;
  url: string;
  snippet: string;
  namespace: number;
  updatedAt?: string;
  provenance: ExternalProvenance;
}

export interface MetaBattleSearchResponse {
  trust: 'untrusted_external';
  source: 'metabattle_search';
  query: string;
  results: MetaBattleSearchResult[];
  retrievedAt: number;
}

export interface MetaBattleEntityReference {
  name?: string;
  id?: number;
  sourceTemplate: string;
  context?: string;
}

export interface MetaBattleSpecialization {
  name?: string;
  id?: number;
  traitChoices: string[];
}

export interface MetaBattleBuildData {
  name: string;
  profession?: string;
  specialization?: string;
  modes: string[];
  focus: string[];
  rating?: string;
  meta?: boolean;
  expansion?: string;
  difficulty?: string;
  updatedForPatch?: string;
  equipment: {
    defaultStats?: string;
    weight?: string;
    statOverrides: Array<{ slot: string; stats: string }>;
    weapons: MetaBattleEntityReference[];
    runes: MetaBattleEntityReference[];
    sigils: MetaBattleEntityReference[];
    relics: MetaBattleEntityReference[];
    otherItems: MetaBattleEntityReference[];
  };
  skills: {
    heal?: MetaBattleEntityReference;
    utilities: MetaBattleEntityReference[];
    elite?: MetaBattleEntityReference;
    other: MetaBattleEntityReference[];
  };
  specializations: MetaBattleSpecialization[];
  mentionedTraits: MetaBattleEntityReference[];
  consumables: {
    food: MetaBattleEntityReference[];
    utility: MetaBattleEntityReference[];
  };
  buildTemplateCode?: string;
  unrecognizedTemplates: string[];
}

export interface MetaBattleBuildSections {
  overview?: string;
  usage?: string;
  rotation?: string;
  defense?: string;
  crowdControl?: string;
  variants?: string;
  notes?: string;
}

export interface MetaBattleBuildResponse {
  trust: 'untrusted_external';
  source: {
    title: string;
    url: string;
    pageId: number;
    revisionId: number;
    retrievedAt: number;
    provenance: ExternalProvenance;
  };
  build: MetaBattleBuildData;
  sections: MetaBattleBuildSections;
  provenance: ExternalProvenance;
}

export interface ResearchSettingsView {
  credentialConfigured: boolean;
  searchAvailable: boolean;
  directFetchAvailable: true;
  jsonFetchAvailable: true;
  metaBattleAvailable: true;
  fixtureMode: boolean;
  message: string;
}

export interface ResearchTestResult {
  ok: true;
  resultCount: number;
  message: string;
}
