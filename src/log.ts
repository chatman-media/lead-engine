// Minimal structured logger. JSON lines on stdout/stderr; correlation id is
// optional and threaded through child loggers. Production aggregators (Loki,
// Cloudwatch, Datadog) ingest one event per line. Levels: debug | info | warn
// | error. Set LOG_LEVEL env to filter at runtime (default "info").

export type LogLevel = "debug" | "info" | "warn" | "error";

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
      Object.assign(event, extra as LogFields);
    } else {
      Object.assign(event, serializeError(extra));
    }
  }
  const line = JSON.stringify(event);
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
