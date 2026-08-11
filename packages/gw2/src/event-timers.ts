import {
  Gw2ccError,
  type Clock,
  type ResourceCache
} from '@gw2cc/core';
import { z } from 'zod';

export const GW2_WIKI_EVENT_TIMER_PAGE = 'Widget:Event timer/data.json';
export const GW2_WIKI_API_ORIGIN = 'https://wiki.guildwars2.com';
export const GW2_WIKI_USER_AGENT = 'GW2CC/0.1.0 (+https://github.com/domwxyz/gw2cc)';
export const GW2_WIKI_EVENT_TIMER_CACHE_KEY = 'gw2-wiki-event-timer:recipe:v1';
export const GW2_WIKI_EVENT_TIMER_CACHE_SOURCE = 'gw2-wiki-event-timer';
export const GW2_WIKI_EVENT_TIMER_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

const sequenceEntrySchema = z.object({
  r: z.number().int().min(0).max(10_000),
  d: z.number().int().min(1).max(DAY_MINUTES)
}).strict();

const timerSegmentSchema = z.object({
  name: z.string().max(500),
  link: z.string().max(1_000).optional(),
  chatlink: z.string().max(100).optional(),
  bg: z.unknown().optional()
}).passthrough();

const timerDefinitionSchema = z.object({
  category: z.string().max(500),
  name: z.string().max(500),
  link: z.string().max(1_000).optional(),
  segments: z.record(z.string().regex(/^\d+$/), timerSegmentSchema),
  sequences: z.object({
    partial: z.array(sequenceEntrySchema).max(500),
    pattern: z.array(sequenceEntrySchema).max(500)
  }).strict()
}).passthrough();

const timerRecipeSchema = z.object({
  config: z.object({
    version: z.string().trim().min(1).max(100)
  }).passthrough(),
  events: z.record(z.string().trim().min(1).max(200), timerDefinitionSchema)
}).passthrough();

const revisionTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'Revision timestamp must be a valid date-time.'
);

const revisionSha1Schema = z.string().regex(/^[a-f\d]{40}$/i);

const mediaWikiResponseSchema = z.object({
  query: z.object({
    pages: z.array(z.object({
      title: z.literal(GW2_WIKI_EVENT_TIMER_PAGE),
      revisions: z.array(z.object({
        revid: z.number().int().positive(),
        timestamp: revisionTimestampSchema,
        sha1: revisionSha1Schema,
        slots: z.object({
          main: z.object({
            content: z.string().min(1).max(900_000)
          }).passthrough()
        }).passthrough()
      }).passthrough()).length(1)
    }).passthrough()).length(1)
  }).passthrough()
}).passthrough();

const cachedRecipeSchema = z.object({
  page: z.literal(GW2_WIKI_EVENT_TIMER_PAGE),
  revisionId: z.number().int().positive(),
  revisionTimestamp: revisionTimestampSchema,
  revisionSha1: revisionSha1Schema,
  recipe: timerRecipeSchema
}).strict();

export type Gw2EventTimerRecipe = z.infer<typeof timerRecipeSchema>;
export type Gw2EventTimerDefinition = z.infer<typeof timerDefinitionSchema>;
export type Gw2EventTimerSegment = z.infer<typeof timerSegmentSchema>;

export interface WikiEventTimerRecipeDocument {
  page: typeof GW2_WIKI_EVENT_TIMER_PAGE;
  revisionId: number;
  revisionTimestamp: string;
  revisionSha1: string;
  recipe: Gw2EventTimerRecipe;
}

export interface Gw2EventTimerQuery {
  windowMinutes: number;
  filter?: string;
  includeActive: boolean;
  limit: number;
}

export interface Gw2EventTimerSource {
  kind: 'gw2_wiki_event_timer';
  page: typeof GW2_WIKI_EVENT_TIMER_PAGE;
  revisionId: number;
  revisionTimestamp: string;
  revisionSha1: string;
  dataVersion: string;
  fetchedAt: string;
  stale: boolean;
}

