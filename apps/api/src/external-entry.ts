import type { ApplicationExecutionResult, ProductEventInput } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import {
  PENDING_EXTERNAL_ENTRY_TTL_MS,
  type BanId,
  type NotificationItemId,
  type ProductSnapshot,
  type ShareLinkFailureReason,
  type ShareLinkId,
  type UserId,
} from "@98plus/product-model";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";

export type ParsedShareStartParam =
  { kind: "share"; token: string } | { kind: "invalid"; raw: string } | { kind: "absent" };

export type ExternalEntryStep = Readonly<{
  eventName: string;
  controlState: ProductSnapshot["controlState"];
  applicationStatus: ApplicationExecutionResult["status"];
  persisted: boolean;
}>;

export type ExternalEntryOrchestration = Readonly<{
  startParam: string | null;
  token: string | null;
  shareAttemptId: string | null;
  shareTargetBanId: string | null;
  incomingBanItemId: string | null;
  bindStatus: "BOUND" | "ALREADY_BOUND" | "CONFLICT" | "MISSING" | "SKIPPED" | null;
  outcome: "RESOLVED" | "REJECTED" | "PENDING" | "EXPIRED" | "NOOP";
  steps: readonly ExternalEntryStep[];
}>;

export type ExternalEntryExecution = Readonly<{
  last: ApplicationExecutionResult | null;
  first: ApplicationExecutionResult | null;
  orchestration: ExternalEntryOrchestration;
}>;

function stepOf(execution: ApplicationExecutionResult): ExternalEntryStep {
  return {
    eventName: execution.event.name,
    controlState: execution.controlState,
    applicationStatus: execution.status,
    persisted: execution.persisted,
  };
}

export function parseShareStartParam(raw: string | null | undefined): ParsedShareStartParam {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return { kind: "absent" };
  }
  const value = raw.trim();
  if (!value.startsWith("share_") || value.length <= "share_".length) {
    return { kind: "invalid", raw: value };
  }
  return { kind: "share", token: value.slice("share_".length) };
}

function instantMs(value: unknown): number {
  return Number(value);
}

export function pendingExternalEntryExpired(snapshot: ProductSnapshot, nowMs: number): boolean {
  const entry = snapshot.extended.pendingExternalEntry;
  if (!entry) {
    return false;
  }
  return instantMs(nowMs) - instantMs(entry.entryTimestamp) >= PENDING_EXTERNAL_ENTRY_TTL_MS;
}

function linkedIncomingItemId(snapshot: ProductSnapshot, banId: BanId, ownerId: UserId) {
  const found = Object.values(snapshot.extended.entities.notificationItems).find(
    (item) => item.kind === "INCOMING_BAN" && item.banId === banId && item.ownerId === ownerId,
  );
  return found?.id ?? null;
}

async function dispatch(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  event: ProductEventInput,
  clientClaimedUserId?: string,
) {
  return executeAuthenticatedEvent(runtime, context, event, clientClaimedUserId);
}

async function rejectExternalEntry(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  failureReason: ShareLinkFailureReason,
  clientClaimedUserId: string | undefined,
  base: Omit<ExternalEntryOrchestration, "outcome" | "steps">,
  prior: ApplicationExecutionResult[],
): Promise<ExternalEntryExecution> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const ensured: ApplicationExecutionResult[] = [...prior];
  if (loaded.snapshot.controlState === null) {
    const opened = await dispatch(
      runtime,
      context,
      { name: "APP.NORMAL_OPEN", payload: { serverState: {} } },
      clientClaimedUserId,
    );
    ensured.push(opened);
  }
  const rejected = await dispatch(
    runtime,
    context,
    { name: "TELEGRAM_SHARE_LINK.REJECTED", payload: { failureReason } },
    clientClaimedUserId,
  );
  const steps = [...ensured.map(stepOf), stepOf(rejected)];
  return {
    first: ensured[0] ?? rejected,
    last: rejected,
    orchestration: { ...base, outcome: "REJECTED", steps },
  };
}

/**
 * Apply E-41 when pendingExternalEntry TTL has expired.
 * Safe to call on every session/snapshot load.
 */
export async function applyPendingExternalEntryExpiry(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  clientClaimedUserId?: string,
): Promise<ApplicationExecutionResult | null> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  if (!pendingExternalEntryExpired(loaded.snapshot, runtime.clock.nowMs())) {
    return null;
  }
  return dispatch(
    runtime,
    context,
    { name: "EXTERNAL_ENTRY.PENDING_EXPIRED", payload: {} },
    clientClaimedUserId,
  );
}

/**
 * Resolve a Telegram Share Link External Entry for the authenticated receiver.
 * Dispatches canonical E-44 then E-45 (online) or leaves pending (offline); E-46 on rejection.
 */
