# design-sync notes — @lead-engine/admin-ui

Repo-specific gotchas for future syncs of this design system (the shadcn/ui
primitives in `apps/admin-ui/src/components/ui`).

## Source shape & entry
- **Package shape, src/synth — there is NO component-library build.** `apps/admin-ui`
  builds the whole app, not a primitives `dist/`. We feed the converter a hand
  barrel `apps/admin-ui/.ds-entry.tsx` (re-exports every `ui/*` module so the
  bundle carries all compound sub-parts — CardHeader, DialogContent, …) via
  `cfg.entry`. PKG_DIR resolves to `apps/admin-ui` by walking up from the entry.
- `--node-modules apps/admin-ui/node_modules` — react/@types/react/tailwind live
  there, NOT at the repo root (Bun workspace, not hoisted to root).
- Run install from the repo root with **Bun**: `bun install --frozen-lockfile`.

## Tailwind v4 CSS — must be recompiled, it is NOT checked in
- Styling is Tailwind v4 utility classes compiled by the Vite plugin. A raw
  `@import "tailwindcss"` will NOT work standalone. We compile a self-contained,
  compiler-free stylesheet and point `cfg.cssEntry` at it.
- **Before every build, recompile:**
  ```sh
  cd apps/admin-ui
  node ../../.ds-sync/node_modules/.bin/tailwindcss -i .ds-css-input.css -o .ds-compiled.css
  ```
  `.ds-compiled.css` is gitignored (build artifact); `.ds-css-input.css` and
  `.ds-entry.tsx` and `.ds-docs/` ARE committed (sync inputs).
- `.ds-css-input.css` imports `src/index.css` (the app's real theme: brand
  indigo/violet "Linear" tokens, light+dark) and widens `@source` scanning to
  the component sources AND `.design-sync/previews` so every utility class the
  previews use is baked in. **If you add new utility classes in a preview,
  recompile the CSS before the build or the class ships unstyled.**

## Fonts
- Brand fonts (Satoshi via Fontshare, IBM Plex Mono via Google Fonts) are loaded
  at RUNTIME from public CDNs — the app's `index.html` uses `<link>`, we use two
  `@import url(...)` lines at the top of `.ds-css-input.css`. Validate reports
  `[FONT_REMOTE]` (informational) — this is expected, not a regression. No
  woff2 ships in the bundle by design.

## DTS contracts are hand-written (`cfg.dtsPropsFor`)
- In src/synth mode there is no `.d.ts` tree, so prop extraction yields only an
  index signature. We provide faithful `<Name>Props` bodies in
  `cfg.dtsPropsFor` for all 20 primitives (Radix/Sonner/native APIs +
  CVA variant/size enums). **When a component's real API changes, update the
  matching `cfg.dtsPropsFor` entry** — extraction will not catch it.

## Component set
- 20 primitives, one card each, defined explicitly via `cfg.componentSrcMap`
  (the primary export per file). Compound sub-parts are in the bundle but not
  separate cards — previews compose them. Grouping comes from `.ds-docs/<Name>.md`
  `category` frontmatter (Forms / Overlays / Display / Navigation / Layout / Feedback).

## Overlays
- Dialog, Sheet, DropdownMenu, Select, Tooltip render forced-open
  (`defaultOpen`) inside `cfg.overrides.<Name>: {cardMode:"single", viewport:"WxH"}`.
  They portal to the iframe body; the viewport sizes keep the open state in frame.

## Dark-first theme (previews)
- The product is **dark-first** (`index.html` sets `admin-theme: dark` → `.dark`
  on `<html>`). Previews must render dark to match. We ship a preview-only
  provider `ThemeRoot` (`apps/admin-ui/.ds-theme.tsx`, wired via
  `cfg.extraEntries` + `cfg.provider`) that adds `.dark` to `documentElement`
  and darkens the body on mount. Putting `.dark` on `<html>` (not a wrapper div)
  is deliberate — it themes Radix **portaled** content (Dialog/Select/Dropdown/
  Tooltip/Sheet) too. `ThemeRoot` is never part of a design built from the
  bundle, so it can't force a theme on the design agent's output.
- Token-based previews flip light↔dark automatically (same utilities, `var()`
  values change), so no separate dark CSS is needed.

## Known render warns (treat as clean on re-sync)
- `[FONT_REMOTE]` Satoshi / IBM Plex Mono — runtime CDN fonts, expected.
- **Toaster** ships the floor card on purpose: Sonner toasts are imperative
  (`toast()`), so a static preview shows nothing. Authoring it would be a
  reimplementation — leave it on the floor card.

## Re-sync risks (what can silently go stale)
- `.ds-compiled.css` is regenerated, not committed — a re-sync that forgets the
  tailwind recompile step ships an older CSS. Always recompile first.
- `cfg.dtsPropsFor` bodies are decoupled from source — a renamed/added prop on a
  primitive won't appear until the entry is hand-updated.
- New `ui/*` components are NOT auto-added: add the file to `.ds-entry.tsx`, a
  `componentSrcMap` entry, a `.ds-docs/<Name>.md` group stub, and (ideally) a
  `dtsPropsFor` body + a `previews/<Name>.tsx`.
- Brand-font CDNs are external — if Fontshare/Google change URLs the runtime
  fonts fall back silently.
