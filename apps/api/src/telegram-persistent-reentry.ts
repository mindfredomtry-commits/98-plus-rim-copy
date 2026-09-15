/**
 * Stage 13A Telegram Persistent Re-entry Runtime integration.
 *
 * beginTelegramPersistentReentryRequest is NOT a Product Event — it allocates a
 * requestId and persists SET_TELEGRAM_PERSISTENT_REENTRY_ACTIVE_REQUEST only.
 * E-61 / E-62 remain the Product Events for grant / decline outcomes.
 *
 * Bootstrap Bot API delivery is a durable external effect:
 * - E-61 may establish persistent re-entry while bootstrap remains pending
 * - an atomic durable claim must be acquired before any send
 * - bootstrapSent becomes true only after confirmed successful send (or explicit mock)
 * - pending delivery retries without replaying E-61 Product semantics
 */

import type { AuthenticatedContext } from "@98plus/identity";
import { applyEffects, type Effect, type TransitionResult } from "@98plus/product-model";
import { loadDiagnostics, type CreateBanContactRuntime } from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";

export const TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_TEXT =
  "98+ закреплён. Новые запреты будут здесь.";

/** Default lease for in-flight bootstrap delivery ownership. */
export const TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_CLAIM_LEASE_MS = 60_000;

export type TelegramPersistentReentryBootstrapIntent = Readonly<{
  telegramUserId: string;
  text: string;
  mode: "live" | "mock";
}>;

export type BeginTelegramPersistentReentryResult = Readonly<{
  requestId: string;
  diagnostics: TestUiDiagnostics;
  eligible: boolean;
  established: boolean;
  activeRequestId: string | null;
}>;

export type TelegramPersistentReentryBootstrapDeliveryResult = Readonly<{
  status: "NOT_PENDING" | "ALREADY_SENT" | "ALREADY_CLAIMED" | "SENT" | "FAILED" | "CONFIG_MISSING";
  intent: TelegramPersistentReentryBootstrapIntent | null;
  error: Readonly<{ code: string; message: string }> | null;
  established: boolean;
  bootstrapSent: boolean;
}>;

export class TelegramPersistentReentryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TelegramPersistentReentryError";
    this.code = code;
  }
}

function stayTransition(
  snapshot: TransitionResult["snapshot"],
  effects: readonly Effect[],
): TransitionResult {
  return {
    outcome: "APPLIED",
    result: "STAY",
    controlState: snapshot.controlState,
    snapshot,
    effects,
    declaredEffects: [],
    traces: [],
    composition: "LOCAL_ONLY",
    error: null,
  };
}

export function requestWriteAccessOutcomeToEventName(
  granted: boolean,
): "TELEGRAM_PERSISTENT_REENTRY.GRANTED" | "TELEGRAM_PERSISTENT_REENTRY.DECLINED" {
  return granted ? "TELEGRAM_PERSISTENT_REENTRY.GRANTED" : "TELEGRAM_PERSISTENT_REENTRY.DECLINED";
}

export async function beginTelegramPersistentReentryRequest(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
): Promise<BeginTelegramPersistentReentryResult> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const eligible = loaded.snapshot.extended.telegramPersistentReentryEligible;
  const established = loaded.snapshot.extended.telegramPersistentReentryEstablished;
  if (!eligible || established) {
    throw new TelegramPersistentReentryError(
      "REENTRY_NOT_ELIGIBLE",
      "Telegram Persistent Re-entry begin requires eligible===true and established===false",
    );
  }
  const requestId = runtime.allocateId("telegram-persistent-reentry");
  const effects: readonly Effect[] = [
    { type: "SET_TELEGRAM_PERSISTENT_REENTRY_ACTIVE_REQUEST", requestId },
  ];
  const nextSnapshot = applyEffects(loaded.snapshot, effects);
  await runtime.productStore.persistTransition({
    currentUserId: context.currentUserId,
    expectedRevision: loaded.revision,
    result: stayTransition(nextSnapshot, effects),
  });
  const { diagnostics } = await loadDiagnostics(runtime, context);
  return {
    requestId,
    diagnostics,
    eligible: diagnostics.telegramPersistentReentryEligible,
    established: diagnostics.telegramPersistentReentryEstablished,
    activeRequestId: diagnostics.telegramPersistentReentryActiveRequestId,
  };
}

export async function sendBootstrapBotMessage(input: {
  botToken: string;
  telegramUserId: string;
  text: string;
}): Promise<void> {
  const chatId = Number(input.telegramUserId);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    throw new TelegramPersistentReentryError(
      "INVALID_TELEGRAM_USER",
      "telegramUserId must be a positive Telegram user id for sendMessage",
    );
  }
  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: input.text,
    }),
  });
  const body = (await response.json()) as { ok?: boolean; description?: string };
  if (!body.ok) {
    throw new TelegramPersistentReentryError(
      "BOOTSTRAP_SEND_FAILED",
      `sendMessage failed: ${body.description ?? response.statusText}`,
    );
  }
}

const bootstrapFailedOnce = new WeakMap<object, true>();

function shouldFailInjectedBootstrap(runtime: CreateBanContactRuntime): boolean {
  if (runtime.telegramPersistentReentryBootstrapSend === "failure") {
    return true;
  }
  if (runtime.telegramPersistentReentryBootstrapSend === "fail-once") {
    if (bootstrapFailedOnce.has(runtime)) {
      return false;
    }
    bootstrapFailedOnce.set(runtime, true);
    return true;
  }
  return false;
}

