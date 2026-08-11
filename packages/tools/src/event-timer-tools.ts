import {
  Gw2ccError,
  toErrorPayload,
  type LlmToolCall,
  type LlmToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolExecutor
} from '@gw2cc/core';
import type {
  Gw2EventTimerGateway,
  Gw2EventTimerOccurrence,
  Gw2EventTimerResult
} from '@gw2cc/gw2';
import { z } from 'zod';
import { boundToolResult } from './results';

const DEFAULT_TOOL_TIMEOUT_MS = 20_000;

interface LocalTimeFormatter {
  timeZone: string;
  format(timestamp: string): string;
}

function createLocalTimeFormatter(timeZone: string): LocalTimeFormatter {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
  } catch (error) {
    throw new Gw2ccError('VALIDATION_ERROR', 'The application event-timer timezone is invalid.', {
      details: { timeZone },
      cause: error
    });
  }
  const resolvedTimeZone = formatter.resolvedOptions().timeZone;
  return {
    timeZone: resolvedTimeZone,
    format(timestamp: string): string {
      const instant = Date.parse(timestamp);
      if (!Number.isFinite(instant)) {
        throw new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'An event timer occurrence contained an invalid UTC timestamp.');
      }
      const values = Object.fromEntries(
        formatter.formatToParts(instant)
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, part.value])
      );
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const second = Number(values.second);
      const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
      const offsetMinutes = Math.round((localAsUtc - instant) / 60_000);
      const sign = offsetMinutes >= 0 ? '+' : '-';
      const absoluteOffset = Math.abs(offsetMinutes);
      const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
      const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');
      return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${sign}${offsetHours}:${offsetRemainder}`;
    }
  };
}

function localizeOccurrence(
  occurrence: Gw2EventTimerOccurrence,
  formatter: LocalTimeFormatter
): Gw2EventTimerOccurrence & {
  endsAtLocal: string;
  startsAtLocal?: string;
  startedAtLocal?: string;
} {
  return {
    ...occurrence,
    endsAtLocal: formatter.format(occurrence.endsAt),
    ...(occurrence.startsAt ? { startsAtLocal: formatter.format(occurrence.startsAt) } : {}),
    ...(occurrence.startedAt ? { startedAtLocal: formatter.format(occurrence.startedAt) } : {})
  };
}

function localizeResult(result: Gw2EventTimerResult, timeZone: string): Gw2EventTimerResult & {
  timeZone: string;
  events: Array<ReturnType<typeof localizeOccurrence>>;
} {
  const formatter = createLocalTimeFormatter(timeZone);
  return {
    ...result,
    timeZone: formatter.timeZone,
    events: result.events.map((occurrence) => localizeOccurrence(occurrence, formatter))
  };
}

const eventTimerInputSchema = z.object({
  windowMinutes: z.number().int().min(15).max(1_440).default(180),
  filter: z.string().trim().max(200).optional(),
  includeActive: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(40)
}).strict();

const DEFINITIONS: readonly LlmToolDefinition[] = [{
  name: 'gw2_get_event_timers',
  description: 'Get current and upcoming deterministic scheduled Guild Wars 2 events derived directly from the validated Guild Wars 2 Wiki timer dataset. This public, account-independent tool works without a GW2 API key. It calculates concrete UTC occurrences in the application and includes local timestamps in the application-provided IANA timezone; results are not live map-instance state and are not ArenaNet /v2/ event data.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      windowMinutes: {
        type: 'integer',
        minimum: 15,
        maximum: 1_440,
        default: 180,
        description: 'Upcoming time window in minutes.'
      },
      filter: {
        type: 'string',
        maxLength: 200,
        description: 'Case-insensitive event, map/timer, category, timer ID, or Wiki-page filter.'
      },
      includeActive: {
        type: 'boolean',
        default: true,
        description: 'Include scheduled occurrences active at the generated time.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 40
      }
    }
  }
}];

export class Gw2EventTimerToolExecutor implements ToolExecutor {
  constructor(
    private readonly gateway: Gw2EventTimerGateway,
    private readonly timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
  ) {}

  definitions(): readonly LlmToolDefinition[] {
    return DEFINITIONS;
  }

  async execute(call: LlmToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      if (call.name !== 'gw2_get_event_timers') {
        throw new Gw2ccError('VALIDATION_ERROR', `Unknown Guild Wars 2 event timer tool: ${call.name}`);
      }
      if (controller.signal.aborted) throw new Gw2ccError('CANCELLED', 'Guild Wars 2 event timers were cancelled.');
      const input = eventTimerInputSchema.parse(call.arguments);
      const result = await this.gateway.getEventTimers(input, controller.signal);
      const localizedResult = localizeResult(result, context.timeZone);
      return boundToolResult(
        localizedResult,
        `Loaded ${result.events.length} scheduled Guild Wars 2 event${result.events.length === 1 ? '' : 's'}`
      );
    } catch (error) {
      const payload = context.signal.aborted
        ? { code: 'CANCELLED' as const, message: 'Guild Wars 2 event timers were cancelled.', retryable: false }
        : timedOut
          ? {
              code: 'GW2_UPSTREAM_UNAVAILABLE' as const,
              message: 'The Guild Wars 2 event timer tool timed out.',
              retryable: true
            }
          : error instanceof z.ZodError
            ? {
                code: 'VALIDATION_ERROR' as const,
                message: 'The Guild Wars 2 event timer arguments were invalid.',
                retryable: false,
                details: { issues: error.issues.slice(0, 5).map((issue) => issue.message) }
              }
            : toErrorPayload(error);
      return {
        ok: false,
        value: { ok: false, error: payload },
        summary: payload.message,
        truncated: false
      };
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
    }
  }
}
