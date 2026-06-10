import { describe, expect, it } from "bun:test";
import { canAccessAdminRoute } from "./admin-rbac.ts";

describe("admin RBAC", () => {
	it("does not restrict superadmin", () => {
		expect(
			canAccessAdminRoute("superadmin", "DELETE", "/api/admin/leads/42"),
		).toBe(true);
		expect(
			canAccessAdminRoute("superadmin", "PUT", "/api/admin/llm-configs/chat"),
		).toBe(true);
		expect(
			canAccessAdminRoute("superadmin", "GET", "/api/admin/diagnostics"),
		).toBe(true);
	});

	it("allows manager daily workbench endpoints", () => {
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/dashboard")).toBe(
			true,
		);
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/events")).toBe(
			true,
		);
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/leads")).toBe(
			true,
		);
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/leads/42")).toBe(
			true,
		);
		expect(canAccessAdminRoute("manager", "POST", "/api/admin/leads")).toBe(
			true,
		);
		expect(
			canAccessAdminRoute("manager", "POST", "/api/admin/leads/42/advance"),
		).toBe(true);
		expect(
			canAccessAdminRoute("manager", "PUT", "/api/admin/leads/42/field-values"),
		).toBe(true);
		expect(
			canAccessAdminRoute(
				"manager",
				"POST",
				"/api/admin/conversations/9/reply",
			),
		).toBe(true);
		expect(
			canAccessAdminRoute("manager", "PATCH", "/api/admin/conversations/9"),
		).toBe(true);
	});

	it("allows manager read-only funnel metadata needed by work pages", () => {
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/funnel")).toBe(
			true,
		);
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/funnel?primary=1"),
		).toBe(true);
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/funnels")).toBe(
			true,
		);
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/funnels/3")).toBe(
			true,
		);
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/funnel/phase-stats"),
		).toBe(true);
		expect(
			canAccessAdminRoute(
				"manager",
				"GET",
				"/api/admin/funnel/analytics?primary=1",
			),
		).toBe(true);
	});

	it("allows manager personal notification endpoints", () => {
		expect(
			canAccessAdminRoute(
				"manager",
				"GET",
				"/api/admin/notifications/settings",
			),
		).toBe(true);
		expect(
			canAccessAdminRoute(
				"manager",
				"PUT",
				"/api/admin/notifications/settings",
			),
		).toBe(true);
		expect(
			canAccessAdminRoute(
				"manager",
				"POST",
				"/api/admin/notifications/settings/link",
			),
		).toBe(true);
		expect(
			canAccessAdminRoute(
				"manager",
				"GET",
				"/api/admin/notifications/informer/feed",
			),
		).toBe(true);
	});

	it("allows manager exchange order operations but not exchange setup writes", () => {
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/exchange/orders"),
		).toBe(true);
		expect(
			canAccessAdminRoute("manager", "PATCH", "/api/admin/exchange/orders/7"),
		).toBe(true);
		expect(
			canAccessAdminRoute(
				"manager",
				"POST",
				"/api/admin/exchange/orders/7/confirm-payment",
			),
		).toBe(true);
		expect(
			canAccessAdminRoute("manager", "POST", "/api/admin/exchange/rates"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "POST", "/api/admin/exchange/requisites"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "PUT", "/api/admin/exchange/settings"),
		).toBe(false);
	});

	it("denies manager owner-only and destructive endpoints", () => {
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/diagnostics"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/billing/usage"),
		).toBe(false);
		expect(canAccessAdminRoute("manager", "GET", "/api/admin/audit-log")).toBe(
			false,
		);
		expect(
			canAccessAdminRoute("manager", "PUT", "/api/admin/llm-configs/chat"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "POST", "/api/admin/channels/telegram"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "PATCH", "/api/admin/leads/42/stage"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "POST", "/api/admin/funnel/stages"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "PATCH", "/api/admin/funnel/stages/12"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "DELETE", "/api/admin/leads/42"),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/leads/export.csv"),
		).toBe(false);
		expect(
			canAccessAdminRoute(
				"manager",
				"GET",
				"/api/admin/conversations/not-a-number",
			),
		).toBe(false);
		expect(
			canAccessAdminRoute(
				"manager",
				"PATCH",
				"/api/admin/exchange/orders/pending",
			),
		).toBe(false);
		expect(
			canAccessAdminRoute(
				"manager",
				"POST",
				"/api/admin/notifications/group-link",
			),
		).toBe(false);
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/notifications/rules"),
		).toBe(false);
	});

	it("normalizes trailing slashes and ignores query strings", () => {
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/leads/?limit=20"),
		).toBe(true);
		expect(
			canAccessAdminRoute("manager", "GET", "/api/admin/conversations/12/?x=1"),
		).toBe(true);
	});
});
