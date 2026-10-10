import type { ApplicationExecutionResult } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type { ProductSnapshot } from "@98plus/product-model";
import {
  parseShareStartParam,
  type ExternalEntryExecution,
  type ExternalEntryOrchestration,
} from "./external-entry.ts";
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

/** In-progress Reply Ban screens that Matrix E-45 Guard A would abort back to N-01. */
const REPLY_BAN_IN_PROGRESS = new Set<ProductSnapshot["controlState"]>([
  "REPLY_BAN.WHAT.FROM_INCOMING_BAN",
  "REPLY_BAN.WHAT.FROM_STATUS",
  "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
  "REPLY_BAN.CONFIRM.FROM_STATUS",
]);

/**
 * When the Mini App re-opens the same share_<token> while already mid Reply Ban for
 * that Ban, skip E-44/E-45. Re-resolving would hit Matrix Guard A (source Incoming
 * still unprocessed), abort Reply → INCOMING, then auto E-14 would re-enter WHAT —
 * duplicate Product Events and draft reset. Different Ban shares still resolve normally.
 */
export async function shortCircuitShareReentryWhileInReplyBan(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  startParam: string | null,
): Promise<ExternalEntryExecution | null> {
  if (isPc02ProbeStartParam(startParam)) {
    return null;
  }
  const parsed = parseShareStartParam(startParam);
  if (parsed.kind !== "share") {
    return null;
  }
  const lookup = await runtime.productStore.findShareByToken(parsed.token);
  const banId = lookup?.share.createdBanId ?? null;
  if (!lookup || banId === null) {
    return null;
  }
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const controlState = loaded.snapshot.controlState;
  if (!REPLY_BAN_IN_PROGRESS.has(controlState)) {
    return null;
  }
  const sourceBanId = loaded.snapshot.extended.replySource?.banId ?? null;
  if (sourceBanId === null || sourceBanId !== banId) {
    return null;
  }
  const orchestration: ExternalEntryOrchestration = {
    startParam,
    token: parsed.token,
    shareAttemptId: lookup.share.attemptId,
    shareTargetBanId: banId,
    incomingBanItemId: null,
    bindStatus: "ALREADY_BOUND",
    outcome: "NOOP",
    steps: [],
  };
  return { first: null, last: null, orchestration };
}

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
