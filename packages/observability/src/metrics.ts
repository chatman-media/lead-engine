// Самописный Prometheus text-format exposition. Без npm-deps (prom-client) —
// для нашего масштаба достаточно counters + histograms. Если станет узким
// местом — swap'нём на prom-client'е, public API совместим.
//
// Спецификация формата:
//   https://prometheus.io/docs/instrumenting/exposition_formats/

export type LabelValues = Readonly<Record<string, string | number>>;

/**
 * Один counter (monotonically-increasing). Поддерживает labels — каждая
 * комбинация labels тракается отдельным числом. Memory не растёт на high-
 * cardinality labels — НЕ кладите в label tenant_slug если у вас 10000
 * tenants, лучше positive вверх агрегатом.
 */
export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  inc(value = 1, labels?: LabelValues): void {
    const key = encodeLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  /** Сброс — нужен для тестов, в production не вызывается. */
  reset(): void {
    this.values.clear();
  }

  /** Промет text-format для этого counter'а. */
  format(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [labelsEnc, value] of this.values) {
      lines.push(`${this.name}${labelsEnc} ${value}`);
    }
    return lines.join("\n");
  }
}

/**
 * Histogram с buckets'ами. По каждой observe() инкрементит соответствующие
 * _bucket'ы (cumulative), плюс _sum и _count.
 */
export class Histogram {
  private readonly bucketCounts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly buckets: readonly number[],
  ) {
    if (buckets.length === 0) throw new Error("Histogram needs at least one bucket");
    // Buckets отсортированы по возрастанию — обязательное требование Prometheus'а.
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i]! <= buckets[i - 1]!) {
        throw new Error(`Histogram buckets must be strictly ascending; got ${buckets.join(",")}`);
      }
    }
  }

  observe(value: number, labels?: LabelValues): void {
    const key = encodeLabels(labels);
    let counts = this.bucketCounts.get(key);
    if (!counts) {
      counts = new Array(this.buckets.length).fill(0);
      this.bucketCounts.set(key, counts);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) counts[i]! += 1;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  reset(): void {
    this.bucketCounts.clear();
    this.sums.clear();
    this.counts.clear();
  }

  format(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [labelsEnc, counts] of this.bucketCounts) {
      const labelsObj = decodeLabels(labelsEnc);
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabel = mergeLabels(labelsObj, { le: this.buckets[i]!.toString() });
        lines.push(`${this.name}_bucket${encodeLabels(bucketLabel)} ${counts[i]}`);
      }
      // +Inf bucket — totals всегда.
      const totalCount = this.counts.get(labelsEnc) ?? 0;
      const infLabel = mergeLabels(labelsObj, { le: "+Inf" });
      lines.push(`${this.name}_bucket${encodeLabels(infLabel)} ${totalCount}`);
      lines.push(`${this.name}_sum${labelsEnc} ${this.sums.get(labelsEnc) ?? 0}`);
      lines.push(`${this.name}_count${labelsEnc} ${totalCount}`);
    }
    return lines.join("\n");
  }
}

/** Реестр всех метрик процесса. /metrics endpoint вызывает .format(). */
export class MetricsRegistry {
  private readonly metrics: Array<Counter | Histogram> = [];

  register<T extends Counter | Histogram>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }

  format(): string {
    return this.metrics.map((m) => m.format()).join("\n\n");
  }

  /** Reset всех метрик — для тестов. */
  reset(): void {
    for (const m of this.metrics) m.reset();
  }
}

// ---- Label encoding ----------------------------------------------------

function encodeLabels(labels: LabelValues | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`);
  return `{${parts.join(",")}}`;
}

function decodeLabels(encoded: string): LabelValues {
  if (encoded === "") return {};
  const inner = encoded.slice(1, -1); // strip { }
  const result: Record<string, string> = {};
  // Простой парсер: `k1="v1",k2="v2"`. value не содержит unescaped ".
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  m = re.exec(inner);
  while (m !== null) {
    result[m[1]!] = m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    m = re.exec(inner);
  }
  return result;
}

function mergeLabels(base: LabelValues, extra: LabelValues): LabelValues {
  return { ...base, ...extra };
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
