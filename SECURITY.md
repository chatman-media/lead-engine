# Security Policy

## Reporting a Vulnerability

Please **do not** open public GitHub issues for security vulnerabilities.

Preferred channel: **GitHub private vulnerability reporting** —
[Report a vulnerability](https://github.com/chatman-media/lead-engine/security/advisories/new)
(private to maintainers, supports CVE issuance).

Alternatively, email **ak.chatman.media@gmail.com** with subject
`[SECURITY] lead-engine: <short summary>`.

Include where possible: affected component (`apps/*` / `packages/*` / hosted
instance), reproduction steps or PoC, impact assessment, and suggested fix.

We aim to acknowledge reports within **72 hours** and to ship a fix or
mitigation for confirmed issues within **14 days**, keeping you informed along
the way. With your consent we will credit you in the advisory.

## Scope

- Source code in this repository: `apps/*`, `packages/*`, deploy/CI scripts.
- Hosted instances: `exchanges.agency`, `client.exchanges.agency` (production)
  and `dev.exchanges.agency` (development).

High-value areas: tenant isolation (Postgres RLS bypass), secrets handling
(AES-256-GCM `tenant_secrets`), webhook signature verification, auth/JWT,
rate limiting, exchange order/payout flows.

## Rules of Engagement

- **Do not test against production tenants or real customer data.** Run the
  stack locally (see README Quick Start) — it reproduces the full platform,
  or test against your own tenant on the dev instance.
- No volumetric/DoS attacks, spam, social engineering, or physical attacks.
- Do not access, modify, or exfiltrate data that is not yours; if you stumble
  into someone else's data, stop and report immediately.

## Out of Scope

- Vulnerabilities only present in third-party dependencies without a working
  exploit path in this project (please report upstream as well).
- Missing best-practice headers/flags without demonstrated impact.
- Reports from automated scanners without validation.

## Supported Versions

Only the latest `main` branch and the currently deployed production release
receive security fixes.
