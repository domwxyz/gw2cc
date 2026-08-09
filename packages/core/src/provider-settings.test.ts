import { describe, expect, it } from 'vitest';
import type { LlmProvider, SettingsRepository } from './ports';
import type { LlmEvent } from './chat-domain';
import { ProviderSettingsService } from './chat-services';
import { InMemorySecretStore } from './memory';

describe('provider settings and model validation', () => {
  it('stores credentials only in SecretStore and validates the configured model against the provider catalog', async () => {
    const values = new Map<string, unknown>();
    const settings: SettingsRepository = {
      get: async <T>(key: string) => values.get(key) as T ?? null,
      set: async <T>(key: string, value: T) => { values.set(key, value); }
    };
    const secrets = new InMemorySecretStore();
    const provider: LlmProvider = {
      id: 'openrouter',
      listModels: async () => [
        { id: 'model-b' },
        { id: 'model-a', name: 'Model A' },
        { id: 'model-a', name: 'Duplicate Model A' }
      ],
      async *stream(): AsyncIterable<LlmEvent> {
        yield { type: 'completed' };
      }
    };
    const service = new ProviderSettingsService(
      settings,
      secrets,
      { get: (providerId) => providerId === 'openrouter' ? provider : undefined },
      false
    );

    const view = await service.update({
      providerId: 'openrouter',
      model: 'model-a',
      toolsEnabled: true,
      apiKey: 'secret-provider-key'
    });
    expect(view).toMatchObject({ credentialConfigured: true, ready: true });
    expect(JSON.stringify([...values.values()])).not.toContain('secret-provider-key');
    expect(await secrets.get('openrouter-api-key')).toBe('secret-provider-key');
    const validated = await service.test();
    expect(validated).toMatchObject({ ok: true, model: 'model-a' });
    expect(validated.models).toEqual([{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }]);

    await service.update({ providerId: 'openrouter', model: 'missing-model', toolsEnabled: false });
    await expect(service.test()).rejects.toMatchObject({ code: 'LLM_MODEL_NOT_FOUND' });
    expect((await service.getView()).message).toContain('Live GW2 and web retrieval are disabled');
  });
});
