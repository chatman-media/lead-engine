/**
 * lead-engine chat widget — entry point.
 *
 * Парсит data-attrs из своего `<script>` тега, mount'ит UI в shadow DOM,
 * открывает WS-соединение с apps/api `/ws/:slug?user=<persistent-id>`.
 *
 * Data attrs (на script-теге):
 *   data-slug  — tenant slug, required
 *   data-host  — base URL apps/api (http://... или https://...), required
 *   data-brand — display name (опц.), shown в header
 *   data-color — hex (#rgb или #rrggbb), customizes accent. Default #6aa6ff
 *   data-auth  — JWT для /ws/ если backend requires (опц.)
 *
 * Идемпотентность: если widget уже инициализирован на странице —
 * повторный load script'а игнорируется.
 *
 * Bundle target: ~10-15KB gzip, no framework deps.
 */

import { mountWidget } from "./widget.ts";

interface Cfg {
  slug: string;
  host: string;
  brand?: string;
  color?: string;
  auth?: string;
}

const INIT_FLAG = "__leadEngineWidgetInit__";

function readConfig(): Cfg | null {
  // Find script tag with data-slug — it's our own injection point.
  const scripts = document.querySelectorAll<HTMLScriptElement>("script[data-slug]");
  for (const s of scripts) {
    const slug = s.dataset.slug;
    const host = s.dataset.host;
    if (!slug || !host) continue;
    return {
      slug,
      host: host.replace(/\/+$/, ""),
      ...(s.dataset.brand ? { brand: s.dataset.brand } : {}),
      ...(s.dataset.color ? { color: s.dataset.color } : {}),
      ...(s.dataset.auth ? { auth: s.dataset.auth } : {}),
    };
  }
  return null;
}

function init() {
  // biome-ignore lint/suspicious/noExplicitAny: window global flag
  if ((window as any)[INIT_FLAG]) {
    return; // already mounted
  }
  // biome-ignore lint/suspicious/noExplicitAny: window global flag
  (window as any)[INIT_FLAG] = true;

  const cfg = readConfig();
  if (!cfg) {
    console.warn("[lead-engine widget] missing data-slug or data-host on <script> tag");
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountWidget(cfg));
  } else {
    mountWidget(cfg);
  }
}

init();
