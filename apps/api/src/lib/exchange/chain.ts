/**
 * On-chain проверка крипто-оплаты (п.15-16 ТЗ). Надёжно автоматизируемо только
 * для крипты: сверяем транзакцию по tx hash в блокчейне.
 *
 * Поддержано: USDT TRC20 (TRON) — основной кейс реального воркфлоу. Источник —
 * публичный Tronscan API. from_address извлекается из транзакции (п.16 —
 * «автоопределяет, откуда был перевод»).
 *
 * Прочие сети (ERC20/BTC/ETH) — заглушка needsOperator: проверяет оператор.
 */

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRONSCAN_TX_API = "https://apilist.tronscanapi.com/api/transaction-info";
const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_TX_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface VerifyResult {
  ok: boolean;
  /** оплату подтвердить автоматически нельзя — нужен оператор */
  needsOperator?: boolean;
  txHash?: string;
  fromAddress?: string;
  toAddress?: string;
  amount?: number;
  symbol?: string;
  network?: string;
  confirmedAt?: number;
  reason?: string;
}

/** Извлекает 64-hex tx hash из строки/ссылки (tronscan, etherscan, голый хеш). */
export function extractTxHash(input: string): string | null {
  const m = input.match(/\b([0-9a-fA-F]{64})\b/);
  return m ? (m[1] as string).toLowerCase() : null;
}

interface TronTxInfo {
  confirmed?: boolean;
  contractRet?: string;
  contract_ret?: string;
  timestamp?: number;
  block_ts?: number;
  trc20TransferInfo?: Array<{
    to_address?: string;
    from_address?: string;
    amount_str?: string;
    symbol?: string;
    decimals?: number;
    contract_address?: string;
    block_ts?: number;
  }>;
}

function toEpochSeconds(raw: number | null | undefined): number | null {
  if (!Number.isFinite(raw ?? Number.NaN)) return null;
  const value = Number(raw);
  if (value <= 0) return null;
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function resolveConfirmedAt(info: TronTxInfo): number | null {
  return (
    toEpochSeconds(info.timestamp) ??
    toEpochSeconds(info.block_ts) ??
    toEpochSeconds(info.trc20TransferInfo?.[0]?.block_ts)
  );
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Проверяет входящий USDT TRC20 перевод по tx hash.
 * Успех = транзакция подтверждена, есть TRC20-перевод USDT на ожидаемый адрес
 * на сумму >= expectedAmount (с допуском на сетевую комиссию).
 */
export async function verifyTronUsdt(opts: {
  txHash: string;
  toAddress: string;
  expectedAmount: number;
  /** допуск недостачи (комиссия сети), доля. Default 0.02 (2%). */
  tolerance?: number;
  /** максимальный возраст транзакции. Default 24h. */
  maxAgeSeconds?: number;
  nowEpoch?: number;
  timeoutMs?: number;
}): Promise<VerifyResult> {
  const txHash = opts.txHash.toLowerCase();
  const tolerance = opts.tolerance ?? 0.02;
  let info: TronTxInfo;
  try {
    info = (await fetchJson(
      `${TRONSCAN_TX_API}?hash=${encodeURIComponent(txHash)}`,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )) as TronTxInfo;
  } catch (err) {
    return {
      ok: false,
      needsOperator: true,
      txHash,
      network: "TRC20",
      reason: `Не удалось получить данные транзакции: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ret = info.contractRet ?? info.contract_ret;
  if (ret && ret !== "SUCCESS") {
    return { ok: false, txHash, network: "TRC20", reason: `Статус транзакции: ${ret}` };
  }
  if (info.confirmed === false) {
    return {
      ok: false,
      txHash,
      network: "TRC20",
      reason: "Транзакция ещё не подтверждена в сети.",
    };
  }

  const confirmedAt = resolveConfirmedAt(info);
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_TX_MAX_AGE_SECONDS;
  if (!confirmedAt) {
    return {
      ok: false,
      needsOperator: true,
      txHash,
      network: "TRC20",
      reason: "Не удалось определить время транзакции — проверит оператор.",
    };
  }
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  if (nowEpoch - confirmedAt > maxAgeSeconds) {
    return {
      ok: false,
      needsOperator: true,
      txHash,
      network: "TRC20",
      confirmedAt,
      reason: `Транзакция старше ${Math.round(maxAgeSeconds / 3600)} часов — проверит оператор.`,
    };
  }

  const transfers = info.trc20TransferInfo ?? [];
  const usdt = transfers.filter(
    (t) =>
      (t.contract_address === USDT_TRC20_CONTRACT || (t.symbol ?? "").toUpperCase() === "USDT") &&
      (t.to_address ?? "").toLowerCase() === opts.toAddress.toLowerCase(),
  );
  if (usdt.length === 0) {
    return {
      ok: false,
      txHash,
      network: "TRC20",
      reason: "В транзакции нет перевода USDT на наш адрес.",
    };
  }

  const t0 = usdt[0] as NonNullable<TronTxInfo["trc20TransferInfo"]>[number];
  const decimals = t0.decimals ?? 6;
  const amount = Number(t0.amount_str ?? "0") / 10 ** decimals;
  const minAcceptable = opts.expectedAmount * (1 - tolerance);
  if (amount < minAcceptable) {
    return {
      ok: false,
      txHash,
      fromAddress: t0.from_address,
      toAddress: t0.to_address,
      amount,
      symbol: "USDT",
      network: "TRC20",
      confirmedAt,
      reason: `Сумма ${amount} USDT меньше ожидаемой ${opts.expectedAmount} USDT.`,
    };
  }

  return {
    ok: true,
    txHash,
    fromAddress: t0.from_address,
    toAddress: t0.to_address,
    amount,
    symbol: "USDT",
    network: "TRC20",
    confirmedAt,
  };
}
