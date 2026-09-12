import type {
  Ban,
  BanAcceptance,
  BanId,
  BanStatus,
  BootstrapState,
  CheckAnswer,
  CheckDerivedStatus,
  CheckPair,
  ConnectionState,
  DomainTimer,
  DurationMinutes,
  NotificationItem,
  PendingOperation,
  ProductSnapshot,
  SessionStatus,
  ShareOperation,
  UserId,
} from "@98plus/product-model";
import { asInstant } from "@98plus/product-model";
import {
  assertCanonicalControlState,
  decodeNotificationItem,
  sessionFromSnapshot,
  snapshotFromRecords,
} from "./codec.ts";
import { assertCheckPairWriteAllowed } from "./check-pair-write.ts";
import { PersistenceError } from "./errors.ts";
import { SQL } from "./sql.ts";
import type {
  BanReceiverBindResult,
  CheckPairLockContext,
  LoadedSnapshot,
  PersistTransitionInput,
  PersistenceSqlClient,
  ProductStore,
  RelationshipBanRecord,
  StoredShareLookup,
} from "./types.ts";

type SessionRow = {
  user_id: string;
  revision: string | number;
  control_state: string | null;
  session_status: SessionStatus;
  connection: ConnectionState;
  bootstrap: BootstrapState;
  rim_chat: ProductSnapshot["extended"]["rimChat"];
  saved_frozen_rim_chat: ProductSnapshot["extended"]["savedFrozenRimChat"];
  create_ban_draft: ProductSnapshot["extended"]["createBanDraft"];
  reply_ban_draft: ProductSnapshot["extended"]["replyBanDraft"];
  reply_source: ProductSnapshot["extended"]["replySource"];
  successful_ban_id: string | null;
  active_notification_item_id: string | null;
  status_priority_item_id: string | null;
  timer_priority_item_id: string | null;
  pending_external_entry: ProductSnapshot["extended"]["pendingExternalEntry"];
};

type BanSqlRow = {
  ban_id: string;
  sender_id: string;
  receiver_id: string | null;
  ban_text: string;
  duration_minutes: number;
  acceptance: BanAcceptance;
  status: BanStatus | null;
  created_seq: number;
};

type TimerSqlRow = {
  timer_id: string;
  ban_id: string;
  started_at: number;
  duration_minutes: number;
  state: DomainTimer["state"];
  check_pair_created: boolean;
};

type PairSqlRow = {
  pair_id: string;
  ban_id: string;
  receiver_item_id: string;
  sender_item_id: string;
  receiver_answer: CheckAnswer | null;
  sender_answer: CheckAnswer | null;
  resulting_status: CheckDerivedStatus | null;
};

type ItemSqlRow = {
  item_id: string;
  owner_id: string;
  ban_id: string;
  kind: NotificationItem["kind"];
  fifo_sequence: number;
  lifecycle_status: "UNPROCESSED" | "PROCESSED";
  lifecycle_display: "WAITING" | "ACTIVE" | null;
  role: "RECEIVER" | "SENDER" | null;
  check_pair_id: string | null;
  domain_timer_id: string | null;
  status: BanStatus | null;
};

type OpSqlRow = {
  operation_id: string;
  owner_id: string;
  kind: PendingOperation["kind"];
  originating_state: PendingOperation["originatingState"];
  originating_item_id: string | null;
  result_applied: boolean;
  superseded_by_external_entry: boolean;
  send_draft: PendingOperation["sendDraft"] | string | null;
};

type ShareSqlRow = {
  attempt_id: string;
  owner_id: string;
  draft: ShareOperation["draft"];
  token: ShareOperation["token"];
  status: ShareOperation["status"];
  created_ban_id: string | null;
};

function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function requireRecord<T>(value: T | string | null, field: string): T {
  const parsed = parseJson<T>(value);
  if (parsed === null || parsed === undefined) {
    throw new PersistenceError("INVARIANT", `Refusing to invent missing product fact: ${field}`);
  }
  return parsed;
}

function pairFromRow(row: PairSqlRow): CheckPair {
  return {
    id: row.pair_id as CheckPair["id"],
    banId: row.ban_id as Ban["id"],
    receiverItemId: row.receiver_item_id as NotificationItem["id"],
    senderItemId: row.sender_item_id as NotificationItem["id"],
    receiverAnswer: row.receiver_answer,
    senderAnswer: row.sender_answer,
    resultingStatus: row.resulting_status,
  };
}

