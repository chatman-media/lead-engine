#!/usr/bin/env bun
/**
 * Generates a coverage badge SVG from Bun's text coverage report.
 * Self-contained — no network, no external badge service (the repo is
 * private, so shields.io can't read its data anyway). The badge is
 * committed to the repo and the README references it by relative path.
 *
 * Parses the `All files` row of Bun's `--coverage-reporter=text` output —
 * the SAME source the CI gate (`check-coverage.ts`) reads, so the badge
 * and the gate never disagree. Bun's lcov and text reporters count lines
 * slightly differently, so a lcov-derived badge would drift from the gate.
 *
 * Run:
 *   bun run test:coverage:badge      # runs coverage + regenerates the badge
 * Or, with a saved text report:
 *   bun scripts/coverage-badge.ts < coverage/coverage.txt
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPORT_PATH = join(process.cwd(), "coverage", "coverage.txt");
const BADGE_PATH = join(process.cwd(), ".github", "badges", "coverage.svg");

/** Pull the line-coverage percent from Bun's text-reporter `All files` row.
 *  The row looks like: `All files | 91.36 | 90.23 |` (funcs | lines). */
function linePercentFromTextReport(text: string): number {
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (m) return Number(m[2]);
  }
  throw new Error("could not find the 'All files' row in the coverage text report");
}

/** shields-style colour ramp keyed off the coverage percentage. */
function colorFor(pct: number): string {
  if (pct >= 90) return "#4c1"; // brightgreen
  if (pct >= 80) return "#97ca00"; // green
  if (pct >= 70) return "#a4a61d"; // yellowgreen
  if (pct >= 50) return "#dfb317"; // yellow
  return "#e05d44"; // red
}

/** Render a flat-square badge (matches the README's existing CI badge style). */
function renderBadge(pct: number): string {
  const value = `${pct.toFixed(1)}%`;
  const color = colorFor(pct);
  const labelW = 62;
  // Rough monospace-ish estimate; flat-square has no kerning subtleties.
  const valueW = value.length * 7 + 10;
  const total = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="coverage: ${value}">
  <title>coverage: ${value}</title>
  <rect width="${labelW}" height="20" fill="#555"/>
  <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">coverage</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>
`;
}

let report: string;
try {
  report = readFileSync(REPORT_PATH, "utf-8");
} catch {
  console.error(`[coverage-badge] ${REPORT_PATH} not found — run \`bun run test:coverage:badge\``);
  process.exit(1);
}

const pct = linePercentFromTextReport(report);
mkdirSync(dirname(BADGE_PATH), { recursive: true });
writeFileSync(BADGE_PATH, renderBadge(pct));
console.error(`[coverage-badge] wrote ${BADGE_PATH} — line coverage ${pct.toFixed(1)}%`);
