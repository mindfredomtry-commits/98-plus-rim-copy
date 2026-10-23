import type { ApplicationExecutionResult } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type {
  Ban,
  ProductSnapshot,
  ShareAttemptId,
  ShareOperation,
  UserId,
} from "@98plus/product-model";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";

const SHARE_PENDING = "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING";
const SUCCESS = "CREATE_BAN.SUCCESS";

export type SharePendingReentryCode =
  | "SUCCESSFUL_BAN_ID_MISSING"
  | "BAN_MISSING"
  | "SHARE_MISSING"
  | "BAN_SENDER_MISMATCH"
  | "SHARE_BAN_MISMATCH"
  | "AMBIGUOUS_SHARE"
  | "E66_REJECTED"
  | "REVISION_CONFLICT"
  | "PERSISTENCE_ERROR";

export type SharePendingReentryLink =
  | { ok: true; shareAttemptId: ShareAttemptId }
  | {
      ok: false;
      code:
        | "NOT_PENDING"
        | Exclude<
            SharePendingReentryCode,
            "E66_REJECTED" | "REVISION_CONFLICT" | "PERSISTENCE_ERROR"
          >;
    };

export type SharePendingReentryResult =
  | { status: "NOT_PENDING" }
  | { status: "RECOVERED"; execution: ApplicationExecutionResult }
  | { status: "NOT_RECOVERABLE"; code: SharePendingReentryCode; message: string }
  | { status: "NOT_PERSISTED"; code: "REVISION_CONFLICT" | "PERSISTENCE_ERROR"; message: string };

const MESSAGES: Record<SharePendingReentryCode, string> = {
  SUCCESSFUL_BAN_ID_MISSING:
    "Share pending recovery skipped because the pending Ban id was not recorded.",
  BAN_MISSING: "Share pending recovery skipped because the persisted Ban is missing.",
  SHARE_MISSING: "Share pending recovery skipped because the persisted share operation is missing.",
  BAN_SENDER_MISMATCH:
    "Share pending recovery skipped because the Ban does not belong to the authenticated sender.",
  SHARE_BAN_MISMATCH:
    "Share pending recovery skipped because the share operation does not reference the pending Ban.",
  AMBIGUOUS_SHARE:
    "Share pending recovery skipped because more than one share operation matches the pending Ban.",
  E66_REJECTED: "Share pending recovery did not apply.",
  REVISION_CONFLICT: "Share pending recovery did not persist. The next session load can retry.",
  PERSISTENCE_ERROR: "Share pending recovery did not persist. The next session load can retry.",
};

function blocked(code: SharePendingReentryCode): SharePendingReentryResult {
  if (code === "REVISION_CONFLICT" || code === "PERSISTENCE_ERROR") {
    return { status: "NOT_PERSISTED", code, message: MESSAGES[code] };
  }
  return { status: "NOT_RECOVERABLE", code, message: MESSAGES[code] };
}

function eligibleShare(share: ShareOperation, ban: Ban, currentUserId: UserId): boolean {
  return (
    (share.status === "ACTIVE" || share.status === "CONFIRMED") &&
    share.createdBanId === ban.id &&
    ban.senderId === currentUserId
  );
}

/**
 * SHARE_PENDING recovery uses only the Ban E-08 recorded as successfulBanId.
 * A share is eligible when it is ACTIVE or CONFIRMED and its createdBanId is
 * that exact Ban. Sender ownership of any other Ban is not an association.
 */
export function resolveSharePendingReentry(
  snapshot: ProductSnapshot,
  currentUserId: UserId,
): SharePendingReentryLink {
  if (snapshot.controlState !== SHARE_PENDING) {
    return { ok: false, code: "NOT_PENDING" };
  }
  const successfulBanId = snapshot.extended.successfulBanId;
  if (!successfulBanId) {
    return { ok: false, code: "SUCCESSFUL_BAN_ID_MISSING" };
  }
  const ban = snapshot.extended.entities.bans[successfulBanId];
  if (!ban) {
    return { ok: false, code: "BAN_MISSING" };
  }
  if (ban.senderId !== currentUserId) {
    return { ok: false, code: "BAN_SENDER_MISMATCH" };
  }
  const matched = Object.values(snapshot.extended.entities.shareOperations).filter((share) =>
    eligibleShare(share, ban, currentUserId),
  );
  if (matched.length === 1) {
    return { ok: true, shareAttemptId: matched[0]!.attemptId };
  }
  if (matched.length > 1) {
    return { ok: false, code: "AMBIGUOUS_SHARE" };
  }
  const pointsElsewhere = Object.values(snapshot.extended.entities.shareOperations).some(
    (share) => share.createdBanId !== null && share.createdBanId !== successfulBanId,
  );
  return { ok: false, code: pointsElsewhere ? "SHARE_BAN_MISMATCH" : "SHARE_MISSING" };
}

async function dispatchReturn(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  shareAttemptId: ShareAttemptId,
): Promise<ApplicationExecutionResult> {
  return executeAuthenticatedEvent(runtime, context, {
    name: "CREATE_BAN.SHARE_RETURNED",
    payload: { shareAttemptId },
  });
}

function persistedSuccess(execution: ApplicationExecutionResult): boolean {
  return (
    execution.status === "APPLIED" && execution.persisted && execution.controlState === SUCCESS
  );
}

/**
 * Session re-entry for a persisted SHARE_PENDING sender.
 * Dispatches E-66 only when the Ban and its share operation agree.
 * Does not call Telegram and does not allocate a Ban or a share.
 */
export async function recoverSharePendingOnReentry(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
): Promise<SharePendingReentryResult> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  if (loaded.snapshot.controlState !== SHARE_PENDING) {
    return { status: "NOT_PENDING" };
  }
  const target = resolveSharePendingReentry(loaded.snapshot, context.currentUserId);
  if (!target.ok) {
    if (target.code === "NOT_PENDING") {
      return { status: "NOT_PENDING" };
    }
    return blocked(target.code);
  }
  const execution = await dispatchReturn(runtime, context, target.shareAttemptId);
  if (persistedSuccess(execution)) {
    return { status: "RECOVERED", execution };
  }
  if (execution.status === "REVISION_CONFLICT" || execution.status === "PERSISTENCE_ERROR") {
    const durable = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    if (durable.snapshot.controlState === SUCCESS) {
      return { status: "NOT_PENDING" };
    }
    if (execution.status === "REVISION_CONFLICT") {
      const retryTarget = resolveSharePendingReentry(durable.snapshot, context.currentUserId);
      if (retryTarget.ok) {
        const retry = await dispatchReturn(runtime, context, retryTarget.shareAttemptId);
        if (persistedSuccess(retry)) {
          return { status: "RECOVERED", execution: retry };
        }
        const afterRetry = await runtime.productStore.loadProductSnapshot(context.currentUserId);
        if (afterRetry.snapshot.controlState === SUCCESS) {
          return { status: "NOT_PENDING" };
        }
      } else if (durable.snapshot.controlState !== SHARE_PENDING) {
        return { status: "NOT_PENDING" };
      }
    }
    return blocked(
      execution.status === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : "PERSISTENCE_ERROR",
    );
  }
  const durable = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  if (durable.snapshot.controlState === SUCCESS) {
    return { status: "NOT_PENDING" };
  }
  return blocked("E66_REJECTED");
}
