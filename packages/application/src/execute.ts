import { callerUserId, type AuthenticatedContext } from "@98plus/identity";
import {
  PersistenceError,
  type AppliedProductRule,
  type ProductStore,
  type RuntimeAttemptAuthority,
} from "@98plus/persistence";
import {
  asInstant,
  CANONICAL_EVENT_DEFINITIONS,
  reduce,
  type AppliedRuleTrace,
  type Ban,
  type BanId,
  type CanonicalEvent,
  type CompositionOrder,
  type Effect,
  type KernelError,
  type MatrixResult,
  type NotificationItemId,
  type ProductControlState,
  type ProductSnapshot,
  type RimChatId,
  type ShareAttemptId,
  type ShareOperation,
  type TransitionOutcome,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import type { ApplicationClock, IdAllocator } from "./clock.ts";
import { pendingExternalEffects, type PendingExternalEffect } from "./effects.ts";
import { ApplicationError } from "./errors.ts";
import { toCanonicalEvent, type ProductEventInput } from "./event.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  runtimeWithAcceptedRetry,
} from "./rim/rim-provider-runtime.ts";

export type ProductExecutorDependencies = Readonly<{
  store: ProductStore;
  clock: ApplicationClock;
  allocateId: IdAllocator;
}>;

export type ExecuteProductEventInput = Readonly<{
  context: AuthenticatedContext;
  event: ProductEventInput;
  clientClaimedUserId?: string;
}>;

export type ApplicationExecutionStatus =
  | "APPLIED"
  | "NOT_APPLIED"
  | "KERNEL_INVARIANT"
  | "REVISION_CONFLICT"
  | "PERSISTENCE_ERROR"
  | "INFRASTRUCTURE_ERROR";

export type ApplicationExecutionResult = Readonly<{
  status: ApplicationExecutionStatus;
  currentUserId: UserId;
  event: CanonicalEvent;
  outcome: TransitionOutcome | null;
  result: MatrixResult | "UNDEFINED" | null;
  controlState: ProductControlState | null;
  snapshot: ProductSnapshot;
  revision: number;
  persisted: boolean;
  effects: readonly Effect[];
  pendingExternalEffects: readonly PendingExternalEffect[];
  traces: readonly AppliedRuleTrace[];
  composition: CompositionOrder | null;
  kernelError: KernelError | null;
  error: ApplicationError | null;
}>;

function executionResult(input: {
  status: ApplicationExecutionStatus;
  currentUserId: UserId;
  event: CanonicalEvent;
  transition: TransitionResult | null;
  snapshot: ProductSnapshot;
  revision: number;
  persisted: boolean;
  error: ApplicationError | null;
}): ApplicationExecutionResult {
  const effects = input.transition?.effects ?? [];
  return {
    status: input.status,
    currentUserId: input.currentUserId,
    event: input.event,
    outcome: input.transition?.outcome ?? null,
    result: input.transition?.result ?? null,
    controlState: input.transition?.controlState ?? input.snapshot.controlState,
    snapshot: input.snapshot,
    revision: input.revision,
    persisted: input.persisted,
    effects,
    pendingExternalEffects: pendingExternalEffects(effects),
    traces: input.transition?.traces ?? [],
    composition: input.transition?.composition ?? null,
    kernelError: input.transition?.error ?? null,
    error: input.error,
  };
}

function appliedRuleFor(event: CanonicalEvent, transition: TransitionResult): AppliedProductRule {
  const definition = CANONICAL_EVENT_DEFINITIONS.find((item) => item.name === event.name);
  if (!definition) {
    throw new ApplicationError("KERNEL_INVARIANT", "Canonical Product event has no id");
  }
  const match = [...transition.traces].reverse().find((trace) => trace.eventId === definition.id);
  if (!match) {
    throw new ApplicationError(
      "KERNEL_INVARIANT",
      "APPLIED transition has no trace for the Product event",
    );
  }
  return { eventId: definition.id, branch: match.branch };
}

