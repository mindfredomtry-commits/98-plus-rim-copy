import type { UserId } from "@98plus/product-model";
import type { AuthenticatedContext } from "./types.ts";

/**
 * The caller identity is always the authenticated server context.
 * Client-supplied userId / currentUserId / senderId values are ignored.
 */
export function callerUserId(context: AuthenticatedContext, _clientClaimedUserId?: string): UserId {
  return context.currentUserId;
}

export function currentTelegramUser(context: AuthenticatedContext) {
  return context.currentTelegramUser;
}
