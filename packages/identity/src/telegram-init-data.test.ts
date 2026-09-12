import { describe, expect, it } from "vitest";
import { createTelegramInitData } from "./create-init-data.ts";
import { TELEGRAM_INIT_DATA_MAX_AGE_SECONDS } from "./freshness.ts";
import { asTelegramUserId, verifyTelegramInitData } from "./telegram-init-data.ts";
import { AuthenticationError } from "./types.ts";

const BOT_TOKEN = "test-bot-token";
const NOW = 1_700_000_000;

function clock(nowSeconds = NOW) {
  return { nowSeconds: () => nowSeconds };
}

describe("Telegram initData verification", () => {
  it("accepts valid signed initData", () => {
    const initData = createTelegramInitData({ id: 4242, first_name: "Ada" });
    const verified = verifyTelegramInitData(
      initData,
      BOT_TOKEN,
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      clock(),
    );
    expect(verified.telegramUserId).toBe(asTelegramUserId("4242"));
  });

  it("rejects an invalid signature/hash", () => {
    const initData = createTelegramInitData({ id: 4242 });
    const tampered = initData.replace(/hash=[0-9a-f]+/i, "hash=deadbeef");
    expect(() =>
      verifyTelegramInitData(tampered, BOT_TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, clock()),
    ).toThrow(AuthenticationError);
    try {
      verifyTelegramInitData(tampered, BOT_TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, clock());
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as AuthenticationError).code).toBe("INVALID_SIGNATURE");
    }
  });

  it("rejects a tampered Telegram user payload", () => {
    const initData = createTelegramInitData({ id: 4242 });
    const params = new URLSearchParams(initData);
    params.set("user", JSON.stringify({ id: 9999, first_name: "Eve" }));
    expect(() =>
      verifyTelegramInitData(
        params.toString(),
        BOT_TOKEN,
        TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
        clock(),
      ),
    ).toThrowError(/signature|hash/i);
  });

  it("rejects missing required authentication data", () => {
    expect(() =>
      verifyTelegramInitData("", BOT_TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, clock()),
    ).toThrow(AuthenticationError);
    const unsigned = new URLSearchParams({
      auth_date: String(NOW - 10),
      user: JSON.stringify({ id: 1 }),
    }).toString();
    expect(() =>
      verifyTelegramInitData(unsigned, BOT_TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, clock()),
    ).toThrowError(/hash/);
  });

  it("rejects stale auth_date outside the authentication freshness window", () => {
    const initData = createTelegramInitData(
      { id: 4242 },
      { authDate: NOW - TELEGRAM_INIT_DATA_MAX_AGE_SECONDS - 1 },
    );
    expect(() =>
      verifyTelegramInitData(initData, BOT_TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, clock()),
    ).toThrow(AuthenticationError);
    try {
      verifyTelegramInitData(initData, BOT_TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, clock());
    } catch (error) {
      expect((error as AuthenticationError).code).toBe("STALE_AUTH_DATE");
    }
  });
});
