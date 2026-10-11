import type {
  Ban,
  CheckPair,
  DomainTimer,
  NotificationItem,
  PendingOperation,
  RelationshipBan,
  ShareOperation,
} from "@98plus/product-model";
import { RELATIONSHIP_BAN_LIMIT } from "@98plus/product-model";
import type { UserId } from "@98plus/product-model";
import type { SessionRecord } from "./codec.ts";
import {
  assertPersistedDuration,
  assertShareStatus,
  cloneJson,
  decodeNotificationItem,
  notificationItemToRecord,
} from "./codec.ts";
import { PersistenceError } from "./errors.ts";
import type {
  BanReceiverBindResult,
  RelationshipBanRecord,
  RelationshipContextSource,
  RimOwnershipOperationKind,
  RimOwnershipReleaseReason,
} from "./types.ts";

type IdentityRow = { userId: UserId; telegramUserId: string };
type BanRecord = Ban & { createdSeq: number; createdAtMs: number };
type ShareRecord = ShareOperation & { ownerId: UserId };
type OperationRecord = PendingOperation & { ownerId: UserId };

type RimChatArchiveRow = {
  rimChatId: string;
  ownerUserId: string;
  contactUserId: string;
  createdAtMs: number;
  terminatedAtMs: number | null;
  terminationReason: string | null;
  openaiConversationId: string | null;
  resultingBanId: string | null;
};

export type OwnershipMemoryRow = {
  userId: string;
  operationKind: RimOwnershipOperationKind;
  attemptId: string;
  requestId: string | null;
  ownerToken: string;
  leasedUntilMs: number;
  releasedAtMs: number | null;
  releaseReason: RimOwnershipReleaseReason | null;
};

type RimMessageArchiveRow = {
  messageKey: string;
  rimChatId: string;
  ordinal: number;
  kind: string;
  payload: unknown;
  sourceAiRequestId: string | null;
  sourceContextRequestId: string | null;
  createdAtMs: number;
};

export type ProductTablesSnapshot = {
  identities: Map<string, IdentityRow>;
  sessions: Map<string, SessionRecord>;
  bans: Map<string, BanRecord>;
  timers: Map<string, DomainTimer>;
  pairs: Map<string, CheckPair>;
  items: Map<string, NotificationItem>;
  operations: Map<string, OperationRecord>;
  shares: Map<string, ShareRecord>;
  rimChats: Map<string, RimChatArchiveRow>;
  rimMessages: Map<string, RimMessageArchiveRow>;
  ownership: Map<string, OwnershipMemoryRow>;
  nextBanSeq: number;
};

function cloneTables(tables: ProductTablesSnapshot): ProductTablesSnapshot {
  return {
    identities: new Map(tables.identities),
    sessions: new Map(
      [...tables.sessions.entries()].map(([key, value]) => [key, cloneJson(value)]),
    ),
    bans: new Map([...tables.bans.entries()].map(([key, value]) => [key, cloneJson(value)])),
    timers: new Map([...tables.timers.entries()].map(([key, value]) => [key, cloneJson(value)])),
    pairs: new Map([...tables.pairs.entries()].map(([key, value]) => [key, cloneJson(value)])),
    items: new Map([...tables.items.entries()].map(([key, value]) => [key, cloneJson(value)])),
    operations: new Map(
      [...tables.operations.entries()].map(([key, value]) => [key, cloneJson(value)]),
    ),
    shares: new Map([...tables.shares.entries()].map(([key, value]) => [key, cloneJson(value)])),
    rimChats: new Map(
      [...tables.rimChats.entries()].map(([key, value]) => [key, cloneJson(value)]),
    ),
    rimMessages: new Map(
      [...tables.rimMessages.entries()].map(([key, value]) => [key, cloneJson(value)]),
    ),
    ownership: new Map(
      [...tables.ownership.entries()].map(([key, value]) => [key, cloneJson(value)]),
    ),
    nextBanSeq: tables.nextBanSeq,
  };
}

