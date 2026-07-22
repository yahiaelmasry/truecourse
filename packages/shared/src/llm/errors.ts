export class LlmSessionLimitError extends Error {
  readonly code = 'LLM_SESSION_LIMIT' as const;
  readonly statusCode = 429;

  constructor(readonly resetHint?: string) {
    super(
      resetHint
        ? `Claude session limit reached; resets ${resetHint}. Wait until the limit resets before retrying.`
        : 'Claude session limit reached. Wait until the limit resets before retrying.',
    );
    this.name = 'LlmSessionLimitError';
  }
}

interface ClaudeErrorEnvelope {
  is_error?: unknown;
  api_error_status?: unknown;
  result?: unknown;
}

const SESSION_LIMIT_PATTERN = /\byou(?:['’]ve)\s+hit\s+your\s+session\s+limit\b/i;
const RESET_HINT_PATTERN = /(?:^|[·—-]\s*|\s+)resets?\s+(.+?)\s*$/i;
const WRAPPED_CLAUDE_429_PATTERN = /\bclaude\s+api\s+error\s*\(\s*api\s+429\s*\)\s*:\s*(.+)$/i;
const CERTIFIABLE_RESET_HINT_PATTERN = /^(tomorrow )?([1-9]|1[0-2])(?::([0-5]\d))?(am|pm) \(([A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+)\)$/;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_CERTIFIED_RESET_DELAY_MS = 49 * HOUR_MS;

function asClaudeEnvelope(value: unknown): ClaudeErrorEnvelope | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value.trim());
      return asClaudeEnvelope(parsed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  return value as ClaudeErrorEnvelope;
}

/**
 * Recognize only the definite Claude session-limit response observed in real
 * analyze runs. A bare 429 is deliberately not enough: ordinary throttling
 * remains eligible for the caller's bounded retry policy.
 */
export function parseLlmSessionLimitError(value: unknown): LlmSessionLimitError | null {
  const envelope = asClaudeEnvelope(value);
  if (
    envelope?.is_error === true &&
    Number(envelope.api_error_status) === 429 &&
    typeof envelope.result === 'string' &&
    SESSION_LIMIT_PATTERN.test(envelope.result)
  ) {
    const resetHint = RESET_HINT_PATTERN.exec(envelope.result)?.[1];
    return new LlmSessionLimitError(resetHint);
  }

  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : null;
  const wrappedDetail = message ? WRAPPED_CLAUDE_429_PATTERN.exec(message)?.[1] : undefined;
  if (
    typeof wrappedDetail !== 'string' ||
    !SESSION_LIMIT_PATTERN.test(wrappedDetail)
  ) {
    return null;
  }

  const resetHint = RESET_HINT_PATTERN.exec(wrappedDetail)?.[1];
  return new LlmSessionLimitError(resetHint);
}

export function isLlmSessionLimitError(value: unknown): value is LlmSessionLimitError {
  return (
    value instanceof LlmSessionLimitError ||
    (!!value &&
      typeof value === 'object' &&
      'code' in value &&
      (value as { code?: unknown }).code === 'LLM_SESSION_LIMIT')
  );
}

/**
 * Convert only the complete timezone-qualified Claude reset forms observed in
 * real session-limit responses into an absolute UTC instant. The durable
 * observation timestamp anchors relative words such as "tomorrow". Unknown
 * prose, invalid zones, DST gaps/overlaps, past instants, and excessive delays
 * deliberately remain informational instead of becoming timers.
 */
export function certifyClaudeSessionResetAt(
  resetHint: string | undefined,
  observedAt: string,
): string | null {
  if (!resetHint) return null;
  const match = CERTIFIABLE_RESET_HINT_PATTERN.exec(resetHint);
  const observedMs = Date.parse(observedAt);
  if (!match || !Number.isFinite(observedMs)) return null;

  const [, tomorrow, rawHour, rawMinute, meridiem, timeZone] = match;
  const hour12 = Number(rawHour);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  const hour = hour12 % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatter.resolvedOptions().timeZone !== timeZone) return null;
  } catch {
    return null;
  }

  const observedDate = zonedDateParts(formatter, observedMs);
  if (!observedDate) return null;
  const targetDate = addCalendarDays(observedDate, tomorrow ? 1 : 0);
  const todayMatches = findZonedMinuteMatches(
    formatter,
    observedMs,
    targetDate,
    hour,
    minute,
  );

  let candidate: number | null = null;
  if (tomorrow) {
    if (todayMatches.length === 1) candidate = todayMatches[0];
  } else {
    const futureMatches = todayMatches.filter((value) => value > observedMs);
    if (todayMatches.length === 1 && futureMatches.length === 1) {
      candidate = futureMatches[0];
    }
  }

  if (
    candidate === null
    || candidate <= observedMs
    || candidate - observedMs > MAX_CERTIFIED_RESET_DELAY_MS
  ) {
    return null;
  }
  return new Date(candidate).toISOString();
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function zonedDateParts(formatter: Intl.DateTimeFormat, instantMs: number): CalendarDate | null {
  const parts = formatter.formatToParts(new Date(instantMs));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    ? { year, month, day }
    : null;
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function findZonedMinuteMatches(
  formatter: Intl.DateTimeFormat,
  observedMs: number,
  targetDate: CalendarDate,
  targetHour: number,
  targetMinute: number,
): number[] {
  const first = Math.floor((observedMs - 26 * HOUR_MS) / MINUTE_MS) * MINUTE_MS;
  const last = Math.ceil((observedMs + 52 * HOUR_MS) / MINUTE_MS) * MINUTE_MS;
  const matches: number[] = [];
  for (let instant = first; instant <= last; instant += MINUTE_MS) {
    const values = formatter.formatToParts(new Date(instant));
    const year = Number(values.find((part) => part.type === 'year')?.value);
    const month = Number(values.find((part) => part.type === 'month')?.value);
    const day = Number(values.find((part) => part.type === 'day')?.value);
    const hour = Number(values.find((part) => part.type === 'hour')?.value);
    const minute = Number(values.find((part) => part.type === 'minute')?.value);
    if (
      year === targetDate.year
      && month === targetDate.month
      && day === targetDate.day
      && hour === targetHour
      && minute === targetMinute
    ) {
      matches.push(instant);
    }
  }
  return matches;
}
