-- replace global slug unique with per-tenant (tenant_id, slug) unique
ALTER TABLE "skills" DROP CONSTRAINT "skills_slug_unique";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_slug_unique" UNIQUE("tenant_id", "slug");
