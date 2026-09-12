import { callerUserId, type AuthenticatedContext } from "@98plus/identity";
import { PersistenceError, type ProductStore } from "@98plus/persistence";
import {
  asInstant,
  reduce,
  type AppliedRuleTrace,
  type CanonicalEvent,
  type CompositionOrder,
  type Effect,
  type KernelError,
  type MatrixResult,
  type ProductControlState,
  type ProductSnapshot,
  type TransitionOutcome,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import type { ApplicationClock, IdAllocator } from "./clock.ts";
import { pendingExternalEffects, type PendingExternalEffect } from "./effects.ts";
import { ApplicationError } from "./errors.ts";
import { toCanonicalEvent, type ProductEventInput } from "./event.ts";

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
      const saved = await deps.store.persistTransition({
        currentUserId,
        expectedRevision: loaded.revision,
        result: transition,
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
