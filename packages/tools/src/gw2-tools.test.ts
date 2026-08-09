import { describe, expect, it } from 'vitest';
import { InMemorySecretStore, type AccountRepository, type AccountStateRecord, type Gw2Gateway, type QueryValue } from '@gw2cc/core';
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

function executor(gateway: Gw2Gateway = new FixtureGw2Gateway(), accountRepository: AccountRepository = accounts) {
  return new Gw2ToolExecutor(gateway, new InMemorySecretStore('fixture-key', true), accountRepository);
}

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
      'gw2_get_materials',
      'gw2_get_v2'
    ]);
    const result = await tools.execute(
      { id: 'call-1', name: 'gw2_get_character_attributes', arguments: {} },
      { focusedCharacterName: 'Aurelia Ward', signal: new AbortController().signal }
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
      { signal: new AbortController().signal }
    );
    expect(unsafe).toMatchObject({ ok: false, value: { ok: false, error: { code: 'VALIDATION_ERROR' } } });

    const extra = await tools.execute(
      { id: 'call-3', name: 'gw2_get_account', arguments: { apiKey: 'must-not-pass' } },
      { signal: new AbortController().signal }
    );
    expect(extra).toMatchObject({ ok: false, value: { error: { code: 'VALIDATION_ERROR' } } });

    const missing = await tools.execute(
      { id: 'call-4', name: 'gw2_get_character', arguments: { name: 'Not On Account' } },
      { signal: new AbortController().signal }
    );
    expect(missing).toMatchObject({ ok: false, value: { error: { code: 'GW2_RESOURCE_NOT_FOUND' } } });
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
      { signal: new AbortController().signal }
    );
    expect(large).toMatchObject({ ok: true, truncated: true, value: { ok: true, truncation: { truncated: true } } });
    expect(() => JSON.parse(JSON.stringify(large.value))).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await tools.execute(
      { id: 'call-6', name: 'gw2_get_account', arguments: {} },
      { signal: controller.signal }
    );
    expect(cancelled).toMatchObject({ ok: false, value: { error: { code: 'CANCELLED' } } });
  });

  it('normalizes broader account resources, reports feature permissions, and aggregates bounded generic pages', async () => {
    const tools = executor();
    const bank = await tools.execute(
      { id: 'call-bank', name: 'gw2_get_bank', arguments: { limit: 10 } },
      { signal: new AbortController().signal }
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
      { signal: new AbortController().signal }
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
      get: async <T>(_key: string, _path: `/v2/${string}`, query: Record<string, QueryValue> = {}) => {
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
      { signal: new AbortController().signal }
    );
    expect(calls).toBe(2);
    expect(paged).toMatchObject({ value: { data: { pagination: { pagesFetched: 2, complete: true, returned: 3 } } } });
  });
});
