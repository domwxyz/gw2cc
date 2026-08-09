import { safeStorage } from 'electron';
import { Gw2ccError, type SecretKey, type SecretStorageStatus, type SecretStore } from '@gw2cc/core';
import type { SqliteSecretBlobRepository } from '@gw2cc/storage';

export class ElectronSecretStore implements SecretStore {
  constructor(private readonly blobs: SqliteSecretBlobRepository) {}

  async get(key: SecretKey): Promise<string | null> {
    const encrypted = this.blobs.get(key);
    if (!encrypted) return null;
    const available = await safeStorage.isAsyncEncryptionAvailable();
    if (!available) {
      throw new Gw2ccError('SECRET_STORAGE_UNAVAILABLE', 'Protected credential storage is temporarily unavailable.');
    }
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    if (decrypted.shouldReEncrypt) {
      this.blobs.set(key, await safeStorage.encryptStringAsync(decrypted.result));
    }
    return decrypted.result;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    const available = await safeStorage.isAsyncEncryptionAvailable();
    if (!available) {
      throw new Gw2ccError('SECRET_STORAGE_UNAVAILABLE', 'Protected credential storage is unavailable.');
    }
    this.blobs.set(key, await safeStorage.encryptStringAsync(value));
  }

  async delete(key: SecretKey): Promise<void> {
    this.blobs.delete(key);
  }

  async status(key: SecretKey): Promise<SecretStorageStatus> {
    const available = await safeStorage.isAsyncEncryptionAvailable();
    const backend = process.platform === 'linux'
      ? safeStorage.getSelectedStorageBackend()
      : process.platform === 'win32'
        ? 'windows-dpapi'
        : 'os-keychain';
    const weak = process.platform === 'linux' && backend === 'basic_text';
    return {
      configured: this.blobs.has(key),
      available,
      strength: !available ? 'unavailable' : weak ? 'weak' : 'strong',
      backend,
      ...(!available
        ? { message: 'Protected credential storage is not currently available.' }
        : weak
          ? { message: 'This Linux session has no desktop secret service; stored credentials have weaker protection.' }
          : {})
    };
  }
}
