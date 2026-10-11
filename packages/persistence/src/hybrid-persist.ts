import type {
  Ban,
  CheckPair,
  DomainTimer,
  Effect,
  NotificationItem,
  PendingOperation,
  ProductSnapshot,
  ShareOperation,
  TransitionResult,
} from "@98plus/product-model";
import type {
  BanId,
  CheckPairId,
  DomainTimerId,
  NotificationItemId,
  OperationId,
  ShareAttemptId,
  UserId,
} from "@98plus/product-model";
import type { CanonicalEventId } from "@98plus/product-model";
import type { AppliedProductRule } from "./types.ts";
import { PersistenceError } from "./errors.ts";

export type PersistenceBaseline = Readonly<{
  revision: number;
  bans: Readonly<Record<string, Ban>>;
  timers: Readonly<Record<string, DomainTimer>>;
  checkPairs: Readonly<Record<string, CheckPair>>;
  items: Readonly<Record<string, NotificationItem>>;
  notificationItemIds: readonly NotificationItemId[];
  pendingOperationIds: readonly OperationId[];
  shareAttemptIds: readonly ShareAttemptId[];
  banIds: readonly BanId[];
  timerIds: readonly DomainTimerId[];
  checkPairIds: readonly CheckPairId[];
}>;

export type EntityWriteSet = Readonly<{
  banIds: readonly BanId[];
  timerIds: readonly DomainTimerId[];
  checkPairIds: readonly CheckPairId[];
  itemIds: readonly NotificationItemId[];
  operationIds: readonly OperationId[];
  operationIdsToDelete: readonly OperationId[];
  shareAttemptIds: readonly ShareAttemptId[];
}>;

export type ProductTransactionLockPlan = Readonly<{
  shareToken?: string;
  sessionUserIds: readonly UserId[];
  banIds: readonly BanId[];
  timerIds: readonly DomainTimerId[];
  checkPairIds: readonly CheckPairId[];
}>;

export type BanMutationAuthority =
  | Readonly<{ kind: "APPLIED_RULE"; eventId: CanonicalEventId; branch: string }>
  | Readonly<{ kind: "BIND_RECEIVER" }>
  | Readonly<{ kind: "PRESERVE_ONLY" }>;

export type HeldLockSet = Readonly<{
  sessionUserIds: ReadonlySet<string>;
  banIds: ReadonlySet<string>;
  timerIds: ReadonlySet<string>;
  checkPairIds: ReadonlySet<string>;
}>;

export type SharedWriteContext = Readonly<{
  baseline: PersistenceBaseline;
  writeSet: EntityWriteSet;
  lockPlan: ProductTransactionLockPlan;
  held?: HeldLockSet;
  mutationAuthority: BanMutationAuthority;
  /** 12D-1: always empty; 12D-2 Status materializer fills this. */
  materializerWrittenItemIds: readonly NotificationItemId[];
}>;

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function baselineFromLoadedSnapshot(
  snapshot: ProductSnapshot,
  revision: number,
): PersistenceBaseline {
  const bans = snapshot.extended.entities.bans;
  const timers = snapshot.extended.entities.domainTimers;
  const checkPairs = snapshot.extended.entities.checkPairs;
  const items = snapshot.extended.entities.notificationItems;
  const shares = snapshot.extended.entities.shareOperations;
  const ops = snapshot.runtime.pendingOperations;
  return {
    revision,
    bans,
    timers,
    checkPairs,
    items,
    notificationItemIds: Object.keys(items) as NotificationItemId[],
    pendingOperationIds: Object.keys(ops) as OperationId[],
    shareAttemptIds: Object.keys(shares) as ShareAttemptId[],
    banIds: Object.keys(bans) as BanId[],
    timerIds: Object.keys(timers) as DomainTimerId[],
    checkPairIds: Object.keys(checkPairs) as CheckPairId[],
  };
}

export function emptyBaseline(revision: number): PersistenceBaseline {
  return {
    revision,
    bans: {},
    timers: {},
    checkPairs: {},
    items: {},
    notificationItemIds: [],
    pendingOperationIds: [],
    shareAttemptIds: [],
    banIds: [],
    timerIds: [],
    checkPairIds: [],
  };
}

