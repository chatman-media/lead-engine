import type { StartedUserbotLogin } from "@chatman-media/channel-telegram";

/**
 * In-memory стор незавершённых userbot-логинов. Многошаговый MTProto-логин
 * (phone → code → 2fa) требует держать ОДИН live gramjs-client между HTTP-
 * запросами: phoneCodeHash и auth-key привязаны к этому соединению.
 *
 * Ключ — `loginId` (UUID), отдаётся клиенту на шаге start и приходит обратно
 * на verify/2fa. TTL ~5 мин; sweep отключает протухшие соединения.
 *
 * ДОПУЩЕНИЕ: apps/api — single-instance (см. ROADMAP: один Postgres/инстанс
 * до ~100 тенантов). При нескольких репликах follow-up запрос может попасть
 * на инстанс без pending-client'а → логин придётся начать заново. Кросс-
 * process стор (Redis) — отдельный PR, когда понадобится горизонтальное масштабирование.
 */

type LoginClient = StartedUserbotLogin["client"];

interface PendingLogin {
  client: LoginClient;
  phoneCodeHash: string;
  phone: string;
  tenantId: number;
  /** Прошёл ли успешно шаг кода (ждём только 2FA). */
  awaiting2fa: boolean;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class UserbotLoginStore {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    // Sweep каждую минуту: дисконнектим протухшие gramjs-клиенты, чтобы
    // long-running процесс не накапливал зависшие MTProto-соединения.
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
  }

  create(entry: {
    loginId: string;
    client: LoginClient;
    phoneCodeHash: string;
    phone: string;
    tenantId: number;
  }): void {
    this.pending.set(entry.loginId, {
      client: entry.client,
      phoneCodeHash: entry.phoneCodeHash,
      phone: entry.phone,
      tenantId: entry.tenantId,
      awaiting2fa: false,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Вернуть pending-логин, только если он принадлежит этому тенанту и не протух. */
  get(loginId: string, tenantId: number): PendingLogin | undefined {
    const entry = this.pending.get(loginId);
    if (!entry) return undefined;
    if (entry.tenantId !== tenantId) return undefined;
    if (entry.expiresAt < Date.now()) {
      void this.discard(loginId);
      return undefined;
    }
    return entry;
  }

  markAwaiting2fa(loginId: string): void {
    const entry = this.pending.get(loginId);
    if (entry) entry.awaiting2fa = true;
  }

  /** Удалить запись + дисконнектить gramjs-client (вызвать на успехе/отмене). */
  async discard(loginId: string): Promise<void> {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    this.pending.delete(loginId);
    try {
      await entry.client.disconnect();
    } catch {
      // соединение и так может быть мёртвым — игнорируем
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of [...this.pending]) {
      if (entry.expiresAt < now) await this.discard(id);
    }
  }

  /** Graceful shutdown: остановить sweep + дисконнектить все pending-клиенты. */
  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.allSettled([...this.pending.keys()].map((id) => this.discard(id)));
  }

  size(): number {
    return this.pending.size;
  }
}
