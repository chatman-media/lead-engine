// Minimal structured logger. JSON lines on stdout/stderr; correlation id is
// optional and threaded through child loggers. Production aggregators (Loki,
// Cloudwatch, Datadog) ingest one event per line. Levels: debug | info | warn
// | error. Set LOG_LEVEL env to filter at runtime (default "info").
//
// PII redaction runs over the serialized JSON line before it's printed.
// String fields the caller passes can contain candidate phone numbers /
// passport IDs / Telegram bot tokens / API keys and these get masked
// before they ever hit stdout. Conservative — leaves user/conversation
// IDs alone since those are internal identifiers, not raw PII.

export type LogLevel = "debug" | "info" | "warn" | "error";

// Patterns are applied to the serialized JSON line. Each replaces the
// match with a `[REDACTED:kind]` token so downstream tooling can still
// see *where* the PII would have appeared without reading it.
//
// Order matters — token patterns first (they would otherwise match the
// digit-only phone regex), then digit-only patterns.
const REDACTORS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // Telegram bot token: `<digits>:<url-safe payload>`. Spec is "35 chars"
  // but observed tokens drift between 35–46 — keep the lower bound and
  // let the upper run open since other secrets fall under api-key. Use
  // \D-anchored bounds (not \b) so URLs like `/bot12345:TOKEN/` still
  // match — \b would fail since `t` and `1` are both word chars.
  { kind: "tg-bot-token", pattern: /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{30,50}(?![A-Za-z0-9_-])/g },
  // OpenAI / OpenRouter / Anthropic / generic API keys (sk-…, sk-or-…, sk-ant-…)
  { kind: "api-key", pattern: /\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  // E.164-ish phone number: optional +, 10-15 digits with optional separators.
  // Tight enough not to eat order ids / timestamps, loose enough to catch
  // "+998 90 123-45-67" / "+7 (495) 555-1234".
  {
    kind: "phone",
    pattern: /(?<!\d)(?:\+|\\u002B)?\d{1,3}[\s\-().]{0,3}(?:\d[\s\-().]{0,2}){8,12}\d(?!\d)/g,
  },
  // Passport-shaped uppercase letters + digits: 2 letters + 7 digits is the
  // most common (RU/UA/UZ/KZ), but also covers AB12345 (5-9 digits).
  { kind: "passport", pattern: /\b[A-Z]{1,2}\d{5,9}\b/g },
];

export function redactPII(line: string): string {
  let out = line;
  for (const { kind, pattern } of REDACTORS) {
    out = out.replace(pattern, `[REDACTED:${kind}]`);
  }
  return out;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

let activeLevel: LogLevel = envLevel();

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields | unknown): void;
  child(bindings: LogFields): Logger;
}

function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return { err_name: err.name, err_message: err.message, err_stack: err.stack };
  }
  return { err: String(err) };
}

function emit(level: LogLevel, base: LogFields, msg: string, extra?: LogFields | unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
  const event: LogFields = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
  };
  if (extra !== undefined) {
    if (extra && typeof extra === "object" && !(extra instanceof Error) && !Array.isArray(extra)) {
      // Hoist a nested `err` field into proper err_name/err_message/err_stack
      // so callers can write `log.error("x", { conv_id, err })` and still
      // get a stack trace in the line.
      const { err, ...rest } = extra as LogFields & { err?: unknown };
      Object.assign(event, rest);
      if (err !== undefined) Object.assign(event, serializeError(err));
    } else {
      Object.assign(event, serializeError(extra));
    }
  }
  const line = redactPII(JSON.stringify(event));
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function build(base: LogFields): Logger {
  return {
    debug: (msg, fields) => emit("debug", base, msg, fields),
    info: (msg, fields) => emit("info", base, msg, fields),
    warn: (msg, fields) => emit("warn", base, msg, fields),
    error: (msg, fields) => emit("error", base, msg, fields),
    child: (bindings) => build({ ...base, ...bindings }),
  };
}

export const log: Logger = build({});

// Cheap correlation id (8 hex chars). Good enough for grouping a single
// request lifecycle across log lines — not a security identifier.
export function newCorrelationId(): string {
  return Math.random().toString(16).slice(2, 10).padStart(8, "0");
}
