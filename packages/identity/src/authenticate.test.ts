import { describe, expect, it } from "vitest";
import { authenticate } from "./authenticate.ts";
import { loadIdentityConfig } from "./config.ts";
import { callerUserId } from "./context.ts";
import { TELEGRAM_INIT_DATA_MAX_AGE_SECONDS } from "./freshness.ts";
import { InMemoryIdentityStore } from "./in-memory-store.ts";
import { createTelegramInitData } from "./create-init-data.ts";
import { AuthenticationError, type IdentityConfig } from "./types.ts";

const BOT_TOKEN = "test-bot-token";
const NOW = 1_700_000_000;

function telegramConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    environment: "development",
    telegramBotToken: BOT_TOKEN,
    authFreshnessSeconds: TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    allowDevelopmentAuth: false,
    developmentAuthSecret: null,
    ...overrides,
  };
}

function clock() {
  return { nowSeconds: () => NOW };
}

describe("authenticate", () => {
  it("succeeds for valid Telegram initData and does not dispatch a Product Event", async () => {
    const store = new InMemoryIdentityStore();
    const result = await authenticate(
      { method: "telegram", initData: createTelegramInitData({ id: 77 }) },
      telegramConfig(),
      store,
      clock(),
    );
    expect(result.currentUserId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.currentTelegramUser.telegramUserId).toBe("77");
    expect(result.authenticationMethod).toBe("telegram");
    expect(result).not.toHaveProperty("event");
    expect(result).not.toHaveProperty("eventId");
    expect(result).not.toHaveProperty("controlState");
  });

  it("resolves the same internal UserId for repeated authentications of the same Telegram identity", async () => {
    const store = new InMemoryIdentityStore();
    const attempt = {
      method: "telegram" as const,
      initData: createTelegramInitData({ id: 88 }),
    };
    const first = await authenticate(attempt, telegramConfig(), store, clock());
    const second = await authenticate(attempt, telegramConfig(), store, clock());
    expect(second.currentUserId).toBe(first.currentUserId);
    expect(store.snapshot()).toHaveLength(1);
  });

  it("ignores a client-claimed userId when reading the caller identity", async () => {
    const store = new InMemoryIdentityStore();
    const context = await authenticate(
      { method: "telegram", initData: createTelegramInitData({ id: 91 }) },
      telegramConfig(),
      store,
      clock(),
    );
    expect(callerUserId(context, "attacker-user")).toBe(context.currentUserId);
    expect(callerUserId(context, context.currentTelegramUser.telegramUserId)).toBe(
      context.currentUserId,
    );
  });

  it("allows development authentication only under explicit development configuration", async () => {
    const store = new InMemoryIdentityStore();
    const config = loadIdentityConfig({
      NODE_ENV: "development",
      IDENTITY_ALLOW_DEV_AUTH: "true",
      IDENTITY_DEV_AUTH_SECRET: "dev-secret",
    });
    const result = await authenticate(
      { method: "development", secret: "dev-secret", telegramUserId: "10001" },
      config,
      store,
      clock(),
    );
    expect(result.authenticationMethod).toBe("development");
    expect(result.currentTelegramUser.telegramUserId).toBe("10001");
    expect(result.currentUserId).toBeTruthy();
  });

  it("rejects development authentication under production configuration", async () => {
    const store = new InMemoryIdentityStore();
    const config = loadIdentityConfig({
      NODE_ENV: "production",
      IDENTITY_ALLOW_DEV_AUTH: "true",
      IDENTITY_DEV_AUTH_SECRET: "dev-secret",
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    });
    expect(config.allowDevelopmentAuth).toBe(false);
    await expect(
      authenticate(
        { method: "development", secret: "dev-secret", telegramUserId: "10001" },
        config,
        store,
        clock(),
      ),
    ).rejects.toMatchObject({
      code: "DEV_AUTH_UNAVAILABLE",
    } satisfies Partial<AuthenticationError>);
  });

  it("does not treat client-supplied Telegram user fields as Telegram authentication", async () => {
    const store = new InMemoryIdentityStore();
    await expect(
      authenticate(
        { method: "telegram", initData: "user=%7B%22id%22%3A1%7D" },
        telegramConfig(),
        store,
        clock(),
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