export async function resolveTelegramShareExternalEntry(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  startParam: string | null | undefined,
  clientClaimedUserId?: string,
): Promise<ExternalEntryExecution> {
  const parsed = parseShareStartParam(startParam);
  const emptyBase = {
    startParam: typeof startParam === "string" ? startParam : null,
    token: null as string | null,
    shareAttemptId: null as string | null,
    shareTargetBanId: null as string | null,
    incomingBanItemId: null as string | null,
    bindStatus: null as ExternalEntryOrchestration["bindStatus"],
  };

  if (parsed.kind === "absent") {
    return {
      first: null,
      last: null,
      orchestration: { ...emptyBase, outcome: "NOOP", steps: [] },
    };
  }

  if (parsed.kind === "invalid") {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      emptyBase,
      [],
    );
  }

  const lookup = await runtime.productStore.findShareByToken(parsed.token);
  const base = {
    ...emptyBase,
    token: parsed.token,
    shareAttemptId: lookup?.share.attemptId ?? null,
    shareTargetBanId: lookup?.share.createdBanId ?? null,
  };

  if (!lookup || lookup.share.status !== "CONFIRMED" || !lookup.share.createdBanId) {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      base,
      [],
    );
  }

  const banId = lookup.share.createdBanId;
  const ban = await runtime.productStore.getBanById(banId);
  if (!ban || ban.senderId === context.currentUserId) {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      base,
      [],
    );
  }

  const bind = await runtime.productStore.bindBanReceiver(banId, context.currentUserId);
  if (bind.status === "MISSING" || bind.status === "CONFLICT") {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      { ...base, bindStatus: bind.status },
      [],
    );
  }

  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  let incomingBanItemId = linkedIncomingItemId(loaded.snapshot, banId, context.currentUserId);
  if (!incomingBanItemId) {
    incomingBanItemId = runtime.allocateId("notification") as NotificationItemId;
  }

  const opened = await dispatch(
    runtime,
    context,
    {
      name: "TELEGRAM_SHARE_LINK.OPENED",
      payload: {
        shareLinkId: lookup.share.attemptId as unknown as ShareLinkId,
        shareTargetBanId: banId,
        currentTelegramUserId: context.currentUserId,
      },
    },
    clientClaimedUserId,
  );

  const withBind = {
    ...base,
    shareTargetBanId: banId,
    incomingBanItemId,
    bindStatus: bind.status,
  };

  if (opened.status !== "APPLIED") {
    return {
      first: opened,
      last: opened,
      orchestration: { ...withBind, outcome: "PENDING", steps: [stepOf(opened)] },
    };
  }

  if (opened.snapshot.runtime.connection === "OFFLINE") {
    return {
      first: opened,
      last: opened,
      orchestration: { ...withBind, outcome: "PENDING", steps: [stepOf(opened)] },
    };
  }

  const resolved = await dispatch(
    runtime,
    context,
    {
      name: "TELEGRAM_SHARE_LINK.RESOLVED",
      payload: {
        targetBanId: banId,
        receiverId: context.currentUserId,
        incomingBanItemId,
      },
    },
    clientClaimedUserId,
  );

  return {
    first: opened,
    last: resolved,
    orchestration: {
      ...withBind,
      outcome: resolved.status === "APPLIED" ? "RESOLVED" : "PENDING",
      steps: [stepOf(opened), stepOf(resolved)],
    },
  };
}

/**
 * On reconnect / session open: if a current pendingExternalEntry exists and the
 * connection is online, attempt server-side resolution without inventing a new entry.
 */
export async function resolvePendingExternalEntryIfOnline(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  clientClaimedUserId?: string,
): Promise<ExternalEntryExecution | null> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const entry = loaded.snapshot.extended.pendingExternalEntry;
  if (!entry) {
    return null;
  }
  if (pendingExternalEntryExpired(loaded.snapshot, runtime.clock.nowMs())) {
    const expired = await applyPendingExternalEntryExpiry(runtime, context, clientClaimedUserId);
    return {
      first: expired,
      last: expired,
      orchestration: {
        startParam: null,
        token: null,
        shareAttemptId: String(entry.shareLinkId),
        shareTargetBanId: entry.shareTargetBanId,
        incomingBanItemId: null,
        bindStatus: "SKIPPED",
        outcome: "EXPIRED",
        steps: expired ? [stepOf(expired)] : [],
      },
    };
  }
  if (loaded.snapshot.runtime.connection === "OFFLINE") {
    return null;
  }

  const banId = entry.shareTargetBanId;
  const ban = await runtime.productStore.getBanById(banId);
  if (!ban) {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      {
        startParam: null,
        token: null,
        shareAttemptId: String(entry.shareLinkId),
        shareTargetBanId: banId,
        incomingBanItemId: null,
        bindStatus: "MISSING",
      },
      [],
    );
  }

  const bind = await runtime.productStore.bindBanReceiver(banId, context.currentUserId);
  if (bind.status === "MISSING" || bind.status === "CONFLICT") {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      {
        startParam: null,
        token: null,
        shareAttemptId: String(entry.shareLinkId),
        shareTargetBanId: banId,
        incomingBanItemId: null,
        bindStatus: bind.status,
      },
      [],
    );
  }

  const afterBind = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  let incomingBanItemId = linkedIncomingItemId(afterBind.snapshot, banId, context.currentUserId);
  if (!incomingBanItemId) {
    incomingBanItemId = runtime.allocateId("notification") as NotificationItemId;
  }

  const resolved = await dispatch(
    runtime,
    context,
    {
      name: "TELEGRAM_SHARE_LINK.RESOLVED",
      payload: {
        targetBanId: banId,
        receiverId: context.currentUserId,
        incomingBanItemId,
      },
    },
    clientClaimedUserId,
  );

  return {
    first: resolved,
    last: resolved,
    orchestration: {
      startParam: null,
      token: null,
      shareAttemptId: String(entry.shareLinkId),
      shareTargetBanId: banId,
      incomingBanItemId,
      bindStatus: bind.status,
      outcome: resolved.status === "APPLIED" ? "RESOLVED" : "PENDING",
      steps: [stepOf(resolved)],
    },
  };
}