export function deriveEntityWriteSet(
  effects: readonly Effect[],
  options: Readonly<{
    materializerWrittenItemIds?: readonly NotificationItemId[];
    applicationAuthorizedItemIds?: readonly NotificationItemId[];
    applicationAuthorizedBanIds?: readonly BanId[];
  }> = {},
): EntityWriteSet {
  const banIds = new Set<string>(
    options.applicationAuthorizedBanIds === undefined
      ? []
      : options.applicationAuthorizedBanIds,
  );
  const timerIds = new Set<string>();
  const checkPairIds = new Set<string>();
  const itemIds = new Set<string>([
    ...(options.materializerWrittenItemIds === undefined
      ? []
      : options.materializerWrittenItemIds),
    ...(options.applicationAuthorizedItemIds === undefined
      ? []
      : options.applicationAuthorizedItemIds),
  ]);
  const operationIds = new Set<string>();
  const operationIdsToDelete = new Set<string>();
  const shareAttemptIds = new Set<string>();

  for (const effect of effects ?? []) {
    switch (effect.type) {
      case "UPSERT_BAN":
        banIds.add(effect.ban.id);
        break;
      case "UPSERT_DOMAIN_TIMER":
        timerIds.add(effect.timer.id);
        break;
      case "UPSERT_CHECK_PAIR":
        checkPairIds.add(effect.pair.id);
        banIds.add(effect.pair.banId);
        break;
      case "UPSERT_NOTIFICATION_ITEM":
        itemIds.add(effect.item.id);
        banIds.add(effect.item.banId);
        break;
      case "SET_NOTIFICATION_LIFECYCLE":
      case "PROCESS_TIMER_NOTIFICATION_ITEM":
        itemIds.add(effect.itemId);
        break;
      case "START_OPERATION":
        operationIds.add(effect.operation.operationId);
        break;
      case "CLEAR_OPERATION":
        operationIdsToDelete.add(effect.operationId);
        break;
      case "MARK_OPERATION_RESULT_APPLIED":
      case "MARK_OPERATION_SUPERSEDED_BY_EXTERNAL_ENTRY":
        operationIds.add(effect.operationId);
        break;
      case "UPSERT_SHARE_OPERATION":
        shareAttemptIds.add(effect.operation.attemptId);
        break;
      default:
        break;
    }
  }

  return {
    banIds: sortedUniqueStrings([...banIds]) as BanId[],
    timerIds: sortedUniqueStrings([...timerIds]) as DomainTimerId[],
    checkPairIds: sortedUniqueStrings([...checkPairIds]) as CheckPairId[],
    itemIds: sortedUniqueStrings([...itemIds]) as NotificationItemId[],
    operationIds: sortedUniqueStrings([...operationIds]) as OperationId[],
    operationIdsToDelete: sortedUniqueStrings([...operationIdsToDelete]) as OperationId[],
    shareAttemptIds: sortedUniqueStrings([...shareAttemptIds]) as ShareAttemptId[],
  };
}

export function buildLockPlan(input: Readonly<{
  shareToken?: string;
  sessionUserIds: readonly UserId[];
  writeSet: EntityWriteSet;
  extraBanIds?: readonly BanId[];
  extraTimerIds?: readonly DomainTimerId[];
  extraCheckPairIds?: readonly CheckPairId[];
}>): ProductTransactionLockPlan {
  const plan: {
    shareToken?: string;
    sessionUserIds: UserId[];
    banIds: BanId[];
    timerIds: DomainTimerId[];
    checkPairIds: CheckPairId[];
  } = {
    sessionUserIds: sortedUniqueStrings(input.sessionUserIds) as UserId[],
    banIds: sortedUniqueStrings([
      ...input.writeSet.banIds,
      ...(input.extraBanIds === undefined ? [] : input.extraBanIds),
    ]) as BanId[],
    timerIds: sortedUniqueStrings([
      ...input.writeSet.timerIds,
      ...(input.extraTimerIds === undefined ? [] : input.extraTimerIds),
    ]) as DomainTimerId[],
    checkPairIds: sortedUniqueStrings([
      ...input.writeSet.checkPairIds,
      ...(input.extraCheckPairIds === undefined ? [] : input.extraCheckPairIds),
    ]) as CheckPairId[],
  };
  if (input.shareToken !== undefined) {
    plan.shareToken = input.shareToken;
  }
  return plan;
}

