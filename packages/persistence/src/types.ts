import type { SqlQueryResult } from "@98plus/identity";
import type {
  Ban,
  CheckPair,
  DomainTimer,
  NotificationItem,
  PendingExternalEntry,
  PendingOperation,
  ProductSnapshot,
  RelationshipBan,
  ShareOperation,
  TransitionResult,
} from "@98plus/product-model";
import type { BanId, UserId } from "@98plus/product-model";

export type PersistenceSqlClient = {
  query<T>(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<T>>;
  transaction<T>(fn: (tx: PersistenceSqlClient) => Promise<T>): Promise<T>;
};

export type LoadedSnapshot = Readonly<{
  snapshot: ProductSnapshot;
  revision: number;
  /** Persistence-only bootstrap send marker for Telegram Persistent Re-entry. */
  telegramPersistentReentryBootstrapSent: boolean;
  /** Persistence-only active claim lease expiry (epoch ms); null if unclaimed. */
  telegramPersistentReentryBootstrapClaimedUntilMs: number | null;
  /** Persistence-only fencing token for the active claim; null if unclaimed. */
  telegramPersistentReentryBootstrapClaimToken: string | null;
}>;

export type PersistTransitionInput = Readonly<{
  currentUserId: UserId;
  expectedRevision: number;
  result: TransitionResult;
}>;

/** Atomic E-45 receiver bind + APPLIED transition persist (single commit boundary). */
export type PersistShareLinkResolvedInput = PersistTransitionInput &
  Readonly<{
    banId: BanId;
    receiverId: UserId;
  }>;

export type PersistShareLinkResolvedResult =
  | {
      status: "PERSISTED";
      loaded: LoadedSnapshot;
      bindStatus: "BOUND" | "ALREADY_BOUND";
    }
  | {
      status: "BIND_REJECTED";
      bindStatus: "MISSING" | "CONFLICT";
    };

export type CheckPairLockContext = Readonly<{
  pair: CheckPair | null;
  loadProductSnapshot(currentUserId: UserId): Promise<LoadedSnapshot>;
  persistTransition(input: PersistTransitionInput): Promise<LoadedSnapshot>;
}>;

export type RelationshipBanRecord = Readonly<{
  banId: BanId;
  createdSeq: number;
  relationshipBan: RelationshipBan;
}>;

export type BanReceiverBindResult =
  | { status: "BOUND"; ban: Ban }
  | { status: "ALREADY_BOUND"; ban: Ban }
  | { status: "CONFLICT"; ban: Ban }
  | { status: "MISSING" };

export type StoredShareLookup = Readonly<{
  share: ShareOperation;
  ownerId: UserId;
}>;

/** Durable mark of confirmed bootstrap Bot API delivery (not a Product Event). */
export type MarkTelegramPersistentReentryBootstrapSentResult =
  | { status: "MARKED" }
  | { status: "ALREADY_MARKED" }
  | { status: "NOT_REQUIRED" }
  | { status: "STALE_CLAIM" };

/** Atomic claim of pending bootstrap delivery before external send. */
export type ClaimTelegramPersistentReentryBootstrapDeliveryResult =
  | { status: "CLAIMED"; claimToken: string; claimedUntilMs: number }
  | { status: "ALREADY_CLAIMED"; claimedUntilMs: number }
  | { status: "ALREADY_SENT" }
  | { status: "NOT_REQUIRED" };

export type ReleaseTelegramPersistentReentryBootstrapClaimResult =
  | { status: "RELEASED" }
  | { status: "NOT_HELD" }
  | { status: "ALREADY_SENT" }
  | { status: "STALE_CLAIM" };

export type ProductStore = {
  loadProductSnapshot(currentUserId: UserId): Promise<LoadedSnapshot>;
  persistTransition(input: PersistTransitionInput): Promise<LoadedSnapshot>;
  /**
   * CAS-bind Ban.receiverId and persist an APPLIED E-45 transition in one transaction.
   * On BIND_REJECTED or any throw before commit, receiverId must remain unchanged.
   */
  persistShareLinkResolved(
    input: PersistShareLinkResolvedInput,
  ): Promise<PersistShareLinkResolvedResult>;
  /**
   * Atomically claim pending bootstrap delivery ownership before Telegram send.
   * Stale claims (claimedUntilMs <= nowMs) may be reclaimed with a new claimToken.
   */
  claimTelegramPersistentReentryBootstrapDelivery(
    currentUserId: UserId,
    nowMs: number,
    leaseMs: number,
  ): Promise<ClaimTelegramPersistentReentryBootstrapDeliveryResult>;
  /**
   * Mark bootstrap delivery completed only after confirmed successful external send.
   * Requires matching claimToken fencing ownership. Clears claim on success.
   */
  markTelegramPersistentReentryBootstrapSent(
    currentUserId: UserId,
    claimToken: string,
  ): Promise<MarkTelegramPersistentReentryBootstrapSentResult>;
  /**
   * Release an in-flight claim after confirmed send failure so a later retry may claim.
   * Requires matching claimToken fencing ownership.
   */
  releaseTelegramPersistentReentryBootstrapClaim(
    currentUserId: UserId,
    claimToken: string,
  ): Promise<ReleaseTelegramPersistentReentryBootstrapClaimResult>;
  withCheckPairLock<T>(
    pairId: string,
    run: (context: CheckPairLockContext) => Promise<T>,
  ): Promise<T>;
  listRelationshipBans(
    leftUserId: UserId,
    rightUserId: UserId,
  ): Promise<readonly RelationshipBanRecord[]>;
  findShareByToken(token: string): Promise<StoredShareLookup | null>;
  getBanById(banId: BanId): Promise<Ban | null>;
  bindBanReceiver(banId: BanId, receiverId: UserId): Promise<BanReceiverBindResult>;
};

export type BanRow = Ban & Readonly<{ createdSeq: number }>;
export type StoredShareOperation = ShareOperation & Readonly<{ ownerId: UserId }>;
export type StoredPendingOperation = PendingOperation & Readonly<{ ownerId: UserId }>;
export type StoredNotificationItem = NotificationItem;
export type StoredDomainTimer = DomainTimer;
export type StoredCheckPair = CheckPair;
export type StoredPendingExternalEntry = PendingExternalEntry | null;
