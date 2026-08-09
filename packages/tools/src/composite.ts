import {
  type LlmToolCall,
  type LlmToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolExecutor
} from '@gw2cc/core';

export class CompositeToolExecutor implements ToolExecutor {
  readonly #definitions: LlmToolDefinition[] = [];
  readonly #owners = new Map<string, ToolExecutor>();

  constructor(executors: readonly ToolExecutor[]) {
    for (const executor of executors) {
      for (const definition of executor.definitions()) {
        if (this.#owners.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
        this.#definitions.push(definition);
        this.#owners.set(definition.name, executor);
      }
    }
  }

  definitions(): readonly LlmToolDefinition[] {
    return this.#definitions;
  }

  execute(call: LlmToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const owner = this.#owners.get(call.name);
    if (!owner) {
      return Promise.resolve({
        ok: false,
        value: {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Unknown read-only tool: ${call.name}`,
            retryable: false
          }
        },
        summary: `Unknown read-only tool: ${call.name}`,
        truncated: false
      });
    }
    return owner.execute(call, context);
  }
}
