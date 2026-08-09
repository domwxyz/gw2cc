import { lookup as lookupDns, type LookupAddress, type LookupOptions } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import type { DnsResolver } from '@gw2cc/web';

export interface PinnedWebNetworking {
  fetch: typeof globalThis.fetch;
  resolve: DnsResolver;
  destroy(): void;
}

export function createPinnedWebNetworking(): PinnedWebNetworking {
  const approved = new Map<string, LookupAddress[]>();
  const resolve: DnsResolver = async (hostname, signal) => {
    if (signal?.aborted) return [];
    const records = await new Promise<LookupAddress[]>((resolveLookup, reject) => {
      lookupDns(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) reject(error);
        else resolveLookup(addresses);
      });
    });
    if (signal?.aborted) return [];
    approved.set(hostname.toLowerCase(), records);
    return records.flatMap((record) => record.family === 4 || record.family === 6
      ? [{ address: record.address, family: record.family }]
      : []);
  };

  const dispatcher = new Agent({
    connect: {
      lookup: ((hostname: string, options: LookupOptions, callback: (...args: any[]) => void) => {
        const addresses = approved.get(hostname.replace(/\.$/, '').toLowerCase());
        if (!addresses?.length) {
          callback(new Error('The hostname was not approved by GW2CC URL validation.'));
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      }) as typeof lookupDns
    }
  });

  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => (
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
  )) as typeof globalThis.fetch;

  return {
    fetch,
    resolve,
    destroy: () => dispatcher.destroy()
  };
}
