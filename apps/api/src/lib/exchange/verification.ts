import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { contacts, conversations } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

export interface ExchangeVerificationStatus {
  verified: boolean;
  verificationId: string | null;
  status: string;
  needsVerification: boolean;
}

export async function getExchangeVerificationStatus(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<ExchangeVerificationStatus> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ attributesJson: contacts.attributesJson })
      .from(conversations)
      .innerJoin(
        contacts,
        and(eq(contacts.id, conversations.userId), eq(contacts.tenantId, tenantId)),
      )
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
      .limit(1);

    if (!row?.attributesJson) {
      return {
        verified: false,
        verificationId: null,
        status: "missing",
        needsVerification: true,
      };
    }

    let attrs: Record<string, unknown> = {};
    try {
      attrs = JSON.parse(row.attributesJson) as Record<string, unknown>;
    } catch {
      return {
        verified: false,
        verificationId: null,
        status: "bad_attributes",
        needsVerification: true,
      };
    }

    const exchangeKyc = attrs.exchangeKyc as Record<string, unknown> | undefined;
    const status = String(
      exchangeKyc?.status ?? attrs.verificationStatus ?? attrs.kycStatus ?? "missing",
    );
    const verificationId =
      typeof exchangeKyc?.verificationId === "string"
        ? exchangeKyc.verificationId
        : typeof attrs.verificationCrmId === "string"
          ? attrs.verificationCrmId
          : null;
    const verified = status === "verified" || attrs.isVerified === true;

    return {
      verified,
      verificationId,
      status: verified ? "verified" : status,
      needsVerification: !verified,
    };
  });
}
