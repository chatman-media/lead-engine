// Tenant resolution из HTTP Host header. Используется admin-API routes
// (NE webhook'ами — Telegram/Meta не могут динамически DNS per tenant,
// у них всё remains path-based: /webhook/telegram/:slug).
//
// Поддерживаемые форматы (resolveTenantFromHost):
//   1. subdomain:    `<slug>.<baseDomain>` → slug
//   2. path-prefix:  `<baseDomain>/t/<slug>/...` (для shared-domain setup)
//   3. apex:         `<baseDomain>` → null (для public landing / health)
//
// Slug-валидация: только [a-z0-9-], 1..63 char, начинается с буквы — это
// тоже соответствует ограничениям tenants.slug в БД (lowercase friendly).

export interface TenantHostConfig {
  /**
   * Корневой домен платформы — всё что справа от subdomain'а. Без leading
   * dot'а. Примеры: "adminstuff.example", "leadengine.app". Используется
   * для проверки что incoming Host точно из нашей зоны (не подделанный).
   */
  baseDomain: string;
  /**
   * Опционально: reserved subdomain'ы, которые НЕ считаются tenant.slug.
   * Default ["www", "api", "admin", "app", "public"]. Запрос на "api.example"
   * НЕ резолвится как tenant slug='api', возвращает null (apex behavior).
   */
  reservedSubdomains?: readonly string[];
}

const DEFAULT_RESERVED = ["www", "api", "admin", "app", "public"] as const;
const SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Извлекает tenant slug из Host header. Возвращает:
 *   - { kind: "tenant", slug } если subdomain валиден и не reserved
 *   - { kind: "apex" } если Host = baseDomain или reserved subdomain
 *   - null если Host не из нашего baseDomain (potentially spoofed)
 */
export function resolveTenantFromHost(
  host: string | null | undefined,
  cfg: TenantHostConfig,
): { kind: "tenant"; slug: string } | { kind: "apex" } | null {
  if (!host) return null;
  // Strip port если присутствует (например "studio.example.com:3000").
  const hostnameOnly = host.split(":")[0]!.toLowerCase();
  const base = cfg.baseDomain.toLowerCase();
  if (hostnameOnly === base) return { kind: "apex" };
  if (!hostnameOnly.endsWith(`.${base}`)) return null;

  // Извлекаем subdomain — всё что слева от ".<base>".
  const subdomain = hostnameOnly.slice(0, hostnameOnly.length - base.length - 1);
  if (subdomain.length === 0) return { kind: "apex" };
  // Multi-level subdomain (например "preview.studio.example") — берём только
  // первый сегмент как slug; преффикс справа от него игнорируем.
  // Для безопасности: запретим если в subdomain'е есть dot — это nested
  // subdomain'ы, потенциальная атака (admin.evil.example.com обходит check).
  if (subdomain.includes(".")) return null;

  const reserved = cfg.reservedSubdomains ?? DEFAULT_RESERVED;
  if (reserved.includes(subdomain)) return { kind: "apex" };
  if (!SLUG_RE.test(subdomain)) return null;
  return { kind: "tenant", slug: subdomain };
}

/**
 * Альтернативный path-prefix форму резолвинга для shared-domain setup'ов:
 *   `/t/<slug>/<rest>` → { slug, rest: '/<rest>' }
 * Возвращает null если path не начинается с `/t/<slug>/`.
 */
export function resolveTenantFromPath(path: string): { slug: string; rest: string } | null {
  const match = /^\/t\/([a-z][a-z0-9-]{0,62})(\/.*)?$/.exec(path);
  if (!match) return null;
  return { slug: match[1]!, rest: match[2] ?? "/" };
}