export interface Gw2EventTimerOccurrence {
  timerId: string;
  category: string;
  map: string;
  event: string;
  status: 'active' | 'upcoming';
  endsAt: string;
  durationMinutes: number;
  chatLink?: string;
  wikiPage?: string;
  startedAt?: string;
  remainingMinutes?: number;
  startsAt?: string;
  startsInMinutes?: number;
}

export interface Gw2EventTimerResult {
  generatedAt: string;
  windowMinutes: number;
  source: Gw2EventTimerSource;
  events: Gw2EventTimerOccurrence[];
}

export interface Gw2EventTimerGateway {
  readonly fixtureMode: boolean;
  getEventTimers(input: Gw2EventTimerQuery, signal?: AbortSignal): Promise<Gw2EventTimerResult>;
}

export interface WikiEventTimerRecipeClient {
  fetchRecipe(signal?: AbortSignal): Promise<WikiEventTimerRecipeDocument>;
}

function timerRecipeError(message: string, details?: Record<string, unknown>): Gw2ccError {
  return new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', message, {
    retryable: true,
    ...(details ? { details } : {})
  });
}

function validateTimerRecipe(recipe: Gw2EventTimerRecipe): Gw2EventTimerRecipe {
  const timers = Object.entries(recipe.events);
  if (timers.length === 0 || timers.length > 200) {
    throw timerRecipeError('The Guild Wars 2 Wiki timer dataset has an invalid timer count.');
  }

  for (const [timerId, timer] of timers) {
    const segmentIds = Object.keys(timer.segments);
    if (segmentIds.length === 0 || segmentIds.length > 500) {
      throw timerRecipeError('The Guild Wars 2 Wiki timer dataset has an invalid segment count.', { timerId });
    }
    for (const entry of [...timer.sequences.partial, ...timer.sequences.pattern]) {
      if (!Object.hasOwn(timer.segments, String(entry.r))) {
        throw timerRecipeError('The Guild Wars 2 Wiki timer dataset references a missing segment.', {
          timerId,
          missingSegment: entry.r
        });
      }
    }
    const partialMinutes = timer.sequences.partial.reduce((total, entry) => total + entry.d, 0);
    const patternMinutes = timer.sequences.pattern.reduce((total, entry) => total + entry.d, 0);
    if (partialMinutes < DAY_MINUTES && patternMinutes === 0) {
      throw timerRecipeError('The Guild Wars 2 Wiki timer dataset contains a schedule that cannot cover a UTC day.', {
        timerId,
        partialMinutes
      });
    }
  }
  return recipe;
}

function parseRecipe(value: unknown): Gw2EventTimerRecipe {
  const parsed = timerRecipeSchema.safeParse(value);
  if (!parsed.success) {
    throw timerRecipeError('The Guild Wars 2 Wiki returned a malformed timer recipe.', {
      issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message)
    });
  }
  return validateTimerRecipe(parsed.data);
}

function validateRecipeDocument(value: unknown): WikiEventTimerRecipeDocument {
  const parsed = cachedRecipeSchema.safeParse(value);
  if (!parsed.success) {
    throw timerRecipeError('The Guild Wars 2 Wiki timer revision metadata or recipe was malformed.', {
      issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message)
    });
  }
  return {
    ...parsed.data,
    recipe: validateTimerRecipe(parsed.data.recipe)
  };
}

export function parseWikiEventTimerResponse(value: unknown): WikiEventTimerRecipeDocument {
  const response = mediaWikiResponseSchema.safeParse(value);
  if (!response.success) {
    throw timerRecipeError('The Guild Wars 2 Wiki returned an unexpected MediaWiki response.', {
      issues: response.error.issues.slice(0, 5).map((issue) => issue.message)
    });
  }
  const revision = response.data.query.pages[0]!.revisions[0]!;
  let rawRecipe: unknown;
  try {
    rawRecipe = JSON.parse(revision.slots.main.content);
  } catch (error) {
    throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'The Guild Wars 2 Wiki timer revision contains malformed JSON.', {
      retryable: true,
      cause: error
    });
  }
  return {
    page: GW2_WIKI_EVENT_TIMER_PAGE,
    revisionId: revision.revid,
    revisionTimestamp: revision.timestamp,
    revisionSha1: revision.sha1,
    recipe: parseRecipe(rawRecipe)
  };
}

