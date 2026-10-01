import { UPSERT_IDENTITY_USER_SQL, type SqlQueryResult } from "@98plus/identity";
import type {
  Ban,
  CheckPair,
  DomainTimer,
  DurationMinutes,
  NotificationItem,
  PendingOperation,
  ProductControlState,
  ShareOperation,
  UserId,
} from "@98plus/product-model";
import { asInstant } from "@98plus/product-model";
import type { SessionRecord } from "./codec.ts";
import { decodeNotificationItem } from "./codec.ts";
import { PersistenceError } from "./errors.ts";
import { SQL } from "./sql.ts";
import { ProductTables } from "./tables.ts";
import type { PersistenceSqlClient } from "./types.ts";

function rows<T>(values: readonly T[]): SqlQueryResult<T> {
  return { rows: values };
}

function parseMaybeJson<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function sessionToRow(session: SessionRecord) {
  return {
    user_id: session.userId,
    revision: session.revision,
    control_state: session.controlState,
    session_status: session.sessionStatus,
    connection: session.connection,
    bootstrap: session.bootstrap,
    rim_chat: session.rimChat,
    saved_frozen_rim_chat: session.savedFrozenRimChat,
    create_ban_draft: session.createBanDraft,
    reply_ban_draft: session.replyBanDraft,
    reply_source: session.replySource,
    successful_ban_id: session.successfulBanId,
    active_notification_item_id: session.activeNotificationItemId,
    status_priority_item_id: session.statusPriorityItemId,
    timer_priority_item_id: session.timerPriorityItemId,
    pending_external_entry: session.pendingExternalEntry,
    telegram_persistent_reentry_eligible: session.telegramPersistentReentryEligible,
    telegram_persistent_reentry_established: session.telegramPersistentReentryEstablished,
    telegram_persistent_reentry_active_request_id: session.telegramPersistentReentryActiveRequestId,
    telegram_persistent_reentry_bootstrap_sent: session.telegramPersistentReentryBootstrapSent,
    telegram_persistent_reentry_bootstrap_claimed_until_ms:
      session.telegramPersistentReentryBootstrapClaimedUntilMs,
    telegram_persistent_reentry_bootstrap_claim_token:
      session.telegramPersistentReentryBootstrapClaimToken,
    telegram_persistent_reentry_cta_surface_generation:
      session.telegramPersistentReentryCtaSurfaceGeneration,
    telegram_persistent_reentry_cta_consumed_surface_generation:
      session.telegramPersistentReentryCtaConsumedSurfaceGeneration,
    rim_provider_runtime: session.rimProviderRuntime,
  };
}

function itemToRow(item: NotificationItem) {
  return {
    item_id: item.id,
    owner_id: item.ownerId,
    ban_id: item.banId,
    kind: item.kind,
    fifo_sequence: item.fifoSequence,
    lifecycle_status: item.lifecycle.status,
    lifecycle_display: item.lifecycle.status === "UNPROCESSED" ? item.lifecycle.display : null,
    role: item.kind === "CHECK" || item.kind === "STATUS" ? item.role : null,
    check_pair_id: item.kind === "CHECK" ? item.checkPairId : null,
    domain_timer_id: item.kind === "TIMER" ? item.domainTimerId : null,
    status: item.kind === "STATUS" ? item.status : null,
  };
}

export class MemorySqlClient implements PersistenceSqlClient {
  readonly tables = new ProductTables();
  private failOnce = false;
  private telegramByUser = new Map<string, string>();
  private transactionTail: Promise<unknown> = Promise.resolve();

  failNextQuery(): void {
    this.failOnce = true;
  }

  async transaction<T>(fn: (tx: PersistenceSqlClient) => Promise<T>): Promise<T> {
    const run = async () => {
      const before = this.tables.snapshot();
      try {
        return await fn(this);
      } catch (error) {
        this.tables.restore(before);
        throw error;
      }
    };
    const current = this.transactionTail.then(run, run);
    this.transactionTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  async query<T>(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<T>> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new PersistenceError("TRANSACTION_FAILED", "injected SQL failure");
    }
    return this.execute(sql, params) as SqlQueryResult<T>;
  }

