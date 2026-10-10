import type { ApplicationExecutionResult } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type { ProductSnapshot } from "@98plus/product-model";
import { parseShareStartParam, type ExternalEntryExecution } from "./external-entry.ts";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";
import { isPc02ProbeStartParam } from "./telegram-pc02-probe.ts";

const STATUS_RECEIVER_REPLY_STATES = new Set<ProductSnapshot["controlState"]>([
  "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER",
  "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER",
  "NOTIFICATIONS.STATUS.BANFLICT.RECEIVER",
  "NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER",
]);

const REPLY_BAN_TERMINAL_OR_IN_PROGRESS = new Set<ProductSnapshot["controlState"]>([
  "REPLY_BAN.WHAT.FROM_INCOMING_BAN",
  "REPLY_BAN.WHAT.FROM_STATUS",
  "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
  "REPLY_BAN.CONFIRM.FROM_STATUS",
  "REPLY_BAN.SUCCESS.FROM_INCOMING_BAN",
  "REPLY_BAN.SUCCESS.FROM_STATUS",
]);

export function isTelegramShareReplyEntryEligible(snapshot: ProductSnapshot): boolean {
  const controlState = snapshot.controlState;
  if (controlState === null || REPLY_BAN_TERMINAL_OR_IN_PROGRESS.has(controlState)) {
    return false;
  }
  const itemId = snapshot.extended.activeNotificationItemId;
  if (!itemId) {
    return false;
  }
  const item = snapshot.extended.entities.notificationItems[itemId];
  if (!item || item.lifecycle.status !== "UNPROCESSED" || item.lifecycle.display !== "ACTIVE") {
    return false;
  }
  if (controlState === "NOTIFICATIONS.INCOMING_BAN") {
    return item.kind === "INCOMING_BAN";
  }
  if (STATUS_RECEIVER_REPLY_STATES.has(controlState)) {
    return item.kind === "STATUS" && item.role === "RECEIVER";
  }
  return false;
}

export type TelegramShareReplyEntryOutcome =
  | Readonly<{ kind: "skipped"; reason: string }>
  | Readonly<{ kind: "applied"; execution: ApplicationExecutionResult }>;

export async function orchestrateTelegramShareReplyEntry(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  externalEntry: ExternalEntryExecution,
  startParam: string | null,
  clientClaimedUserId?: string,
): Promise<TelegramShareReplyEntryOutcome> {
  if (isPc02ProbeStartParam(startParam)) {
    return { kind: "skipped", reason: "pc02_probe" };
  }
  if (parseShareStartParam(startParam).kind !== "share") {
    return { kind: "skipped", reason: "not_share_start_param" };
  }
  if (externalEntry.orchestration.outcome !== "RESOLVED") {
    return { kind: "skipped", reason: "external_entry_not_resolved" };
  }
  const baseSnapshot =
    externalEntry.last?.snapshot ??
    (await runtime.productStore.loadProductSnapshot(context.currentUserId)).snapshot;
  if (!isTelegramShareReplyEntryEligible(baseSnapshot)) {
    return { kind: "skipped", reason: "not_reply_eligible" };
  }
  const execution = await executeAuthenticatedEvent(
    runtime,
    context,
    { name: "NOTIFICATIONS.PRESS_REPLY_BAN", payload: {} },
    clientClaimedUserId,
  );
  if (
    execution.status === "APPLIED" &&
    (execution.controlState === "REPLY_BAN.WHAT.FROM_INCOMING_BAN" ||
      execution.controlState === "REPLY_BAN.WHAT.FROM_STATUS")
  ) {
    return { kind: "applied", execution };
  }
  return { kind: "skipped", reason: "press_reply_ban_not_applied" };
}

export function mergeTelegramShareReplyEntry(
  externalEntry: ExternalEntryExecution,
  reply: TelegramShareReplyEntryOutcome,
): ExternalEntryExecution {
  if (reply.kind !== "applied") {
    return externalEntry;
  }
  const step = {
    eventName: reply.execution.event.name,
    controlState: reply.execution.controlState,
    applicationStatus: reply.execution.status,
    persisted: reply.execution.persisted,
  };
  return {
    ...externalEntry,
    first: externalEntry.first ?? reply.execution,
    last: reply.execution,
    orchestration: {
      ...externalEntry.orchestration,
      steps: [...externalEntry.orchestration.steps, step],
    },
  };
}