export function assertWriteSetCoveredByLockPlan(
  writeSet: EntityWriteSet,
  plan: ProductTransactionLockPlan,
): void {
  const banSet = new Set(plan.banIds);
  const timerSet = new Set(plan.timerIds);
  const pairSet = new Set(plan.checkPairIds);
  for (const id of writeSet.banIds) {
    if (!banSet.has(id)) {
      throw new PersistenceError(
        "INVARIANT",
        `Shared Ban write ${id} is outside the predeclared transaction lock plan`,
      );
    }
  }
  for (const id of writeSet.timerIds) {
    if (!timerSet.has(id)) {
      throw new PersistenceError(
        "INVARIANT",
        `DomainTimer write ${id} is outside the predeclared transaction lock plan`,
      );
    }
  }
  for (const id of writeSet.checkPairIds) {
    if (!pairSet.has(id)) {
      throw new PersistenceError(
        "INVARIANT",
        `CheckPair write ${id} is outside the predeclared transaction lock plan`,
      );
    }
  }
}

/**
 * P2-LOCK-EXPAND: once an outer transaction already holds Ban/Timer/Pair locks,
 * nested writeOn must not acquire additional rows of that resource class
 * (would invert ascending lock order and risk deadlock).
 * Empty held sets mean that resource class has not been locked yet and writeOn
 * may acquire the full sorted plan.
 */
export function assertNoHeldLockExpansion(
  held: HeldLockSet | undefined,
  plan: ProductTransactionLockPlan,
): void {
  if (held === undefined) {
    return;
  }
  if (held.banIds.size > 0) {
    for (const id of plan.banIds) {
      if (!held.banIds.has(id)) {
        throw new PersistenceError(
          "INVARIANT",
          `Lock plan expands held Ban locks with ${id}; nested acquisition is forbidden`,
        );
      }
    }
  }
  if (held.timerIds.size > 0) {
    for (const id of plan.timerIds) {
      if (!held.timerIds.has(id)) {
        throw new PersistenceError(
          "INVARIANT",
          `Lock plan expands held DomainTimer locks with ${id}; nested acquisition is forbidden`,
        );
      }
    }
  }
  if (held.checkPairIds.size > 0) {
    for (const id of plan.checkPairIds) {
      if (!held.checkPairIds.has(id)) {
        throw new PersistenceError(
          "INVARIANT",
          `Lock plan expands held CheckPair locks with ${id}; nested acquisition is forbidden`,
        );
      }
    }
  }
}

export function mutationAuthorityFromRule(
  rule: AppliedProductRule | undefined,
): BanMutationAuthority {
  if (!rule) {
    return { kind: "PRESERVE_ONLY" };
  }
  return { kind: "APPLIED_RULE", eventId: rule.eventId, branch: rule.branch };
}

export function mutationAuthorityFromTransition(
  rule: AppliedProductRule | undefined,
  result: TransitionResult,
): BanMutationAuthority {
  if (rule) {
    return mutationAuthorityFromRule(rule);
  }
  const traces = result.traces ?? [];
  const trace = [...traces].reverse().find((item) => item.eventId !== "LATE_RESULT");
  if (trace && trace.eventId !== "LATE_RESULT") {
    return { kind: "APPLIED_RULE", eventId: trace.eventId, branch: trace.branch };
  }
  return { kind: "PRESERVE_ONLY" };
}

