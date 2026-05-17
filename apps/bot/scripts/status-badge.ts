#!/usr/bin/env bun
/**
 * Generates a flat-square status badge SVG (passing / failing) for a named
 * pipeline stage — currently `tests` and `deploy`. Self-contained: no
 * network, no external badge service (the repo is private, so shields.io
 * can't read it and renders "repo not found"). The SVG is committed to the
 * repo and the README references it by relative path.
 *
 * The CI workflow's `status` job runs this with each stage's result and
 * commits the SVGs on push to main. Mirrors scripts/ci-badge.ts.
 *
 * Run:
 *   bun scripts/status-badge.ts tests passing
 *   bun scripts/status-badge.ts deploy failing
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Render a flat-square badge — same style as the ci / coverage badges. */
function renderBadge(label: string, status: "passing" | "failing"): string {
  const color = status === "passing" ? "#4c1" : "#e05d44";
  const labelW = label.length * 7 + 10;
  const valueW = status.length * 7 + 10;
  const total = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${status}">
  <title>${label}: ${status}</title>
  <rect width="${labelW}" height="20" fill="#555"/>
  <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="14">${status}</text>
  </g>
</svg>
`;
}

const label = process.argv[2];
const status = process.argv[3];
if (!label || !/^[a-z][a-z0-9-]*$/.test(label)) {
  console.error("[status-badge] usage: bun scripts/status-badge.ts <label> <passing|failing>");
  process.exit(1);
}
if (status !== "passing" && status !== "failing") {
  console.error("[status-badge] usage: bun scripts/status-badge.ts <label> <passing|failing>");
  process.exit(1);
}

const badgePath = join(process.cwd(), ".github", "badges", `${label}.svg`);
mkdirSync(dirname(badgePath), { recursive: true });
writeFileSync(badgePath, renderBadge(label, status));
console.error(`[status-badge] wrote ${badgePath} — ${label}: ${status}`);
