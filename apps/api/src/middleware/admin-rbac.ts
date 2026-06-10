import { createMiddleware } from "hono/factory";

type AdminRole = "superadmin" | "manager";
type RuleMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface AccessRule {
	method: RuleMethod;
	path: string;
}

const NUMERIC_ID_PATTERN = /^\d+$/;

const MANAGER_ALLOWED_RULES: AccessRule[] = [
	// Shell + daily overview.
	{ method: "GET", path: "/api/admin/dashboard" },
	{ method: "GET", path: "/api/admin/events" },
	{ method: "GET", path: "/api/admin/onboarding-status" },
	{ method: "GET", path: "/api/admin/tenant" },
	{ method: "GET", path: "/api/admin/admins" },

	// Lead workbench: read, notes, field filling and controlled workflow actions.
	{ method: "GET", path: "/api/admin/leads" },
	{ method: "GET", path: "/api/admin/leads/:id" },
	{ method: "GET", path: "/api/admin/contacts" },
	{ method: "POST", path: "/api/admin/leads" },
	{ method: "POST", path: "/api/admin/leads/:id/advance" },
	{ method: "PUT", path: "/api/admin/leads/:id/field-values" },
	{ method: "POST", path: "/api/admin/leads/:id/notes" },
	{ method: "POST", path: "/api/admin/leads/:id/send-photo" },
	{ method: "POST", path: "/api/admin/leads/:id/send-offer" },

	// Read-only funnel metadata required by dashboard, lead list and lead detail.
	{ method: "GET", path: "/api/admin/funnel" },
	{ method: "GET", path: "/api/admin/funnels" },
	{ method: "GET", path: "/api/admin/funnels/:id" },
	{ method: "GET", path: "/api/admin/funnel/phase-stats" },
	{ method: "GET", path: "/api/admin/funnel/analytics" },

	// Conversation inbox.
	{ method: "GET", path: "/api/admin/conversations" },
	{ method: "GET", path: "/api/admin/conversations/:id" },
	{ method: "POST", path: "/api/admin/conversations/:id/reply" },
	{ method: "POST", path: "/api/admin/conversations/:id/advance" },
	{ method: "PUT", path: "/api/admin/conversations/:id/mode" },
	{ method: "PATCH", path: "/api/admin/conversations/:id" },

	// Personal operator notifications.
	{ method: "GET", path: "/api/admin/notifications/settings" },
	{ method: "PUT", path: "/api/admin/notifications/settings" },
	{ method: "POST", path: "/api/admin/notifications/settings/link" },
	{ method: "POST", path: "/api/admin/notifications/settings/test" },
	{ method: "GET", path: "/api/admin/notifications/informer/feed" },
	{ method: "PUT", path: "/api/admin/notifications/informer" },

	// Exchange operator surface: read config needed by the current page, operate orders.
	{ method: "GET", path: "/api/admin/exchange/rates" },
	{ method: "GET", path: "/api/admin/exchange/settings" },
	{ method: "GET", path: "/api/admin/exchange/requisites" },
	{ method: "GET", path: "/api/admin/exchange/orders" },
	{ method: "GET", path: "/api/admin/exchange/orders/:id" },
	{ method: "GET", path: "/api/admin/exchange/turnover" },
	{ method: "PATCH", path: "/api/admin/exchange/orders/:id" },
	{ method: "POST", path: "/api/admin/exchange/orders/:id/confirm-payment" },
	{ method: "POST", path: "/api/admin/exchange/orders/:id/issue-payout-code" },
];

function normalizePath(pathname: string): string {
	const pathOnly = pathname.split("?")[0] ?? pathname;
	if (pathOnly.length > 1 && pathOnly.endsWith("/"))
		return pathOnly.slice(0, -1);
	return pathOnly;
}

function matchesPath(pattern: string, pathname: string): boolean {
	const patternParts = normalizePath(pattern).split("/").filter(Boolean);
	const pathParts = normalizePath(pathname).split("/").filter(Boolean);
	if (patternParts.length !== pathParts.length) return false;

	return patternParts.every((part, index) => {
		const pathPart = pathParts[index];
		if (!pathPart) return false;
		if (part.startsWith(":")) {
			const paramName = part.slice(1);
			if (paramName === "id" || paramName.endsWith("Id")) {
				return NUMERIC_ID_PATTERN.test(pathPart);
			}
			return pathPart.length > 0;
		}
		return part === pathParts[index];
	});
}

export function canAccessAdminRoute(
	role: AdminRole,
	method: string,
	pathname: string,
): boolean {
	if (role === "superadmin") return true;
	const normalizedMethod = method.toUpperCase();

	return MANAGER_ALLOWED_RULES.some(
		(rule) =>
			rule.method === normalizedMethod && matchesPath(rule.path, pathname),
	);
}

export function makeAdminRbac() {
	return createMiddleware(async (c, next) => {
		if (
			canAccessAdminRoute(c.var.role, c.req.method, new URL(c.req.url).pathname)
		) {
			await next();
			return;
		}

		return c.json({ error: "manager_forbidden" }, 403);
	});
}
