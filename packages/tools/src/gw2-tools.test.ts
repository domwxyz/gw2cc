import { describe, expect, it, vi } from 'vitest';
import {
  Gw2ccError,
  InMemorySecretStore,
  type AccountRepository,
  type AccountStateRecord,
  type Gw2Gateway,
  type QueryValue,
  type SecretStore
} from '@gw2cc/core';
import { FixtureGw2Gateway } from '@gw2cc/gw2';
import { Gw2ToolExecutor } from './gw2-tools';

const account: AccountStateRecord = {
  account: { id: 'fixture-account-001', name: 'Fixture Commander.1234' },
  permissions: ['account', 'characters', 'builds', 'inventories', 'wallet', 'progression'],
  characterNames: ['Aurelia Ward', 'Sylvari Ranger'],
  selectedCharacterName: 'Aurelia Ward',
  lastConnectedAt: 1
};

const accounts: AccountRepository = {
  getActive: async () => account,
  save: async () => {},
  clearActive: async () => {}
};

function executor(
  gateway: Gw2Gateway = new FixtureGw2Gateway(),
  accountRepository: AccountRepository = accounts,
  secrets: SecretStore = new InMemorySecretStore('fixture-key', true)
) {
  return new Gw2ToolExecutor(gateway, secrets, accountRepository);
}

function mockGateway(routes: Record<string, unknown | Error>): {
  gateway: Gw2Gateway;
  getMock: ReturnType<typeof vi.fn>;
} {
  const fixture = new FixtureGw2Gateway();
  const getMock = vi.fn(async (_key: string | undefined, path: `/v2/${string}`) => {
    const response = routes[path];
    if (response instanceof Error) throw response;
    if (!(path in routes)) throw new Error(`Unexpected mock GW2 route: ${path}`);
    return response;
  });
  const gateway: Gw2Gateway = {
    fixtureMode: true,
    validateKey: (key) => fixture.validateKey(key),
    getCharacterSnapshot: (key, name, refresh, signal) => fixture.getCharacterSnapshot(key, name, refresh, signal),
    get: async <T>(key: string | undefined, path: `/v2/${string}`) => getMock(key, path) as Promise<T>
  };
  return { gateway, getMock };
}

const dailyRoutes: Record<string, unknown> = {
  '/v2/achievements/daily': { pve: [{ id: 101 }, { id: 102 }] },
  '/v2/achievements': [
    { id: 101, name: 'Daily Kryta Vista Viewer' },
    { id: 102, name: 'Daily Fractal Adept' }
  ],
  '/v2/account/achievements': [{ id: 101, current: 1, max: 1, done: true }],
  '/v2/account/worldbosses': ['behemoth'],
  '/v2/account/dungeons': ['ac_story'],
  '/v2/account/dailycrafting': ['charged_quartz_crystal'],
  '/v2/account/raids': ['vale_guardian'],
  '/v2/account/mapchests': ['auric_basin_heros_choice_chest']
};