function createWikiEventTimerUrl(): URL {
  const url = new URL('/api.php', GW2_WIKI_API_ORIGIN);
  url.searchParams.set('action', 'query');
  url.searchParams.set('prop', 'revisions');
  url.searchParams.set('titles', GW2_WIKI_EVENT_TIMER_PAGE);
  url.searchParams.set('rvprop', 'ids|timestamp|sha1|content');
  url.searchParams.set('rvslots', 'main');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('format', 'json');
  return url;
}

export interface WikiEventTimerClientOptions {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class WikiEventTimerClient implements WikiEventTimerRecipeClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: WikiEventTimerClientOptions) {
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 250;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 2_000;
    this.sleep = options.sleep ?? ((milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Gw2ccError('CANCELLED', 'The Guild Wars 2 Wiki timer request was cancelled.'));
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Gw2ccError('CANCELLED', 'The Guild Wars 2 Wiki timer request was cancelled.'));
      }, { once: true });
    }));
  }

  async fetchRecipe(signal?: AbortSignal): Promise<WikiEventTimerRecipeDocument> {
    const url = createWikiEventTimerUrl();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'User-Agent': GW2_WIKI_USER_AGENT,
              'Api-User-Agent': GW2_WIKI_USER_AGENT
            },
            redirect: 'error',
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (attempt < this.maxRetries) {
            await this.waitForRetry(attempt, undefined, controller.signal);
            continue;
          }
          throw error;
        }

        if (!response.ok) {
          if (this.isTransientStatus(response.status) && attempt < this.maxRetries) {
            const retryAfter = response.headers.get('retry-after') ?? undefined;
            void response.body?.cancel();
            await this.waitForRetry(attempt, retryAfter, controller.signal);
            continue;
          }
          await this.throwForResponse(response);
        }

        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
          void response.body?.cancel();
          throw timerRecipeError('The Guild Wars 2 Wiki timer response exceeded the configured size limit.');
        }
        const bytes = await this.readBounded(response.body, controller.signal);
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
          throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'The Guild Wars 2 Wiki returned malformed JSON.', {
            retryable: true,
            cause: error
          });
        }
        return parseWikiEventTimerResponse(value);
      }
      throw timerRecipeError('The Guild Wars 2 Wiki timer request exhausted its retry limit.');
    } catch (error) {
      if (signal?.aborted) {
        throw new Gw2ccError('CANCELLED', 'The Guild Wars 2 Wiki timer request was cancelled.');
      }
      if (timedOut) {
        throw timerRecipeError('The Guild Wars 2 Wiki timer request timed out.');
      }
      if (error instanceof Gw2ccError) throw error;
      throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'Could not reach the Guild Wars 2 Wiki timer API.', {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private isTransientStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private async throwForResponse(response: Response): Promise<never> {
    void response.body?.cancel();
    if (response.status === 403) {
      throw new Gw2ccError(
        'GW2_UPSTREAM_UNAVAILABLE',
        'The Guild Wars 2 Wiki timer API denied access to the request (HTTP 403).',
        { retryable: false, details: { status: response.status } }
      );
    }
    if (response.status === 429) {
      throw new Gw2ccError('GW2_RATE_LIMITED', 'The Guild Wars 2 Wiki rate-limited the timer request after bounded retries.', {
        retryable: true,
        details: { status: response.status }
      });
    }
    throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', `The Guild Wars 2 Wiki timer API returned HTTP ${response.status}.`, {
      retryable: this.isTransientStatus(response.status),
      details: { status: response.status }
    });
  }

  private async waitForRetry(attempt: number, retryAfter: string | undefined, signal: AbortSignal): Promise<void> {
    let delay = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** attempt));
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        delay = Math.min(this.maxRetryDelayMs, seconds * 1_000);
      } else {
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) delay = Math.min(this.maxRetryDelayMs, Math.max(0, retryAt - Date.now()));
      }
    }
    await this.sleep(delay, signal);
  }

  private async readBounded(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
    if (!body) throw timerRecipeError('The Guild Wars 2 Wiki timer API returned an empty response body.');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Gw2ccError('CANCELLED', 'The Guild Wars 2 Wiki timer request was cancelled.');
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw timerRecipeError('The Guild Wars 2 Wiki timer response exceeded the configured size limit.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

interface LoadedRecipe {
  document: WikiEventTimerRecipeDocument;
  fetchedAt: number;
  stale: boolean;
}

interface RawOccurrence {
  timerId: string;
  category: string;
  map: string;
  segment: Gw2EventTimerSegment;
  segmentId: number;
  wikiPage?: string;
  startsAt: number;
  endsAt: number;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function appendScheduleEntry(
  output: RawOccurrence[],
  timerId: string,
  timer: Gw2EventTimerDefinition,
  segmentId: number,
  startsAt: number,
  endsAt: number
): void {
  const segment = timer.segments[String(segmentId)]!;
  const previous = output.at(-1);
  if (previous &&
      previous.timerId === timerId &&
      previous.segmentId === segmentId &&
      previous.endsAt === startsAt) {
    previous.endsAt = endsAt;
    return;
  }
  output.push({
    timerId,
    category: timer.category.trim(),
    map: timer.name.trim(),
    segment,
    segmentId,
    ...(segment.link?.trim()
      ? { wikiPage: segment.link.trim() }
      : timer.link?.trim()
        ? { wikiPage: timer.link.trim() }
        : {}),
    startsAt,
    endsAt
  });
}

function materializeTimerDay(
  output: RawOccurrence[],
  timerId: string,
  timer: Gw2EventTimerDefinition,
  dayStart: number
): void {
  const dayEnd = dayStart + DAY_MS;
  let cursor = dayStart;
  for (const entry of timer.sequences.partial) {
    if (cursor >= dayEnd) break;
    const end = Math.min(dayEnd, cursor + entry.d * MINUTE_MS);
    appendScheduleEntry(output, timerId, timer, entry.r, cursor, end);
    cursor = end;
  }
  while (cursor < dayEnd) {
    for (const entry of timer.sequences.pattern) {
      if (cursor >= dayEnd) break;
      const end = Math.min(dayEnd, cursor + entry.d * MINUTE_MS);
      appendScheduleEntry(output, timerId, timer, entry.r, cursor, end);
      cursor = end;
    }
  }
}

function normalizeOccurrence(raw: RawOccurrence, now: number): Gw2EventTimerOccurrence {
  const segment = raw.segment;
  const base = {
    timerId: raw.timerId,
    category: raw.category,
    map: raw.map,
    event: segment.name.trim(),
    endsAt: new Date(raw.endsAt).toISOString(),
    durationMinutes: (raw.endsAt - raw.startsAt) / MINUTE_MS,
    ...(segment.chatlink?.trim() ? { chatLink: segment.chatlink.trim() } : {}),
    ...(raw.wikiPage ? { wikiPage: raw.wikiPage } : {})
  };
  if (raw.startsAt <= now && raw.endsAt > now) {
    return {
      ...base,
      status: 'active',
      startedAt: new Date(raw.startsAt).toISOString(),
      remainingMinutes: Math.ceil((raw.endsAt - now) / MINUTE_MS)
    };
  }
  return {
    ...base,
    status: 'upcoming',
    startsAt: new Date(raw.startsAt).toISOString(),
    startsInMinutes: Math.ceil((raw.startsAt - now) / MINUTE_MS)
  };
}

export function expandGw2EventTimerSchedule(
  recipe: Gw2EventTimerRecipe,
  now: number,
  input: Gw2EventTimerQuery
): Gw2EventTimerOccurrence[] {
  if (!Number.isFinite(now)) throw new Gw2ccError('VALIDATION_ERROR', 'The event timer clock is invalid.');
  const windowEnd = now + input.windowMinutes * MINUTE_MS;
  const firstDay = utcDayStart(now) - DAY_MS;
  const lastDay = utcDayStart(windowEnd) + DAY_MS;
  const raw: RawOccurrence[] = [];

  for (const [timerId, timer] of Object.entries(recipe.events)) {
    const timerOccurrences: RawOccurrence[] = [];
    for (let day = firstDay; day <= lastDay; day += DAY_MS) {
      materializeTimerDay(timerOccurrences, timerId, timer, day);
    }
    raw.push(...timerOccurrences);
  }

  const filter = input.filter?.trim().toLocaleLowerCase('en-US');
  return raw
    .filter((occurrence) => occurrence.segmentId !== 0 && occurrence.segment.name.trim().length > 0)
    .filter((occurrence) => {
      const active = occurrence.startsAt <= now && occurrence.endsAt > now;
      const upcoming = occurrence.startsAt > now && occurrence.startsAt <= windowEnd;
      return (input.includeActive && active) || upcoming;
    })
    .filter((occurrence) => !filter || [
      occurrence.segment.name,
      occurrence.map,
      occurrence.category,
      occurrence.timerId,
      occurrence.wikiPage ?? ''
    ].some((value) => value.toLocaleLowerCase('en-US').includes(filter)))
    .sort((left, right) => (
      left.startsAt - right.startsAt ||
      left.timerId.localeCompare(right.timerId) ||
      left.segment.name.localeCompare(right.segment.name)
    ))
    .slice(0, input.limit)
    .map((occurrence) => normalizeOccurrence(occurrence, now));
}

function createResult(loaded: LoadedRecipe, now: number, input: Gw2EventTimerQuery): Gw2EventTimerResult {
  return {
    generatedAt: new Date(now).toISOString(),
    windowMinutes: input.windowMinutes,
    source: {
      kind: 'gw2_wiki_event_timer',
      page: GW2_WIKI_EVENT_TIMER_PAGE,
      revisionId: loaded.document.revisionId,
      revisionTimestamp: loaded.document.revisionTimestamp,
      revisionSha1: loaded.document.revisionSha1,
      dataVersion: loaded.document.recipe.config.version,
      fetchedAt: new Date(loaded.fetchedAt).toISOString(),
      stale: loaded.stale
    },
    events: expandGw2EventTimerSchedule(loaded.document.recipe, now, input)
  };
}

export class LiveGw2EventTimerGateway implements Gw2EventTimerGateway {
  readonly fixtureMode = false;

  constructor(
    private readonly client: WikiEventTimerRecipeClient,
    private readonly cache: ResourceCache,
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly cacheTtlMs = GW2_WIKI_EVENT_TIMER_CACHE_TTL_MS
  ) {}

  async getEventTimers(input: Gw2EventTimerQuery, signal?: AbortSignal): Promise<Gw2EventTimerResult> {
    if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'The Guild Wars 2 event timer request was cancelled.');
    const loaded = await this.loadRecipe(signal);
    const now = this.clock.now();
    return createResult(loaded, now, input);
  }

  private async loadRecipe(signal?: AbortSignal): Promise<LoadedRecipe> {
    const cached = await this.cache.get<unknown>(GW2_WIKI_EVENT_TIMER_CACHE_KEY);
    let validCached: WikiEventTimerRecipeDocument | undefined;
    if (cached) {
      try {
        validCached = validateRecipeDocument(cached.payload);
      } catch {
        validCached = undefined;
      }
    }
    const checkedAt = this.clock.now();
    if (cached && validCached && cached.expiresAt !== undefined && cached.expiresAt > checkedAt) {
      return { document: validCached, fetchedAt: cached.fetchedAt, stale: false };
    }

    try {
      const document = validateRecipeDocument(await this.client.fetchRecipe(signal));
      const fetchedAt = this.clock.now();
      await this.cache.set({
        key: GW2_WIKI_EVENT_TIMER_CACHE_KEY,
        source: GW2_WIKI_EVENT_TIMER_CACHE_SOURCE,
        schemaVersion: document.recipe.config.version,
        payload: document,
        fetchedAt,
        expiresAt: fetchedAt + this.cacheTtlMs
      });
      return { document, fetchedAt, stale: false };
    } catch (error) {
      if (signal?.aborted || (error instanceof Gw2ccError && error.code === 'CANCELLED')) throw error;
      if (cached && validCached) {
        return { document: validCached, fetchedAt: cached.fetchedAt, stale: true };
      }
      throw error;
    }
  }
}

const FIXTURE_RECIPE = parseRecipe({
  config: { version: 'fixture-v1' },
  events: {
    'hot-ab': {
      category: 'Heart of Thorns',
      name: 'Auric Basin',
      segments: {
        1: { name: 'Pylons', link: 'Defending Tarir', chatlink: '[&BN0HAAA=]' },
        2: { name: 'Challenges', link: 'Battle in Tarir', chatlink: '[&BGwIAAA=]' },
        3: { name: 'Octovine', link: 'Battle in Tarir', chatlink: '[&BAIIAAA=]' },
        4: { name: 'Reset', link: "A Moment's Rest" }
      },
      sequences: {
        partial: [{ r: 1, d: 45 }, { r: 2, d: 15 }, { r: 3, d: 20 }, { r: 4, d: 10 }],
        pattern: [{ r: 1, d: 75 }, { r: 2, d: 15 }, { r: 3, d: 20 }, { r: 4, d: 10 }]
      }
    },
    'public-eotn': {
      category: 'Public Instances',
      name: 'Eye of the North',
      segments: {
        0: { name: '' },
        1: { name: 'Twisted Marionette', link: 'The Twisted Marionette', chatlink: '[&BAkMAAA=]' },
        2: { name: "Battle For Lion's Arch", link: "The Battle For Lion's Arch", chatlink: '[&BAkMAAA=]' },
        3: { name: 'Dragonstorm', link: 'Dragonstorm', chatlink: '[&BAkMAAA=]' },
        4: { name: 'Tower of Nightmares', link: 'The Tower of Nightmares (meta event)', chatlink: '[&BAkMAAA=]' }
      },
      sequences: {
        partial: [],
        pattern: [
          { r: 1, d: 20 }, { r: 0, d: 10 }, { r: 2, d: 15 }, { r: 0, d: 15 },
          { r: 3, d: 20 }, { r: 0, d: 10 }, { r: 4, d: 15 }, { r: 0, d: 15 }
        ]
      }
    }
  }
});

export class FixtureGw2EventTimerGateway implements Gw2EventTimerGateway {
  readonly fixtureMode = true;

  constructor(private readonly clock: Clock = { now: () => Date.now() }) {}

  async getEventTimers(input: Gw2EventTimerQuery, signal?: AbortSignal): Promise<Gw2EventTimerResult> {
    if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'Fixture Guild Wars 2 event timers were cancelled.');
    const now = this.clock.now();
    return createResult({
      document: {
        page: GW2_WIKI_EVENT_TIMER_PAGE,
        revisionId: 3_000_001,
        revisionTimestamp: '2026-01-01T00:00:00Z',
        revisionSha1: '1111111111111111111111111111111111111111',
        recipe: FIXTURE_RECIPE
      },
      fetchedAt: now,
      stale: false
    }, now, input);
  }
}
