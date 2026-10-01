import {
  emptySnapshot,
  isProductControlState,
  isValidDurationMinutes,
  type Ban,
  type BanDraft,
  type CheckPair,
  type DomainTimer,
  type NotificationItem,
  type PendingExternalEntry,
  type PendingOperation,
  type ProductControlState,
  type ProductSnapshot,
  type ReplyBanDraft,
  type ReplySource,
  type RimChat,
  type ShareOperation,
} from "@98plus/product-model";
import type { UserId } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";

export function cloneJson<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export function assertCanonicalControlState(value: string | null): ProductControlState | null {
  if (value === null) {
    return null;
  }
  if (!isProductControlState(value)) {
    throw new PersistenceError("INVARIANT", `Non-canonical Product Control State ${value}`);
  }
  return value;
}

export function assertPersistedDuration(value: number): void {
  if (!isValidDurationMinutes(value)) {
    throw new PersistenceError("INVARIANT", "Ban/DomainTimer duration must remain 3–60 minutes");
  }
}

export function assertShareStatus(status: ShareOperation["status"]): void {
  if (status === "INVALIDATED") {
    throw new PersistenceError(
      "INVARIANT",
      "INVALIDATED ShareOperation is not a reachable persisted status",
    );
  }
}

export type NotificationItemRecord = Readonly<{
  item_id: string;
  owner_id: string;
  ban_id: string;
  kind: string;
  fifo_sequence: number;
  lifecycle_status: string | null;
  lifecycle_display: string | null;
  role: string | null;
  check_pair_id: string | null;
  domain_timer_id: string | null;
  status: string | null;
}>;

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined || value === "") {
    throw new PersistenceError("INVARIANT", `Refusing to invent missing product fact: ${field}`);
  }
  return value;
}

export function decodeNotificationItem(row: NotificationItemRecord): NotificationItem {
  const lifecycleStatus = required(row.lifecycle_status, "notification_items.lifecycle_status");
  const lifecycle =
    lifecycleStatus === "PROCESSED"
      ? { status: "PROCESSED" as const }
      : lifecycleStatus === "UNPROCESSED"
        ? {
            status: "UNPROCESSED" as const,
            display: required(row.lifecycle_display, "notification_items.lifecycle_display") as
              "WAITING" | "ACTIVE",
          }
        : (() => {
            throw new PersistenceError(
              "INVARIANT",
              `Refusing to invent missing product fact: notification_items.lifecycle_status`,
            );
          })();
  if (
    lifecycle.status === "UNPROCESSED" &&
    lifecycle.display !== "WAITING" &&
    lifecycle.display !== "ACTIVE"
  ) {
    throw new PersistenceError(
      "INVARIANT",
      "Refusing to invent missing product fact: notification_items.lifecycle_display",
    );
  }
  if (!Number.isFinite(row.fifo_sequence)) {
    throw new PersistenceError(
      "INVARIANT",
      "Refusing to invent missing product fact: notification_items.fifo_sequence",
    );
  }
  const base = {
    id: required(row.item_id, "notification_items.item_id") as NotificationItem["id"],
    ownerId: required(row.owner_id, "notification_items.owner_id") as UserId,
    banId: required(row.ban_id, "notification_items.ban_id") as NotificationItem["banId"],
    fifoSequence: row.fifo_sequence,
    lifecycle,
  };
  if (row.kind === "INCOMING_BAN") {
    return { ...base, kind: "INCOMING_BAN" };
  }
  if (row.kind === "TIMER") {
    return {
      ...base,
      kind: "TIMER",
      domainTimerId: required(row.domain_timer_id, "notification_items.domain_timer_id") as Extract<
        NotificationItem,
        { kind: "TIMER" }
      >["domainTimerId"],
    };
  }
  if (row.kind === "CHECK") {
    const role = required(row.role, "notification_items.role");
    if (role !== "RECEIVER" && role !== "SENDER") {
      throw new PersistenceError(
        "INVARIANT",
        "Refusing to invent missing product fact: notification_items.role",
      );
    }
    return {
      ...base,
      kind: "CHECK",
      role,
      checkPairId: required(row.check_pair_id, "notification_items.check_pair_id") as Extract<
        NotificationItem,
        { kind: "CHECK" }
      >["checkPairId"],
    };
  }
  if (row.kind === "STATUS") {
    const role = required(row.role, "notification_items.role");
    if (role !== "RECEIVER" && role !== "SENDER") {
      throw new PersistenceError(
        "INVARIANT",
        "Refusing to invent missing product fact: notification_items.role",
      );
    }
    const status = required(row.status, "notification_items.status");
    if (
      status !== "OVERBOARD" &&
      status !== "BANTASTIC" &&
      status !== "BANFLICT" &&
      status !== "FAIR_ENOUGH"
    ) {
      throw new PersistenceError(
        "INVARIANT",
        "Refusing to invent missing product fact: notification_items.status",
      );
    }
    return { ...base, kind: "STATUS", role, status };
  }
  throw new PersistenceError(
    "INVARIANT",
    `Refusing to invent missing product fact: notification_items.kind`,
  );
}

