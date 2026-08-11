import { describe, expect, it, vi } from 'vitest';
import {
  Gw2ccError,
  InMemorySecretStore,
  type AccountRepository
} from '@gw2cc/core';
import {
  FixtureGw2EventTimerGateway,
  FixtureGw2Gateway,
  type Gw2EventTimerGateway
} from '@gw2cc/gw2';
import { CompositeToolExecutor } from './composite';
import { Gw2EventTimerToolExecutor } from './event-timer-tools';
import { Gw2ToolExecutor } from './gw2-tools';

describe('gw2_get_event_timers tool', () => {
  const clock = { now: () => Date.parse('2026-08-11T00:10:00Z') };

  it('publishes the bounded public contract and applies defaults', async () => {
    const executor = new Gw2EventTimerToolExecutor(new FixtureGw2EventTimerGateway(clock));
    const definition = executor.definitions()[0]!;
    expect(definition).toMatchObject({
      name: 'gw2_get_event_timers',
      inputSchema: {
        additionalProperties: false,
        properties: {
          windowMinutes: { minimum: 15, maximum: 1_440, default: 180 },
          filter: { maxLength: 200 },
          includeActive: { default: true },
          limit: { maximum: 100, default: 40 }
        }
      }
    });
    expect(definition.description).toContain('without a GW2 API key');
    expect(definition.description).toContain('not live map-instance state');
    expect(definition.description).toContain('not ArenaNet /v2/ event data');
    expect(definition.inputSchema).not.toHaveProperty('properties.timeZone');

    const result = await executor.execute(
      { id: 'timers', name: 'gw2_get_event_timers', arguments: { filter: 'Octovine' } },
      { timeZone: 'America/Chicago', signal: new AbortController().signal }
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        data: {
          generatedAt: '2026-08-11T00:10:00.000Z',
          windowMinutes: 180,
          timeZone: 'America/Chicago',
          source: { kind: 'gw2_wiki_event_timer', stale: false },
          events: expect.arrayContaining([
            expect.objectContaining({
              event: 'Octovine',
              status: 'upcoming',
              startsAt: '2026-08-11T01:00:00.000Z',
              startsAtLocal: '2026-08-10T20:00:00-05:00',
              endsAt: '2026-08-11T01:20:00.000Z',
              endsAtLocal: '2026-08-10T20:20:00-05:00',
              startsInMinutes: 50
            })
          ])
        }
      },
      truncated: false
    });
  });

  it('localizes fixture active events from injected context while preserving UTC and relative fields', async () => {
    const executor = new Gw2EventTimerToolExecutor(new FixtureGw2EventTimerGateway(clock));
    const result = await executor.execute(
      { id: 'active-fixture', name: 'gw2_get_event_timers', arguments: { filter: 'Pylons', limit: 1 } },
      { timeZone: 'America/Chicago', signal: new AbortController().signal }
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          timeZone: 'America/Chicago',
          events: [{
            status: 'active',
            startedAt: '2026-08-10T23:30:00.000Z',
            startedAtLocal: '2026-08-10T18:30:00-05:00',
            endsAt: '2026-08-11T00:45:00.000Z',
            endsAtLocal: '2026-08-10T19:45:00-05:00',
            remainingMinutes: 35
          }]
        }
      }
    });
  });

  it('formats spring DST transitions through the IANA timezone without a fixed offset', async () => {
    const dstGateway: Gw2EventTimerGateway = {
      fixtureMode: true,
      getEventTimers: async (input) => ({
        generatedAt: '2026-03-08T07:00:00.000Z',
        windowMinutes: input.windowMinutes,
        source: {
          kind: 'gw2_wiki_event_timer',
          page: 'Widget:Event timer/data.json',
          revisionId: 1,
          revisionTimestamp: '2026-01-01T00:00:00Z',
          revisionSha1: '1111111111111111111111111111111111111111',
          dataVersion: 'dst-fixture',
          fetchedAt: '2026-03-08T07:00:00.000Z',
          stale: false
        },
        events: [{
          timerId: 'dst-test',
          category: 'Fixture',
          map: 'Clock Test',
          event: 'DST transition',
          status: 'upcoming',
          startsAt: '2026-03-08T07:30:00.000Z',
          endsAt: '2026-03-08T08:30:00.000Z',
          startsInMinutes: 30,
          durationMinutes: 60
        }]
      })
    };
    const result = await new Gw2EventTimerToolExecutor(dstGateway).execute(
      { id: 'dst', name: 'gw2_get_event_timers', arguments: {} },
      { timeZone: 'America/Chicago', signal: new AbortController().signal }
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          timeZone: 'America/Chicago',
          events: [{
            startsAt: '2026-03-08T07:30:00.000Z',
            startsAtLocal: '2026-03-08T01:30:00-06:00',
            endsAt: '2026-03-08T08:30:00.000Z',
            endsAtLocal: '2026-03-08T03:30:00-05:00',
            startsInMinutes: 30
          }]
        }
      }
    });
  });

  it('requires no GW2 API key or active account and registers through CompositeToolExecutor', async () => {
    const getActive = vi.fn(async () => null);
    const accounts: AccountRepository = {
      getActive,
      save: async () => {},
      clearActive: async () => {}
    };
    const composite = new CompositeToolExecutor([
      new Gw2ToolExecutor(new FixtureGw2Gateway(), new InMemorySecretStore(null, true), accounts),
      new Gw2EventTimerToolExecutor(new FixtureGw2EventTimerGateway(clock))
    ]);

    expect(composite.definitions().map((definition) => definition.name)).toContain('gw2_get_event_timers');
    const result = await composite.execute(
      { id: 'public-timers', name: 'gw2_get_event_timers', arguments: { filter: 'Auric Basin', limit: 2 } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(result).toMatchObject({ ok: true, value: { data: { events: expect.any(Array) } } });
    expect(getActive).not.toHaveBeenCalled();
  });

  it('returns structured validation, cancellation, and timeout errors', async () => {
    const fixtureExecutor = new Gw2EventTimerToolExecutor(new FixtureGw2EventTimerGateway(clock));
    const invalid = await fixtureExecutor.execute(
      {
        id: 'invalid-timers',
        name: 'gw2_get_event_timers',
        arguments: { windowMinutes: 14, filter: 'x'.repeat(201), apiKey: 'never' }
      },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(invalid).toMatchObject({ ok: false, value: { error: { code: 'VALIDATION_ERROR' } } });

    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelled = await fixtureExecutor.execute(
      { id: 'cancelled-timers', name: 'gw2_get_event_timers', arguments: {} },
      { timeZone: 'UTC', signal: cancelledController.signal }
    );
    expect(cancelled).toMatchObject({ ok: false, value: { error: { code: 'CANCELLED' } } });

    const hangingGateway: Gw2EventTimerGateway = {
      fixtureMode: false,
      getEventTimers: async (_input, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(
          new Gw2ccError('CANCELLED', 'underlying request cancelled')
        ), { once: true });
      })
    };
    const timeout = await new Gw2EventTimerToolExecutor(hangingGateway, 5).execute(
      { id: 'timeout-timers', name: 'gw2_get_event_timers', arguments: {} },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(timeout).toMatchObject({
      ok: false,
      value: { error: { code: 'GW2_UPSTREAM_UNAVAILABLE', message: expect.stringMatching(/timed out/i) } }
    });
  });
});
