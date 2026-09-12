import type { ApplicationExecutionResult, ProductEventInput } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type { BanId, OperationId, ProductSnapshot } from "@98plus/product-model";
import type { ContactSendOrchestration } from "./contact-send.ts";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";

export function pendingReplyBanSend(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    ) ?? null
  );
}

export function pendingUnappliedReplyBanSend(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND" && !operation.resultApplied,
    ) ?? null
  );
}

function isReplyBanConfirmState(controlState: string | null | undefined): boolean {
  return (
    controlState === "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN" ||
    controlState === "REPLY_BAN.CONFIRM.FROM_STATUS"
  );
}

function replySourceMatchesConfirm(
  controlState: string | null | undefined,
  kind: string | undefined,
): boolean {
  if (controlState === "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN") {
    return kind === "INCOMING_BAN";
  }
  if (controlState === "REPLY_BAN.CONFIRM.FROM_STATUS") {
    return kind === "STATUS";
  }
  return false;
}

export function shouldCompleteReplyBanSend(execution: ApplicationExecutionResult): boolean {
  return (
    execution.event.name === "REPLY_BAN.PRESS_FORBID" &&
    execution.status === "APPLIED" &&
    isReplyBanConfirmState(execution.snapshot.controlState) &&
    replySourceMatchesConfirm(
      execution.snapshot.controlState,
      execution.snapshot.extended.replySource?.kind,
    ) &&
    pendingUnappliedReplyBanSend(execution.snapshot) !== null
  );
}

const replyBanFailedOnce = new WeakMap<object, true>();

function shouldFailReplyBanSend(runtime: CreateBanContactRuntime): boolean {
  if (runtime.replyBanCompletion === "failure") {
    return true;
  }
  if (runtime.replyBanCompletion === "fail-once") {
    if (replyBanFailedOnce.has(runtime)) {
      return false;
    }
    replyBanFailedOnce.set(runtime, true);
    return true;
  }
  return false;
}

export async function completeReplyBanSend(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  forbid: ApplicationExecutionResult,
  clientClaimedUserId?: string,
): Promise<ApplicationExecutionResult> {
  const pending = pendingUnappliedReplyBanSend(forbid.snapshot);
  const source = forbid.snapshot.extended.replySource;
  if (
    !pending ||
    !source ||
    !replySourceMatchesConfirm(forbid.snapshot.controlState, source.kind)
  ) {
    return forbid;
  }
  const operationId = pending.operationId as OperationId;
  const event: ProductEventInput = shouldFailReplyBanSend(runtime)
    ? {
        name: "REPLY_BAN.SEND_FAILED",
        payload: {
          operationId,
          failure: { code: "REPLY_BAN_SEND_FAILED" },
        },
      }
    : {
        name: "REPLY_BAN.SEND_CONFIRMED",
        payload: {
          operationId,
          replyBanId: runtime.allocateId("ban") as BanId,
          source,
        },
      };
  return executeAuthenticatedEvent(runtime, context, event, clientClaimedUserId);
}

export function replyBanOrchestration(
  press: ApplicationExecutionResult,
  server: ApplicationExecutionResult,
): ContactSendOrchestration {
  const pending = pendingReplyBanSend(press.snapshot);
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
      pendingOperationId: pendingReplyBanSend(server.snapshot)?.operationId ?? null,
      correlatedOperationId:
        typeof serverPayload.operationId === "string" ? serverPayload.operationId : null,
    },
  };
}