function itemParams(item: NotificationItem): unknown[] {
  const lifecycleStatus = item.lifecycle.status;
  const lifecycleDisplay = item.lifecycle.status === "UNPROCESSED" ? item.lifecycle.display : null;
  return [
    item.id,
    item.ownerId,
    item.banId,
    item.kind,
    item.fifoSequence,
    lifecycleStatus,
    lifecycleDisplay,
    item.kind === "CHECK" || item.kind === "STATUS" ? item.role : null,
    item.kind === "CHECK" ? item.checkPairId : null,
    item.kind === "TIMER" ? item.domainTimerId : null,
    item.kind === "STATUS" ? item.status : null,
  ];
}

export class PostgresProductStore implements ProductStore {
  constructor(private readonly client: PersistenceSqlClient) {}

  async loadProductSnapshot(currentUserId: UserId): Promise<LoadedSnapshot> {
    return this.read(this.client, currentUserId);
  }

  async persistTransition(input: PersistTransitionInput): Promise<LoadedSnapshot> {
    if (input.result.outcome !== "APPLIED") {
      throw new PersistenceError(
        "APPLIED_TRANSITION_REQUIRED",
        "Only an APPLIED Product Kernel TransitionResult may be persisted",
      );
    }
    return this.write(input.currentUserId, input.expectedRevision, input.result.snapshot, false);
  }

  async withCheckPairLock<T>(
    pairId: string,
    run: (context: CheckPairLockContext) => Promise<T>,
  ): Promise<T> {
    return this.client.transaction(async (tx) => {
      const locked = await tx.query<PairSqlRow>(SQL.selectPairForUpdate, [pairId]);
      const pair = locked.rows[0] ? pairFromRow(locked.rows[0]) : null;
      return run({
        pair,
        loadProductSnapshot: (currentUserId) => this.read(tx, currentUserId),
        persistTransition: async (input) => {
          if (input.result.outcome !== "APPLIED") {
            throw new PersistenceError(
              "APPLIED_TRANSITION_REQUIRED",
              "Only an APPLIED Product Kernel TransitionResult may be persisted",
            );
          }
          return this.writeOn(
            tx,
            input.currentUserId,
            input.expectedRevision,
            input.result.snapshot,
            false,
          );
        },
      });
    });
  }

  async listRelationshipBans(
    leftUserId: UserId,
    rightUserId: UserId,
  ): Promise<readonly RelationshipBanRecord[]> {
    const result = await this.client.query<BanSqlRow>(SQL.selectRelationshipBans, [
      leftUserId,
      rightUserId,
    ]);
    return [...result.rows].reverse().map((row) => ({
      banId: row.ban_id as Ban["id"],
      createdSeq: Number(row.created_seq),
      relationshipBan: {
        banText: row.ban_text,
        senderId: row.sender_id as UserId,
        receiverId: row.receiver_id as UserId,
        status: row.status,
      },
    }));
  }

  async findShareByToken(token: string): Promise<StoredShareLookup | null> {
    const result = await this.client.query<ShareSqlRow>(SQL.selectShareByToken, [token]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      ownerId: row.owner_id as UserId,
      share: {
        attemptId: row.attempt_id as ShareOperation["attemptId"],
        draft: requireRecord(row.draft, "share_operations.draft"),
        token: row.token,
        status: row.status,
        createdBanId: row.created_ban_id as ShareOperation["createdBanId"],
      },
    };
  }

  async getBanById(banId: BanId): Promise<Ban | null> {
    const result = await this.client.query<BanSqlRow>(SQL.selectBanById, [banId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.ban_id as Ban["id"],
      senderId: row.sender_id as UserId,
      receiverId: row.receiver_id as UserId | null,
      banText: row.ban_text,
      durationMinutes: row.duration_minutes as DurationMinutes,
      acceptance: row.acceptance,
      status: row.status,
    };
  }

  async bindBanReceiver(banId: BanId, receiverId: UserId): Promise<BanReceiverBindResult> {
    const existing = await this.getBanById(banId);
    if (!existing) {
      return { status: "MISSING" };
    }
    if (existing.receiverId === receiverId) {
      return { status: "ALREADY_BOUND", ban: existing };
    }
    if (existing.receiverId !== null) {
      return { status: "CONFLICT", ban: existing };
    }
    const result = await this.client.query<BanSqlRow>(SQL.bindBanReceiverIfUnbound, [
      banId,
      receiverId,
    ]);
    const row = result.rows[0];
    if (row) {
      return {
        status: "BOUND",
        ban: {
          id: row.ban_id as Ban["id"],
          senderId: row.sender_id as UserId,
          receiverId: row.receiver_id as UserId | null,
          banText: row.ban_text,
          durationMinutes: row.duration_minutes as DurationMinutes,
          acceptance: row.acceptance,
          status: row.status,
        },
      };
    }
    const raced = await this.getBanById(banId);
    if (!raced) {
      return { status: "MISSING" };
    }
    if (raced.receiverId === receiverId) {
      return { status: "ALREADY_BOUND", ban: raced };
    }
    return { status: "CONFLICT", ban: raced };
  }

  protected async write(
    currentUserId: UserId,
    expectedRevision: number,
    snapshot: ProductSnapshot,
    seed: boolean,
  ): Promise<LoadedSnapshot> {
    try {
      return await this.client.transaction(async (tx) =>
        this.writeOn(tx, currentUserId, expectedRevision, snapshot, seed),
      );
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        "TRANSACTION_FAILED",
        error instanceof Error ? error.message : "product persistence transaction failed",
      );
    }
  }

