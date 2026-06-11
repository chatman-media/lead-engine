import { Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExchangeRateCardProposal } from "@/api/saas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function formatRate(n: number): string {
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function formatAmount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "";
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 6,
  })
    .format(n)
    .replace(/\u00a0/g, " ");
}

function parseCompactNumber(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "").replace(",", ".");
  if (!text || text === "∞") return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)([kкmм])?%?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2];
  if (suffix === "k" || suffix === "к") return value * 1_000;
  if (suffix === "m" || suffix === "м") return value * 1_000_000;
  return value;
}

function applyDeviation(marketRate: number, deviationPct: number): number {
  return round(marketRate * (1 + deviationPct / 100));
}

function nonNegative(n: number): number {
  return Math.max(0, n);
}

function formatFormula(marketRate: number, deviationPct: number, displayRate: number): string {
  const sign = deviationPct >= 0 ? "+" : "-";
  return `${formatRate(marketRate)} ${sign} ${formatRate(Math.abs(deviationPct))}% = ${formatRate(displayRate)}`;
}

function normalizeTier(
  proposal: ExchangeRateCardProposal,
  tier: ExchangeRateCardProposal["tiers"][number],
): ExchangeRateCardProposal["tiers"][number] {
  const deviationPct = Number.isFinite(tier.deviationPct) ? tier.deviationPct : 0;
  const displayRate = applyDeviation(proposal.marketRate, deviationPct);
  return {
    ...tier,
    displayRate,
    deviationPct,
    formula: formatFormula(proposal.marketRate, deviationPct, displayRate),
  };
}

interface CompactNumberInputProps {
  value: number | null;
  onCommit: (value: number | null) => void;
  placeholder?: string;
  className?: string;
  allowEmpty?: boolean;
  decimals?: boolean;
}

