import type { SqlQueryResult } from "@98plus/identity";
import type {
  Ban,
  CanonicalEventId,
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
import type { ClaimTemplateShareInput, ClaimTemplateShareResult } from "./claim-template-share.ts";
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

/** The applied Matrix row that produced this Product commit. History projection uses it. */
export type AppliedProductRule = Readonly<{
  eventId: CanonicalEventId;
  branch: string;
}>;

export type PersistTransitionInput = Readonly<{
  currentUserId: UserId;
  expectedRevision: number;
  result: TransitionResult;
  appliedRule?: AppliedProductRule;
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

export type RimOwnershipOperationKind = "initialization" | "user-attempt";

export type RimOwnershipReleaseReason =
  "completed" | "owner-terminated" | "chat-abandoned" | "superseded";

export type RimOwnershipPhase = "held" | "renewal-lapsed" | "released";

/**
 * One provider-call owner. `phase` is derived from PostgreSQL time on read.
 * A lapsed lease does not change `ownerToken`.
 */
export type RimProviderOwnership = Readonly<{
  userId: UserId;
  operationKind: RimOwnershipOperationKind;
  attemptId: string;
  requestId: string | null;
  ownerToken: string;
  leasedUntil: string;
  releasedAt: string | null;
  releaseReason: RimOwnershipReleaseReason | null;
  phase: RimOwnershipPhase;
}>;

export type RimOwnershipKey = Readonly<{
  currentUserId: UserId;
  operationKind: RimOwnershipOperationKind;
  attemptId: string;
}>;

/**
 * Writes the acceptance-unknown runtime and the ownership row in one transaction.
 * A lost insert does not replace an existing token and does not write the runtime.
 */
export type AcquireRimProviderOwnershipInput = Readonly<{
  currentUserId: UserId;
  expectedRevision: number;
  runtime: unknown;
  operationKind: RimOwnershipOperationKind;
  attemptId: string;
  requestId: string | null;
  leaseSeconds: number;
}>;

export type AcquireRimProviderOwnershipResult =
  | {
      readonly status: "ACQUIRED";
      readonly loaded: LoadedSnapshot;
      readonly ownership: RimProviderOwnership;
    }
  | {
      readonly status: "ALREADY_PRESENT";
      readonly loaded: LoadedSnapshot;
      readonly ownership: RimProviderOwnership;
    };

export type RenewRimProviderOwnershipInput = RimOwnershipKey &
  Readonly<{
    ownerToken: string;
    leaseSeconds: number;
  }>;

export type RimOwnershipTokenRejection = "ABSENT" | "TOKEN_MISMATCH" | "ALREADY_RELEASED";

export type RenewRimProviderOwnershipResult =
  | { readonly status: "RENEWED"; readonly ownership: RimProviderOwnership }
  | {
      readonly status: "REJECTED";
      readonly reason: RimOwnershipTokenRejection | "EXPIRED";
      readonly ownership: RimProviderOwnership | null;
    };

export type ReleaseRimProviderOwnershipInput = RimOwnershipKey &
  Readonly<{
    ownerToken: string;
    releaseReason: "completed" | "owner-terminated";
  }>;

export type ReleaseRimProviderOwnershipResult =
  | { readonly status: "RELEASED"; readonly ownership: RimProviderOwnership }
  | {
      readonly status: "REJECTED";
      readonly reason: RimOwnershipTokenRejection;
      readonly ownership: RimProviderOwnership | null;
    };

export type InvalidateRimProviderOwnershipInput = RimOwnershipKey &
  Readonly<{
    releaseReason: "chat-abandoned" | "superseded";
  }>;

export type InvalidateRimProviderOwnershipResult =
  | { readonly status: "INVALIDATED"; readonly ownership: RimProviderOwnership }
  | { readonly status: "ABSENT" }
  | { readonly status: "ALREADY_RELEASED"; readonly ownership: RimProviderOwnership };

/**
 * Session row, then ownership row. The callback decides what to do.
 * Writes stay on this transaction. The store does not choose E-64 or a successor.
 * `revision`, `runtime`, and `ownership` are the values at lock time.
 */
export type RimOwnershipCoordinationContext = Readonly<{
  revision: number;
  runtime: unknown | null;
  ownership: RimProviderOwnership | null;
  invalidate(
    reason: "chat-abandoned" | "superseded",
  ): Promise<InvalidateRimProviderOwnershipResult>;
  load(): Promise<LoadedSnapshot>;
  replaceRuntime(runtime: unknown): Promise<LoadedSnapshot>;
  release(
    ownerToken: string,
    reason: "completed" | "owner-terminated",
  ): Promise<ReleaseRimProviderOwnershipResult>;
  persistApplied(input: PersistTransitionInput): Promise<LoadedSnapshot>;
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
    currentUserId: UserId,
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
  getShareByAttemptId(attemptId: string): Promise<StoredShareLookup | null>;
  /**
   * Atomically mint one Template Ban for an authenticated non-sender.
   * The share row stays owned by the sender. Receiver session/items are the
   * only user snapshot written. Sender control state is not updated.
   */
  claimTemplateShare(input: ClaimTemplateShareInput): Promise<ClaimTemplateShareResult>;
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
  /**
   * Insert ownership and replace the provider runtime in the same transaction.
   * The caller commits this before any provider call. An existing row keeps its token.
   */
  acquireRimProviderOwnership(
    input: AcquireRimProviderOwnershipInput,
  ): Promise<AcquireRimProviderOwnershipResult>;
  /**
   * Extend `leased_until` from PostgreSQL time when the token still holds an unexpired lease.
   * Does not change the Product session revision or the owner token.
   */
  renewRimProviderOwnership(
    input: RenewRimProviderOwnershipInput,
  ): Promise<RenewRimProviderOwnershipResult>;
  /**
   * Token-checked close. A lapsed lease may still be released by its original token.
   * Does not change the Product session revision or transfer the token.
   */
  releaseRimProviderOwnership(
    input: ReleaseRimProviderOwnershipInput,
  ): Promise<ReleaseRimProviderOwnershipResult>;
  /** Read one ownership row. Absence is not abandonment. */
  lookupRimProviderOwnership(key: RimOwnershipKey): Promise<RimProviderOwnership | null>;
  /**
   * Mark a row chat-abandoned or superseded without the owner token.
   * Locks the session row, then the ownership row. Does not change Product revision.
   */
  invalidateRimProviderOwnership(
    input: InvalidateRimProviderOwnershipInput,
  ): Promise<InvalidateRimProviderOwnershipResult>;
  /**
   * Hold the session row, then the ownership row, for one callback.
   * Lock order is fixed. The callback's throw rolls the transaction back.
   */
  withRimProviderOwnershipCoordination<T>(
    key: RimOwnershipKey,
    run: (context: RimOwnershipCoordinationContext) => Promise<T>,
  ): Promise<T>;
};

export type BanRow = Ban & Readonly<{ createdSeq: number }>;
export type StoredShareOperation = ShareOperation & Readonly<{ ownerId: UserId }>;
export type StoredPendingOperation = PendingOperation & Readonly<{ ownerId: UserId }>;
export type StoredNotificationItem = NotificationItem;
export type StoredDomainTimer = DomainTimer;
export type StoredCheckPair = CheckPair;
export type StoredPendingExternalEntry = PendingExternalEntry | null;
