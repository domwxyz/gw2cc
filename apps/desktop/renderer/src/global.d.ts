import type { Gw2ccClient } from '@gw2cc/protocol';

declare global {
  interface Window {
    gw2cc: Gw2ccClient;
  }
}

export {};

