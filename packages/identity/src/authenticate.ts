import { isDevelopmentAuthAllowed } from "./config.ts";
import { asTelegramUserId, verifyTelegramInitData } from "./telegram-init-data.ts";
import {
  AuthenticationError,
  type AuthenticatedContext,
  type AuthenticationAttempt,
  type IdentityClock,
  type IdentityConfig,
  type IdentityStore,
} from "./types.ts";

const systemClock: IdentityClock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

function contextFromUser(
  user: {
    userId: AuthenticatedContext["currentUserId"];
    telegramUserId: AuthenticatedContext["currentTelegramUser"]["telegramUserId"];
  },
  authenticationMethod: AuthenticatedContext["authenticationMethod"],
): AuthenticatedContext {
  return {
    currentUserId: user.userId,
    currentTelegramUser: { telegramUserId: user.telegramUserId },
    authenticationMethod,
  };
}

export async function authenticate(
  attempt: AuthenticationAttempt,
  config: IdentityConfig,
  store: IdentityStore,
  clock: IdentityClock = systemClock,
): Promise<AuthenticatedContext> {
  if (attempt.method === "development") {
    if (!isDevelopmentAuthAllowed(config) || !config.developmentAuthSecret) {
      throw new AuthenticationError(
        "DEV_AUTH_UNAVAILABLE",
        "Development authentication is not available in this configuration",
      );
    }
    if (
      attempt.secret !== config.developmentAuthSecret ||
      attempt.telegramUserId.trim().length === 0
    ) {
      throw new AuthenticationError(
        "INVALID_DEV_AUTH",
        "Development authentication credentials are invalid",
      );
    }
    const user = await store.resolveByTelegramUserId(
      asTelegramUserId(attempt.telegramUserId.trim()),
    );
    return contextFromUser(user, "development");
  }

  if (!config.telegramBotToken) {
    throw new AuthenticationError("MISSING_BOT_TOKEN", "Telegram bot token is not configured");
  }
  const verified = verifyTelegramInitData(
    attempt.initData,
    config.telegramBotToken,
    config.authFreshnessSeconds,
    clock,
  );
  const user = await store.resolveByTelegramUserId(verified.telegramUserId);
  return contextFromUser(user, "telegram");
}