export function sharedWriteContextForTransition(input: Readonly<{
  currentUserId: UserId;
  expectedRevision: number;
  result: TransitionResult;
  baseline?: PersistenceBaseline | undefined;
  appliedRule?: AppliedProductRule | undefined;
  held?: HeldLockSet | undefined;
  materializerWrittenItemIds?: readonly NotificationItemId[] | undefined;
  applicationAuthorizedBanIds?: readonly BanId[] | undefined;
  applicationAuthorizedItemIds?: readonly NotificationItemId[] | undefined;
  shareToken?: string | undefined;
  extraSessionUserIds?: readonly UserId[] | undefined;
  extraBanIds?: readonly BanId[] | undefined;
  extraTimerIds?: readonly DomainTimerId[] | undefined;
  extraCheckPairIds?: readonly CheckPairId[] | undefined;
  /** When set, replaces derived banIds in the lock plan (claim Ban closure). */
  freezeBanIds?: readonly BanId[] | undefined;
}>): SharedWriteContext {
  const materializerWrittenItemIds = input.materializerWrittenItemIds ?? [];
  const writeSetOptions: {
    materializerWrittenItemIds: readonly NotificationItemId[];
    applicationAuthorizedBanIds?: readonly BanId[];
    applicationAuthorizedItemIds?: readonly NotificationItemId[];
  } = { materializerWrittenItemIds };
  if (input.applicationAuthorizedBanIds !== undefined) {
    writeSetOptions.applicationAuthorizedBanIds = input.applicationAuthorizedBanIds;
  }
  if (input.applicationAuthorizedItemIds !== undefined) {
    writeSetOptions.applicationAuthorizedItemIds = input.applicationAuthorizedItemIds;
  }
  const writeSet = deriveEntityWriteSet(input.result.effects, writeSetOptions);
  // P1-BASELINE-01: never invent an empty baseline as Ban mutation evidence.
  if (input.baseline === undefined && writeSet.banIds.length > 0) {
    throw new PersistenceError(
      "INVARIANT",
      "Product Ban writes require a PersistenceBaseline from the pre-transition actor snapshot",
    );
  }
  const baseline =
    input.baseline === undefined
      ? emptyBaseline(input.expectedRevision)
      : input.baseline;
  const lockPlanInput: {
    shareToken?: string;
    sessionUserIds: readonly UserId[];
    writeSet: EntityWriteSet;
    extraBanIds?: readonly BanId[];
    extraTimerIds?: readonly DomainTimerId[];
    extraCheckPairIds?: readonly CheckPairId[];
  } = {
    sessionUserIds: [
      input.currentUserId,
      ...(input.extraSessionUserIds === undefined ? [] : input.extraSessionUserIds),
    ],
    writeSet,
  };
  if (input.shareToken !== undefined) {
    lockPlanInput.shareToken = input.shareToken;
  }
  if (input.extraBanIds !== undefined) {
    lockPlanInput.extraBanIds = input.extraBanIds;
  }
  if (input.extraTimerIds !== undefined) {
    lockPlanInput.extraTimerIds = input.extraTimerIds;
  }
  if (input.extraCheckPairIds !== undefined) {
    lockPlanInput.extraCheckPairIds = input.extraCheckPairIds;
  }
  const lockPlan = buildLockPlan(lockPlanInput);
  const frozenPlan =
    input.freezeBanIds === undefined
      ? lockPlan
      : {
          ...lockPlan,
          banIds: sortedUniqueStrings(input.freezeBanIds) as BanId[],
        };
  const context: {
    baseline: PersistenceBaseline;
    writeSet: EntityWriteSet;
    lockPlan: ProductTransactionLockPlan;
    held?: HeldLockSet;
    mutationAuthority: BanMutationAuthority;
    materializerWrittenItemIds: readonly NotificationItemId[];
  } = {
    baseline,
    writeSet,
    lockPlan: frozenPlan,
    mutationAuthority: mutationAuthorityFromTransition(input.appliedRule, input.result),
    materializerWrittenItemIds,
  };
  if (input.held !== undefined) {
    context.held = input.held;
  }
  return context;
}

export type BanFieldKey = keyof Ban;

