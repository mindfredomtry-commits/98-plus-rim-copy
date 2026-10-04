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
import type { RuntimeAttemptAuthority } from "./runtime-attempt-authority.ts";

export type { RuntimeAttemptAuthority };

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
  /**
   * Persistence-only provider runtime JSON.
   * Absent is null. Applicability is decided by the Application parser, not by this field's presence.
   */
  rimProviderRuntime: unknown | null;
}>;

export type PersistTransitionInput = Readonly<{
  currentUserId: UserId;
  expectedRevision: number;
  result: TransitionResult;
}>;

/**
 * Product commit guarded by the current technical attempt.
 * The attempt check and the snapshot write share one session transaction.
 * `rimProviderRuntime`, when present, replaces that column in the same commit.
 */
export type CommitOwnedTransitionInput = PersistTransitionInput &
  Readonly<{
    requireAttempt: RuntimeAttemptAuthority;
    rimProviderRuntime?: unknown;
  }>;

export type CommitOwnedTransitionResult =
  | { readonly status: "COMMITTED"; readonly loaded: LoadedSnapshot }
  | { readonly status: "ATTEMPT_SUPERSEDED"; readonly loaded: LoadedSnapshot };

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

/** Pair history for the Application RelationshipContext builder. Chronological, not limited to 10. */
export type RelationshipContextSource = Readonly<{
  banId: BanId;
  senderId: UserId;
  receiverId: UserId;
  banText: string;
  acceptance: Ban["acceptance"];
  status: Ban["status"];
  createdSeq: number;
  createdAtMs: number | null;
  timerStartedAtMs: number | null;
  timerState: "RUNNING" | "EXPIRED" | null;
  checkPairCreated: boolean;
  receiverAnswer: CheckPair["receiverAnswer"] | null;
  senderAnswer: CheckPair["senderAnswer"] | null;
  resultingStatus: CheckPair["resultingStatus"] | null;
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
   * Persist an APPLIED transition only while `requireAttempt` is still the locked
   * runtime's current attempt and that attempt is not already marked for retry.
   * A superseded attempt does not write Product state.
   */
  commitOwnedTransition(input: CommitOwnedTransitionInput): Promise<CommitOwnedTransitionResult>;
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
  listRelationshipContextSources(
    leftUserId: UserId,
    rightUserId: UserId,
  ): Promise<readonly RelationshipContextSource[]>;
  findShareByToken(token: string): Promise<StoredShareLookup | null>;
  getBanById(banId: BanId): Promise<Ban | null>;
  bindBanReceiver(banId: BanId, receiverId: UserId): Promise<BanReceiverBindResult>;
  /**
   * Replace the persistence-only provider runtime for this user session.
   * Does not change Product snapshot fields. Requires the current session revision.
   */
  saveRimProviderRuntime(
    currentUserId: UserId,
    expectedRevision: number,
    runtime: unknown | null,
  ): Promise<LoadedSnapshot>;
};

export type BanRow = Ban & Readonly<{ createdSeq: number }>;
export type StoredShareOperation = ShareOperation & Readonly<{ ownerId: UserId }>;
export type StoredPendingOperation = PendingOperation & Readonly<{ ownerId: UserId }>;
export type StoredNotificationItem = NotificationItem;
export type StoredDomainTimer = DomainTimer;
export type StoredCheckPair = CheckPair;
export type StoredPendingExternalEntry = PendingExternalEntry | null;
