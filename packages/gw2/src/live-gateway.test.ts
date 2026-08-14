import { describe, expect, it, vi } from 'vitest';
import type { CachedResource, ResourceCache } from '@gw2cc/core';
import { Gw2HttpClient } from './client';
import { LiveGw2Gateway } from './live-gateway';

class MemoryResourceCache implements ResourceCache {
  private readonly resources = new Map<string, CachedResource>();

  async get<T>(key: string): Promise<CachedResource<T> | null> {
    return (this.resources.get(key) as CachedResource<T> | undefined) ?? null;
  }

  async set<T>(resource: CachedResource<T>): Promise<void> {
    this.resources.set(resource.key, resource);
  }

  async deleteBySource(source: string): Promise<void> {
    for (const [key, resource] of this.resources) {
      if (resource.source === source) this.resources.delete(key);
    }
  }
}

describe('cached public GW2 definition gateway', () => {
  it('caches the specialization index, specialization metadata, and batched trait metadata', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const ids = url.searchParams.get('ids');
      let payload: unknown;
      if (url.pathname === '/v2/specializations' && ids === null) {
        payload = [6];
      } else if (url.pathname === '/v2/specializations') {
        payload = [{
          id: 6,
          name: 'Explosives',
          profession: 'Engineer',
          elite: false,
          major_traits: [110, 121, 132]
        }];
      } else if (url.pathname === '/v2/traits') {
        payload = [
          { id: 110, name: 'Adept Top', specialization: 6, tier: 1, order: 0, slot: 'Major' },
          { id: 121, name: 'Master Middle', specialization: 6, tier: 2, order: 1, slot: 'Major' },
          { id: 132, name: 'Grandmaster Bottom', specialization: 6, tier: 3, order: 2, slot: 'Major' }
        ];
      } else {
        throw new Error(`Unexpected fixture request: ${url.pathname}`);
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const gateway = new LiveGw2Gateway(
      new Gw2HttpClient({ fetch: fetchMock as typeof fetch, maxRetries: 0 }),
      new MemoryResourceCache(),
      () => 1_000
    );

    const firstSpecializations = await gateway.getPublicDefinitions('specializations', undefined);
    const firstTraits = await gateway.getPublicDefinitions('traits', [110, 121, 132]);
    const secondSpecializations = await gateway.getPublicDefinitions('specializations', undefined);
    const secondTraits = await gateway.getPublicDefinitions('traits', [132, 121, 110, 110]);

    expect(firstSpecializations).toEqual([{
      id: 6,
      name: 'Explosives',
      majorTraitIds: [110, 121, 132]
    }]);
    expect(firstTraits).toEqual([
      { id: 110, name: 'Adept Top', specializationId: 6, tier: 1, order: 0 },
      { id: 121, name: 'Master Middle', specializationId: 6, tier: 2, order: 1 },
      { id: 132, name: 'Grandmaster Bottom', specializationId: 6, tier: 3, order: 2 }
    ]);
    expect(secondSpecializations).toEqual(firstSpecializations);
    expect([...secondTraits].sort((left, right) => left.id - right.id)).toEqual(firstTraits);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
