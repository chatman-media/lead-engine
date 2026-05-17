#!/usr/bin/env bun
/**
 * Generates a CI status badge SVG. Self-contained — no network, no external
 * badge service (the repo is private, so shields.io can't read it and renders
 * "repo not found"). The badge is committed to the repo and the README
 * references it by relative path, mirroring scripts/coverage-badge.ts.
 *
 * The CI workflow's `status` job runs this with the overall run result, then
 * commits the SVG on push to main.
 *
 * Run:
 *   bun scripts/ci-badge.ts passing
 *   bun scripts/ci-badge.ts failing
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BADGE_PATH = join(process.cwd(), ".github", "badges", "ci.svg");

/** Render a flat-square badge — same style as the coverage badge. */
function renderBadge(status: "passing" | "failing"): string {
  const color = status === "passing" ? "#4c1" : "#e05d44";
  const labelW = 26;
  const valueW = status.length * 7 + 10;
  const total = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="ci: ${status}">
  <title>ci: ${status}</title>
  <rect width="${labelW}" height="20" fill="#555"/>
  <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">ci</text>
    <text x="${labelW + valueW / 2}" y="14">${status}</text>
  </g>
</svg>
`;
}

const arg = process.argv[2];
if (arg !== "passing" && arg !== "failing") {
  console.error(`[ci-badge] usage: bun scripts/ci-badge.ts <passing|failing>`);
  process.exit(1);
}

mkdirSync(dirname(BADGE_PATH), { recursive: true });
writeFileSync(BADGE_PATH, renderBadge(arg));
console.error(`[ci-badge] wrote ${BADGE_PATH} — status ${arg}`);
