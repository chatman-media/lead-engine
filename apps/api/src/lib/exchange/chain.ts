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
  trc20TransferInfo?: Array<{
    to_address?: string;
    from_address?: string;
    amount_str?: string;
    symbol?: string;
    decimals?: number;
    contract_address?: string;
  }>;
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
    return { ok: false, txHash, network: "TRC20", reason: "Транзакция ещё не подтверждена в сети." };
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
  };
}