function persistenceApplicationError(error: PersistenceError): ApplicationError {
  if (error.code === "REVISION_CONFLICT" || error.code === "CHECK_PAIR_CONFLICT") {
    return new ApplicationError("REVISION_CONFLICT", error.message, error);
  }
  if (
    error.code === "INVARIANT" ||
    error.code === "MISSING_FACT" ||
    error.code === "IDENTITY_REQUIRED"
  ) {
    return new ApplicationError("PERSISTENCE_INVARIANT", error.message, error);
  }
  return new ApplicationError("PERSISTENCE_FAILURE", error.message, error);
}

/**
 * Revision conflicts are surfaced to the caller.
 * Stage 5 does not automatically reload + retry: a retry could duplicate
 * non-idempotent Kernel operations such as START_OPERATION.
 */
export async function executeProductEvent(
  input: ExecuteProductEventInput,
  deps: ProductExecutorDependencies,
): Promise<ApplicationExecutionResult> {
  const event = toCanonicalEvent(input.event);
  const currentUserId = callerUserId(input.context, input.clientClaimedUserId);
  try {
    const loaded = await deps.store.loadProductSnapshot(currentUserId);
    const transition = reduce(loaded.snapshot, event, {
      now: asInstant(deps.clock.nowMs()),
      currentUserId,
      allocateId: deps.allocateId,
    });
    if (transition.outcome !== "APPLIED") {
      return executionResult({
        status: transition.outcome === "KERNEL_INVARIANT" ? "KERNEL_INVARIANT" : "NOT_APPLIED",
        currentUserId,
        event,
        transition,
        snapshot: loaded.snapshot,
        revision: loaded.revision,
        persisted: false,
        error:
          transition.outcome === "KERNEL_INVARIANT"
            ? new ApplicationError(
                "KERNEL_INVARIANT",
                transition.error?.message ?? "Product Kernel invariant failed",
                transition.error,
              )
            : null,
      });
    }
    try {
      if (event.name === "RIM.PRESS_RETRY_AI") {
        const accepted = runtimeWithAcceptedRetry(
          loaded.rimProviderRuntime,
          loaded.snapshot,
          event.payload.failedRequestId,
        );
        if (accepted) {
          const owned = await deps.store.commitOwnedTransition({
            currentUserId,
            expectedRevision: loaded.revision,
            result: transition,
            requireAttempt: accepted.authority,
            rimProviderRuntime: accepted.runtime,
            appliedRule: appliedRuleFor(event, transition),
          });
          if (owned.status === "ATTEMPT_SUPERSEDED") {
            return executionResult({
              status: "NOT_APPLIED",
              currentUserId,
              event,
              transition,
              snapshot: owned.loaded.snapshot,
              revision: owned.loaded.revision,
              persisted: false,
              error: null,
            });
          }
          return executionResult({
            status: "APPLIED",
            currentUserId,
            event,
            transition,
            snapshot: owned.loaded.snapshot,
            revision: owned.loaded.revision,
            persisted: true,
            error: null,
          });
        }
      }
      const saved = await deps.store.persistTransition({
        currentUserId,
        expectedRevision: loaded.revision,
        result: transition,
        appliedRule: appliedRuleFor(event, transition),
      });
      return executionResult({
        status: "APPLIED",
        currentUserId,
        event,
        transition,
        snapshot: saved.snapshot,
        revision: saved.revision,
        persisted: true,
        error: null,
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        const durable = await deps.store.loadProductSnapshot(currentUserId);
        const applicationError = persistenceApplicationError(error);
        return executionResult({
          status: error.code === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : "PERSISTENCE_ERROR",
          currentUserId,
          event,
          transition,
          snapshot: durable.snapshot,
          revision: durable.revision,
          persisted: false,
          error: applicationError,
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }
    if (error instanceof PersistenceError) {
      throw persistenceApplicationError(error);
    }
    throw new ApplicationError(
      "INFRASTRUCTURE_FAILURE",
      error instanceof Error ? error.message : "application infrastructure failure",
      error,
    );
  }
}

/**
 * Commit E-58 or E-59 only for the attempt that was current at this revision.
 * The store rechecks that attempt under the session lock in the same transaction
 * as the Product write. A revision conflict or a superseded attempt discards the
 * result and does not retry against the newer snapshot.
 */
export async function commitProductEventIfAttemptCurrent(
  input: ExecuteProductEventInput & Readonly<{ authority: RuntimeAttemptAuthority }>,
  deps: ProductExecutorDependencies,
): Promise<ApplicationExecutionResult | null> {
  const event = toCanonicalEvent(input.event);
  const currentUserId = callerUserId(input.context, input.clientClaimedUserId);
  const loaded = await deps.store.loadProductSnapshot(currentUserId);
  if (!attemptStillCurrent(loaded.rimProviderRuntime, input.authority)) {
    return null;
  }
  const transition = reduce(loaded.snapshot, event, {
    now: asInstant(deps.clock.nowMs()),
    currentUserId,
    allocateId: deps.allocateId,
  });
  if (transition.outcome !== "APPLIED") {
    return executionResult({
      status: transition.outcome === "KERNEL_INVARIANT" ? "KERNEL_INVARIANT" : "NOT_APPLIED",
      currentUserId,
      event,
      transition,
      snapshot: loaded.snapshot,
      revision: loaded.revision,
      persisted: false,
      error:
        transition.outcome === "KERNEL_INVARIANT"
          ? new ApplicationError(
              "KERNEL_INVARIANT",
              transition.error?.message ?? "Product Kernel invariant failed",
              transition.error,
            )
          : null,
    });
  }
  try {
    const owned = await deps.store.commitOwnedTransition({
      currentUserId,
      expectedRevision: loaded.revision,
      result: transition,
      requireAttempt: input.authority,
      appliedRule: appliedRuleFor(event, transition),
    });
    if (owned.status !== "COMMITTED") {
      return null;
    }
    return executionResult({
      status: "APPLIED",
      currentUserId,
      event,
      transition,
      snapshot: owned.loaded.snapshot,
      revision: owned.loaded.revision,
      persisted: true,
      error: null,
    });
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "REVISION_CONFLICT") {
      return null;
    }
    if (error instanceof PersistenceError) {
      throw persistenceApplicationError(error);
    }
    throw error;
  }
}

function attemptStillCurrent(runtimeValue: unknown, authority: RuntimeAttemptAuthority): boolean {
  const parsed = parseRimProviderRuntime(runtimeValue);
  const applicable =
    parsed.status === "PRESENT"
      ? applicableRimProviderRuntime(parsed, authority.rimChatId as RimChatId)
      : null;
  const attempt = applicable?.attempt;
  if (!applicable || !attempt) {
    return false;
  }
  const intent = applicable.retryIntent;
  if (
    intent &&
    intent.attemptId === authority.attemptId &&
    intent.requestId === authority.requestId &&
    intent.rimChatId === authority.rimChatId &&
    intent.contextRequestId === authority.contextRequestId
  ) {
    return false;
  }
  return (
    applicable.selectedContactId === authority.selectedContactId &&
    applicable.contextRequestId === authority.contextRequestId &&
    applicable.continuityMode === authority.continuityMode &&
    attempt.attemptId === authority.attemptId &&
    attempt.requestId === authority.requestId
  );
}

export type ExecuteShareLinkResolvedInput = ExecuteProductEventInput &
  Readonly<{
    targetBanId: BanId;
    receiverId: UserId;
  }>;

export type ShareLinkResolvedExecution = ApplicationExecutionResult &
  Readonly<{
    bindStatus: "BOUND" | "ALREADY_BOUND" | "CONFLICT" | "MISSING" | null;
  }>;

function withHydratedBan(snapshot: ProductSnapshot, ban: Ban | null): ProductSnapshot {
  if (!ban) {
    return snapshot;
  }
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: {
        ...snapshot.extended.entities,
        bans: {
          ...snapshot.extended.entities.bans,
          [ban.id]: ban,
        },
      },
    },
  };
}

/**
 * E-45 path: hydrate target Ban into the in-memory snapshot (so unbound Template Bans
 * are visible to Kernel), then CAS-bind receiverId + persist the APPLIED transition
 * in one ProductStore transaction. No durable receiverId before successful commit.
 */
export async function executeShareLinkResolved(
  input: ExecuteShareLinkResolvedInput,
  deps: ProductExecutorDependencies,
): Promise<ShareLinkResolvedExecution> {
  const event = toCanonicalEvent(input.event);
  const currentUserId = callerUserId(input.context, input.clientClaimedUserId);
  try {
    const loaded = await deps.store.loadProductSnapshot(currentUserId);
    const ban = await deps.store.getBanById(input.targetBanId);
    const hydrated = withHydratedBan(loaded.snapshot, ban);
    const transition = reduce(hydrated, event, {
      now: asInstant(deps.clock.nowMs()),
      currentUserId,
      allocateId: deps.allocateId,
    });
    if (transition.outcome !== "APPLIED") {
      return {
        ...executionResult({
          status: transition.outcome === "KERNEL_INVARIANT" ? "KERNEL_INVARIANT" : "NOT_APPLIED",
          currentUserId,
          event,
          transition,
          snapshot: loaded.snapshot,
          revision: loaded.revision,
          persisted: false,
          error:
            transition.outcome === "KERNEL_INVARIANT"
              ? new ApplicationError(
                  "KERNEL_INVARIANT",
                  transition.error?.message ?? "Product Kernel invariant failed",
                  transition.error,
                )
              : null,
        }),
        bindStatus: null,
      };
    }
    try {
      const persisted = await deps.store.persistShareLinkResolved({
        currentUserId,
        expectedRevision: loaded.revision,
        result: transition,
        banId: input.targetBanId,
        receiverId: input.receiverId,
        appliedRule: appliedRuleFor(event, transition),
      });
      if (persisted.status === "BIND_REJECTED") {
        const durable = await deps.store.loadProductSnapshot(currentUserId);
        return {
          ...executionResult({
            status: "NOT_APPLIED",
            currentUserId,
            event,
            transition,
            snapshot: durable.snapshot,
            revision: durable.revision,
            persisted: false,
            error: null,
          }),
          bindStatus: persisted.bindStatus,
        };
      }
      return {
        ...executionResult({
          status: "APPLIED",
          currentUserId,
          event,
          transition,
          snapshot: persisted.loaded.snapshot,
          revision: persisted.loaded.revision,
          persisted: true,
          error: null,
        }),
        bindStatus: persisted.bindStatus,
      };
    } catch (error) {
      if (error instanceof PersistenceError) {
        const durable = await deps.store.loadProductSnapshot(currentUserId);
        const applicationError = persistenceApplicationError(error);
        return {
          ...executionResult({
            status: error.code === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : "PERSISTENCE_ERROR",
            currentUserId,
            event,
            transition,
            snapshot: durable.snapshot,
            revision: durable.revision,
            persisted: false,
            error: applicationError,
          }),
          bindStatus: null,
        };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }
    if (error instanceof PersistenceError) {
      throw persistenceApplicationError(error);
    }
    throw new ApplicationError(
      "INFRASTRUCTURE_FAILURE",
      error instanceof Error ? error.message : "application infrastructure failure",
      error,
    );
  }
}

function withHydratedShare(snapshot: ProductSnapshot, share: ShareOperation): ProductSnapshot {
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: {
        ...snapshot.extended.entities,
        shareOperations: {
          ...snapshot.extended.entities.shareOperations,
          [share.attemptId]: share,
        },
      },
    },
  };
}

