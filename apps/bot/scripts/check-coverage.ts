#!/usr/bin/env bun
/**
 * Parses Bun's coverage text report from stdin and exits non-zero if
 * the "All files" line falls below the threshold. Wraps `bun test`
 * because Bun 1.3.14's `coverageThreshold` in bunfig.toml is currently
 * a no-op (the value is read but never enforced).
 *
 * Usage:
 *   bun test --coverage --coverage-reporter=text 2>&1 | bun scripts/check-coverage.ts --line 0.70 --function 0.75
 *
 * Or:
 *   bun scripts/check-coverage.ts --line 0.70 --function 0.75 < coverage.txt
 *
 * Designed to be safe to drop in front of any source of Bun's `--coverage-reporter=text`
 * output — if the summary line isn't present (e.g. the test command itself failed),
 * exits 1 with a clear error.
 */

interface Thresholds {
  line: number;
  function: number;
}

function parseFlags(argv: string[]): Thresholds {
  const out: Thresholds = { line: 0, function: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--line") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error(`--line wants a number, got ${argv[i]}`);
      out.line = n;
    } else if (a === "--function") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error(`--function wants a number, got ${argv[i]}`);
      out.function = n;
    }
  }
  return out;
}

function findAllFilesRow(text: string): { funcs: number; lines: number } | null {
  // Bun's text reporter prints a row like:
  //   All files                             |   81.68 |   77.36 |
  // Locale-independent — values are always plain ASCII percents.
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (m) {
      return { funcs: Number(m[1]) / 100, lines: Number(m[2]) / 100 };
    }
  }
  return null;
}

const thresholds = parseFlags(process.argv.slice(2));

// Read all of stdin (the piped `bun test --coverage` output).
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = Buffer.concat(chunks).toString("utf-8");

// Pass-through to stdout so CI logs still show the full table.
process.stdout.write(input);

const row = findAllFilesRow(input);
if (!row) {
  console.error(
    "\n[check-coverage] could not find 'All files' summary row — test output unparseable",
  );
  process.exit(1);
}

const failures: string[] = [];
if (row.lines < thresholds.line) {
  failures.push(
    `line coverage ${(row.lines * 100).toFixed(2)}% < threshold ${(thresholds.line * 100).toFixed(0)}%`,
  );
}
if (row.funcs < thresholds.function) {
  failures.push(
    `function coverage ${(row.funcs * 100).toFixed(2)}% < threshold ${(thresholds.function * 100).toFixed(0)}%`,
  );
}

if (failures.length > 0) {
  console.error(`\n[check-coverage] FAIL: ${failures.join("; ")}`);
  process.exit(1);
}

console.error(
  `[check-coverage] OK: lines=${(row.lines * 100).toFixed(2)}% funcs=${(row.funcs * 100).toFixed(2)}%`,
);