/**
 * Deliver pending bootstrap when established=true and bootstrapSent=false.
 * Acquires a durable claim BEFORE any send so concurrent callers cannot double-send.
 * Marks bootstrapSent only after confirmed success (or explicit DEV/mock success).
 * Missing live TELEGRAM_BOT_TOKEN is not success.
 */
export async function deliverPendingTelegramPersistentReentryBootstrap(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
): Promise<TelegramPersistentReentryBootstrapDeliveryResult> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const established = loaded.snapshot.extended.telegramPersistentReentryEstablished;
  const bootstrapSent = loaded.telegramPersistentReentryBootstrapSent;
  if (!established) {
    return {
      status: "NOT_PENDING",
      intent: null,
      error: null,
      established: false,
      bootstrapSent,
    };
  }
  if (bootstrapSent) {
    return {
      status: "ALREADY_SENT",
      intent: null,
      error: null,
      established: true,
      bootstrapSent: true,
    };
  }

  const telegramUserId = String(context.currentTelegramUser.telegramUserId);
  const text = TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_TEXT;
  const explicitMock = runtime.telegramPersistentReentryBootstrapMode === "mock";
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;

  // Config check before claim so a missing live token does not strand ownership.
  if (!explicitMock && !botToken) {
    return {
      status: "CONFIG_MISSING",
      intent: null,
      error: {
        code: "TELEGRAM_BOT_TOKEN_MISSING",
        message:
          "TELEGRAM_BOT_TOKEN is required for live Telegram persistent re-entry bootstrap delivery",
      },
      established: true,
      bootstrapSent: false,
    };
  }

  const nowMs = runtime.clock.nowMs();
  const claim = await runtime.productStore.claimTelegramPersistentReentryBootstrapDelivery(
    context.currentUserId,
    nowMs,
    TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_CLAIM_LEASE_MS,
  );
  if (claim.status === "ALREADY_SENT") {
    return {
      status: "ALREADY_SENT",
      intent: null,
      error: null,
      established: true,
      bootstrapSent: true,
    };
  }
  if (claim.status === "ALREADY_CLAIMED") {
    return {
      status: "ALREADY_CLAIMED",
      intent: null,
      error: null,
      established: true,
      bootstrapSent: false,
    };
  }
  if (claim.status === "NOT_REQUIRED") {
    return {
      status: "NOT_PENDING",
      intent: null,
      error: null,
      established: false,
      bootstrapSent: false,
    };
  }

  const claimToken = claim.claimToken;

  if (runtime.telegramPersistentReentryBootstrapAfterClaim) {
    await runtime.telegramPersistentReentryBootstrapAfterClaim();
  }

  if (shouldFailInjectedBootstrap(runtime)) {
    await runtime.productStore.releaseTelegramPersistentReentryBootstrapClaim(
      context.currentUserId,
      claimToken,
    );
    return {
      status: "FAILED",
      intent: null,
      error: {
        code: "BOOTSTRAP_SEND_FAILED",
        message: "Injected Telegram persistent re-entry bootstrap send failure",
      },
      established: true,
      bootstrapSent: false,
    };
  }

  if (explicitMock) {
    const intent: TelegramPersistentReentryBootstrapIntent = {
      telegramUserId,
      text,
      mode: "mock",
    };
    runtime.telegramPersistentReentryBootstrapIntents.push(intent);
    const marked = await runtime.productStore.markTelegramPersistentReentryBootstrapSent(
      context.currentUserId,
      claimToken,
    );
    if (marked.status === "ALREADY_MARKED") {
      return {
        status: "ALREADY_SENT",
        intent: null,
        error: null,
        established: true,
        bootstrapSent: true,
      };
    }
    if (marked.status === "STALE_CLAIM" || marked.status === "NOT_REQUIRED") {
      return {
        status: "FAILED",
        intent: null,
        error: {
          code: "STALE_CLAIM",
          message: "Bootstrap claim ownership was replaced before completion",
        },
        established: true,
        bootstrapSent: false,
      };
    }
    return {
      status: "SENT",
      intent,
      error: null,
      established: true,
      bootstrapSent: true,
    };
  }

  try {
    await sendBootstrapBotMessage({ botToken: botToken!, telegramUserId, text });
  } catch (error) {
    await runtime.productStore.releaseTelegramPersistentReentryBootstrapClaim(
      context.currentUserId,
      claimToken,
    );
    const code =
      error instanceof TelegramPersistentReentryError ? error.code : "BOOTSTRAP_SEND_FAILED";
    const message = error instanceof Error ? error.message : "Bootstrap send failed";
    return {
      status: "FAILED",
      intent: null,
      error: { code, message },
      established: true,
      bootstrapSent: false,
    };
  }

  const intent: TelegramPersistentReentryBootstrapIntent = {
    telegramUserId,
    text,
    mode: "live",
  };
  runtime.telegramPersistentReentryBootstrapIntents.push(intent);
  const marked = await runtime.productStore.markTelegramPersistentReentryBootstrapSent(
    context.currentUserId,
    claimToken,
  );
  if (marked.status === "ALREADY_MARKED") {
    return {
      status: "ALREADY_SENT",
      intent: null,
      error: null,
      established: true,
      bootstrapSent: true,
    };
  }
  if (marked.status === "STALE_CLAIM" || marked.status === "NOT_REQUIRED") {
    return {
      status: "FAILED",
      intent: null,
      error: {
        code: "STALE_CLAIM",
        message: "Bootstrap claim ownership was replaced before completion",
      },
      established: true,
      bootstrapSent: false,
    };
  }
  return {
    status: "SENT",
    intent,
    error: null,
    established: true,
    bootstrapSent: true,
  };
}
