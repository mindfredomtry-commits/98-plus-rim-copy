export { authenticate } from "./authenticate.ts";
export { loadIdentityConfig, isDevelopmentAuthAllowed } from "./config.ts";
export { callerUserId, currentTelegramUser } from "./context.ts";
export { AUTH_DATE_FUTURE_SKEW_SECONDS, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS } from "./freshness.ts";
export { InMemoryIdentityStore } from "./in-memory-store.ts";
export { PostgresIdentityStore, UPSERT_IDENTITY_USER_SQL } from "./postgres-store.ts";
export { IDENTITY_STAGE, STAGE_3_EXCLUDES } from "./stage.ts";
export { asTelegramUserId, verifyTelegramInitData } from "./telegram-init-data.ts";
export { AuthenticationError } from "./types.ts";
export type {
  AuthenticatedContext,
  AuthenticationAttempt,
  AuthErrorCode,
  IdentityClock,
  IdentityConfig,
  IdentityEnvironment,
  IdentityStore,
  IdentityUser,
  SqlClient,
  SqlQueryResult,
  TelegramUserId,
  VerifiedTelegramIdentity,
} from "./types.ts";
