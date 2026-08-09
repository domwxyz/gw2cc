import type { LlmProvider, LlmProviderRegistry, ProviderId } from '@gw2cc/core';

export class StaticLlmProviderRegistry implements LlmProviderRegistry {
  readonly #providers = new Map<ProviderId, LlmProvider>();

  constructor(providers: readonly LlmProvider[]) {
    for (const provider of providers) this.#providers.set(provider.id, provider);
  }

  get(providerId: ProviderId): LlmProvider | undefined {
    return this.#providers.get(providerId);
  }
}
