import type { SecretStorageStatus } from './domain';
import type { SecretKey, SecretStore } from './ports';

export class InMemorySecretStore implements SecretStore {
  readonly #values = new Map<SecretKey, string>();
  readonly #fixture: boolean;

  constructor(initialValue: string | null = null, fixture = false) {
    if (initialValue !== null) this.#values.set('gw2-api-key', initialValue);
    this.#fixture = fixture;
  }

  async get(key: SecretKey): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.#values.set(key, value);
  }

  async delete(key: SecretKey): Promise<void> {
    this.#values.delete(key);
  }

  async status(key: SecretKey): Promise<SecretStorageStatus> {
    return {
      configured: this.#values.has(key),
      available: true,
      strength: 'strong',
      backend: this.#fixture ? 'fixture-memory' : 'memory'
    };
  }
}