  private execute(sql: string, params: readonly unknown[]): SqlQueryResult<unknown> {
    switch (sql) {
      case SQL.selectIdentity: {
        const userId = String(params[0]);
        return rows(this.tables.hasUser(userId) ? [{ user_id: userId }] : []);
      }
      case UPSERT_IDENTITY_USER_SQL: {
        const candidateUserId = params[0] as UserId;
        const telegramUserId = String(params[1]);
        const existing = this.tables.findIdentityByTelegramUserId(telegramUserId);
        if (existing) {
          return rows([{ user_id: existing.userId, telegram_user_id: existing.telegramUserId }]);
        }
        this.tables.registerIdentityUser(candidateUserId, telegramUserId);
        return rows([{ user_id: candidateUserId, telegram_user_id: telegramUserId }]);
      }
      case SQL.insertIdentity: {
        this.tables.registerIdentityUser(params[0] as UserId, String(params[1]));
        this.telegramByUser.set(String(params[0]), String(params[1]));
        return rows([]);
      }
      case SQL.selectSessionForUpdate: {
        const session = this.tables.lockSession(String(params[0]));
        return rows(session ? [sessionToRow(session)] : []);
      }
      case SQL.upsertSession: {
        this.tables.writeSession({
          userId: params[0] as UserId,
          revision: Number(params[1]),
          controlState: params[2] as ProductControlState | null,
          sessionStatus: params[3] as SessionRecord["sessionStatus"],
          connection: params[4] as SessionRecord["connection"],
          bootstrap: parseMaybeJson(params[5]),
          rimChat: parseMaybeJson(params[6]),
          savedFrozenRimChat: parseMaybeJson(params[7]),
          createBanDraft: parseMaybeJson(params[8]),
          replyBanDraft: parseMaybeJson(params[9]),
          replySource: parseMaybeJson(params[10]),
          successfulBanId: params[11] as SessionRecord["successfulBanId"],
          activeNotificationItemId: params[12] as SessionRecord["activeNotificationItemId"],
          statusPriorityItemId: params[13] as SessionRecord["statusPriorityItemId"],
          timerPriorityItemId: params[14] as SessionRecord["timerPriorityItemId"],
          pendingExternalEntry: parseMaybeJson(params[15]),
          telegramPersistentReentryEligible: Boolean(params[16]),
          telegramPersistentReentryEstablished: Boolean(params[17]),
          telegramPersistentReentryActiveRequestId:
            params[18] === null || params[18] === undefined ? null : String(params[18]),
          telegramPersistentReentryBootstrapSent: Boolean(params[19]),
          telegramPersistentReentryBootstrapClaimedUntilMs:
            params[20] === null || params[20] === undefined ? null : Number(params[20]),
          telegramPersistentReentryBootstrapClaimToken:
            params[21] === null || params[21] === undefined ? null : String(params[21]),
          telegramPersistentReentryCtaSurfaceGeneration:
            params[22] === null || params[22] === undefined ? 0 : Number(params[22]),
          telegramPersistentReentryCtaConsumedSurfaceGeneration:
            params[23] === null || params[23] === undefined ? null : Number(params[23]),
          rimProviderRuntime: parseMaybeJson(params[24] ?? null),
        });
        return rows([]);
      }
      case SQL.updateRimProviderRuntime: {
        const session = this.tables.lockSession(String(params[0]));
        if (!session || session.revision !== Number(params[1])) {
          return rows([]);
        }
        this.tables.writeSession({
          ...session,
          revision: session.revision + 1,
          rimProviderRuntime: parseMaybeJson(params[2] ?? null),
        });
        return rows([{ user_id: session.userId }]);
      }
      case SQL.claimTelegramPersistentReentryBootstrapDelivery: {
        const session = this.tables.lockSession(String(params[0]));
        const nowMs = Number(params[2]);
        const leaseUntil = Number(params[1]);
        const claimToken = String(params[3]);
        if (!session || !session.telegramPersistentReentryEstablished) {
          return rows([]);
        }
        if (session.telegramPersistentReentryBootstrapSent) {
          return rows([]);
        }
        const claimedUntil = session.telegramPersistentReentryBootstrapClaimedUntilMs;
        if (claimedUntil !== null && claimedUntil > nowMs) {
          return rows([]);
        }
        this.tables.writeSession({
          ...session,
          revision: session.revision + 1,
          telegramPersistentReentryBootstrapClaimedUntilMs: leaseUntil,
          telegramPersistentReentryBootstrapClaimToken: claimToken,
        });
        return rows([
          {
            user_id: session.userId,
            telegram_persistent_reentry_bootstrap_claimed_until_ms: leaseUntil,
            telegram_persistent_reentry_bootstrap_claim_token: claimToken,
          },
        ]);
      }
      case SQL.markTelegramPersistentReentryBootstrapSent: {
        const session = this.tables.lockSession(String(params[0]));
        const claimToken = String(params[1]);
        if (
          !session ||
          !session.telegramPersistentReentryEstablished ||
          session.telegramPersistentReentryBootstrapSent ||
          session.telegramPersistentReentryBootstrapClaimToken !== claimToken
        ) {
          return rows([]);
        }
        this.tables.writeSession({
          ...session,
          revision: session.revision + 1,
          telegramPersistentReentryBootstrapSent: true,
          telegramPersistentReentryBootstrapClaimedUntilMs: null,
          telegramPersistentReentryBootstrapClaimToken: null,
        });
        return rows([{ user_id: session.userId }]);
      }
      case SQL.releaseTelegramPersistentReentryBootstrapClaim: {
        const session = this.tables.lockSession(String(params[0]));
        const claimToken = String(params[1]);
        if (
          !session ||
          session.telegramPersistentReentryBootstrapSent ||
          session.telegramPersistentReentryBootstrapClaimToken === null ||
          session.telegramPersistentReentryBootstrapClaimToken !== claimToken
        ) {
          return rows([]);
        }
        this.tables.writeSession({
          ...session,
          revision: session.revision + 1,
          telegramPersistentReentryBootstrapClaimedUntilMs: null,
          telegramPersistentReentryBootstrapClaimToken: null,
        });
        return rows([{ user_id: session.userId }]);
      }
      case SQL.selectBansForUser: {
        return rows(
          this.tables.listBansForUser(String(params[0])).map((ban) => ({
            ban_id: ban.id,
            sender_id: ban.senderId,
            receiver_id: ban.receiverId,
            ban_text: ban.banText,
            duration_minutes: ban.durationMinutes,
            acceptance: ban.acceptance,
            status: ban.status,
            bound_via_telegram_share_link: ban.boundViaTelegramShareLink,
            source_proposal_id: ban.sourceProposalId,
            created_seq: this.tables.getBan(ban.id)?.createdSeq ?? 0,
          })),
        );
      }
      case SQL.upsertBan: {
        this.tables.upsertBan({
          id: params[0] as Ban["id"],
          senderId: params[1] as UserId,
          receiverId: params[2] as UserId | null,
          banText: String(params[3]),
          durationMinutes: params[4] as DurationMinutes,
          acceptance: params[5] as Ban["acceptance"],
          status: params[6] as Ban["status"],
          boundViaTelegramShareLink: Boolean(params[7]),
          sourceProposalId: (params[8] ?? null) as Ban["sourceProposalId"],
        });
        return rows([]);
      }
      case SQL.selectTimersForBans: {
        const banIds = (params[0] as string[]) ?? [];
        return rows(
          this.tables.listTimersForBans(banIds).map((timer) => ({
            timer_id: timer.id,
            ban_id: timer.banId,
            started_at: timer.startedAt,
            duration_minutes: timer.durationMinutes,
            state: timer.state,
            check_pair_created: timer.checkPairCreated,
          })),
        );
      }
      case SQL.upsertTimer: {
        this.tables.upsertTimer({
          id: params[0] as DomainTimer["id"],
          banId: params[1] as Ban["id"],
          startedAt: asInstant(Number(params[2])),
          durationMinutes: params[3] as DurationMinutes,
          state: params[4] as DomainTimer["state"],
          checkPairCreated: Boolean(params[5]),
        });
        return rows([]);
      }
      case SQL.selectPairsForBans: {
        const banIds = (params[0] as string[]) ?? [];
        return rows(
          this.tables.listPairsForBans(banIds).map((pair) => ({
            pair_id: pair.id,
            ban_id: pair.banId,
            receiver_item_id: pair.receiverItemId,
            sender_item_id: pair.senderItemId,
            receiver_answer: pair.receiverAnswer,
            sender_answer: pair.senderAnswer,
            resulting_status: pair.resultingStatus,
          })),
        );
      }
      case SQL.selectPairForUpdate: {
        const pair = this.tables.getPair(String(params[0]));
        return rows(
          pair
            ? [
                {
                  pair_id: pair.id,
                  ban_id: pair.banId,
                  receiver_item_id: pair.receiverItemId,
                  sender_item_id: pair.senderItemId,
                  receiver_answer: pair.receiverAnswer,
                  sender_answer: pair.senderAnswer,
                  resulting_status: pair.resultingStatus,
                },
              ]
            : [],
        );
      }
      case SQL.upsertPair: {
        this.tables.upsertPair({
          id: params[0] as CheckPair["id"],
          banId: params[1] as Ban["id"],
          receiverItemId: params[2] as NotificationItem["id"],
          senderItemId: params[3] as NotificationItem["id"],
          receiverAnswer: params[4] as CheckPair["receiverAnswer"],
          senderAnswer: params[5] as CheckPair["senderAnswer"],
          resultingStatus: params[6] as CheckPair["resultingStatus"],
        });
        return rows([]);
      }
      case SQL.selectItemsForUser: {
        return rows(this.tables.listItemsForUser(String(params[0])).map(itemToRow));
      }
      case SQL.upsertItem: {
        const item = decodeNotificationItem({
          item_id: String(params[0]),
          owner_id: String(params[1]),
          ban_id: String(params[2]),
          kind: String(params[3]),
          fifo_sequence: Number(params[4]),
          lifecycle_status:
            params[5] === null || params[5] === undefined ? null : String(params[5]),
          lifecycle_display:
            params[6] === null || params[6] === undefined ? null : String(params[6]),
          role: params[7] === null || params[7] === undefined ? null : String(params[7]),
          check_pair_id: params[8] === null || params[8] === undefined ? null : String(params[8]),
          domain_timer_id: params[9] === null || params[9] === undefined ? null : String(params[9]),
          status: params[10] === null || params[10] === undefined ? null : String(params[10]),
        });
        this.tables.upsertItem(item);
        return rows([]);
      }
      case SQL.selectOpsForUser: {
        return rows(
          this.tables.listOperationsForUser(String(params[0])).map((operation) => ({
            operation_id: operation.operationId,
            owner_id: params[0],
            kind: operation.kind,
            originating_state: operation.originatingState,
            originating_item_id: operation.originatingItemId,
            result_applied: operation.resultApplied,
            superseded_by_external_entry: operation.supersededByExternalEntry,
            send_draft: operation.sendDraft,
          })),
        );
      }
      case SQL.upsertOperation: {
        this.tables.upsertOperation(params[1] as UserId, {
          operationId: params[0] as PendingOperation["operationId"],
          kind: params[2] as PendingOperation["kind"],
          originatingState: params[3] as PendingOperation["originatingState"],
          originatingItemId: params[4] as PendingOperation["originatingItemId"],
          resultApplied: Boolean(params[5]),
          supersededByExternalEntry: Boolean(params[6]),
          sendDraft: (params[7] as PendingOperation["sendDraft"]) ?? null,
        });
        return rows([]);
      }
      case SQL.deleteOpsNotIn: {
        const keep = new Set((params[1] as string[]) ?? []);
        const ownerId = params[0] as UserId;
        const remaining = this.tables
          .listOperationsForUser(ownerId)
          .filter((operation) => keep.has(operation.operationId));
        this.tables.replaceOperations(ownerId, remaining);
        return rows([]);
      }
      case SQL.deleteItemsNotIn: {
        const keep = new Set((params[1] as string[]) ?? []);
        const ownerId = params[0] as UserId;
        const remaining = this.tables.listItemsForUser(ownerId).filter((item) => keep.has(item.id));
        this.tables.replaceOwnedItems(ownerId, remaining);
        return rows([]);
      }
      case SQL.deleteSharesNotIn: {
        const keep = new Set((params[1] as string[]) ?? []);
        const ownerId = params[0] as UserId;
        const remaining = this.tables
          .listSharesForUser(ownerId)
          .filter((share) => keep.has(share.attemptId));
        this.tables.replaceOwnedShares(ownerId, remaining);
        return rows([]);
      }
      case SQL.selectSharesForUser: {
        return rows(
          this.tables.listSharesForUser(String(params[0])).map((share) => ({
            attempt_id: share.attemptId,
            owner_id: params[0],
            draft: share.draft,
            token: share.token,
            status: share.status,
            created_ban_id: share.createdBanId,
          })),
        );
      }
      case SQL.selectShareByToken: {
        const share = this.tables.findShareByToken(String(params[0]));
        if (!share) {
          return rows([]);
        }
        return rows([
          {
            attempt_id: share.attemptId,
            owner_id: share.ownerId,
            draft: share.draft,
            token: share.token,
            status: share.status,
            created_ban_id: share.createdBanId,
          },
        ]);
      }
      case SQL.selectBanById: {
        const ban = this.tables.getBan(String(params[0]));
        if (!ban) {
          return rows([]);
        }
        return rows([
          {
            ban_id: ban.id,
            sender_id: ban.senderId,
            receiver_id: ban.receiverId,
            ban_text: ban.banText,
            duration_minutes: ban.durationMinutes,
            acceptance: ban.acceptance,
            status: ban.status,
            bound_via_telegram_share_link: ban.boundViaTelegramShareLink,
            source_proposal_id: ban.sourceProposalId,
            created_seq: ban.createdSeq,
          },
        ]);
      }
      case SQL.bindBanReceiverIfUnbound: {
        const result = this.tables.bindBanReceiver(String(params[0]), params[1] as UserId);
        if (result.status !== "BOUND") {
          return rows([]);
        }
        const ban = this.tables.getBan(String(params[0]));
        if (!ban) {
          return rows([]);
        }
        return rows([
          {
            ban_id: ban.id,
            sender_id: ban.senderId,
            receiver_id: ban.receiverId,
            ban_text: ban.banText,
            duration_minutes: ban.durationMinutes,
            acceptance: ban.acceptance,
            status: ban.status,
            bound_via_telegram_share_link: ban.boundViaTelegramShareLink,
            source_proposal_id: ban.sourceProposalId,
            created_seq: ban.createdSeq,
          },
        ]);
      }
      case SQL.upsertShare: {
        this.tables.upsertShare(params[1] as UserId, {
          attemptId: params[0] as ShareOperation["attemptId"],
          draft: parseMaybeJson(params[2]),
          token: params[3] as ShareOperation["token"],
          status: params[4] as ShareOperation["status"],
          createdBanId: params[5] as ShareOperation["createdBanId"],
        });
        return rows([]);
      }
      case SQL.selectRelationshipContextSources: {
        const records = this.tables.listRelationshipContextSources(
          params[0] as UserId,
          params[1] as UserId,
        );
        return rows(
          records.map((record) => ({
            ban_id: record.banId,
            sender_id: record.senderId,
            receiver_id: record.receiverId,
            ban_text: record.banText,
            acceptance: record.acceptance,
            status: record.status,
            created_seq: record.createdSeq,
            created_at: record.createdAtMs,
            started_at: record.timerStartedAtMs,
            timer_state: record.timerState,
            check_pair_created: record.checkPairCreated,
            receiver_answer: record.receiverAnswer,
            sender_answer: record.senderAnswer,
            resulting_status: record.resultingStatus,
          })),
        );
      }
      case SQL.selectRelationshipBans: {
        const records = this.tables.listRelationshipBans(params[0] as UserId, params[1] as UserId);
        return rows(
          [...records].reverse().map((record) => ({
            ban_id: record.banId,
            sender_id: record.relationshipBan.senderId,
            receiver_id: record.relationshipBan.receiverId,
            ban_text: record.relationshipBan.banText,
            status: record.relationshipBan.status,
            created_seq: record.createdSeq,
          })),
        );
      }
      default:
        throw new PersistenceError("INVARIANT", `Unsupported SQL in memory client: ${sql}`);
    }
  }
}