export type ExecuteTemplateShareClaimInput = Readonly<{
  context: AuthenticatedContext;
  receiverId: UserId;
  token: string;
  shareAttemptId: ShareAttemptId;
  shareOwnerId: UserId;
  incomingBanItemId?: NotificationItemId;
  clientClaimedUserId?: string;
}>;

export type TemplateShareClaimExecution =
  | { kind: "CLAIMED"; banId: BanId; execution: ShareLinkResolvedExecution }
  | { kind: "ALREADY_BOUND"; banId: BanId }
  | { kind: "CONFLICT"; banId: BanId | null }
  | { kind: "REJECTED"; reason: "UNKNOWN_TOKEN" | "SENDER" | "CANCELLED" | "MALFORMED" }
  | { kind: "FAILED"; execution: ShareLinkResolvedExecution };

/**
 * E-45 binds the Ban already created by E-08. Runs inside
 * ProductStore.claimTemplateShare so the receiver binding, exactly one
 * Incoming item, and sender-owned ACTIVE → CONFIRMED update commit together.
 * Claim does not allocate a Ban and does not emit CREATE_BAN.CLAIM_OBSERVED.
 */
export async function executeTemplateShareClaim(
  input: ExecuteTemplateShareClaimInput,
  deps: ProductExecutorDependencies,
): Promise<TemplateShareClaimExecution> {
  const currentUserId = callerUserId(input.context, input.clientClaimedUserId);
  if (currentUserId !== input.receiverId) {
    return { kind: "REJECTED", reason: "MALFORMED" };
  }
  let claimedEvent: CanonicalEvent | null = null;
  let claimedTransition: TransitionResult | null = null;
  try {
    const claimed = await deps.store.claimTemplateShare({
      receiverId: input.receiverId,
      token: input.token,
      reduceClaim: (context) => {
        const incomingBanItemId =
          input.incomingBanItemId ?? (deps.allocateId("notification") as NotificationItemId);
        const event = toCanonicalEvent({
          name: "TELEGRAM_SHARE_LINK.RESOLVED",
          payload: {
            targetBanId: context.ban.id,
            receiverId: input.receiverId,
            incomingBanItemId,
            shareAttemptId: input.shareAttemptId,
            shareOwnerId: input.shareOwnerId,
          },
        });
        claimedEvent = event;
        const transition = reduce(
          withHydratedShare(context.receiver.snapshot, context.share),
          event,
          {
            now: asInstant(deps.clock.nowMs()),
            currentUserId,
            allocateId: deps.allocateId,
          },
        );
        claimedTransition = transition;
        return transition;
      },
    });
    if (claimed.status === "ALREADY_BOUND") {
      return { kind: "ALREADY_BOUND", banId: claimed.banId };
    }
    if (claimed.status === "CONFLICT") {
      return { kind: "CONFLICT", banId: claimed.banId };
    }
    if (claimed.status === "REJECTED") {
      return { kind: "REJECTED", reason: claimed.reason };
    }
    const event = claimedEvent;
    if (!event) {
      return { kind: "REJECTED", reason: "MALFORMED" };
    }
    if (claimed.status === "NOT_APPLIED") {
      return {
        kind: "FAILED",
        execution: {
          ...executionResult({
            status:
              claimed.transition.outcome === "KERNEL_INVARIANT"
                ? "KERNEL_INVARIANT"
                : "NOT_APPLIED",
            currentUserId,
            event,
            transition: claimed.transition,
            snapshot: claimed.transition.snapshot,
            revision: 0,
            persisted: false,
            error:
              claimed.transition.outcome === "KERNEL_INVARIANT"
                ? new ApplicationError(
                    "KERNEL_INVARIANT",
                    claimed.transition.error?.message ?? "Product Kernel invariant failed",
                    claimed.transition.error,
                  )
                : null,
          }),
          bindStatus: null,
        },
      };
    }
    return {
      kind: "CLAIMED",
      banId: claimed.banId,
      execution: {
        ...executionResult({
          status: "APPLIED",
          currentUserId,
          event,
          transition: claimed.transition,
          snapshot: claimed.loadedSnapshot,
          revision: claimed.loadedRevision,
          persisted: true,
          error: null,
        }),
        bindStatus: "BOUND",
      },
    };
  } catch (error) {
    if (error instanceof PersistenceError) {
      const durable = await deps.store.loadProductSnapshot(currentUserId);
      const event =
        claimedEvent ??
        toCanonicalEvent({
          name: "TELEGRAM_SHARE_LINK.RESOLVED",
          payload: {
            targetBanId: deps.allocateId("ban") as BanId,
            receiverId: input.receiverId,
            incomingBanItemId:
              input.incomingBanItemId ?? (deps.allocateId("notification") as NotificationItemId),
            shareAttemptId: input.shareAttemptId,
            shareOwnerId: input.shareOwnerId,
          },
        });
      return {
        kind: "FAILED",
        execution: {
          ...executionResult({
            status: error.code === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : "PERSISTENCE_ERROR",
            currentUserId,
            event,
            transition: claimedTransition,
            snapshot: durable.snapshot,
            revision: durable.revision,
            persisted: false,
            error: persistenceApplicationError(error),
          }),
          bindStatus: null,
        },
      };
    }
    if (error instanceof ApplicationError) {
      throw error;
    }
    throw new ApplicationError(
      "INFRASTRUCTURE_FAILURE",
      error instanceof Error ? error.message : "template share claim failed",
      error,
    );
  }
}
