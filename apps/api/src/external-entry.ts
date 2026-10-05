import type { ApplicationExecutionResult, ProductEventInput } from "@98plus/application";
import { executeShareLinkResolved, executeTemplateShareClaim } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import {
  PENDING_EXTERNAL_ENTRY_TTL_MS,
  type BanId,
  type NotificationItemId,
  type ProductSnapshot,
  type ShareAttemptId,
  type ShareLinkFailureReason,
  type ShareLinkId,
  type UserId,
} from "@98plus/product-model";
import {
  executeAuthenticatedEvent,
  executorDeps,
  type CreateBanContactRuntime,
} from "./runtime.ts";

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

/** Safe Stage 12 live-diagnosis summary — never includes full token or secrets. */
export type StartParamIntakeProbe = Readonly<{
  receivedStartParam: boolean;
  sanitizedPrefix: "share_" | "other" | "absent";
  tokenLength: number | null;
  orchestratorInvoked: boolean;
  e44Dispatched: boolean;
  tokenLookup: "SKIPPED" | "FOUND_CONFIRMED" | "FOUND_NOT_CONFIRMED" | "MISSING" | "INVALID_PARAM";
  outcome: ExternalEntryOrchestration["outcome"] | "NOT_INVOKED";
}>;

export function buildStartParamIntakeProbe(
  startParam: string | null | undefined,
  execution: ExternalEntryExecution | null,
): StartParamIntakeProbe {
  const parsed = parseShareStartParam(startParam);
  const received = typeof startParam === "string" && startParam.trim().length > 0;
  if (!received || !execution || parsed.kind === "absent") {
    return {
      receivedStartParam: false,
      sanitizedPrefix: "absent",
      tokenLength: null,
      orchestratorInvoked: false,
      e44Dispatched: false,
      tokenLookup: "SKIPPED",
      outcome: "NOT_INVOKED",
    };
  }
  const steps = execution.orchestration.steps;
  const e44Dispatched = steps.some((step) => step.eventName === "TELEGRAM_SHARE_LINK.OPENED");
  let tokenLookup: StartParamIntakeProbe["tokenLookup"] = "INVALID_PARAM";
  if (parsed.kind === "share") {
    if (execution.orchestration.shareAttemptId) {
      tokenLookup =
        execution.orchestration.outcome === "REJECTED" && !execution.orchestration.shareTargetBanId
          ? "FOUND_NOT_CONFIRMED"
          : execution.orchestration.shareTargetBanId
            ? "FOUND_CONFIRMED"
            : "FOUND_NOT_CONFIRMED";
    } else if (execution.orchestration.outcome === "REJECTED") {
      tokenLookup = "MISSING";
    } else {
      tokenLookup = "MISSING";
    }
  }
  return {
    receivedStartParam: true,
    sanitizedPrefix: parsed.kind === "share" ? "share_" : "other",
    tokenLength: parsed.kind === "share" ? parsed.token.length : null,
    orchestratorInvoked: true,
    e44Dispatched,
    tokenLookup,
    outcome: execution.orchestration.outcome,
  };
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

async function dispatchShareResolved(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  payload: Readonly<{
    targetBanId: BanId;
    receiverId: UserId;
    incomingBanItemId: NotificationItemId;
  }>,
  clientClaimedUserId?: string,
) {
  return executeShareLinkResolved(
    {
      context,
      event: {
        name: "TELEGRAM_SHARE_LINK.RESOLVED",
        payload,
      },
      targetBanId: payload.targetBanId,
      receiverId: payload.receiverId,
      ...(clientClaimedUserId === undefined ? {} : { clientClaimedUserId }),
    },
    executorDeps(runtime),
  );
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

async function openActiveTemplateShare(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  clientClaimedUserId: string | undefined,
  attemptId: string,
  ownerId: UserId,
  token: string,
  base: Omit<ExternalEntryOrchestration, "outcome" | "steps">,
): Promise<ExternalEntryExecution> {
  const opened = await dispatch(
    runtime,
    context,
    {
      name: "TELEGRAM_SHARE_LINK.OPENED",
      payload: {
        shareLinkId: attemptId as ShareLinkId,
        shareTargetBanId: null,
        currentTelegramUserId: context.currentUserId,
      },
    },
    clientClaimedUserId,
  );
  const openedBase = {
    ...base,
    shareAttemptId: attemptId,
    shareTargetBanId: null,
    incomingBanItemId: null,
    bindStatus: null as ExternalEntryOrchestration["bindStatus"],
  };
  if (opened.status !== "APPLIED" || opened.snapshot.runtime.connection === "OFFLINE") {
    return {
      first: opened,
      last: opened,
      orchestration: { ...openedBase, outcome: "PENDING", steps: [stepOf(opened)] },
    };
  }

  const claimed = await executeTemplateShareClaim(
    {
      context,
      receiverId: context.currentUserId,
      token,
      shareAttemptId: attemptId as ShareAttemptId,
      shareOwnerId: ownerId,
      ...(clientClaimedUserId === undefined ? {} : { clientClaimedUserId }),
    },
    executorDeps(runtime),
  );

  if (claimed.kind === "CLAIMED") {
    return {
      first: opened,
      last: claimed.execution,
      orchestration: {
        ...openedBase,
        shareTargetBanId: claimed.banId,
        incomingBanItemId: linkedIncomingItemId(
          claimed.execution.snapshot,
          claimed.banId,
          context.currentUserId,
        ),
        bindStatus: "BOUND",
        outcome: "RESOLVED",
        steps: [stepOf(opened), stepOf(claimed.execution)],
      },
    };
  }

  if (claimed.kind === "ALREADY_BOUND") {
    const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    const incomingBanItemId =
      linkedIncomingItemId(loaded.snapshot, claimed.banId, context.currentUserId) ??
      (runtime.allocateId("notification") as NotificationItemId);
    const resolved = await dispatchShareResolved(
      runtime,
      context,
      {
        targetBanId: claimed.banId,
        receiverId: context.currentUserId,
        incomingBanItemId,
      },
      clientClaimedUserId,
    );
    if (resolved.bindStatus === "MISSING" || resolved.bindStatus === "CONFLICT") {
      return rejectExternalEntry(
        runtime,
        context,
        {} as ShareLinkFailureReason,
        clientClaimedUserId,
        { ...openedBase, shareTargetBanId: claimed.banId, bindStatus: resolved.bindStatus },
        [opened],
      );
    }
    return {
      first: opened,
      last: resolved,
      orchestration: {
        ...openedBase,
        shareTargetBanId: claimed.banId,
        incomingBanItemId,
        bindStatus: resolved.bindStatus,
        outcome: resolved.status === "APPLIED" ? "RESOLVED" : "PENDING",
        steps: [stepOf(opened), stepOf(resolved)],
      },
    };
  }

  if (claimed.kind === "FAILED") {
    return {
      first: opened,
      last: claimed.execution,
      orchestration: {
        ...openedBase,
        outcome: "PENDING",
        steps: [stepOf(opened), stepOf(claimed.execution)],
      },
    };
  }

  return rejectExternalEntry(
    runtime,
    context,
    {} as ShareLinkFailureReason,
    clientClaimedUserId,
    {
      ...openedBase,
      shareTargetBanId: claimed.kind === "CONFLICT" ? claimed.banId : null,
      bindStatus: claimed.kind === "CONFLICT" ? "CONFLICT" : null,
    },
    [opened],
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

  if (!lookup) {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      base,
      [],
    );
  }

  if (lookup.ownerId === context.currentUserId) {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      base,
      [],
    );
  }

  if (lookup.share.status === "CANCELLED" || lookup.share.status === "INVALIDATED") {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      base,
      [],
    );
  }

  if (lookup.share.status === "ACTIVE" && lookup.share.createdBanId === null) {
    return openActiveTemplateShare(
      runtime,
      context,
      clientClaimedUserId,
      lookup.share.attemptId,
      lookup.ownerId,
      parsed.token,
      base,
    );
  }

  if (lookup.share.status !== "CONFIRMED" || !lookup.share.createdBanId) {
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

  // Non-mutating conflict peek. Authoritative receiver binding is deferred until E-45
  // so E-44 alone cannot establish MVP8 Contact eligibility (receiverId stays null).
  if (ban.receiverId !== null && ban.receiverId !== context.currentUserId) {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      { ...base, bindStatus: "CONFLICT" },
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

  const openedBase = {
    ...base,
    shareTargetBanId: banId,
    incomingBanItemId,
    bindStatus:
      ban.receiverId === context.currentUserId
        ? ("ALREADY_BOUND" as const)
        : (null as ExternalEntryOrchestration["bindStatus"]),
  };

  if (opened.status !== "APPLIED") {
    return {
      first: opened,
      last: opened,
      orchestration: { ...openedBase, outcome: "PENDING", steps: [stepOf(opened)] },
    };
  }

  if (opened.snapshot.runtime.connection === "OFFLINE") {
    return {
      first: opened,
      last: opened,
      orchestration: { ...openedBase, outcome: "PENDING", steps: [stepOf(opened)] },
    };
  }

  const resolved = await dispatchShareResolved(
    runtime,
    context,
    {
      targetBanId: banId,
      receiverId: context.currentUserId,
      incomingBanItemId,
    },
    clientClaimedUserId,
  );

  if (resolved.bindStatus === "MISSING" || resolved.bindStatus === "CONFLICT") {
    return rejectExternalEntry(
      runtime,
      context,
      {} as ShareLinkFailureReason,
      clientClaimedUserId,
      { ...openedBase, bindStatus: resolved.bindStatus },
      [opened],
    );
  }

  const withBind = {
    ...openedBase,
    bindStatus: resolved.bindStatus,
  };

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

  let banId = entry.shareTargetBanId;
  if (banId === null) {
    const pendingShare = await runtime.productStore.getShareByAttemptId(String(entry.shareLinkId));
    if (
      !pendingShare ||
      pendingShare.ownerId === context.currentUserId ||
      pendingShare.share.status === "CANCELLED" ||
      pendingShare.share.status === "INVALIDATED"
    ) {
      return rejectExternalEntry(
        runtime,
        context,
        {} as ShareLinkFailureReason,
        clientClaimedUserId,
        {
          startParam: null,
          token: pendingShare ? String(pendingShare.share.token) : null,
          shareAttemptId: String(entry.shareLinkId),
          shareTargetBanId: null,
          incomingBanItemId: null,
          bindStatus: null,
        },
        [],
      );
    }
    if (pendingShare.share.status === "ACTIVE" && pendingShare.share.createdBanId === null) {
      const claimed = await executeTemplateShareClaim(
        {
          context,
          receiverId: context.currentUserId,
          token: String(pendingShare.share.token),
          shareAttemptId: pendingShare.share.attemptId,
          shareOwnerId: pendingShare.ownerId,
          ...(clientClaimedUserId === undefined ? {} : { clientClaimedUserId }),
        },
        executorDeps(runtime),
      );
      if (claimed.kind === "CLAIMED") {
        return {
          first: claimed.execution,
          last: claimed.execution,
          orchestration: {
            startParam: null,
            token: String(pendingShare.share.token),
            shareAttemptId: String(entry.shareLinkId),
            shareTargetBanId: claimed.banId,
            incomingBanItemId: linkedIncomingItemId(
              claimed.execution.snapshot,
              claimed.banId,
              context.currentUserId,
            ),
            bindStatus: "BOUND",
            outcome: "RESOLVED",
            steps: [stepOf(claimed.execution)],
          },
        };
      }
      if (claimed.kind === "FAILED") {
        return {
          first: claimed.execution,
          last: claimed.execution,
          orchestration: {
            startParam: null,
            token: String(pendingShare.share.token),
            shareAttemptId: String(entry.shareLinkId),
            shareTargetBanId: null,
            incomingBanItemId: null,
            bindStatus: null,
            outcome: "PENDING",
            steps: [stepOf(claimed.execution)],
          },
        };
      }
      if (claimed.kind === "ALREADY_BOUND") {
        banId = claimed.banId;
      } else {
        return rejectExternalEntry(
          runtime,
          context,
          {} as ShareLinkFailureReason,
          clientClaimedUserId,
          {
            startParam: null,
            token: String(pendingShare.share.token),
            shareAttemptId: String(entry.shareLinkId),
            shareTargetBanId: claimed.kind === "CONFLICT" ? claimed.banId : null,
            incomingBanItemId: null,
            bindStatus: claimed.kind === "CONFLICT" ? "CONFLICT" : null,
          },
          [],
        );
      }
    } else if (pendingShare.share.createdBanId) {
      banId = pendingShare.share.createdBanId;
    } else {
      return rejectExternalEntry(
        runtime,
        context,
        {} as ShareLinkFailureReason,
        clientClaimedUserId,
        {
          startParam: null,
          token: String(pendingShare.share.token),
          shareAttemptId: String(entry.shareLinkId),
          shareTargetBanId: null,
          incomingBanItemId: null,
          bindStatus: null,
        },
        [],
      );
    }
  }
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

  if (ban.receiverId !== null && ban.receiverId !== context.currentUserId) {
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
        bindStatus: "CONFLICT",
      },
      [],
    );
  }

  let incomingBanItemId = linkedIncomingItemId(loaded.snapshot, banId, context.currentUserId);
  if (!incomingBanItemId) {
    incomingBanItemId = runtime.allocateId("notification") as NotificationItemId;
  }

  const resolved = await dispatchShareResolved(
    runtime,
    context,
    {
      targetBanId: banId,
      receiverId: context.currentUserId,
      incomingBanItemId,
    },
    clientClaimedUserId,
  );

  if (resolved.bindStatus === "MISSING" || resolved.bindStatus === "CONFLICT") {
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
        incomingBanItemId,
        bindStatus: resolved.bindStatus,
      },
      [],
    );
  }

  return {
    first: resolved,
    last: resolved,
    orchestration: {
      startParam: null,
      token: null,
      shareAttemptId: String(entry.shareLinkId),
      shareTargetBanId: banId,
      incomingBanItemId,
      bindStatus: resolved.bindStatus,
      outcome: resolved.status === "APPLIED" ? "RESOLVED" : "PENDING",
      steps: [stepOf(resolved)],
    },
  };
}
