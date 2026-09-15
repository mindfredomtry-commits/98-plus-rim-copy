import type { ProductControlState } from "./states.ts";
import type { ProductSnapshot } from "./extended-state.ts";

/** MVP10 whitelist — CTA may display only on these Product Control States. */
export const TELEGRAM_PERSISTENT_REENTRY_CTA_STATES = [
  "RIM.LOBBY",
  "CREATE_BAN.SUCCESS",
  "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER",
  "REPLY_BAN.SUCCESS.FROM_INCOMING_BAN",
] as const satisfies readonly ProductControlState[];

export type TelegramPersistentReentryCtaState =
  (typeof TELEGRAM_PERSISTENT_REENTRY_CTA_STATES)[number];

export function isTelegramPersistentReentryCtaSurface(
  state: ProductControlState | null | undefined,
): state is TelegramPersistentReentryCtaState {
  return (
    state !== null &&
    state !== undefined &&
    (TELEGRAM_PERSISTENT_REENTRY_CTA_STATES as readonly string[]).includes(state)
  );
}

/**
 * MVP10 CTA visibility:
 * eligible && !established && whitelisted surface && current surface opportunity not consumed.
 */
export function shouldShowTelegramPersistentReentryCta(snapshot: ProductSnapshot): boolean {
  const { extended, controlState } = snapshot;
  if (!extended.telegramPersistentReentryEligible) {
    return false;
  }
  if (extended.telegramPersistentReentryEstablished) {
    return false;
  }
  if (!isTelegramPersistentReentryCtaSurface(controlState)) {
    return false;
  }
  const consumed = extended.telegramPersistentReentryCtaConsumedSurfaceGeneration;
  if (consumed !== null && consumed === extended.telegramPersistentReentryCtaSurfaceGeneration) {
    return false;
  }
  return true;
}
