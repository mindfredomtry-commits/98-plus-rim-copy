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

export type ProductStore = {
  loadProductSnapshot(currentUserId: UserId): Promise<LoadedSnapshot>;
  persistTransition(input: PersistTransitionInput): Promise<LoadedSnapshot>;
  withCheckPairLock<T>(
    pairId: string,
    run: (context: CheckPairLockContext) => Promise<T>,
  ): Promise<T>;
  listRelationshipBans(
    leftUserId: UserId,
    rightUserId: UserId,
  ): Promise<readonly RelationshipBanRecord[]>;
};

export type BanRow = Ban & Readonly<{ createdSeq: number }>;
export type StoredShareOperation = ShareOperation & Readonly<{ ownerId: UserId }>;
export type StoredPendingOperation = PendingOperation & Readonly<{ ownerId: UserId }>;
export type StoredNotificationItem = NotificationItem;
export type StoredDomainTimer = DomainTimer;
export type StoredCheckPair = CheckPair;
export type StoredPendingExternalEntry = PendingExternalEntry | null;