export function fieldDiffBan(baseline: Ban | undefined, next: Ban): ReadonlySet<BanFieldKey> {
  // Absent baseline cannot authorize field changes (P1-BASELINE-01). Callers must fail closed
  // before merge, or mergeBan must preserve durable state when baselineBan is undefined.
  if (baseline === undefined) {
    return new Set();
  }
  const keys: BanFieldKey[] = [
    "id",
    "senderId",
    "receiverId",
    "banText",
    "durationMinutes",
    "acceptance",
    "status",
    "boundViaTelegramShareLink",
    "sourceProposalId",
  ];
  const changed = new Set<BanFieldKey>();
  for (const key of keys) {
    if (baseline[key] !== next[key]) {
      changed.add(key);
    }
  }
  return changed;
}

/** Frozen M3 allowlist — verified against instantiate.ts Ban writers. */
export function allowedBanFields(authority: BanMutationAuthority): ReadonlySet<BanFieldKey> {
  if (authority.kind === "BIND_RECEIVER") {
    return new Set<BanFieldKey>(["receiverId"]);
  }
  if (authority.kind === "PRESERVE_ONLY") {
    return new Set();
  }
  const { eventId, branch } = authority;
  switch (eventId) {
    case "E-20":
    case "E-23":
      return new Set<BanFieldKey>(["status"]);
    case "E-30":
      // New Ban: full create; original Ban acceptance-only — caller distinguishes by create vs update.
      return new Set<BanFieldKey>([
        "id",
        "senderId",
        "receiverId",
        "banText",
        "durationMinutes",
        "acceptance",
        "status",
        "boundViaTelegramShareLink",
        "sourceProposalId",
      ]);
    case "E-10":
      return new Set<BanFieldKey>([
        "id",
        "senderId",
        "receiverId",
        "banText",
        "durationMinutes",
        "acceptance",
        "status",
        "boundViaTelegramShareLink",
        "sourceProposalId",
      ]);
    case "E-08":
      if (branch.includes("template") || branch === "valid-template-draft") {
        return new Set<BanFieldKey>([
          "id",
          "senderId",
          "receiverId",
          "banText",
          "durationMinutes",
          "acceptance",
          "status",
          "boundViaTelegramShareLink",
          "sourceProposalId",
        ]);
      }
      return new Set();
    case "E-45":
      return new Set<BanFieldKey>(["receiverId", "boundViaTelegramShareLink"]);
    case "E-65":
      return new Set();
    default:
      return new Set();
  }
}

export function snapshotEntitiesForWriteSet(
  snapshot: ProductSnapshot,
  writeSet: EntityWriteSet,
): Readonly<{
  bans: Ban[];
  timers: DomainTimer[];
  pairs: CheckPair[];
  items: NotificationItem[];
  operations: PendingOperation[];
  shares: ShareOperation[];
}> {
  const bans: Ban[] = [];
  for (const id of writeSet.banIds) {
    const ban = snapshot.extended.entities.bans[id];
    if (ban) {
      bans.push(ban);
    }
  }
  const timers: DomainTimer[] = [];
  for (const id of writeSet.timerIds) {
    const timer = snapshot.extended.entities.domainTimers[id];
    if (timer) {
      timers.push(timer);
    }
  }
  const pairs: CheckPair[] = [];
  for (const id of writeSet.checkPairIds) {
    const pair = snapshot.extended.entities.checkPairs[id];
    if (pair) {
      pairs.push(pair);
    }
  }
  const items: NotificationItem[] = [];
  for (const id of writeSet.itemIds) {
    const item = snapshot.extended.entities.notificationItems[id];
    if (item) {
      items.push(item);
    }
  }
  const operations: PendingOperation[] = [];
  for (const id of writeSet.operationIds) {
    const op = snapshot.runtime.pendingOperations[id];
    if (op) {
      operations.push(op);
    }
  }
  const shares: ShareOperation[] = [];
  for (const id of writeSet.shareAttemptIds) {
    const share = snapshot.extended.entities.shareOperations[id];
    if (share) {
      shares.push(share);
    }
  }
  return { bans, timers, pairs, items, operations, shares };
}
