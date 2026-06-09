import { describe, expect, it } from "bun:test";
import { getExchangeVerificationStatus } from "./verification.ts";

type Row = { attributesJson: string | null } | undefined;

function dbReturning(row: Row) {
	const executeCalls: unknown[] = [];
	const tx = {
		execute: async (query: unknown) => {
			executeCalls.push(query);
		},
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: () => ({
						limit: async () => (row ? [row] : []),
					}),
				}),
			}),
		}),
	};
	return {
		db: {
			transaction: async <T>(fn: (innerTx: typeof tx) => Promise<T>) => fn(tx),
		},
		executeCalls,
	};
}

describe("getExchangeVerificationStatus", () => {
	it("requires verification when no contact attributes are stored", async () => {
		const { db, executeCalls } = dbReturning({ attributesJson: null });

		await expect(
			getExchangeVerificationStatus(db as never, 42, 100),
		).resolves.toEqual({
			verified: false,
			verificationId: null,
			status: "missing",
			needsVerification: true,
		});
		expect(executeCalls).toHaveLength(1);
	});

	it("requires verification when contact attributes are not valid JSON", async () => {
		const { db } = dbReturning({ attributesJson: "{" });

		await expect(
			getExchangeVerificationStatus(db as never, 42, 100),
		).resolves.toEqual({
			verified: false,
			verificationId: null,
			status: "bad_attributes",
			needsVerification: true,
		});
	});

	it("reads verified exchangeKyc payloads with provider verification ids", async () => {
		const { db } = dbReturning({
			attributesJson: JSON.stringify({
				exchangeKyc: { status: "verified", verificationId: "crm-123" },
			}),
		});

		await expect(
			getExchangeVerificationStatus(db as never, 42, 100),
		).resolves.toEqual({
			verified: true,
			verificationId: "crm-123",
			status: "verified",
			needsVerification: false,
		});
	});

	it("falls back to legacy verification status and CRM id attributes", async () => {
		const { db } = dbReturning({
			attributesJson: JSON.stringify({
				verificationStatus: "pending_review",
				verificationCrmId: "legacy-crm-7",
			}),
		});

		await expect(
			getExchangeVerificationStatus(db as never, 42, 100),
		).resolves.toEqual({
			verified: false,
			verificationId: "legacy-crm-7",
			status: "pending_review",
			needsVerification: true,
		});
	});

	it("normalizes legacy isVerified contacts to verified", async () => {
		const { db } = dbReturning({
			attributesJson: JSON.stringify({
				kycStatus: "manual_override",
				isVerified: true,
			}),
		});

		await expect(
			getExchangeVerificationStatus(db as never, 42, 100),
		).resolves.toEqual({
			verified: true,
			verificationId: null,
			status: "verified",
			needsVerification: false,
		});
	});
});
