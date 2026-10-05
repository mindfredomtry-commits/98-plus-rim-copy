import type {
  Ban,
  ProductSnapshot,
  ShareOperation,
  TransitionResult,
  UserId,
} from "@98plus/product-model";
import type { BanId } from "@98plus/product-model";

export type TemplateShareClaimContext = Readonly<{
  share: ShareOperation;
  ownerId: UserId;
  receiver: Readonly<{
    revision: number;
    snapshot: ProductSnapshot;
  }>;
}>;

export type ClaimTemplateShareInput = Readonly<{
  receiverId: UserId;
  token: string;
  /**
   * Runs inside the share claim transaction after the share row is re-read.
   * Must be synchronous. A non-APPLIED result writes nothing.
   */
  reduceClaim: (context: TemplateShareClaimContext) => TransitionResult;
}>;

export type ClaimTemplateShareResult =
  | {
      status: "CLAIMED";
      loadedRevision: number;
      loadedSnapshot: ProductSnapshot;
      banId: BanId;
      transition: TransitionResult;
    }
  | { status: "ALREADY_BOUND"; banId: BanId }
  | { status: "CONFLICT"; banId: BanId | null }
  | {
      status: "REJECTED";
      reason: "UNKNOWN_TOKEN" | "SENDER" | "CANCELLED" | "MALFORMED";
    }
  | { status: "NOT_APPLIED"; transition: TransitionResult };

export function classifyShareForClaim(
  ownerId: UserId,
  share: ShareOperation,
  receiverId: UserId,
  ban: Ban | null,
):
  | { action: "MINT" }
  | { action: "ALREADY_BOUND"; banId: BanId }
  | { action: "CONFLICT"; banId: BanId | null }
  | { action: "REJECTED"; reason: "SENDER" | "CANCELLED" | "MALFORMED" } {
  if (ownerId === receiverId) {
    return { action: "REJECTED", reason: "SENDER" };
  }
  if (share.status === "CANCELLED") {
    return { action: "REJECTED", reason: "CANCELLED" };
  }
  if (share.status === "CONFIRMED") {
    if (!share.createdBanId || !ban) {
      return { action: "REJECTED", reason: "MALFORMED" };
    }
    if (ban.receiverId === receiverId) {
      return { action: "ALREADY_BOUND", banId: share.createdBanId };
    }
    if (ban.receiverId !== null) {
      return { action: "CONFLICT", banId: share.createdBanId };
    }
    return { action: "REJECTED", reason: "MALFORMED" };
  }
  if (share.status === "ACTIVE" && share.createdBanId === null) {
    return { action: "MINT" };
  }
  return { action: "REJECTED", reason: "MALFORMED" };
}

export function createdClaimBan(before: ProductSnapshot, after: ProductSnapshot): Ban | null {
  const prior = new Set(Object.keys(before.extended.entities.bans));
  const created = Object.values(after.extended.entities.bans).filter((ban) => !prior.has(ban.id));
  return created.length === 1 ? (created[0] ?? null) : null;
}

/**
 * Receiver persist must not adopt the sender-owned share or record the minted Ban
 * as the receiver's successfulBanId.
 */
export function snapshotForReceiverClaimPersist(
  before: ProductSnapshot,
  after: ProductSnapshot,
  shareAttemptId: string,
): ProductSnapshot {
  const shareOperations = { ...after.extended.entities.shareOperations };
  delete shareOperations[shareAttemptId];
  return {
    ...after,
    extended: {
      ...after.extended,
      successfulBanId: before.extended.successfulBanId,
      entities: {
        ...after.extended.entities,
        shareOperations,
      },
    },
  };
}