export function notificationItemToRecord(item: NotificationItem): NotificationItemRecord {
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

export function sessionFromSnapshot(
  userId: UserId,
  snapshot: ProductSnapshot,
  revision: number,
  options?: Readonly<{
    telegramPersistentReentryBootstrapSent?: boolean;
    telegramPersistentReentryBootstrapClaimedUntilMs?: number | null;
    telegramPersistentReentryBootstrapClaimToken?: string | null;
    /** Previous persistence-only provider runtime. Product writes must pass it through. */
    rimProviderRuntime?: unknown | null;
  }>,
): SessionRecord {
  const previousBootstrapSent = options?.telegramPersistentReentryBootstrapSent ?? false;
  const previousClaimedUntilMs =
    options?.telegramPersistentReentryBootstrapClaimedUntilMs === undefined
      ? null
      : options.telegramPersistentReentryBootstrapClaimedUntilMs;
  const previousClaimToken =
    options?.telegramPersistentReentryBootstrapClaimToken === undefined
      ? null
      : options.telegramPersistentReentryBootstrapClaimToken;
  return {
    userId,
    revision,
    controlState: assertCanonicalControlState(snapshot.controlState),
    sessionStatus: snapshot.runtime.session,
    connection: snapshot.runtime.connection,
    bootstrap: cloneJson(snapshot.runtime.bootstrap),
    rimChat: cloneJson(snapshot.extended.rimChat),
    savedFrozenRimChat: cloneJson(snapshot.extended.savedFrozenRimChat),
    createBanDraft: cloneJson(snapshot.extended.createBanDraft),
    replyBanDraft: cloneJson(snapshot.extended.replyBanDraft),
    replySource: cloneJson(snapshot.extended.replySource),
    successfulBanId: snapshot.extended.successfulBanId,
    activeNotificationItemId: snapshot.extended.activeNotificationItemId,
    statusPriorityItemId: snapshot.extended.priorities.statusItemId,
    timerPriorityItemId: snapshot.extended.priorities.timerItemId,
    pendingExternalEntry: cloneJson(snapshot.extended.pendingExternalEntry),
    telegramPersistentReentryEligible: snapshot.extended.telegramPersistentReentryEligible,
    telegramPersistentReentryEstablished: snapshot.extended.telegramPersistentReentryEstablished,
    telegramPersistentReentryActiveRequestId:
      snapshot.extended.telegramPersistentReentryActiveRequestId,
    telegramPersistentReentryCtaSurfaceGeneration:
      snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration,
    telegramPersistentReentryCtaConsumedSurfaceGeneration:
      snapshot.extended.telegramPersistentReentryCtaConsumedSurfaceGeneration,
    // Persistence-only delivery completion — never derived from established.
    telegramPersistentReentryBootstrapSent: previousBootstrapSent,
    // Persistence-only in-flight claim lease — preserved across Product transitions.
    telegramPersistentReentryBootstrapClaimedUntilMs: previousClaimedUntilMs,
    // Persistence-only fencing token — preserved across Product transitions.
    telegramPersistentReentryBootstrapClaimToken: previousClaimToken,
    rimProviderRuntime:
      options?.rimProviderRuntime === undefined ? null : cloneJson(options.rimProviderRuntime),
  };
}

export function snapshotFromRecords(input: {
  session: SessionRecord | undefined;
  bans: readonly Ban[];
  items: readonly NotificationItem[];
  timers: readonly DomainTimer[];
  pairs: readonly CheckPair[];
  shares: readonly ShareOperation[];
  operations: readonly PendingOperation[];
}): ProductSnapshot {
  const empty = emptySnapshot();
  return {
    controlState: input.session?.controlState ?? null,
    extended: {
      rimChat: cloneJson(input.session?.rimChat ?? null),
      savedFrozenRimChat: cloneJson(input.session?.savedFrozenRimChat ?? null),
      createBanDraft: cloneJson(input.session?.createBanDraft ?? null),
      replyBanDraft: cloneJson(input.session?.replyBanDraft ?? null),
      replySource: cloneJson(input.session?.replySource ?? null),
      successfulBanId: input.session?.successfulBanId ?? null,
      activeNotificationItemId: input.session?.activeNotificationItemId ?? null,
      priorities: {
        statusItemId: input.session?.statusPriorityItemId ?? null,
        timerItemId: input.session?.timerPriorityItemId ?? null,
      },
      pendingExternalEntry: cloneJson(input.session?.pendingExternalEntry ?? null),
      telegramPersistentReentryEligible: input.session?.telegramPersistentReentryEligible ?? false,
      telegramPersistentReentryEstablished:
        input.session?.telegramPersistentReentryEstablished ?? false,
      telegramPersistentReentryActiveRequestId:
        input.session?.telegramPersistentReentryActiveRequestId ?? null,
      telegramPersistentReentryCtaSurfaceGeneration:
        input.session?.telegramPersistentReentryCtaSurfaceGeneration ?? 0,
      telegramPersistentReentryCtaConsumedSurfaceGeneration:
        input.session?.telegramPersistentReentryCtaConsumedSurfaceGeneration ?? null,
      entities: {
        bans: Object.fromEntries(input.bans.map((ban) => [ban.id, ban])),
        notificationItems: Object.fromEntries(input.items.map((item) => [item.id, item])),
        checkPairs: Object.fromEntries(input.pairs.map((pair) => [pair.id, pair])),
        domainTimers: Object.fromEntries(input.timers.map((timer) => [timer.id, timer])),
        shareOperations: Object.fromEntries(
          input.shares.map((share) => {
            required(share.draft, "share_operations.draft");
            return [share.attemptId, share];
          }),
        ),
      },
    },
    runtime: {
      connection: input.session
        ? required(input.session.connection, "product_user_sessions.connection")
        : empty.runtime.connection,
      session: input.session
        ? required(input.session.sessionStatus, "product_user_sessions.session_status")
        : empty.runtime.session,
      bootstrap: cloneJson(
        input.session
          ? required(input.session.bootstrap, "product_user_sessions.bootstrap")
          : empty.runtime.bootstrap,
      ),
      transitionInFlight: null,
      pendingOperations: Object.fromEntries(
        input.operations.map((operation) => [operation.operationId, operation]),
      ),
    },
  };
}

export type SessionRecord = Readonly<{
  userId: UserId;
  revision: number;
  controlState: ProductControlState | null;
  sessionStatus: ProductSnapshot["runtime"]["session"];
  connection: ProductSnapshot["runtime"]["connection"];
  bootstrap: ProductSnapshot["runtime"]["bootstrap"];
  rimChat: RimChat | null;
  savedFrozenRimChat: RimChat | null;
  createBanDraft: BanDraft | null;
  replyBanDraft: ReplyBanDraft | null;
  replySource: ReplySource | null;
  successfulBanId: ProductSnapshot["extended"]["successfulBanId"];
  activeNotificationItemId: ProductSnapshot["extended"]["activeNotificationItemId"];
  statusPriorityItemId: ProductSnapshot["extended"]["priorities"]["statusItemId"];
  timerPriorityItemId: ProductSnapshot["extended"]["priorities"]["timerItemId"];
  pendingExternalEntry: PendingExternalEntry | null;
  telegramPersistentReentryEligible: boolean;
  telegramPersistentReentryEstablished: boolean;
  telegramPersistentReentryActiveRequestId: string | null;
  telegramPersistentReentryCtaSurfaceGeneration: number;
  telegramPersistentReentryCtaConsumedSurfaceGeneration: number | null;
  /** Persistence-only Bot API send idempotency; not a Product Authority fact. */
  telegramPersistentReentryBootstrapSent: boolean;
  /** Persistence-only claim lease expiry (epoch ms); null if unclaimed. */
  telegramPersistentReentryBootstrapClaimedUntilMs: number | null;
  /** Persistence-only fencing token for the active claim; null if unclaimed. */
  telegramPersistentReentryBootstrapClaimToken: string | null;
  /**
   * Persistence-only provider runtime for one RimChatId.
   * Not loaded into ProductSnapshot and not stored inside rim_chat.
   */
  rimProviderRuntime: unknown | null;
}>;
