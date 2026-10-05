import type { ApplicationExecutionResult, ProductEventInput } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type { BanId, OperationId, ProductSnapshot } from "@98plus/product-model";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";
import { CreateBanContactTransportError } from "./transport-error.ts";

const SERVER_RESULT_EVENTS = new Set([
  "CREATE_BAN.SEND_CONFIRMED",
  "CREATE_BAN.SEND_FAILED",
  "NOTIFICATIONS.OVERBOARD_CONFIRMED",
  "NOTIFICATIONS.ACTION_FAILED",
  "NOTIFICATIONS.SELECT_NEXT",
  "REPLY_BAN.SEND_CONFIRMED",
  "REPLY_BAN.SEND_FAILED",
  "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
  "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
  "BAN.DURATION_EXPIRED",
  "RIM.CONTEXT_READY",
  "RIM.CONTEXT_FAILED",
  "RIM.AI_RESULT_RECEIVED",
  "RIM.AI_REQUEST_FAILED",
  "TELEGRAM_SHARE_LINK.OPENED",
  "TELEGRAM_SHARE_LINK.RESOLVED",
  "TELEGRAM_SHARE_LINK.REJECTED",
  "EXTERNAL_ENTRY.PENDING_EXPIRED",
  "CREATE_BAN.CLAIM_OBSERVED",
]);

export type ContactSendStep = Readonly<{
  eventName: string;
  controlState: ProductSnapshot["controlState"];
  applicationStatus: ApplicationExecutionResult["status"];
  persisted: boolean;
  banCount: number;
  pendingOperationId: string | null;
  correlatedOperationId: string | null;
}>;

export type ContactSendOrchestration = Readonly<{
  userEvent: ContactSendStep;
  serverEvent: ContactSendStep;
}>;

export type CreateBanContactExecution = Readonly<{
  last: ApplicationExecutionResult;
  first: ApplicationExecutionResult;
  orchestration: ContactSendOrchestration | null;
}>;

export function assertUiTransportEvent(eventName: string): void {
  if (SERVER_RESULT_EVENTS.has(eventName)) {
    throw new CreateBanContactTransportError(
      "SERVER_RESULT_NOT_ACCEPTED",
      eventName,
      `${eventName} is a SERVER result and is not accepted from the TEST UI transport`,
    );
  }
}

export function pendingCreateBanSend(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "CREATE_BAN_SEND",
    ) ?? null
  );
}

function correlatedOperationIdOf(execution: ApplicationExecutionResult): string | null {
  const payload = execution.event.payload as { operationId?: unknown };
  if (typeof payload.operationId === "string" && payload.operationId.length > 0) {
    return payload.operationId;
  }
  return pendingCreateBanSend(execution.snapshot)?.operationId ?? null;
}

function stepOf(execution: ApplicationExecutionResult): ContactSendStep {
  const pending = pendingCreateBanSend(execution.snapshot);
  return {
    eventName: execution.event.name,
    controlState: execution.controlState,
    applicationStatus: execution.status,
    persisted: execution.persisted,
    banCount: Object.keys(execution.snapshot.extended.entities.bans).length,
    pendingOperationId: pending?.operationId ?? null,
    correlatedOperationId: correlatedOperationIdOf(execution),
  };
}

export function shouldCompleteContactSend(execution: ApplicationExecutionResult): boolean {
  return (
    execution.event.name === "CREATE_BAN.PRESS_FORBID" &&
    execution.status === "APPLIED" &&
    ((execution.snapshot.controlState === "CREATE_BAN.CONFIRM.CONTACT" &&
      execution.snapshot.extended.createBanDraft?.origin === "CONTACT") ||
      (execution.snapshot.controlState === "CREATE_BAN.CONFIRM.RIM" &&
        execution.snapshot.extended.createBanDraft?.origin === "RIM")) &&
    pendingCreateBanSend(execution.snapshot) !== null
  );
}

export async function completeContactSend(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  forbid: ApplicationExecutionResult,
  clientClaimedUserId?: string,
): Promise<ApplicationExecutionResult> {
  const pending = pendingCreateBanSend(forbid.snapshot);
  if (!pending) {
    return forbid;
  }
  const operationId = pending.operationId as OperationId;
  const event: ProductEventInput =
    runtime.contactSendCompletion === "failure"
      ? {
          name: "CREATE_BAN.SEND_FAILED",
          payload: { operationId, failure: { code: "CONTACT_SEND_FAILED" } },
        }
      : {
          name: "CREATE_BAN.SEND_CONFIRMED",
          payload: {
            operationId,
            createdBanId: runtime.allocateId("ban") as BanId,
          },
        };
  return executeAuthenticatedEvent(runtime, context, event, clientClaimedUserId);
}

export async function executeCreateBanContactVertical(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  event: ProductEventInput,
  clientClaimedUserId?: string,
): Promise<CreateBanContactExecution> {
  const first = await executeAuthenticatedEvent(runtime, context, event, clientClaimedUserId);
  if (!shouldCompleteContactSend(first)) {
    return { first, last: first, orchestration: null };
  }
  const server = await completeContactSend(runtime, context, first, clientClaimedUserId);
  return {
    first,
    last: server,
    orchestration: {
      userEvent: stepOf(first),
      serverEvent: stepOf(server),
    },
  };
}