  private async writeOn(
    tx: PersistenceSqlClient,
    currentUserId: UserId,
    expectedRevision: number,
    snapshot: ProductSnapshot,
    seed: boolean,
  ): Promise<LoadedSnapshot> {
    const identity = await tx.query<{ user_id: string }>(SQL.selectIdentity, [currentUserId]);
    if (!identity.rows[0]) {
      throw new PersistenceError(
        "IDENTITY_REQUIRED",
        "Persistence operations require an authenticated identity_users.user_id",
      );
    }
    const sessionResult = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [currentUserId]);
    const currentRevision = Number(sessionResult.rows[0]?.revision ?? 0);
    if (!seed && currentRevision !== expectedRevision) {
      throw new PersistenceError(
        "REVISION_CONFLICT",
        "Conflicting writes to the same user's durable ProductSnapshot",
      );
    }
    const nextRevision = currentRevision + 1;
    const entities = snapshot.extended.entities;
    for (const ban of Object.values(entities.bans)) {
      await tx.query(SQL.upsertBan, [
        ban.id,
        ban.senderId,
        ban.receiverId,
        ban.banText,
        ban.durationMinutes,
        ban.acceptance,
        ban.status,
      ]);
    }
    for (const timer of Object.values(entities.domainTimers)) {
      await tx.query(SQL.upsertTimer, [
        timer.id,
        timer.banId,
        timer.startedAt,
        timer.durationMinutes,
        timer.state,
        timer.checkPairCreated,
      ]);
    }
    for (const pair of Object.values(entities.checkPairs)) {
      const locked = await tx.query<PairSqlRow>(SQL.selectPairForUpdate, [pair.id]);
      assertCheckPairWriteAllowed(locked.rows[0] ? pairFromRow(locked.rows[0]) : undefined, pair);
      await tx.query(SQL.upsertPair, [
        pair.id,
        pair.banId,
        pair.receiverItemId,
        pair.senderItemId,
        pair.receiverAnswer,
        pair.senderAnswer,
        pair.resultingStatus,
      ]);
    }
    for (const item of Object.values(entities.notificationItems)) {
      await tx.query(SQL.upsertItem, itemParams(item));
    }
    await tx.query(SQL.deleteItemsNotIn, [
      currentUserId,
      Object.values(entities.notificationItems).map((item) => item.id),
    ]);
    for (const share of Object.values(entities.shareOperations)) {
      await tx.query(SQL.upsertShare, [
        share.attemptId,
        currentUserId,
        jsonParam(share.draft),
        share.token,
        share.status,
        share.createdBanId,
      ]);
    }
    await tx.query(SQL.deleteSharesNotIn, [
      currentUserId,
      Object.values(entities.shareOperations).map((share) => share.attemptId),
    ]);
    const operationIds = Object.keys(snapshot.runtime.pendingOperations);
    await tx.query(SQL.deleteOpsNotIn, [currentUserId, operationIds]);
    for (const operation of Object.values(snapshot.runtime.pendingOperations)) {
      await tx.query(SQL.upsertOperation, [
        operation.operationId,
        currentUserId,
        operation.kind,
        operation.originatingState,
        operation.originatingItemId,
        operation.resultApplied,
        operation.supersededByExternalEntry,
        jsonParam(operation.sendDraft),
      ]);
    }
    const session = sessionFromSnapshot(currentUserId, snapshot, nextRevision);
    await tx.query(SQL.upsertSession, [
      session.userId,
      session.revision,
      session.controlState,
      session.sessionStatus,
      session.connection,
      jsonParam(session.bootstrap),
      jsonParam(session.rimChat),
      jsonParam(session.savedFrozenRimChat),
      jsonParam(session.createBanDraft),
      jsonParam(session.replyBanDraft),
      jsonParam(session.replySource),
      session.successfulBanId,
      session.activeNotificationItemId,
      session.statusPriorityItemId,
      session.timerPriorityItemId,
      jsonParam(session.pendingExternalEntry),
    ]);
    return this.read(tx, currentUserId);
  }

  private async read(client: PersistenceSqlClient, currentUserId: UserId): Promise<LoadedSnapshot> {
    const sessionResult = await client.query<SessionRow>(SQL.selectSessionForUpdate, [
      currentUserId,
    ]);
    const sessionRow = sessionResult.rows[0];
    const bansResult = await client.query<BanSqlRow>(SQL.selectBansForUser, [currentUserId]);
    const bans = bansResult.rows.map((row): Ban => ({
      id: row.ban_id as Ban["id"],
      senderId: row.sender_id as UserId,
      receiverId: row.receiver_id as UserId | null,
      banText: row.ban_text,
      durationMinutes: row.duration_minutes as DurationMinutes,
      acceptance: row.acceptance,
      status: row.status,
    }));
    const banIds = bans.map((ban) => ban.id);
    const timersResult = await client.query<TimerSqlRow>(SQL.selectTimersForBans, [banIds]);
    const pairsResult = await client.query<PairSqlRow>(SQL.selectPairsForBans, [banIds]);
    const itemsResult = await client.query<ItemSqlRow>(SQL.selectItemsForUser, [currentUserId]);
    const sharesResult = await client.query<ShareSqlRow>(SQL.selectSharesForUser, [currentUserId]);
    const opsResult = await client.query<OpSqlRow>(SQL.selectOpsForUser, [currentUserId]);
    const session = sessionRow
      ? {
          userId: sessionRow.user_id as UserId,
          revision: Number(sessionRow.revision),
          controlState: assertCanonicalControlState(sessionRow.control_state),
          sessionStatus: sessionRow.session_status,
          connection: sessionRow.connection,
          bootstrap: requireRecord(sessionRow.bootstrap, "product_user_sessions.bootstrap"),
          rimChat: parseJson(sessionRow.rim_chat),
          savedFrozenRimChat: parseJson(sessionRow.saved_frozen_rim_chat),
          createBanDraft: parseJson(sessionRow.create_ban_draft),
          replyBanDraft: parseJson(sessionRow.reply_ban_draft),
          replySource: parseJson(sessionRow.reply_source),
          successfulBanId:
            sessionRow.successful_ban_id as ProductSnapshot["extended"]["successfulBanId"],
          activeNotificationItemId:
            sessionRow.active_notification_item_id as ProductSnapshot["extended"]["activeNotificationItemId"],
          statusPriorityItemId:
            sessionRow.status_priority_item_id as ProductSnapshot["extended"]["priorities"]["statusItemId"],
          timerPriorityItemId:
            sessionRow.timer_priority_item_id as ProductSnapshot["extended"]["priorities"]["timerItemId"],
          pendingExternalEntry: parseJson(sessionRow.pending_external_entry),
        }
      : undefined;
    return {
      revision: session?.revision ?? 0,
      snapshot: snapshotFromRecords({
        session,
        bans,
        items: itemsResult.rows.map((row) =>
          decodeNotificationItem({
            item_id: row.item_id,
            owner_id: row.owner_id,
            ban_id: row.ban_id,
            kind: row.kind,
            fifo_sequence: row.fifo_sequence,
            lifecycle_status: row.lifecycle_status,
            lifecycle_display: row.lifecycle_display,
            role: row.role,
            check_pair_id: row.check_pair_id,
            domain_timer_id: row.domain_timer_id,
            status: row.status,
          }),
        ),
        timers: timersResult.rows.map((row) => ({
          id: row.timer_id as DomainTimer["id"],
          banId: row.ban_id as Ban["id"],
          startedAt: asInstant(Number(row.started_at)),
          durationMinutes: row.duration_minutes as DurationMinutes,
          state: row.state,
          checkPairCreated: row.check_pair_created,
        })),
        pairs: pairsResult.rows.map((row) => ({
          id: row.pair_id as CheckPair["id"],
          banId: row.ban_id as Ban["id"],
          receiverItemId: row.receiver_item_id as NotificationItem["id"],
          senderItemId: row.sender_item_id as NotificationItem["id"],
          receiverAnswer: row.receiver_answer,
          senderAnswer: row.sender_answer,
          resultingStatus: row.resulting_status,
        })),
        shares: sharesResult.rows.map((row) => ({
          attemptId: row.attempt_id as ShareOperation["attemptId"],
          draft: requireRecord(row.draft, "share_operations.draft"),
          token: row.token,
          status: row.status,
          createdBanId: row.created_ban_id as ShareOperation["createdBanId"],
        })),
        operations: opsResult.rows.map((row) => ({
          operationId: row.operation_id as PendingOperation["operationId"],
          kind: row.kind,
          originatingState: row.originating_state,
          originatingItemId: row.originating_item_id as PendingOperation["originatingItemId"],
          resultApplied: row.result_applied,
          supersededByExternalEntry: row.superseded_by_external_entry,
          sendDraft: parseJson<PendingOperation["sendDraft"]>(row.send_draft) ?? null,
        })),
      }),
    };
  }
}
