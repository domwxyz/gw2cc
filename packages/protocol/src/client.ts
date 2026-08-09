import { Gw2ccError } from '@gw2cc/core';
import {
  parseCommandOutput,
  responseEnvelopeSchema,
  type CommandInput,
  type CommandMap,
  type CommandName,
  type CommandOutput
} from './commands';
import { parseGw2ccEvent } from './events';
import type { Gw2ccEvent } from '@gw2cc/core';

export interface ProtocolTransport {
  invoke(request: { command: CommandName; input: unknown }): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}

export interface Gw2ccClient {
  request<T extends CommandName>(command: T, input: CommandInput<T>): Promise<CommandOutput<T>>;
  subscribe(listener: (event: Gw2ccEvent) => void): () => void;
}

export function createGw2ccClient(transport: ProtocolTransport): Gw2ccClient {
  return {
    async request<T extends keyof CommandMap>(command: T, input: CommandInput<T>): Promise<CommandOutput<T>> {
      const raw = await transport.invoke({ command, input });
      const response = responseEnvelopeSchema.parse(raw);
      if (!response.ok) {
        throw new Gw2ccError(response.error.code, response.error.message, {
          retryable: response.error.retryable,
          ...(response.error.details ? { details: response.error.details } : {})
        });
      }
      return parseCommandOutput(command, response.output);
    },
    subscribe(listener: (event: Gw2ccEvent) => void): () => void {
      if (!transport.subscribe) return () => {};
      return transport.subscribe((event) => listener(parseGw2ccEvent(event)));
    }
  };
}