describe('bounded read-only GW2 tool registry', () => {
  it('registers the complete GW2 tool surface and reuses AttributeReport', async () => {
    const tools = executor();
    expect(tools.definitions().map((tool) => tool.name)).toEqual([
      'gw2_get_account',
      'gw2_list_characters',
      'gw2_get_character',
      'gw2_get_character_equipment',
      'gw2_get_character_build',
      'gw2_get_character_attributes',
      'gw2_get_item',
      'gw2_get_items',
      'gw2_get_bank',
      'gw2_get_shared_inventory',
      'gw2_get_character_inventory',
      'gw2_get_wallet',
      'gw2_get_achievements',
      'gw2_get_daily_status',
      'gw2_get_materials',
      'gw2_get_v2'
    ]);
    expect(tools.definitions().find((tool) => tool.name === 'gw2_get_account')?.description)
      .toContain('progression context');
    expect(tools.definitions().find((tool) => tool.name === 'gw2_get_v2')?.description)
      .toContain('Never tell the user an ArenaNet endpoint is unavailable without attempting it through gw2_get_v2.');
    const result = await tools.execute(
      { id: 'call-1', name: 'gw2_get_character_attributes', arguments: {} },
      { focusedCharacterName: 'Aurelia Ward', timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, data: { source: expect.stringContaining('AttributeReport'), completeness: 'baseline_estimate' } }
    });
  });

  it('rejects unsafe generic paths, unknown characters, and secret-bearing extra arguments as structured tool errors', async () => {
    const tools = executor();
    const unsafe = await tools.execute(
      { id: 'call-2', name: 'gw2_get_v2', arguments: { path: 'https://evil.example/v2/account', query: {} } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(unsafe).toMatchObject({ ok: false, value: { ok: false, error: { code: 'VALIDATION_ERROR' } } });

    const extra = await tools.execute(
      { id: 'call-3', name: 'gw2_get_account', arguments: { apiKey: 'must-not-pass' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(extra).toMatchObject({ ok: false, value: { error: { code: 'VALIDATION_ERROR' } } });

    const missing = await tools.execute(
      { id: 'call-4', name: 'gw2_get_character', arguments: { name: 'Not On Account' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(missing).toMatchObject({ ok: false, value: { error: { code: 'GW2_RESOURCE_NOT_FOUND' } } });
  });

  it('runs public item and generic tools without loading a connected account', async () => {
    const getActive = vi.fn(async () => null);
    const disconnectedAccounts: AccountRepository = {
      getActive,
      save: async () => {},
      clearActive: async () => {}
    };
    const tools = executor(
      new FixtureGw2Gateway(),
      disconnectedAccounts,
      new InMemorySecretStore(null, true)
    );
    const signal = new AbortController().signal;

    const item = await tools.execute(
      { id: 'public-item', name: 'gw2_get_item', arguments: { id: 1001 } },
      { timeZone: 'UTC', signal }
    );
    const items = await tools.execute(
      { id: 'public-items', name: 'gw2_get_items', arguments: { ids: [1001, 1002] } },
      { timeZone: 'UTC', signal }
    );
    const generic = await tools.execute(
      { id: 'public-v2', name: 'gw2_get_v2', arguments: { path: '/v2/items/1001' } },
      { timeZone: 'UTC', signal }
    );

    expect(item).toMatchObject({ ok: true, value: { data: { item: { id: 1001 } } } });
    expect(items).toMatchObject({ ok: true, value: { data: { items: [{ id: 1001 }, { id: 1002 }] } } });
    expect(generic).toMatchObject({ ok: true, value: { data: { result: { id: 1001 } } } });
    expect(getActive).not.toHaveBeenCalled();
  });

  it('keeps account tools protected and reports authenticated generic endpoints when disconnected', async () => {
    const disconnectedAccounts: AccountRepository = {
      getActive: async () => null,
      save: async () => {},
      clearActive: async () => {}
    };
    const tools = executor(
      new FixtureGw2Gateway(),
      disconnectedAccounts,
      new InMemorySecretStore(null, true)
    );
    const signal = new AbortController().signal;

    const accountResult = await tools.execute(
      { id: 'disconnected-account', name: 'gw2_get_account', arguments: {} },
      { timeZone: 'UTC', signal }
    );
    const bankResult = await tools.execute(
      { id: 'disconnected-bank', name: 'gw2_get_bank', arguments: {} },
      { timeZone: 'UTC', signal }
    );
    const genericAccountResult = await tools.execute(
      { id: 'disconnected-v2-account', name: 'gw2_get_v2', arguments: { path: '/v2/account' } },
      { timeZone: 'UTC', signal }
    );

    expect(accountResult).toMatchObject({ ok: false, value: { error: { code: 'GW2_NOT_CONNECTED' } } });
    expect(bankResult).toMatchObject({ ok: false, value: { error: { code: 'GW2_NOT_CONNECTED' } } });
    expect(genericAccountResult).toMatchObject({
      ok: false,
      value: { error: { code: 'GW2_NOT_CONNECTED', message: expect.stringContaining('requires a connected API key') } }
    });
  });

  it('uses a configured API key for generic requests without requiring an active account', async () => {
    const fixture = new FixtureGw2Gateway();
    const getMock = vi.fn(async (key: string | undefined, path: `/v2/${string}`) => {
      if (key !== 'fixture-key' || path !== '/v2/account') throw new Error('Unexpected generic request.');
      return { id: 'account-id' };
    });
    const gateway: Gw2Gateway = {
      fixtureMode: true,
      validateKey: (key) => fixture.validateKey(key),
      getCharacterSnapshot: (key, name, refresh, signal) => fixture.getCharacterSnapshot(key, name, refresh, signal),
      get: async <T>(key: string | undefined, path: `/v2/${string}`) => getMock(key, path) as Promise<T>
    };
    const disconnectedAccounts: AccountRepository = {
      getActive: async () => null,
      save: async () => {},
      clearActive: async () => {}
    };
    const tools = executor(gateway, disconnectedAccounts, new InMemorySecretStore('fixture-key', true));

    const result = await tools.execute(
      { id: 'authenticated-v2', name: 'gw2_get_v2', arguments: { path: '/v2/account' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );

    expect(result).toMatchObject({ ok: true, value: { data: { result: { id: 'account-id' } } } });
    expect(getMock).toHaveBeenCalledWith('fixture-key', '/v2/account');
  });

  it('marks oversized generic results as valid structured truncation and propagates cancellation', async () => {
    const fixture = new FixtureGw2Gateway();
    const oversized: Gw2Gateway = {
      fixtureMode: true,
      validateKey: (key) => fixture.validateKey(key),
      getCharacterSnapshot: (key, name, refresh, signal) => fixture.getCharacterSnapshot(key, name, refresh, signal),
      get: async <T>() => ({ payload: 'x'.repeat(80_000) }) as T
    };
    const tools = executor(oversized);
    const large = await tools.execute(
      { id: 'call-5', name: 'gw2_get_v2', arguments: { path: '/v2/account', query: {} } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(large).toMatchObject({ ok: true, truncated: true, value: { ok: true, truncation: { truncated: true } } });
    expect(() => JSON.parse(JSON.stringify(large.value))).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await tools.execute(
      { id: 'call-6', name: 'gw2_get_account', arguments: {} },
      { timeZone: 'UTC', signal: controller.signal }
    );
    expect(cancelled).toMatchObject({ ok: false, value: { error: { code: 'CANCELLED' } } });
  });

  it('normalizes broader account resources, reports feature permissions, and aggregates bounded generic pages', async () => {
    const tools = executor();
    const bank = await tools.execute(
      { id: 'call-bank', name: 'gw2_get_bank', arguments: { limit: 10 } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(bank).toMatchObject({
      ok: true,
      value: { data: { provenance: { kind: 'arenanet_api', endpoint: '/v2/account/bank' } } }
    });
    expect((bank.value as any).data.entries[0]).toMatchObject({ slot: 0, id: 1001 });

    const restricted: AccountRepository = {
      getActive: async () => ({ ...account, permissions: ['account', 'characters', 'builds'] }),
      save: async () => {},
      clearActive: async () => {}
    };
    const denied = await executor(new FixtureGw2Gateway(), restricted).execute(
      { id: 'call-bank-denied', name: 'gw2_get_bank', arguments: {} },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(denied).toMatchObject({
      ok: false,
      value: { error: { code: 'GW2_PERMISSION_MISSING', details: { feature: 'Account bank', missingPermissions: ['inventories'] } } }
    });

    const fixture = new FixtureGw2Gateway();
    let calls = 0;
    const pagedGateway: Gw2Gateway = {
      fixtureMode: true,
      validateKey: (key) => fixture.validateKey(key),
      getCharacterSnapshot: (key, name, refresh, signal) => fixture.getCharacterSnapshot(key, name, refresh, signal),
      get: async <T>(_key: string | undefined, _path: `/v2/${string}`, query: Record<string, QueryValue> = {}) => {
        calls += 1;
        const page = Number(query.page ?? 0);
        return (page === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }]) as T;
      }
    };
    const paged = await executor(pagedGateway).execute(
      {
        id: 'call-pages',
        name: 'gw2_get_v2',
        arguments: { path: '/v2/commerce/prices', pagination: { mode: 'all', pageSize: 2, maxPages: 3 } }
      },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(calls).toBe(2);
    expect(paged).toMatchObject({ value: { data: { pagination: { pagesFetched: 2, complete: true, returned: 3 } } } });
  });

  it('keeps catalog reads unpaged, exposes explicit page progress, and safely batches rich ID lookups', async () => {
    const fixture = new FixtureGw2Gateway();
    const queries: Array<Record<string, QueryValue>> = [];
    const gateway: Gw2Gateway = {
      fixtureMode: true,
      validateKey: (key) => fixture.validateKey(key),
      getCharacterSnapshot: (key, name, refresh, signal) => fixture.getCharacterSnapshot(key, name, refresh, signal),
      get: async <T>(_key: string | undefined, _path: `/v2/${string}`, query: Record<string, QueryValue> = {}) => {
        queries.push(query);
        if (Array.isArray(query.ids)) return query.ids.map((id) => ({ id, name: `Quest ${id}` })) as T;
        if ('page' in query) return [{ id: Number(query.page) * 100 + 1 }, { id: Number(query.page) * 100 + 2 }] as T;
        return [101, 102, 103] as T;
      }
    };
    const tools = executor(gateway);
    const signal = new AbortController().signal;

    const catalog = await tools.execute(
      { id: 'catalog', name: 'gw2_get_v2', arguments: { path: '/v2/quests' } },
      { timeZone: 'UTC', signal }
    );
    expect(queries[0]).toEqual({});
    expect(catalog).toMatchObject({ value: { data: { result: [101, 102, 103] } } });

    const page = await tools.execute(
      { id: 'page-zero', name: 'gw2_get_v2', arguments: { path: '/v2/quests', pagination: { page: 0 } } },
      { timeZone: 'UTC', signal }
    );
    expect(queries[1]).toMatchObject({ page: 0, page_size: 25 });
    expect(page).toMatchObject({
      value: { data: { pagination: { mode: 'single', page: 0, pageSize: 25, returned: 2, reachedEnd: true } } }
    });

    const ids = Array.from({ length: 30 }, (_, index) => index + 1);
    const batch = await tools.execute(
      { id: 'id-batch', name: 'gw2_get_v2', arguments: { path: '/v2/quests', query: { ids } } },
      { timeZone: 'UTC', signal }
    );
    expect(queries[2]!.ids).toEqual(ids.slice(0, 25));
    expect(batch).toMatchObject({
      value: { data: { batching: { requested: 30, executed: 25, batchPage: 0, remainingIds: ids.slice(25), hasMore: true } } }
    });

    const nextBatch = await tools.execute(
      {
        id: 'id-batch-next',
        name: 'gw2_get_v2',
        arguments: { path: '/v2/quests', query: { ids }, pagination: { page: 1 } }
      },
      { timeZone: 'UTC', signal }
    );
    expect(queries[3]!.ids).toEqual(ids.slice(25));
    expect(nextBatch).toMatchObject({
      value: { data: { batching: { batchPage: 1, skippedBefore: 25, remainingIds: [], hasMore: false } } }
    });

    const all = await tools.execute(
      { id: 'ids-all', name: 'gw2_get_v2', arguments: { path: '/v2/quests', query: { ids: 'all' } } },
      { timeZone: 'UTC', signal }
    );
    expect(queries[4]).toMatchObject({ page: 0, page_size: 25 });
    expect(queries[4]).not.toHaveProperty('ids');
    expect(all).toMatchObject({ value: { data: { pagination: { translatedFromIdsAll: true } } } });
  });

  it('passes through the extended raw account progression fields', async () => {
    const { gateway } = mockGateway({
      '/v2/account': {
        id: 'account-id',
        name: 'Commander.1234',
        world: 1001,
        access: ['GuildWars2', 'HeartOfThorns'],
        fractal_level: 47,
        daily_ap: 15_001,
        monthly_ap: 500,
        commander: true,
        created: '2012-08-25T00:00:00Z',
        age: 4_000_000,
        wvw: { rank: 321, team_id: 11001 },
        guilds: ['guild-one', 'guild-two'],
        guild_leader: ['guild-one'],
        build_storage_slots: 8
      }
    });
    const result = await executor(gateway).execute(
      { id: 'account-progression', name: 'gw2_get_account', arguments: {} },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          provenance: { kind: 'arenanet_api', endpoint: '/v2/account' },
          account: {
            id: 'account-id',
            name: 'Commander.1234',
            worldId: 1001,
            access: ['GuildWars2', 'HeartOfThorns'],
            fractal_level: 47,
            daily_ap: 15_001,
            monthly_ap: 500,
            commander: true,
            created: '2012-08-25T00:00:00Z',
            age: 4_000_000,
            wvw: { rank: 321, team_id: 11001 },
            guilds: ['guild-one', 'guild-two'],
            guild_leader: ['guild-one'],
            build_storage_slots: 8
          }
        }
      }
    });
  });

  it('returns structured section notes for a token with partial permissions', async () => {
    const restricted: AccountRepository = {
      getActive: async () => ({ ...account, permissions: ['account'] }),
      save: async () => {},
      clearActive: async () => {}
    };
    const { gateway, getMock } = mockGateway({ '/v2/achievements/daily': dailyRoutes['/v2/achievements/daily'] });
    const result = await executor(gateway, restricted).execute(
      { id: 'daily-partial-permissions', name: 'gw2_get_daily_status', arguments: {} },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          pve: [],
          worldBossesKilled: [],
          dungeonsCompleted: [],
          dailyCraftingDone: [],
          raidsCleared: [],
          mapChests: []
        }
      }
    });
    const notes = (result.value as any).data.notes;
    expect(notes).toHaveLength(6);
    expect(notes.every((note: any) => note.error.code === 'GW2_PERMISSION_MISSING')).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('marks every named PvE daily incomplete for an empty-progress account', async () => {
    const { gateway } = mockGateway({
      ...dailyRoutes,
      '/v2/account/achievements': [],
      '/v2/account/worldbosses': [],
      '/v2/account/dungeons': [],
      '/v2/account/dailycrafting': [],
      '/v2/account/raids': [],
      '/v2/account/mapchests': []
    });
    const result = await executor(gateway).execute(
      { id: 'daily-empty-progress', name: 'gw2_get_daily_status', arguments: {} },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          pve: [
            { id: 101, name: 'Daily Kryta Vista Viewer', done: false },
            { id: 102, name: 'Daily Fractal Adept', done: false }
          ],
          worldBossesKilled: [],
          dungeonsCompleted: [],
          dailyCraftingDone: [],
          raidsCleared: [],
          mapChests: [],
          notes: []
        }
      }
    });
  });

  it('keeps successful daily sections when one account sub-endpoint fails', async () => {
    const { gateway } = mockGateway({
      ...dailyRoutes,
      '/v2/account/worldbosses': new Gw2ccError(
        'GW2_UPSTREAM_UNAVAILABLE',
        'World boss status is temporarily unavailable.',
        { retryable: true }
      )
    });
    const result = await executor(gateway).execute(
      { id: 'daily-one-failure', name: 'gw2_get_daily_status', arguments: {} },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          pve: [
            { id: 101, name: 'Daily Kryta Vista Viewer', done: true },
            { id: 102, name: 'Daily Fractal Adept', done: false }
          ],
          worldBossesKilled: [],
          dungeonsCompleted: ['ac_story'],
          dailyCraftingDone: ['charged_quartz_crystal'],
          raidsCleared: ['vale_guardian'],
          mapChests: ['auric_basin_heros_choice_chest'],
          notes: [{
            section: 'worldBossesKilled',
            endpoint: '/v2/account/worldbosses',
            error: { code: 'GW2_UPSTREAM_UNAVAILABLE', retryable: true }
          }]
        }
      }
    });
  });
});
