import { randomUUID } from "node:crypto";
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
  classifyShareForClaim,
  createdClaimBan,
  snapshotForReceiverClaimPersist,
  type ClaimTemplateShareInput,
  type ClaimTemplateShareResult,
} from "./claim-template-share.ts";
import {
  assertCanonicalControlState,
  decodeNotificationItem,
  sessionFromSnapshot,
  snapshotFromRecords,
} from "./codec.ts";
import { assertCheckPairWriteAllowed } from "./check-pair-write.ts";
import { PersistenceError } from "./errors.ts";
import { runtimeAttemptAllowsCommit } from "./runtime-attempt-authority.ts";
import { SQL } from "./sql.ts";
import type {
  BanReceiverBindResult,
  CheckPairLockContext,
  CommitOwnedTransitionInput,
  CommitOwnedTransitionResult,
  LoadedSnapshot,
  PersistShareLinkResolvedInput,
  PersistShareLinkResolvedResult,
  PersistTransitionInput,
  PersistenceSqlClient,
  ProductStore,
  RelationshipBanRecord,
  RelationshipContextSource,
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
  telegram_persistent_reentry_eligible?: boolean | null;
  telegram_persistent_reentry_established?: boolean | null;
  telegram_persistent_reentry_active_request_id?: string | null;
  telegram_persistent_reentry_bootstrap_sent?: boolean | null;
  telegram_persistent_reentry_bootstrap_claimed_until_ms?: number | string | null;
  telegram_persistent_reentry_bootstrap_claim_token?: string | null;
  telegram_persistent_reentry_cta_surface_generation?: number | string | null;
  telegram_persistent_reentry_cta_consumed_surface_generation?: number | string | null;
  rim_provider_runtime?: unknown | null;
};

type RelationshipContextSourceSqlRow = {
  ban_id: string;
  sender_id: string;
  receiver_id: string;
  ban_text: string;
  acceptance: BanAcceptance;
  status: BanStatus | null;
  created_seq: number;
  created_at: Date | string | number | null;
  started_at: number | null;
  timer_state: DomainTimer["state"] | null;
  check_pair_created: boolean | null;
  receiver_answer: CheckAnswer | null;
  sender_answer: CheckAnswer | null;
  resulting_status: CheckDerivedStatus | null;
};

