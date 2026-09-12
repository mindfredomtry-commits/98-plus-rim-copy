import type { UserId } from "@98plus/product-model";

declare const telegramBrand: unique symbol;

export type TelegramUserId = string & { readonly [telegramBrand]: "TelegramUserId" };

export type VerifiedTelegramIdentity = Readonly<{
  telegramUserId: TelegramUserId;
}>;

export type IdentityUser = Readonly<{
  userId: UserId;
  telegramUserId: TelegramUserId;
}>;

export type AuthenticatedContext = Readonly<{
  currentUserId: UserId;
  currentTelegramUser: VerifiedTelegramIdentity;
  authenticationMethod: "telegram" | "development";
}>;

export type AuthenticationAttempt =
  | { method: "telegram"; initData: string }
  | { method: "development"; secret: string; telegramUserId: string };

export type AuthErrorCode =
  | "INVALID_INIT_DATA"
  | "INVALID_SIGNATURE"
  | "TAMPERED_USER"
  | "MISSING_REQUIRED_DATA"
  | "STALE_AUTH_DATE"
  | "DEV_AUTH_UNAVAILABLE"
  | "INVALID_DEV_AUTH"
  | "MISSING_BOT_TOKEN";

export class AuthenticationError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export type IdentityEnvironment = "development" | "production";

export type IdentityConfig = Readonly<{
  environment: IdentityEnvironment;
  telegramBotToken: string | null;
  authFreshnessSeconds: number;
  allowDevelopmentAuth: boolean;
  developmentAuthSecret: string | null;
}>;

export type IdentityClock = Readonly<{
  nowSeconds: () => number;
}>;

export type IdentityStore = {
  resolveByTelegramUserId(telegramUserId: TelegramUserId): Promise<IdentityUser>;
};

export type SqlQueryResult<T> = Readonly<{
  rows: readonly T[];
}>;

export type SqlClient = {
  query<T>(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<T>>;
};
