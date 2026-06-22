/**
 * Индикатор «печатает…» с авто-переподнятием.
 *
 * Telegram показывает typing-action ~5 сек на каждый sendChatAction; на медленной
 * генерации ответа (LLM + enqueue) он гаснет раньше, чем приходит сообщение.
 * Хелпер шлёт «печатает…» сразу и затем каждые intervalMs (< 5с TTL), пока идёт
 * генерация. Возвращает stop() — вызови его после enqueue ответа (в finally).
 *
 * Best-effort: ошибки signal() глотаются — индикатор не должен влиять на ответ.
 * maxMs — предохранитель от утечки таймера, если stop() забыли вызвать (например,
 * generateReplyAndEnqueue бросил исключение): по истечении таймер гасится сам.
 */
export interface TypingKeepaliveOptions {
  /** Период переподнятия, мс. По умолчанию 4000 (< 5с TTL Telegram). */
  intervalMs?: number;
  /** Жёсткий потолок жизни таймера, мс. По умолчанию 30000. */
  maxMs?: number;
}

export function startTypingKeepalive(
  signal: () => Promise<void>,
  options: TypingKeepaliveOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 4_000;
  const maxMs = options.maxMs ?? 30_000;
  let stopped = false;

  const fire = (): void => {
    void signal().catch(() => {});
  };

  fire(); // первый «печатает…» сразу, не дожидаясь интервала

  const interval = setInterval(fire, intervalMs);
  let guard: ReturnType<typeof setTimeout>;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(guard);
  };
  guard = setTimeout(stop, maxMs);
  return stop;
}
