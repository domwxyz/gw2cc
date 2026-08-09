import type { Gw2ccErrorCode, Gw2ccErrorPayload } from './domain';

export class Gw2ccError extends Error {
  readonly code: Gw2ccErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: Gw2ccErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'Gw2ccError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toErrorPayload(error: unknown): Gw2ccErrorPayload {
  if (error instanceof Gw2ccError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {})
    };
  }

  return {
    code: 'GW2_UPSTREAM_UNAVAILABLE',
    message: 'An unexpected application error occurred.',
    retryable: true
  };
}
