import { TELEGRAM_INIT_DATA_MAX_AGE_SECONDS } from "./freshness.ts";
import type { IdentityConfig, IdentityEnvironment } from "./types.ts";

function environmentOf(env: NodeJS.ProcessEnv): IdentityEnvironment {
  if (env.NODE_ENV === "production" || env.APP_ENV === "production") {
    return "production";
  }
  return "development";
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const environment = environmentOf(env);
  const developmentAuthSecret = env.IDENTITY_DEV_AUTH_SECRET?.trim() || null;
  const allowDevelopmentAuth =
    environment !== "production" &&
    env.IDENTITY_ALLOW_DEV_AUTH === "true" &&
    developmentAuthSecret !== null;
  return {
    environment,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    authFreshnessSeconds: TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    allowDevelopmentAuth,
    developmentAuthSecret: allowDevelopmentAuth ? developmentAuthSecret : null,
  };
}

export function isDevelopmentAuthAllowed(config: IdentityConfig): boolean {
  return (
    config.environment !== "production" &&
    config.allowDevelopmentAuth &&
    config.developmentAuthSecret !== null
  );
}