function asBan(record: BanRecord): Ban {
  const { createdSeq: _createdSeq, createdAtMs: _createdAtMs, ...ban } = record;
  return ban;
}

export function emptyTables(): ProductTablesSnapshot {
  return {
    identities: new Map(),
    sessions: new Map(),
    bans: new Map(),
    timers: new Map(),
    pairs: new Map(),
    items: new Map(),
    operations: new Map(),
    shares: new Map(),
    rimChats: new Map(),
    rimMessages: new Map(),
    ownership: new Map(),
    nextBanSeq: 1,
  };
}

export class ProductTables {
  private data = emptyTables();
  private pairLockTail = new Map<string, Promise<unknown>>();
  private banLockTail = new Map<string, Promise<unknown>>();

  snapshot(): ProductTablesSnapshot {
    return cloneTables(this.data);
  }

  restore(snapshot: ProductTablesSnapshot): void {
    this.data = cloneTables(snapshot);
  }

  async withPairLock<T>(pairId: string, run: () => Promise<T> | T): Promise<T> {
    const previous = this.pairLockTail.get(pairId) ?? Promise.resolve();
    const current = previous.then(() => run(), () => run());
    this.pairLockTail.set(
      pairId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  async withBanLock<T>(banId: string, run: () => Promise<T> | T): Promise<T> {
    const previous = this.banLockTail.get(banId) ?? Promise.resolve();
    const current = previous.then(() => run(), () => run());
    this.banLockTail.set(
      banId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  async withOrderedBanLocks<T>(banIds: readonly string[], run: () => Promise<T> | T): Promise<T> {
    const ordered = [...new Set(banIds)].sort((a, b) => a.localeCompare(b));
    const acquire = async (index: number): Promise<T> => {
      if (index >= ordered.length) {
        return run();
      }
      return this.withBanLock(ordered[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  }

  getPair(pairId: string): CheckPair | undefined {
    const pair = this.data.pairs.get(pairId);
    return pair ? cloneJson(pair) : undefined;
  }

  transaction<T>(fn: () => T): T {
    const before = this.snapshot();
    try {
      return fn();
    } catch (error) {
      this.restore(before);
      throw error;
    }
  }

  hasUser(userId: string): boolean {
    return this.data.identities.has(userId);
  }

  findIdentityByTelegramUserId(telegramUserId: string): IdentityRow | undefined {
    return [...this.data.identities.values()].find((row) => row.telegramUserId === telegramUserId);
  }

  registerIdentityUser(userId: UserId, telegramUserId: string): void {
    const existing = [...this.data.identities.values()].find(
      (row) => row.telegramUserId === telegramUserId,
    );
    if (existing && existing.userId !== userId) {
      throw new PersistenceError("INVARIANT", "telegram_user_id is unique");
    }
    this.data.identities.set(userId, { userId, telegramUserId });
  }

  requireUser(userId: string, field: string): void {
    if (!this.hasUser(userId)) {
      throw new PersistenceError(
        "IDENTITY_REQUIRED",
        `${field} must reference identity_users.user_id`,
      );
    }
  }

  lockSession(userId: string): SessionRecord | undefined {
    const session = this.data.sessions.get(userId);
    return session ? cloneJson(session) : undefined;
  }

  writeSession(row: SessionRecord): void {
    this.requireUser(row.userId, "product_user_sessions.user_id");
    this.data.sessions.set(row.userId, cloneJson(row));
  }

  upsertBan(ban: Ban): BanRecord {
    this.requireUser(ban.senderId, "bans.sender_id");
    if (ban.receiverId) {
      this.requireUser(ban.receiverId, "bans.receiver_id");
    }
    assertPersistedDuration(Number(ban.durationMinutes));
    if (ban.acceptance !== "PENDING" && ban.acceptance !== "ACCEPTED") {
      throw new PersistenceError("INVARIANT", "BanAcceptance is only PENDING | ACCEPTED");
    }
    const existing = this.data.bans.get(ban.id);
    const record: BanRecord = {
      ...cloneJson(ban),
      createdSeq: existing?.createdSeq ?? this.data.nextBanSeq++,
      // bans.created_at DEFAULT NOW() on insert; ON CONFLICT does not change it.
      createdAtMs: existing?.createdAtMs ?? Date.now(),
    };
    this.data.bans.set(ban.id, record);
    return record;
  }

  getBan(banId: string): BanRecord | undefined {
    const ban = this.data.bans.get(banId);
    return ban ? cloneJson(ban) : undefined;
  }

  listBansForUser(userId: string): Ban[] {
    return [...this.data.bans.values()]
      .filter((ban) => ban.senderId === userId || ban.receiverId === userId)
      .map((ban) => asBan(cloneJson(ban)));
  }

  upsertTimer(timer: DomainTimer): void {
    const ban = this.data.bans.get(timer.banId);
    if (!ban) {
      throw new PersistenceError("MISSING_FACT", "DomainTimer requires an existing Ban");
    }
    assertPersistedDuration(Number(timer.durationMinutes));
    const other = [...this.data.timers.values()].find(
      (existing) => existing.banId === timer.banId && existing.id !== timer.id,
    );
    if (other) {
      throw new PersistenceError("INVARIANT", "A Ban may have only one authoritative DomainTimer");
    }
    this.data.timers.set(timer.id, cloneJson(timer));
  }

  listTimersForBans(banIds: readonly string[]): DomainTimer[] {
    const ids = new Set(banIds);
    return [...this.data.timers.values()]
      .filter((timer) => ids.has(timer.banId))
      .map((timer) => cloneJson(timer));
  }

  upsertPair(pair: CheckPair): void {
    const ban = this.data.bans.get(pair.banId);
    if (!ban) {
      throw new PersistenceError("MISSING_FACT", "CheckPair requires an existing Ban");
    }
    const other = [...this.data.pairs.values()].find(
      (existing) => existing.banId === pair.banId && existing.id !== pair.id,
    );
    if (other) {
      throw new PersistenceError("INVARIANT", "A Ban may have only one CheckPair");
    }
    this.data.pairs.set(pair.id, cloneJson(pair));
  }

  listPairsForBans(banIds: readonly string[]): CheckPair[] {
    const ids = new Set(banIds);
    return [...this.data.pairs.values()]
      .filter((pair) => ids.has(pair.banId))
      .map((pair) => cloneJson(pair));
  }

  upsertItem(item: NotificationItem): void {
    this.requireUser(item.ownerId, "notification_items.owner_id");
    if (!this.data.bans.has(item.banId)) {
      throw new PersistenceError("MISSING_FACT", "NotificationItem requires an existing Ban");
    }
    if (item.kind === "TIMER" && !this.data.timers.has(item.domainTimerId)) {
      throw new PersistenceError("MISSING_FACT", "Timer NotificationItem requires DomainTimer");
    }
    if (item.kind === "CHECK" && !this.data.pairs.has(item.checkPairId)) {
      throw new PersistenceError("MISSING_FACT", "Check NotificationItem requires CheckPair");
    }
    this.data.items.set(item.id, cloneJson(item));
  }

  replaceOwnedItems(ownerId: UserId, items: readonly NotificationItem[]): void {
    const keep = new Set<string>(items.map((item) => item.id));
    for (const [id, item] of this.data.items) {
      if (item.ownerId === ownerId && !keep.has(id)) {
        this.data.items.delete(id);
      }
    }
    for (const item of items) {
      this.upsertItem(item);
    }
  }

  installRawItem(item: NotificationItem): void {
    this.data.items.set(item.id, cloneJson(item));
  }

  listItemsForUser(userId: string): NotificationItem[] {
    return [...this.data.items.values()]
      .filter((item) => item.ownerId === userId)
      .map((item) => decodeNotificationItem(notificationItemToRecord(item)));
  }

  countItems(): number {
    return this.data.items.size;
  }

  countPairs(): number {
    return this.data.pairs.size;
  }

  countTimers(): number {
    return this.data.timers.size;
  }

  countBans(): number {
    return this.data.bans.size;
  }

  upsertOperation(ownerId: UserId, operation: PendingOperation): void {
    this.requireUser(ownerId, "pending_operations.owner_id");
    this.data.operations.set(operation.operationId, { ...cloneJson(operation), ownerId });
  }

  deleteOperationById(ownerId: UserId, operationId: string): void {
    const existing = this.data.operations.get(operationId);
    if (existing && existing.ownerId === ownerId) {
      this.data.operations.delete(operationId);
    }
  }

  getItem(itemId: string): NotificationItem | undefined {
    const item = this.data.items.get(itemId);
    return item ? cloneJson(item) : undefined;
  }

  getTimer(timerId: string): DomainTimer | undefined {
    const timer = this.data.timers.get(timerId);
    return timer ? cloneJson(timer) : undefined;
  }

  replaceOperations(ownerId: UserId, operations: readonly PendingOperation[]): void {
    for (const [id, operation] of this.data.operations) {
      if (operation.ownerId === ownerId) {
        this.data.operations.delete(id);
      }
    }
    for (const operation of operations) {
      this.upsertOperation(ownerId, operation);
    }
  }

  listOperationsForUser(userId: string): PendingOperation[] {
    return [...this.data.operations.values()]
      .filter((operation) => operation.ownerId === userId)
      .map(({ ownerId: _ownerId, ...operation }) => cloneJson(operation));
  }

  upsertShare(ownerId: UserId, share: ShareOperation): void {
    this.requireUser(ownerId, "share_operations.owner_id");
    assertShareStatus(share.status);
    if (share.createdBanId && !this.data.bans.has(share.createdBanId)) {
      throw new PersistenceError("MISSING_FACT", "Share createdBanId requires an existing Ban");
    }
    const other = [...this.data.shares.values()].find(
      (existing) =>
        existing.createdBanId &&
        existing.createdBanId === share.createdBanId &&
        existing.attemptId !== share.attemptId,
    );
    if (other) {
      throw new PersistenceError("INVARIANT", "created_ban_id is unique on share_operations");
    }
    const sameToken = [...this.data.shares.values()].find(
      (existing) =>
        String(existing.token) === String(share.token) && existing.attemptId !== share.attemptId,
    );
    if (sameToken) {
      throw new PersistenceError("INVARIANT", "token is unique on share_operations");
    }
    this.data.shares.set(share.attemptId, { ...cloneJson(share), ownerId });
  }

  replaceOwnedShares(ownerId: UserId, shares: readonly ShareOperation[]): void {
    const keep = new Set<string>(shares.map((share) => share.attemptId));
    for (const [id, share] of this.data.shares) {
      if (share.ownerId === ownerId && !keep.has(id)) {
        this.data.shares.delete(id);
      }
    }
    for (const share of shares) {
      this.upsertShare(ownerId, share);
    }
  }

  listSharesForUser(userId: string): ShareOperation[] {
    return [...this.data.shares.values()]
      .filter((share) => share.ownerId === userId)
      .map(({ ownerId: _ownerId, ...share }) => cloneJson(share));
  }

  getShare(attemptId: string): ShareRecord | undefined {
    const share = this.data.shares.get(attemptId);
    return share ? cloneJson(share) : undefined;
  }

  findShareByToken(token: string): ShareRecord | undefined {
    const share = [...this.data.shares.values()].find((item) => String(item.token) === token);
    return share ? cloneJson(share) : undefined;
  }

  bindBanReceiver(banId: string, receiverId: UserId): BanReceiverBindResult {
    const ban = this.data.bans.get(banId);
    if (!ban) {
      return { status: "MISSING" };
    }
    if (ban.receiverId === null) {
      this.requireUser(receiverId, "bans.receiver_id");
      const next = { ...ban, receiverId };
      this.data.bans.set(banId, next);
      return { status: "BOUND", ban: asBan(cloneJson(next)) };
    }
    if (ban.receiverId === receiverId) {
      return { status: "ALREADY_BOUND", ban: asBan(cloneJson(ban)) };
    }
    return { status: "CONFLICT", ban: asBan(cloneJson(ban)) };
  }

  listRelationshipBans(leftUserId: UserId, rightUserId: UserId): RelationshipBanRecord[] {
    const matches = [...this.data.bans.values()]
      .filter((ban) => ban.receiverId)
      .filter(
        (ban) =>
          (ban.senderId === leftUserId && ban.receiverId === rightUserId) ||
          (ban.senderId === rightUserId && ban.receiverId === leftUserId),
      )
      .sort((a, b) => b.createdSeq - a.createdSeq)
      .slice(0, RELATIONSHIP_BAN_LIMIT)
      .sort((a, b) => a.createdSeq - b.createdSeq);
    return matches.map((ban) => ({
      banId: ban.id,
      createdSeq: ban.createdSeq,
      relationshipBan: {
        banText: ban.banText,
        senderId: ban.senderId,
        receiverId: ban.receiverId as UserId,
        status: ban.status,
      } satisfies RelationshipBan,
    }));
  }

  listRelationshipContextSources(
    leftUserId: UserId,
    rightUserId: UserId,
  ): RelationshipContextSource[] {
    const timers = [...this.data.timers.values()];
    const pairs = [...this.data.pairs.values()];
    return [...this.data.bans.values()]
      .filter((ban) => ban.receiverId)
      .filter(
        (ban) =>
          (ban.senderId === leftUserId && ban.receiverId === rightUserId) ||
          (ban.senderId === rightUserId && ban.receiverId === leftUserId),
      )
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .map((ban) => {
        const timer = timers.find((item) => item.banId === ban.id) ?? null;
        const pair = pairs.find((item) => item.banId === ban.id) ?? null;
        return {
          banId: ban.id,
          senderId: ban.senderId,
          receiverId: ban.receiverId as UserId,
          banText: ban.banText,
          acceptance: ban.acceptance,
          status: ban.status,
          createdSeq: ban.createdSeq,
          createdAtMs: ban.createdAtMs,
          timerStartedAtMs: timer ? Number(timer.startedAt) : null,
          timerState: timer?.state ?? null,
          checkPairCreated: timer?.checkPairCreated ?? pair !== null,
          receiverAnswer: pair?.receiverAnswer ?? null,
          senderAnswer: pair?.senderAnswer ?? null,
          resultingStatus: pair?.resultingStatus ?? null,
        };
      });
  }

  insertRimChat(rimChatId: string, ownerUserId: string, contactUserId: string): boolean {
    this.requireUser(ownerUserId, "rim_chats.owner_user_id");
    this.requireUser(contactUserId, "rim_chats.contact_user_id");
    if (this.data.rimChats.has(rimChatId)) {
      return false;
    }
    this.data.rimChats.set(rimChatId, {
      rimChatId,
      ownerUserId,
      contactUserId,
      createdAtMs: 1,
      terminatedAtMs: null,
      terminationReason: null,
      openaiConversationId: null,
      resultingBanId: null,
    });
    return true;
  }

  getRimChat(rimChatId: string): RimChatArchiveRow | undefined {
    const row = this.data.rimChats.get(rimChatId);
    return row ? cloneJson(row) : undefined;
  }

  listRimMessages(rimChatId: string): RimMessageArchiveRow[] {
    return [...this.data.rimMessages.values()]
      .filter((row) => row.rimChatId === rimChatId)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => cloneJson(row));
  }

  getRimMessage(messageKey: string): RimMessageArchiveRow | undefined {
    const row = this.data.rimMessages.get(messageKey);
    return row ? cloneJson(row) : undefined;
  }

  insertRimMessage(row: RimMessageArchiveRow): boolean {
    if (!this.data.rimChats.has(row.rimChatId)) {
      throw new PersistenceError("INVARIANT", "RIM history message requires a chat");
    }
    if (this.data.rimMessages.has(row.messageKey)) {
      return false;
    }
    const ordinalTaken = [...this.data.rimMessages.values()].some(
      (existing) => existing.rimChatId === row.rimChatId && existing.ordinal === row.ordinal,
    );
    if (ordinalTaken) {
      throw new PersistenceError("INVARIANT", "RIM history message ordinal conflict");
    }
    this.data.rimMessages.set(row.messageKey, cloneJson(row));
    return true;
  }

  terminateRimChat(
    rimChatId: string,
    reason: string,
    resultingBanId: string | null,
  ): RimChatArchiveRow | undefined {
    const row = this.data.rimChats.get(rimChatId);
    if (!row) {
      return undefined;
    }
    if (row.terminationReason !== null && row.terminationReason !== reason) {
      return undefined;
    }
    if (
      resultingBanId !== null &&
      row.resultingBanId !== null &&
      row.resultingBanId !== resultingBanId
    ) {
      return undefined;
    }
    if (resultingBanId !== null && !this.data.bans.has(resultingBanId)) {
      throw new PersistenceError("INVARIANT", "RIM history Ban reference is missing");
    }
    const next: RimChatArchiveRow = {
      ...row,
      terminatedAtMs: row.terminatedAtMs ?? 2,
      terminationReason: row.terminationReason ?? reason,
      resultingBanId: resultingBanId ?? row.resultingBanId,
    };
    this.data.rimChats.set(rimChatId, next);
    return cloneJson(next);
  }

  setRimConversationId(rimChatId: string, conversationId: string): boolean {
    const row = this.data.rimChats.get(rimChatId);
    if (!row) {
      return false;
    }
    if (row.openaiConversationId !== null && row.openaiConversationId !== conversationId) {
      return false;
    }
    this.data.rimChats.set(rimChatId, { ...row, openaiConversationId: conversationId });
    return true;
  }

  getOwnership(
    userId: string,
    operationKind: RimOwnershipOperationKind,
    attemptId: string,
  ): OwnershipMemoryRow | undefined {
    const row = this.data.ownership.get(ownershipMemoryKey(userId, operationKind, attemptId));
    return row ? cloneJson(row) : undefined;
  }

  insertOwnership(row: OwnershipMemoryRow): boolean {
    this.requireUser(row.userId, "rim_provider_ownership.user_id");
    const key = ownershipMemoryKey(row.userId, row.operationKind, row.attemptId);
    if (this.data.ownership.has(key)) {
      return false;
    }
    this.data.ownership.set(key, cloneJson(row));
    return true;
  }

  replaceOwnership(row: OwnershipMemoryRow): void {
    const key = ownershipMemoryKey(row.userId, row.operationKind, row.attemptId);
    if (!this.data.ownership.has(key)) {
      throw new PersistenceError("MISSING_FACT", "rim ownership row is missing");
    }
    this.data.ownership.set(key, cloneJson(row));
  }

  abandonOpenOwnership(userId: string, nowMs: number): void {
    for (const [key, row] of this.data.ownership) {
      if (row.userId === userId && row.releasedAtMs === null) {
        this.data.ownership.set(key, {
          ...row,
          releasedAtMs: nowMs,
          releaseReason: "chat-abandoned",
        });
      }
    }
  }

  /** Test seam. Moves the in-memory lease deadline. PostgreSQL uses clock_timestamp(). */
  retimeOwnershipLease(
    userId: string,
    operationKind: RimOwnershipOperationKind,
    attemptId: string,
    leasedUntilMs: number,
  ): void {
    const key = ownershipMemoryKey(userId, operationKind, attemptId);
    const row = this.data.ownership.get(key);
    if (!row) {
      throw new PersistenceError("MISSING_FACT", "rim ownership row is missing");
    }
    this.data.ownership.set(key, { ...row, leasedUntilMs });
  }
}

function ownershipMemoryKey(
  userId: string,
  operationKind: RimOwnershipOperationKind,
  attemptId: string,
): string {
  return `${userId}\u0000${operationKind}\u0000${attemptId}`;
}
