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
