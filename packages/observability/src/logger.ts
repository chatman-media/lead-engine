// Structured JSON logger. Каждая запись — одна строка JSON, готовая
// для grok'а в Fluentd / Datadog / Loki без regex'ов.
//
// Формат:
//   {"ts":"2026-05-21T10:30:00.123Z","level":"info","msg":"...","scope":"apps/api",...meta}
//
// Не зависит от node:console — пишет в options.stream (default = process.stdout).
// Это позволяет swap'нуть на in-memory buffer в тестах.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface JsonLoggerOptions {
  scope?: string;
  /**
   * Минимальный уровень — записи ниже отбрасываются. Default "info".
   * Иерархия: debug < info < warn < error.
   */
  minLevel?: LogLevel;
  /** Куда писать. Default process.stdout. */
  stream?: { write(chunk: string): void };
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class JsonLogger {
  private readonly scope: string | undefined;
  private readonly minLevel: number;
  private readonly stream: { write(chunk: string): void };

  constructor(opts: JsonLoggerOptions = {}) {
    this.scope = opts.scope;
    this.minLevel = LEVEL_ORDER[opts.minLevel ?? "info"];
    this.stream = opts.stream ?? process.stdout;
  }

  /** Производный logger с расширенным scope'ом (например "apps/api/webhook"). */
  child(extraScope: string): JsonLogger {
    return new JsonLogger({
      scope: this.scope ? `${this.scope}/${extraScope}` : extraScope,
      minLevel: this.minLevelName(),
      stream: this.stream,
    });
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (this.scope) record.scope = this.scope;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        // Error инстансы → плоский message/stack (JSON.stringify их игнорирует
        // т.к. enumerable own properties отсутствуют).
        if (v instanceof Error) {
          record[k] = { message: v.message, stack: v.stack, name: v.name };
        } else {
          record[k] = v;
        }
      }
    }
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  private minLevelName(): LogLevel {
    if (this.minLevel <= LEVEL_ORDER.debug) return "debug";
    if (this.minLevel <= LEVEL_ORDER.info) return "info";
    if (this.minLevel <= LEVEL_ORDER.warn) return "warn";
    return "error";
  }
}

/** Default logger для apps. Минимальный setup. */
export function makeDefaultLogger(scope: string): JsonLogger {
  const env = (process.env.LOG_LEVEL ?? "info") as LogLevel;
  return new JsonLogger({ scope, minLevel: env });
}
