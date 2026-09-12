import {
  pendingExternalEffects,
  toCanonicalEvent,
  type ApplicationExecutionResult,
  type ProductEventInput,
} from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import {
  asInstant,
  reduce,
  type CheckAnswer,
  type CheckDerivedStatus,
  type CheckPair,
  type CheckPairId,
  type NotificationItemId,
  type OperationId,
  type ProductSnapshot,
} from "@98plus/product-model";
import type { ContactSendOrchestration } from "./contact-send.ts";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";

export function pendingCheckAnswer(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "CHECK_ANSWER",
    ) ?? null
  );
}

export function pendingUnappliedCheckAnswer(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "CHECK_ANSWER" && !operation.resultApplied,
    ) ?? null
  );
}

export function shouldCompleteCheckAnswer(execution: ApplicationExecutionResult): boolean {
  return (
    (execution.event.name === "NOTIFICATIONS.CHECK_ANSWER.FULFILLED" ||
      execution.event.name === "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED") &&
    execution.status === "APPLIED" &&
    (execution.snapshot.controlState === "NOTIFICATIONS.CHECK.RECEIVER" ||
      execution.snapshot.controlState === "NOTIFICATIONS.CHECK.SENDER") &&
    pendingUnappliedCheckAnswer(execution.snapshot) !== null &&
    execution.snapshot.extended.activeNotificationItemId !== null
  );
}

const checkAnswerFailedOnce = new WeakMap<object, true>();

function shouldFailCheckAnswer(runtime: CreateBanContactRuntime): boolean {
  if (runtime.checkAnswerCompletion === "failure") {
    return true;
  }
  if (runtime.checkAnswerCompletion === "fail-once") {
    if (checkAnswerFailedOnce.has(runtime)) {
      return false;
    }
    checkAnswerFailedOnce.set(runtime, true);
    return true;
  }
  return false;
}

export function resultingStatusOf(first: CheckAnswer, second: CheckAnswer): CheckDerivedStatus {
  if (first === "FULFILLED" && second === "FULFILLED") {
    return "BANTASTIC";
  }
  if (first === "NOT_FULFILLED" && second === "NOT_FULFILLED") {
    return "FAIR_ENOUGH";
  }
  return "BANFLICT";
}

function answerOfPress(eventName: string): CheckAnswer {
  return eventName === "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED" ? "NOT_FULFILLED" : "FULFILLED";
}

function confirmationEvent(
  pair: CheckPair,
  role: "RECEIVER" | "SENDER",
  itemId: NotificationItemId,
  answer: CheckAnswer,
): ProductEventInput | null {
  const mine = role === "RECEIVER" ? pair.receiverAnswer : pair.senderAnswer;
  const other = role === "RECEIVER" ? pair.senderAnswer : pair.receiverAnswer;
  if (mine !== null) {
    return null;
  }
  return other === null
    ? {
        name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
        payload: {
          checkItemId: itemId,
          answer,
          checkPairId: pair.id as CheckPairId,
        },
      }
    : {
        name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
        payload: {
          checkItemId: itemId,
          answer,
          checkPairId: pair.id as CheckPairId,
          resultingStatus: resultingStatusOf(other, answer),
        },
      };
}

export async function completeCheckAnswer(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  press: ApplicationExecutionResult,
  clientClaimedUserId?: string,
): Promise<ApplicationExecutionResult> {
  const pending = pendingUnappliedCheckAnswer(press.snapshot);
  const itemId = press.snapshot.extended.activeNotificationItemId;
  if (!pending || !itemId) {
    return press;
  }
  const item = press.snapshot.extended.entities.notificationItems[itemId];
  if (!item || item.kind !== "CHECK") {
    return press;
  }
  if (shouldFailCheckAnswer(runtime)) {
    return executeAuthenticatedEvent(
      runtime,
      context,
      {
        name: "NOTIFICATIONS.ACTION_FAILED",
        payload: {
          operationId: pending.operationId as OperationId,
          sourceItemId: itemId as NotificationItemId,
          failure: { code: "CHECK_ANSWER_FAILED" },
        },
      },
      clientClaimedUserId,
    );
  }
  const answer = answerOfPress(press.event.name);
  return runtime.productStore.withCheckPairLock(item.checkPairId, async (locked) => {
    const loaded = await locked.loadProductSnapshot(context.currentUserId);
    const pair = locked.pair ?? loaded.snapshot.extended.entities.checkPairs[item.checkPairId];
    const currentItem = loaded.snapshot.extended.entities.notificationItems[itemId];
    const currentPending = pendingUnappliedCheckAnswer(loaded.snapshot);
    if (!pair || !currentItem || currentItem.kind !== "CHECK" || !currentPending) {
      return press;
    }
    if (
      pair.id !== currentItem.checkPairId ||
      currentPending.originatingItemId !== itemId ||
      currentPending.resultApplied
    ) {
      return press;
    }
    const event = confirmationEvent(pair, currentItem.role, itemId as NotificationItemId, answer);
    if (!event) {
      return press;
    }
    const canonical = toCanonicalEvent(event);
    const transition = reduce(loaded.snapshot, canonical, {
      now: asInstant(runtime.clock.nowMs()),
      currentUserId: context.currentUserId,
      allocateId: runtime.allocateId,
    });
    if (transition.outcome !== "APPLIED") {
      return {
        status: transition.outcome === "KERNEL_INVARIANT" ? "KERNEL_INVARIANT" : "NOT_APPLIED",
        currentUserId: context.currentUserId,
        event: canonical,
        outcome: transition.outcome,
        result: transition.result,
        controlState: loaded.snapshot.controlState,
        snapshot: loaded.snapshot,
        revision: loaded.revision,
        persisted: false,
        effects: transition.effects,
        pendingExternalEffects: pendingExternalEffects(transition.effects),
        traces: transition.traces,
        composition: transition.composition,
        kernelError: transition.error,
        error: null,
      };
    }
    const saved = await locked.persistTransition({
      currentUserId: context.currentUserId,
      expectedRevision: loaded.revision,
      result: transition,
    });
    return {
      status: "APPLIED",
      currentUserId: context.currentUserId,
      event: canonical,
      outcome: transition.outcome,
      result: transition.result,
      controlState: saved.snapshot.controlState,
      snapshot: saved.snapshot,
      revision: saved.revision,
      persisted: true,
      effects: transition.effects,
      pendingExternalEffects: pendingExternalEffects(transition.effects),
      traces: transition.traces,
      composition: transition.composition,
      kernelError: null,
      error: null,
    };
  });
}

export function checkAnswerOrchestration(
  press: ApplicationExecutionResult,
  server: ApplicationExecutionResult,
): ContactSendOrchestration {
  const pending = pendingCheckAnswer(press.snapshot);
  const serverPayload = server.event.payload as { operationId?: string };
  return {
    userEvent: {
      eventName: press.event.name,
      controlState: press.controlState,
      applicationStatus: press.status,
      persisted: press.persisted,
      banCount: Object.keys(press.snapshot.extended.entities.bans).length,
      pendingOperationId: pending?.operationId ?? null,
      correlatedOperationId: pending?.operationId ?? null,
    },
    serverEvent: {
      eventName: server.event.name,
      controlState: server.controlState,
      applicationStatus: server.status,
      persisted: server.persisted,
      banCount: Object.keys(server.snapshot.extended.entities.bans).length,
      pendingOperationId: pendingCheckAnswer(server.snapshot)?.operationId ?? null,
      correlatedOperationId:
        typeof serverPayload.operationId === "string" ? serverPayload.operationId : null,
    },
  };
}
