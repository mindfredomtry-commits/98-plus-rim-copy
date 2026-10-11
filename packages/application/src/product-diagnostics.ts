import {
  bindDiagnosticContext,
  classifyApplicationStatus,
  classifyPersistenceError,
  createActionId,
  emitDiagnostic,
} from "@98plus/diagnostics";
import type { CanonicalEvent, ProductControlState, TransitionResult } from "@98plus/product-model";

function pcs(value: ProductControlState | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function beginProductActionDiagnostics(input: {
  event: CanonicalEvent;
  eventId: string | undefined;
  actorId: string;
}): string {
  const actionId = createActionId();
  bindDiagnosticContext({
    source: "product",
    actionId,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    actorId: input.actorId,
  });
  return actionId;
}

export function emitProductReceived(input: {
  actionId: string;
  eventId: string | undefined;
  eventName: string;
  actorId: string;
  pcsBefore: ProductControlState | null;
  sessionRevisionBefore: number;
}): void {
  emitDiagnostic({
    eventName: "product.event.received",
    source: "product",
    meta: {
      actionId: input.actionId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      eventName: input.eventName,
      actorId: input.actorId,
      pcsBefore: pcs(input.pcsBefore),
      sessionRevisionBefore: input.sessionRevisionBefore,
    },
  });
}

export function emitProductNotApplied(input: {
  actionId: string;
  eventId: string | undefined;
  eventName: string;
  actorId: string;
  pcsBefore: ProductControlState | null;
  pcsAfter: ProductControlState | null;
  status: "NOT_APPLIED" | "KERNEL_INVARIANT";
  kernelOutcome: string;
  sessionRevisionBefore: number;
  errorMessage: string | undefined;
}): void {
  emitDiagnostic({
    eventName: input.status === "KERNEL_INVARIANT" ? "product.event.failed" : "product.event.rejected",
    source: "product",
    meta: {
      actionId: input.actionId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      eventName: input.eventName,
      actorId: input.actorId,
      pcsBefore: pcs(input.pcsBefore),
      pcsAfter: pcs(input.pcsAfter),
      kernelOutcome: input.kernelOutcome,
      ...(input.status === "NOT_APPLIED" ? { guardResult: "REJECTED" } : {}),
      classification: classifyApplicationStatus(input.status),
      sessionRevisionBefore: input.sessionRevisionBefore,
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage.slice(0, 128) }),
    },
  });
}

export function emitProductApplied(input: {
  actionId: string;
  eventId: string;
  eventName: string;
  actorId: string;
  pcsBefore: ProductControlState | null;
  transition: TransitionResult;
  matrixBranch: string;
  effectTypes: readonly string[];
  sessionRevisionBefore: number;
  sessionRevisionAfter: number;
}): void {
  emitDiagnostic({
    eventName: "product.event.applied",
    source: "product",
    meta: {
      actionId: input.actionId,
      eventId: input.eventId,
      eventName: input.eventName,
      actorId: input.actorId,
      pcsBefore: pcs(input.pcsBefore),
      pcsAfter: pcs(input.transition.controlState),
      matrixRuleId: input.eventId,
      matrixBranch: input.matrixBranch,
      kernelOutcome: input.transition.outcome,
      effectTypes: [...input.effectTypes],
      effectCount: input.effectTypes.length,
      sessionRevisionBefore: input.sessionRevisionBefore,
      sessionRevisionAfter: input.sessionRevisionAfter,
      persistenceOutcome: "COMMITTED",
      classification: "OK",
    },
  });
}

export function emitProductStale(input: {
  actionId: string;
  eventId: string;
  eventName: string;
  actorId: string;
  pcsBefore: ProductControlState | null;
  sessionRevisionBefore: number;
}): void {
  emitDiagnostic({
    eventName: "product.event.rejected",
    source: "product",
    meta: {
      actionId: input.actionId,
      eventId: input.eventId,
      eventName: input.eventName,
      actorId: input.actorId,
      pcsBefore: pcs(input.pcsBefore),
      classification: "STALE_AI_RESULT",
      sessionRevisionBefore: input.sessionRevisionBefore,
    },
  });
}

export function emitProductPersistFailed(input: {
  actionId: string;
  eventId: string;
  eventName: string;
  actorId: string;
  pcsBefore: ProductControlState | null;
  transition: TransitionResult;
  effectTypes: readonly string[];
  sessionRevisionBefore: number;
  sessionRevisionAfter: number;
  persistenceCode: string;
  persistenceMessage: string;
}): void {
  emitDiagnostic({
    eventName: "product.event.failed",
    source: "product",
    meta: {
      actionId: input.actionId,
      eventId: input.eventId,
      eventName: input.eventName,
      actorId: input.actorId,
      pcsBefore: pcs(input.pcsBefore),
      pcsAfter: pcs(input.transition.controlState),
      matrixRuleId: input.eventId,
      kernelOutcome: input.transition.outcome,
      effectTypes: [...input.effectTypes],
      effectCount: input.effectTypes.length,
      sessionRevisionBefore: input.sessionRevisionBefore,
      sessionRevisionAfter: input.sessionRevisionAfter,
      classification: classifyPersistenceError(input.persistenceCode, input.persistenceMessage),
      errorCode: input.persistenceCode,
      errorMessage: input.persistenceMessage.slice(0, 128),
      persistenceOutcome: "ROLLED_BACK",
    },
  });
}

export function emitProductInfrastructureFailed(input: {
  actionId: string;
  eventId: string | undefined;
  eventName: string;
  actorId: string;
  message: string;
}): void {
  emitDiagnostic({
    eventName: "product.event.failed",
    source: "product",
    meta: {
      actionId: input.actionId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      eventName: input.eventName,
      actorId: input.actorId,
      classification: "INFRASTRUCTURE_FAILURE",
      errorMessage: input.message.slice(0, 128),
    },
  });
}
