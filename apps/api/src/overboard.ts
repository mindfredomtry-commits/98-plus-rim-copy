import type { ApplicationExecutionResult, ProductEventInput } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type {
  BanId,
  NotificationItemId,
  OperationId,
  ProductSnapshot,
} from "@98plus/product-model";
import {
  executeCreateBanContactVertical,
  type ContactSendOrchestration,
  type CreateBanContactExecution,
} from "./contact-send.ts";
import {
  completeReplyBanSend,
  replyBanOrchestration,
  shouldCompleteReplyBanSend,
} from "./reply-ban.ts";
import {
  checkAnswerOrchestration,
  completeCheckAnswer,
  shouldCompleteCheckAnswer,
} from "./check-answer.ts";
import { applyElapsedDomainTimers } from "./duration-expired.ts";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";

export function pendingOverboard(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "OVERBOARD",
    ) ?? null
  );
}

export function pendingUnappliedOverboard(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "OVERBOARD" && !operation.resultApplied,
    ) ?? null
  );
}

export function shouldCompleteOverboard(execution: ApplicationExecutionResult): boolean {
  return (
    execution.event.name === "NOTIFICATIONS.PRESS_OVERBOARD" &&
    execution.status === "APPLIED" &&
    execution.snapshot.controlState === "NOTIFICATIONS.INCOMING_BAN" &&
    pendingUnappliedOverboard(execution.snapshot) !== null &&
    execution.snapshot.extended.activeNotificationItemId !== null
  );
}

const overboardFailedOnce = new WeakMap<object, true>();

function shouldFailOverboard(runtime: CreateBanContactRuntime): boolean {
  if (runtime.overboardCompletion === "failure") {
    return true;
  }
  if (runtime.overboardCompletion === "fail-once") {
    if (overboardFailedOnce.has(runtime)) {
      return false;
    }
    overboardFailedOnce.set(runtime, true);
    return true;
  }
  return false;
}

export async function completeOverboard(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  press: ApplicationExecutionResult,
  clientClaimedUserId?: string,
): Promise<ApplicationExecutionResult> {
  const pending = pendingUnappliedOverboard(press.snapshot);
  const sourceItemId = press.snapshot.extended.activeNotificationItemId;
  if (!pending || !sourceItemId) {
    return press;
  }
  const sourceItem = press.snapshot.extended.entities.notificationItems[sourceItemId];
  const operationId = pending.operationId as OperationId;
  const event: ProductEventInput = shouldFailOverboard(runtime)
    ? {
        name: "NOTIFICATIONS.ACTION_FAILED",
        payload: {
          operationId,
          sourceItemId,
          failure: { code: "OVERBOARD_FAILED" },
        },
      }
    : {
        name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
        payload: {
          operationId,
          sourceItemId: sourceItemId as NotificationItemId,
          banId: (sourceItem?.banId ?? "") as BanId,
        },
      };
  return executeAuthenticatedEvent(runtime, context, event, clientClaimedUserId);
}

export async function executeIncomingOverboardVertical(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  event: ProductEventInput,
  clientClaimedUserId?: string,
): Promise<CreateBanContactExecution> {
  const contact = await executeCreateBanContactVertical(
    runtime,
    context,
    event,
    clientClaimedUserId,
  );
  if (contact.orchestration !== null) {
    return finishWithElapsedTimers(runtime, context, contact);
  }
  if (shouldCompleteOverboard(contact.last)) {
    const server = await completeOverboard(runtime, context, contact.last, clientClaimedUserId);
    const afterExpiry = await finishWithElapsedTimers(runtime, context, {
      first: contact.last,
      last: server,
      orchestration: overboardOrchestration(contact.last, server),
    });
    return afterExpiry;
  }
  if (shouldCompleteReplyBanSend(contact.last)) {
    const server = await completeReplyBanSend(runtime, context, contact.last, clientClaimedUserId);
    return finishWithElapsedTimers(runtime, context, {
      first: contact.last,
      last: server,
      orchestration: replyBanOrchestration(contact.last, server),
    });
  }
  if (shouldCompleteCheckAnswer(contact.last)) {
    const server = await completeCheckAnswer(runtime, context, contact.last, clientClaimedUserId);
    return finishWithElapsedTimers(runtime, context, {
      first: contact.last,
      last: server,
      orchestration: checkAnswerOrchestration(contact.last, server),
    });
  }
  return finishWithElapsedTimers(runtime, context, contact);
}

async function finishWithElapsedTimers(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  execution: CreateBanContactExecution,
): Promise<CreateBanContactExecution> {
  await applyElapsedDomainTimers(runtime, context);
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  return {
    ...execution,
    last: {
      ...execution.last,
      snapshot: loaded.snapshot,
      controlState: loaded.snapshot.controlState,
    },
  };
}

function overboardOrchestration(
  press: ApplicationExecutionResult,
  server: ApplicationExecutionResult,
): ContactSendOrchestration {
  const pending = pendingOverboard(press.snapshot);
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
      pendingOperationId: pendingOverboard(server.snapshot)?.operationId ?? null,
      correlatedOperationId:
        typeof serverPayload.operationId === "string" ? serverPayload.operationId : null,
    },
  };
}