function createdAtMs(value: Date | string | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

type BanSqlRow = {
  ban_id: string;
  sender_id: string;
  receiver_id: string | null;
  ban_text: string;
  duration_minutes: number;
  acceptance: BanAcceptance;
  status: BanStatus | null;
  bound_via_telegram_share_link?: boolean | null;
  source_proposal_id?: string | null;
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

function banFromRow(row: BanSqlRow): Ban {
  return {
    id: row.ban_id as Ban["id"],
    senderId: row.sender_id as UserId,
    receiverId: row.receiver_id as UserId | null,
    banText: row.ban_text,
    durationMinutes: row.duration_minutes as DurationMinutes,
    acceptance: row.acceptance,
    status: row.status,
    boundViaTelegramShareLink: Boolean(row.bound_via_telegram_share_link),
    sourceProposalId: row.source_proposal_id
      ? (row.source_proposal_id as Ban["sourceProposalId"])
      : null,
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
  private failAfterBans = false;

  constructor(private readonly client: PersistenceSqlClient) {}

  /** Test-only: fail inside the write transaction after Ban upserts (rolls back bind+write). */
  failNextWriteAfterBans(): void {
    this.failAfterBans = true;
  }

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

  async commitOwnedTransition(
    input: CommitOwnedTransitionInput,
  ): Promise<CommitOwnedTransitionResult> {
    if (input.result.outcome !== "APPLIED") {
      throw new PersistenceError(
        "APPLIED_TRANSITION_REQUIRED",
        "Only an APPLIED Product Kernel TransitionResult may be persisted",
      );
    }
    try {
      return await this.client.transaction(async (tx) => {
        const sessionResult = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [
          input.currentUserId,
        ]);
        const row = sessionResult.rows[0];
        if (!row || Number(row.revision) !== input.expectedRevision) {
          throw new PersistenceError(
            "REVISION_CONFLICT",
            "Conflicting writes to the same user's durable ProductSnapshot",
          );
        }
        const runtime = parseJson(row.rim_provider_runtime ?? null);
        if (!runtimeAttemptAllowsCommit(runtime, input.requireAttempt)) {
          return {
            status: "ATTEMPT_SUPERSEDED" as const,
            loaded: await this.read(tx, input.currentUserId),
          };
        }
        const loaded = await this.writeOn(
          tx,
          input.currentUserId,
          input.expectedRevision,
          input.result.snapshot,
          false,
          "rimProviderRuntime" in input ? input.rimProviderRuntime : undefined,
        );
        return { status: "COMMITTED" as const, loaded };
      });
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

  async saveRimProviderRuntime(
    currentUserId: UserId,
    expectedRevision: number,
    runtime: unknown | null,
  ): Promise<LoadedSnapshot> {
    try {
      return await this.client.transaction(async (tx) => {
        const sessionResult = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [
          currentUserId,
        ]);
        const row = sessionResult.rows[0];
        if (!row) {
          throw new PersistenceError(
            "INVARIANT",
            "rim provider runtime requires an existing product_user_sessions row",
          );
        }
        if (Number(row.revision) !== expectedRevision) {
          throw new PersistenceError(
            "REVISION_CONFLICT",
            "Conflicting writes to the same user's durable ProductSnapshot",
          );
        }
        const updated = await tx.query<{ user_id: string }>(SQL.updateRimProviderRuntime, [
          currentUserId,
          expectedRevision,
          jsonParam(runtime),
        ]);
        if (!updated.rows[0]) {
          throw new PersistenceError(
            "REVISION_CONFLICT",
            "Conflicting writes to the same user's durable ProductSnapshot",
          );
        }
        return this.read(tx, currentUserId);
      });
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

  async listRelationshipContextSources(
    leftUserId: UserId,
    rightUserId: UserId,
  ): Promise<readonly RelationshipContextSource[]> {
    const result = await this.client.query<RelationshipContextSourceSqlRow>(
      SQL.selectRelationshipContextSources,
      [leftUserId, rightUserId],
    );
    return result.rows.map((row) => ({
      banId: row.ban_id as Ban["id"],
      senderId: row.sender_id as UserId,
      receiverId: row.receiver_id as UserId,
      banText: row.ban_text,
      acceptance: row.acceptance,
      status: row.status,
      createdSeq: Number(row.created_seq),
      createdAtMs: createdAtMs(row.created_at),
      timerStartedAtMs:
        row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
      timerState: row.timer_state ?? null,
      checkPairCreated: Boolean(row.check_pair_created),
      receiverAnswer: row.receiver_answer ?? null,
      senderAnswer: row.sender_answer ?? null,
      resultingStatus: row.resulting_status ?? null,
    }));
  }

  async findShareByToken(token: string): Promise<StoredShareLookup | null> {
    const result = await this.client.query<ShareSqlRow>(SQL.selectShareByToken, [token]);
    return this.shareLookupFromRow(result.rows[0]);
  }

  async getShareByAttemptId(attemptId: string): Promise<StoredShareLookup | null> {
    const result = await this.client.query<ShareSqlRow>(SQL.selectShareByAttemptId, [attemptId]);
    return this.shareLookupFromRow(result.rows[0]);
  }

  async claimTemplateShare(input: ClaimTemplateShareInput): Promise<ClaimTemplateShareResult> {
    try {
      return await this.client.transaction(async (tx) => {
        const selected = await tx.query<ShareSqlRow>(SQL.selectShareByTokenForUpdate, [
          input.token,
        ]);
        const lookup = this.shareLookupFromRow(selected.rows[0]);
        if (!lookup) {
          return { status: "REJECTED" as const, reason: "UNKNOWN_TOKEN" as const };
        }
        const existing = lookup.share.createdBanId
          ? await tx.query<BanSqlRow>(SQL.selectBanById, [lookup.share.createdBanId])
          : null;
        const ban = existing?.rows[0] ? banFromRow(existing.rows[0]) : null;
        const classification = classifyShareForClaim(
          lookup.ownerId,
          lookup.share,
          input.receiverId,
          ban,
        );
        if (classification.action === "ALREADY_BOUND") {
          return { status: "ALREADY_BOUND" as const, banId: classification.banId };
        }
        if (classification.action === "CONFLICT") {
          return { status: "CONFLICT" as const, banId: classification.banId };
        }
        if (classification.action === "REJECTED") {
          return { status: "REJECTED" as const, reason: classification.reason };
        }
        for (const userId of [lookup.ownerId, input.receiverId].sort()) {
          await tx.query(SQL.selectSessionForUpdate, [userId]);
        }
        const loaded = await this.read(tx, input.receiverId);
        const transition = input.reduceClaim({
          share: lookup.share,
          ownerId: lookup.ownerId,
          receiver: { revision: loaded.revision, snapshot: loaded.snapshot },
        });
        if (transition.outcome !== "APPLIED") {
          return { status: "NOT_APPLIED" as const, transition };
        }
        const created = createdClaimBan(loaded.snapshot, transition.snapshot);
        if (
          !created ||
          created.senderId !== lookup.ownerId ||
          created.receiverId !== input.receiverId ||
          created.boundViaTelegramShareLink !== true
        ) {
          throw new PersistenceError(
            "INVARIANT",
            "Template share claim did not create exactly one receiver-bound Ban",
          );
        }
        const persisted = snapshotForReceiverClaimPersist(
          loaded.snapshot,
          transition.snapshot,
          lookup.share.attemptId,
        );
        const written = await this.writeOn(tx, input.receiverId, loaded.revision, persisted, false);
        const confirmed = await tx.query<{ attempt_id: string }>(SQL.confirmShareIfActive, [
          lookup.share.attemptId,
          created.id,
          lookup.ownerId,
        ]);
        if (confirmed.rows.length !== 1) {
          throw new PersistenceError(
            "TRANSACTION_FAILED",
            "Template share claim lost the ACTIVE compare-and-swap",
          );
        }
        const confirmedShare = {
          ...lookup.share,
          status: "CONFIRMED" as const,
          createdBanId: created.id,
        };
        const senderLoaded = await this.read(tx, lookup.ownerId);
        const observation = input.observeSender?.({
          ownerId: lookup.ownerId,
          share: confirmedShare,
          ban: created,
          sender: { revision: senderLoaded.revision, snapshot: senderLoaded.snapshot },
        });
        if (observation) {
          if (observation.outcome !== "APPLIED") {
            throw new PersistenceError(
              "INVARIANT",
              "CREATE_BAN.CLAIM_OBSERVED did not apply for the pending sender",
            );
          }
          await this.writeOn(
            tx,
            lookup.ownerId,
            senderLoaded.revision,
            observation.snapshot,
            false,
          );
        }
        return {
          status: "CLAIMED" as const,
          loadedRevision: written.revision,
          loadedSnapshot: written.snapshot,
          banId: created.id,
          transition,
        };
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        "TRANSACTION_FAILED",
        error instanceof Error ? error.message : "template share claim transaction failed",
      );
    }
  }

  private shareLookupFromRow(row: ShareSqlRow | undefined): StoredShareLookup | null {
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
    return banFromRow(row);
  }

  async markTelegramPersistentReentryBootstrapSent(currentUserId: UserId, claimToken: string) {
    return this.client.transaction(async (tx) => {
      const locked = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [currentUserId]);
      const row = locked.rows[0];
      if (!row || !row.telegram_persistent_reentry_established) {
        return { status: "NOT_REQUIRED" as const };
      }
      if (row.telegram_persistent_reentry_bootstrap_sent) {
        return { status: "ALREADY_MARKED" as const };
      }
      if (row.telegram_persistent_reentry_bootstrap_claim_token !== claimToken) {
        return { status: "STALE_CLAIM" as const };
      }
      const updated = await tx.query<{ user_id: string }>(
        SQL.markTelegramPersistentReentryBootstrapSent,
        [currentUserId, claimToken],
      );
      if (updated.rows.length === 0) {
        return { status: "STALE_CLAIM" as const };
      }
      return { status: "MARKED" as const };
    });
  }

  async claimTelegramPersistentReentryBootstrapDelivery(
    currentUserId: UserId,
    nowMs: number,
    leaseMs: number,
  ) {
    return this.client.transaction(async (tx) => {
      const locked = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [currentUserId]);
      const row = locked.rows[0];
      if (!row || !row.telegram_persistent_reentry_established) {
        return { status: "NOT_REQUIRED" as const };
      }
      if (row.telegram_persistent_reentry_bootstrap_sent) {
        return { status: "ALREADY_SENT" as const };
      }
      const existingClaim =
        row.telegram_persistent_reentry_bootstrap_claimed_until_ms === null ||
        row.telegram_persistent_reentry_bootstrap_claimed_until_ms === undefined
          ? null
          : Number(row.telegram_persistent_reentry_bootstrap_claimed_until_ms);
      if (existingClaim !== null && Number.isFinite(existingClaim) && existingClaim > nowMs) {
        return { status: "ALREADY_CLAIMED" as const, claimedUntilMs: existingClaim };
      }
      const claimedUntilMs = nowMs + leaseMs;
      const claimToken = randomUUID();
      const updated = await tx.query<{
        user_id: string;
        telegram_persistent_reentry_bootstrap_claimed_until_ms: number | string;
        telegram_persistent_reentry_bootstrap_claim_token: string;
      }>(SQL.claimTelegramPersistentReentryBootstrapDelivery, [
        currentUserId,
        claimedUntilMs,
        nowMs,
        claimToken,
      ]);
      if (updated.rows.length === 0) {
        const again = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [currentUserId]);
        const againRow = again.rows[0];
        if (againRow?.telegram_persistent_reentry_bootstrap_sent) {
          return { status: "ALREADY_SENT" as const };
        }
        const againClaim =
          againRow?.telegram_persistent_reentry_bootstrap_claimed_until_ms === null ||
          againRow?.telegram_persistent_reentry_bootstrap_claimed_until_ms === undefined
            ? nowMs
            : Number(againRow.telegram_persistent_reentry_bootstrap_claimed_until_ms);
        return {
          status: "ALREADY_CLAIMED" as const,
          claimedUntilMs: Number.isFinite(againClaim) ? againClaim : nowMs,
        };
      }
      return { status: "CLAIMED" as const, claimToken, claimedUntilMs };
    });
  }

  async releaseTelegramPersistentReentryBootstrapClaim(currentUserId: UserId, claimToken: string) {
    return this.client.transaction(async (tx) => {
      const locked = await tx.query<SessionRow>(SQL.selectSessionForUpdate, [currentUserId]);
      const row = locked.rows[0];
      if (!row) {
        return { status: "NOT_HELD" as const };
      }
      if (row.telegram_persistent_reentry_bootstrap_sent) {
        return { status: "ALREADY_SENT" as const };
      }
      if (
        row.telegram_persistent_reentry_bootstrap_claim_token === null ||
        row.telegram_persistent_reentry_bootstrap_claim_token === undefined
      ) {
        return { status: "NOT_HELD" as const };
      }
      if (row.telegram_persistent_reentry_bootstrap_claim_token !== claimToken) {
        return { status: "STALE_CLAIM" as const };
      }
      const updated = await tx.query<{ user_id: string }>(
        SQL.releaseTelegramPersistentReentryBootstrapClaim,
        [currentUserId, claimToken],
      );
      if (updated.rows.length === 0) {
        return { status: "STALE_CLAIM" as const };
      }
      return { status: "RELEASED" as const };
    });
  }

  async bindBanReceiver(banId: BanId, receiverId: UserId): Promise<BanReceiverBindResult> {
    return this.bindBanReceiverOn(this.client, banId, receiverId);
  }

  async persistShareLinkResolved(
    input: PersistShareLinkResolvedInput,
  ): Promise<PersistShareLinkResolvedResult> {
    if (input.result.outcome !== "APPLIED") {
      throw new PersistenceError(
        "APPLIED_TRANSITION_REQUIRED",
        "Only an APPLIED Product Kernel TransitionResult may be persisted",
      );
    }
    try {
      return await this.client.transaction(async (tx) => {
        const bind = await this.bindBanReceiverOn(tx, input.banId, input.receiverId);
        if (bind.status === "MISSING" || bind.status === "CONFLICT") {
          return { status: "BIND_REJECTED" as const, bindStatus: bind.status };
        }
        const loaded = await this.writeOn(
          tx,
          input.currentUserId,
          input.expectedRevision,
          input.result.snapshot,
          false,
        );
        return {
          status: "PERSISTED" as const,
          loaded,
          bindStatus: bind.status,
        };
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        "TRANSACTION_FAILED",
        error instanceof Error
          ? error.message
          : "share-link resolved persistence transaction failed",
      );
    }
  }

  private async bindBanReceiverOn(
    client: PersistenceSqlClient,
    banId: BanId,
    receiverId: UserId,
  ): Promise<BanReceiverBindResult> {
    const existingResult = await client.query<BanSqlRow>(SQL.selectBanById, [banId]);
    const existingRow = existingResult.rows[0];
    if (!existingRow) {
      return { status: "MISSING" };
    }
    const existing = banFromRow(existingRow);
    if (existing.receiverId === receiverId) {
      return { status: "ALREADY_BOUND", ban: existing };
    }
    if (existing.receiverId !== null) {
      return { status: "CONFLICT", ban: existing };
    }
    const result = await client.query<BanSqlRow>(SQL.bindBanReceiverIfUnbound, [banId, receiverId]);
    const row = result.rows[0];
    if (row) {
      return {
        status: "BOUND",
        ban: banFromRow(row),
      };
    }
    const racedResult = await client.query<BanSqlRow>(SQL.selectBanById, [banId]);
    const racedRow = racedResult.rows[0];
    if (!racedRow) {
      return { status: "MISSING" };
    }
    const raced = banFromRow(racedRow);
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
    runtimeReplacement?: unknown,
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
        ban.boundViaTelegramShareLink,
        ban.sourceProposalId,
      ]);
    }
    if (this.failAfterBans) {
      this.failAfterBans = false;
      throw new PersistenceError("TRANSACTION_FAILED", "injected failure after Ban write");
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
    const previousBootstrapSent = Boolean(
      sessionResult.rows[0]?.telegram_persistent_reentry_bootstrap_sent,
    );
    const previousClaimedUntil =
      sessionResult.rows[0]?.telegram_persistent_reentry_bootstrap_claimed_until_ms;
    const previousClaimedUntilMs =
      previousClaimedUntil === null || previousClaimedUntil === undefined
        ? null
        : Number(previousClaimedUntil);
    const previousClaimToken =
      sessionResult.rows[0]?.telegram_persistent_reentry_bootstrap_claim_token ?? null;
    const session = sessionFromSnapshot(currentUserId, snapshot, nextRevision, {
      telegramPersistentReentryBootstrapSent: previousBootstrapSent,
      telegramPersistentReentryBootstrapClaimedUntilMs: Number.isFinite(previousClaimedUntilMs)
        ? previousClaimedUntilMs
        : null,
      telegramPersistentReentryBootstrapClaimToken: previousClaimToken,
      rimProviderRuntime:
        runtimeReplacement === undefined
          ? parseJson(sessionResult.rows[0]?.rim_provider_runtime ?? null)
          : runtimeReplacement,
    });
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
      session.telegramPersistentReentryEligible,
      session.telegramPersistentReentryEstablished,
      session.telegramPersistentReentryActiveRequestId,
      session.telegramPersistentReentryBootstrapSent,
      session.telegramPersistentReentryBootstrapClaimedUntilMs,
      session.telegramPersistentReentryBootstrapClaimToken,
      session.telegramPersistentReentryCtaSurfaceGeneration,
      session.telegramPersistentReentryCtaConsumedSurfaceGeneration,
      jsonParam(session.rimProviderRuntime),
    ]);
    return this.read(tx, currentUserId);
  }

  private async read(client: PersistenceSqlClient, currentUserId: UserId): Promise<LoadedSnapshot> {
    const sessionResult = await client.query<SessionRow>(SQL.selectSessionForUpdate, [
      currentUserId,
    ]);
    const sessionRow = sessionResult.rows[0];
    const bansResult = await client.query<BanSqlRow>(SQL.selectBansForUser, [currentUserId]);
    const bans = bansResult.rows.map((row): Ban => banFromRow(row));
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
          telegramPersistentReentryEligible: Boolean(
            sessionRow.telegram_persistent_reentry_eligible,
          ),
          telegramPersistentReentryEstablished: Boolean(
            sessionRow.telegram_persistent_reentry_established,
          ),
          telegramPersistentReentryActiveRequestId:
            sessionRow.telegram_persistent_reentry_active_request_id ?? null,
          telegramPersistentReentryBootstrapSent: Boolean(
            sessionRow.telegram_persistent_reentry_bootstrap_sent,
          ),
          telegramPersistentReentryBootstrapClaimedUntilMs: (() => {
            const raw = sessionRow.telegram_persistent_reentry_bootstrap_claimed_until_ms;
            if (raw === null || raw === undefined) {
              return null;
            }
            const value = Number(raw);
            return Number.isFinite(value) ? value : null;
          })(),
          telegramPersistentReentryBootstrapClaimToken:
            sessionRow.telegram_persistent_reentry_bootstrap_claim_token ?? null,
          telegramPersistentReentryCtaSurfaceGeneration: (() => {
            const raw = sessionRow.telegram_persistent_reentry_cta_surface_generation;
            if (raw === null || raw === undefined) {
              return 0;
            }
            const value = Number(raw);
            return Number.isFinite(value) ? value : 0;
          })(),
          telegramPersistentReentryCtaConsumedSurfaceGeneration: (() => {
            const raw = sessionRow.telegram_persistent_reentry_cta_consumed_surface_generation;
            if (raw === null || raw === undefined) {
              return null;
            }
            const value = Number(raw);
            return Number.isFinite(value) ? value : null;
          })(),
          rimProviderRuntime: parseJson(sessionRow.rim_provider_runtime ?? null),
        }
      : undefined;
    return {
      revision: session?.revision ?? 0,
      telegramPersistentReentryBootstrapSent:
        session?.telegramPersistentReentryBootstrapSent ?? false,
      telegramPersistentReentryBootstrapClaimedUntilMs:
        session?.telegramPersistentReentryBootstrapClaimedUntilMs ?? null,
      telegramPersistentReentryBootstrapClaimToken:
        session?.telegramPersistentReentryBootstrapClaimToken ?? null,
      rimProviderRuntime: session?.rimProviderRuntime ?? null,
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
