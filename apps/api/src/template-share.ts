import type { ApplicationExecutionResult, ProductEventInput } from "@98plus/application";
import type { AuthenticatedContext } from "@98plus/identity";
import type { ProductSnapshot, ShareAttemptId } from "@98plus/product-model";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";
import {
  buildTemplateShareDeepLink,
  normalizeTelegramBotUsername,
  prepareTelegramShareMessage,
  type TelegramSharePrepareResult,
} from "./telegram-share.ts";

function telegramBotUsernameFromEnv(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME;
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  return normalizeTelegramBotUsername(raw);
}

export function activeTemplateShareOperation(snapshot: ProductSnapshot) {
  return (
    Object.values(snapshot.extended.entities.shareOperations).find(
      (operation) => operation.status === "ACTIVE",
    ) ?? null
  );
}

export function shouldOpenTelegramShare(execution: ApplicationExecutionResult): boolean {
  return (
    execution.event.name === "CREATE_BAN.PRESS_FORBID" &&
    execution.status === "APPLIED" &&
    execution.snapshot.controlState === "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING" &&
    execution.snapshot.extended.createBanDraft?.origin === "TEMPLATE" &&
    activeTemplateShareOperation(execution.snapshot) !== null &&
    execution.pendingExternalEffects.some((item) => item.effect.type === "OPEN_TELEGRAM_SHARE")
  );
}

export async function buildTelegramShareInvocation(
  runtime: CreateBanContactRuntime,
  snapshot: ProductSnapshot,
  telegramUserId: string,
): Promise<TelegramSharePrepareResult | null> {
  const share = activeTemplateShareOperation(snapshot);
  if (!share) {
    return null;
  }
  const duration = share.draft.durationMinutes;
  if (duration === null) {
    return null;
  }
  // Mock/tests may omit env; live Telegram prepare requires TELEGRAM_BOT_USERNAME.
  const botUsername =
    telegramBotUsernameFromEnv() ?? (runtime.telegramSharePrepare === "mock" ? "98plus_bot" : null);
  const shareUrl = botUsername
    ? buildTemplateShareDeepLink({ botUsername, token: String(share.token) })
    : "";
  const base = {
    attemptId: String(share.attemptId),
    token: String(share.token),
    shareUrl,
    api: "shareMessage" as const,
  };
  if (runtime.telegramSharePrepare === "mock") {
    return {
      ...base,
      preparedMessageId: `mock-prepared-${share.attemptId}`,
    };
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  if (!botToken || !botUsername) {
    return {
      ...base,
      preparedMessageId: "",
    };
  }
  try {
    return await prepareTelegramShareMessage({
      attemptId: String(share.attemptId),
      token: String(share.token),
      banText: share.draft.banText,
      durationMinutes: duration,
      telegramUserId,
      botToken,
      botUsername,
    });
  } catch {
    // Product transition already applied. A failed prepare must not mint a Ban.
    return {
      ...base,
      preparedMessageId: "",
    };
  }
}

export async function completeTelegramShare(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  input: Readonly<{
    shareAttemptId: string;
    outcome: "CONFIRMED" | "CANCELLED";
  }>,
  clientClaimedUserId?: string,
): Promise<ApplicationExecutionResult | null> {
  if (input.outcome !== "CANCELLED") {
    return null;
  }
  const event: ProductEventInput = {
    name: "CREATE_BAN.SHARE_CANCELLED",
    payload: { shareAttemptId: input.shareAttemptId as ShareAttemptId },
  };
  return executeAuthenticatedEvent(runtime, context, event, clientClaimedUserId);
}
