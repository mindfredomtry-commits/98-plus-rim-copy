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
  /** Existing unbound canonical Ban. Claim binds it and must not allocate another. */
  ban: Ban;
  receiver: Readonly<{
    revision: number;
    snapshot: ProductSnapshot;
  }>;
}>;

export type SenderClaimObservationContext = Readonly<{
  ownerId: UserId;
  share: ShareOperation;
  ban: Ban;
  sender: Readonly<{
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
  /**
   * Optional same-transaction sender write. The product claim path does not
   * pass this and does not emit CREATE_BAN.CLAIM_OBSERVED. A non-APPLIED
   * result still aborts the whole claim.
   */
  observeSender?: (context: SenderClaimObservationContext) => TransitionResult | null;
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
  | { action: "BIND"; banId: BanId }
  | { action: "ALREADY_BOUND"; banId: BanId }
  | { action: "CONFLICT"; banId: BanId | null }
  | { action: "REJECTED"; reason: "SENDER" | "CANCELLED" | "MALFORMED" } {
  if (ownerId === receiverId) {
    return { action: "REJECTED", reason: "SENDER" };
  }
  if (share.status === "CANCELLED") {
    return { action: "REJECTED", reason: "CANCELLED" };
  }
  if (share.status === "CONFIRMED" || share.status === "ACTIVE") {
    if (!share.createdBanId || !ban || ban.id !== share.createdBanId || ban.senderId !== ownerId) {
      return { action: "REJECTED", reason: "MALFORMED" };
    }
    if (ban.receiverId === null) {
      if (share.status !== "ACTIVE") {
        return { action: "REJECTED", reason: "MALFORMED" };
      }
      return { action: "BIND", banId: share.createdBanId };
    }
    if (ban.receiverId === receiverId) {
      return { action: "ALREADY_BOUND", banId: share.createdBanId };
    }
    return { action: "CONFLICT", banId: share.createdBanId };
  }
  return { action: "REJECTED", reason: "MALFORMED" };
}

export function receiverSnapshotForClaim(
  snapshot: ProductSnapshot,
  share: ShareOperation,
  ban: Ban,
): ProductSnapshot {
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: {
        ...snapshot.extended.entities,
        bans: { ...snapshot.extended.entities.bans, [ban.id]: ban },
        shareOperations: {
          ...snapshot.extended.entities.shareOperations,
          [share.attemptId]: share,
        },
      },
    },
  };
}

/** The existing Ban is bound to this recipient and no second Ban id appeared. */
export function boundExistingClaimBan(
  before: ProductSnapshot,
  after: ProductSnapshot,
  banId: BanId,
  receiverId: UserId,
  ownerId: UserId,
): Ban | null {
  const extra = Object.keys(after.extended.entities.bans).filter(
    (id) => id !== banId && !(id in before.extended.entities.bans),
  );
  if (extra.length > 0) {
    return null;
  }
  const afterBan = after.extended.entities.bans[banId];
  if (!afterBan || afterBan.senderId !== ownerId || afterBan.receiverId !== receiverId) {
    return null;
  }
  if (afterBan.boundViaTelegramShareLink !== true) {
    return null;
  }
  return afterBan;
}

export function newClaimIncomingCount(
  before: ProductSnapshot,
  after: ProductSnapshot,
  banId: BanId,
  receiverId: UserId,
): number {
  const prior = new Set(Object.keys(before.extended.entities.notificationItems));
  return Object.values(after.extended.entities.notificationItems).filter(
    (item) =>
      !prior.has(item.id) &&
      item.kind === "INCOMING_BAN" &&
      item.banId === banId &&
      item.ownerId === receiverId,
  ).length;
}

/**
 * Receiver persist must not adopt the sender-owned share or record the bound Ban
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