function CompactNumberInput({
  value,
  onCommit,
  placeholder,
  className,
  allowEmpty = false,
  decimals = false,
}: CompactNumberInputProps) {
  const [draft, setDraft] = useState(() =>
    decimals ? formatRate(value ?? Number.NaN) : formatAmount(value),
  );
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(decimals ? formatRate(value ?? Number.NaN) : formatAmount(value));
  }, [decimals, focused, value]);

  function commit(nextDraft = draft) {
    const parsed = parseCompactNumber(nextDraft);
    if (parsed === null) {
      if (allowEmpty) {
        onCommit(null);
        setDraft("");
      } else {
        setDraft(decimals ? formatRate(value ?? Number.NaN) : formatAmount(value));
      }
      setFocused(false);
      return;
    }
    onCommit(parsed);
    setDraft(decimals ? formatRate(parsed) : formatAmount(parsed));
    setFocused(false);
  }

  return (
    <Input
      className={cn("h-8 tabular-nums", className)}
      inputMode="decimal"
      placeholder={placeholder}
      value={draft}
      onFocus={(e) => {
        const target = e.currentTarget;
        setFocused(true);
        setDraft(value === null || !Number.isFinite(value) ? "" : String(value));
        requestAnimationFrame(() => target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(decimals ? formatRate(value ?? Number.NaN) : formatAmount(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function PercentInput({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const nudge = (delta: number) => onCommit(round(safeValue + delta, 2));

  return (
    <div className="grid h-8 grid-cols-[1.5rem_minmax(3.25rem,1fr)_1.5rem] overflow-hidden rounded-md border bg-background">
      <button
        type="button"
        className="text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => nudge(-0.1)}
        aria-label="Уменьшить отклонение"
      >
        -
      </button>
      <div className="relative">
        <CompactNumberInput
          value={safeValue}
          decimals
          onCommit={(next) => onCommit(round(next ?? 0, 2))}
          className="h-full rounded-none border-0 px-1.5 pr-4 text-center shadow-none focus-visible:ring-0"
        />
        <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-1 text-xs text-muted-foreground">
          %
        </span>
      </div>
      <button
        type="button"
        className="text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => nudge(0.1)}
        aria-label="Увеличить отклонение"
      >
        +
      </button>
    </div>
  );
}

export function RateCardEditor({
  proposals,
  quoteCode,
  onChange,
}: {
  proposals: ExchangeRateCardProposal[];
  quoteCode: string;
  onChange: (proposals: ExchangeRateCardProposal[]) => void;
}) {
  function update(next: ExchangeRateCardProposal[]) {
    onChange(
      next.map((proposal) => ({
        ...proposal,
        tiers: proposal.tiers.map((tier) => normalizeTier(proposal, tier)),
      })),
    );
  }

  function patchTier(
    proposalIndex: number,
    tierIndex: number,
    patch: Partial<ExchangeRateCardProposal["tiers"][number]>,
  ) {
    update(
      proposals.map((proposal, i) => {
        if (i !== proposalIndex) return proposal;
        return {
          ...proposal,
          tiers: proposal.tiers.map((tier, j) => (j === tierIndex ? { ...tier, ...patch } : tier)),
        };
      }),
    );
  }

  function addTier(proposalIndex: number) {
    update(
      proposals.map((proposal, i) => {
        if (i !== proposalIndex) return proposal;
        const last = proposal.tiers.at(-1);
        const minThb = last ? (last.maxThb ?? last.minThb + 1_000) : 0;
        const deviationPct = last?.deviationPct ?? 0;
        return {
          ...proposal,
          tiers: [
            ...proposal.tiers,
            {
              minThb,
              maxThb: null,
              displayRate: applyDeviation(proposal.marketRate, deviationPct),
              deviationPct,
              formula: "",
            },
          ],
        };
      }),
    );
  }

  function removeTier(proposalIndex: number, tierIndex: number) {
    update(
      proposals.map((proposal, i) =>
        i === proposalIndex
          ? { ...proposal, tiers: proposal.tiers.filter((_, j) => j !== tierIndex) }
          : proposal,
      ),
    );
  }

  return (
    <div className="space-y-4">
      {proposals.map((proposal, proposalIndex) => (
        <div key={proposal.asset} className="overflow-x-auto rounded-lg border">
          <div className="min-w-[38rem]">
            <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
              <span className="text-sm font-medium">
                {proposal.asset === "RUB"
                  ? `🇷🇺 RUB → ${quoteCode}`
                  : proposal.asset === "USDT"
                    ? `💲 USDT → ${quoteCode}`
                    : `${proposal.asset} → ${quoteCode}`}
              </span>
              <span className="text-xs text-muted-foreground">
                рынок: {formatRate(proposal.marketRate)}{" "}
                {proposal.quoteMode === "divide"
                  ? `${proposal.asset}/${quoteCode}`
                  : `${quoteCode}/${proposal.asset}`}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(6rem,1fr)_minmax(6rem,1fr)_8rem_minmax(6rem,0.8fr)_2rem] gap-2 px-3 py-1.5 text-xs text-muted-foreground">
              <span>от ({quoteCode})</span>
              <span>до ({quoteCode})</span>
              <span>откл. от рынка</span>
              <span>курс</span>
              <span />
            </div>
            {proposal.tiers.map((tier, tierIndex) => {
              const normalized = normalizeTier(proposal, tier);
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: строки переупорядочиваемы пользователем
                  key={`${proposal.asset}-${tierIndex}`}
                  className="grid grid-cols-[minmax(6rem,1fr)_minmax(6rem,1fr)_8rem_minmax(6rem,0.8fr)_2rem] items-center gap-2 border-t px-3 py-1.5"
                >
                  <CompactNumberInput
                    value={normalized.minThb}
                    onCommit={(value) =>
                      patchTier(proposalIndex, tierIndex, { minThb: nonNegative(value ?? 0) })
                    }
                  />
                  <CompactNumberInput
                    value={normalized.maxThb}
                    allowEmpty
                    placeholder="∞"
                    onCommit={(value) =>
                      patchTier(proposalIndex, tierIndex, {
                        maxThb: value === null ? null : nonNegative(value),
                      })
                    }
                  />
                  <PercentInput
                    value={normalized.deviationPct}
                    onCommit={(value) =>
                      patchTier(proposalIndex, tierIndex, { deviationPct: value })
                    }
                  />
                  <div className="min-w-0">
                    <div className="rounded-md bg-muted/45 px-2 py-1.5 font-medium text-sm tabular-nums">
                      {formatRate(normalized.displayRate)}
                    </div>
                    <div className="truncate px-1 pt-0.5 text-[11px] text-muted-foreground">
                      {normalized.formula}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeTier(proposalIndex, tierIndex)}
                    aria-label="Удалить строку"
                    className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              );
            })}
            <div className="border-t px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => addTier(proposalIndex)}
              >
                + Добавить диапазон
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
