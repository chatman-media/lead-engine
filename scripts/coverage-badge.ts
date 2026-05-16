#!/usr/bin/env bun
/**
 * Generates a coverage badge SVG from Bun's lcov report. Self-contained —
 * no network, no external badge service (the repo is private, so shields.io
 * can't read its data anyway). The badge is committed to the repo and the
 * README references it by relative path.
 *
 * Reads `coverage/lcov.info` (produced by `bun test --coverage
 * --coverage-reporter=lcov`), sums the `LF:` (lines found) and `LH:` (lines
 * hit) records across all files, and writes a flat-square SVG to
 * `.github/badges/coverage.svg`.
 *
 * Run:
 *   bun run test:coverage           # produces coverage/lcov.info
 *   bun scripts/coverage-badge.ts   # then regenerate the badge
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LCOV_PATH = join(process.cwd(), "coverage", "lcov.info");
const BADGE_PATH = join(process.cwd(), ".github", "badges", "coverage.svg");

/** Sum lcov `LF:`/`LH:` records into an overall line-coverage percentage. */
function linePercentFromLcov(lcov: string): number {
  let found = 0;
  let hit = 0;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("LF:")) found += Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) hit += Number(line.slice(3)) || 0;
  }
  if (found === 0) throw new Error("lcov report has no line records (LF: total is 0)");
  return (hit / found) * 100;
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

let lcov: string;
try {
  lcov = readFileSync(LCOV_PATH, "utf-8");
} catch {
  console.error(`[coverage-badge] ${LCOV_PATH} not found — run \`bun run test:coverage\` first`);
  process.exit(1);
}

const pct = linePercentFromLcov(lcov);
mkdirSync(dirname(BADGE_PATH), { recursive: true });
writeFileSync(BADGE_PATH, renderBadge(pct));
console.error(`[coverage-badge] wrote ${BADGE_PATH} — line coverage ${pct.toFixed(1)}%`);
