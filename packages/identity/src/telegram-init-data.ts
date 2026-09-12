import { createHmac, timingSafeEqual } from "node:crypto";
import { AUTH_DATE_FUTURE_SKEW_SECONDS } from "./freshness.ts";
import { AuthenticationError, type IdentityClock, type TelegramUserId } from "./types.ts";
import type { VerifiedTelegramIdentity } from "./types.ts";

export function asTelegramUserId(value: string): TelegramUserId {
  return value as TelegramUserId;
}

function hexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) {
    return false;
  }
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function computedHash(botToken: string, checkString: string): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secret).update(checkString).digest("hex");
}

function parseUser(raw: string): { id: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthenticationError("TAMPERED_USER", "Telegram user payload is not parseable JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthenticationError("TAMPERED_USER", "Telegram user payload is not an object");
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new AuthenticationError("MISSING_REQUIRED_DATA", "Telegram user identity id is required");
  }
  return { id };
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  freshnessSeconds: number,
  clock: IdentityClock,
): VerifiedTelegramIdentity {
  if (typeof initData !== "string" || initData.trim().length === 0) {
    throw new AuthenticationError("MISSING_REQUIRED_DATA", "Telegram initData is required");
  }
  if (typeof botToken !== "string" || botToken.trim().length === 0) {
    throw new AuthenticationError("MISSING_BOT_TOKEN", "Telegram bot token is not configured");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");
  if (!hash || !authDateRaw || !userRaw) {
    throw new AuthenticationError(
      "MISSING_REQUIRED_DATA",
      "Telegram initData must include hash, auth_date, and user",
    );
  }

  const expected = computedHash(botToken, dataCheckString(params));
  if (!hexEqual(expected, hash)) {
    throw new AuthenticationError(
      "INVALID_SIGNATURE",
      "Telegram initData signature/hash is invalid",
    );
  }

  const authDate = Number(authDateRaw);
  if (!Number.isInteger(authDate) || authDate <= 0) {
    throw new AuthenticationError(
      "INVALID_INIT_DATA",
      "Telegram auth_date is not a unix timestamp",
    );
  }
  const now = clock.nowSeconds();
  if (authDate > now + AUTH_DATE_FUTURE_SKEW_SECONDS) {
    throw new AuthenticationError(
      "STALE_AUTH_DATE",
      "Telegram auth_date is unreasonably in the future",
    );
  }
  if (now - authDate > freshnessSeconds) {
    throw new AuthenticationError(
      "STALE_AUTH_DATE",
      "Telegram initData auth_date is outside the authentication freshness window",
    );
  }

  const user = parseUser(userRaw);
  return { telegramUserId: asTelegramUserId(String(user.id)) };
}
