import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import { InMemoryIdentityStore, PostgresIdentityStore } from "@98plus/identity";
import { InMemoryProductStore, MemorySqlClient, PostgresProductStore } from "@98plus/persistence";
import {
  API_IDENTITY_STAGE,
  API_KERNEL_STAGE,
  API_PERSISTENCE_STAGE,
  API_STAGE,
  API_STAGE_3_EXCLUDES,
  API_STAGE_5_EXCLUDES,
  CREATE_BAN_CONTACT_STAGE,
  STAGE_6_EXCLUDES,
  authenticateRequest,
  executeAuthenticatedProductEvent,
  handleAuthenticatedProductRequest,
  productCallerUserId,
} from "./index.ts";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("api Stage 5 application execution", () => {
  it("exposes Stage 5 without changing frozen kernel, identity, or persistence stages", () => {
    expect(API_STAGE).toBe(5);
    expect(API_KERNEL_STAGE).toBe(2);
    expect(API_IDENTITY_STAGE).toBe(3);
    expect(API_PERSISTENCE_STAGE).toBe(4);
    expect(API_STAGE_3_EXCLUDES).toContain("external-entry");
    expect(API_STAGE_5_EXCLUDES).toContain("openai");
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(STAGE_6_EXCLUDES).toContain("full-notifications-ui");
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(358);
  });

  it("does not accept development authentication when production env is loaded", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      IDENTITY_ALLOW_DEV_AUTH: process.env.IDENTITY_ALLOW_DEV_AUTH,
      IDENTITY_DEV_AUTH_SECRET: process.env.IDENTITY_DEV_AUTH_SECRET,
    };
    process.env.NODE_ENV = "production";
    process.env.IDENTITY_ALLOW_DEV_AUTH = "true";
    process.env.IDENTITY_DEV_AUTH_SECRET = "secret";
    try {
      await expect(
        authenticateRequest(
          { method: "development", secret: "secret", telegramUserId: "1" },
          new InMemoryIdentityStore(),
        ),
      ).rejects.toMatchObject({ code: "DEV_AUTH_UNAVAILABLE" });
    } finally {
      restoreEnv("NODE_ENV", previous.NODE_ENV);
      restoreEnv("IDENTITY_ALLOW_DEV_AUTH", previous.IDENTITY_ALLOW_DEV_AUTH);
      restoreEnv("IDENTITY_DEV_AUTH_SECRET", previous.IDENTITY_DEV_AUTH_SECRET);
    }
  });

  it("binds product caller identity from authenticated context only", () => {
    const context = {
      currentUserId: "user-from-auth" as never,
      currentTelegramUser: { telegramUserId: "42" as never },
      authenticationMethod: "telegram" as const,
    };
    expect(productCallerUserId(context, "spoofed")).toBe("user-from-auth");
  });

  it("runs the authenticated product execution cycle through the API boundary", async () => {
    const store = new InMemoryProductStore();
    store.inspect().registerIdentityUser("user-from-auth" as never, "42");
    const context = {
      currentUserId: "user-from-auth" as never,
      currentTelegramUser: { telegramUserId: "42" as never },
      authenticationMethod: "telegram" as const,
    };
    const result = await executeAuthenticatedProductEvent(
      context,
      { name: "APP.NORMAL_OPEN", payload: { serverState: {} } },
      store,
      { clock: { nowMs: () => 1_000_000 } },
    );
    expect(result.status).toBe("APPLIED");
    expect(result.snapshot.controlState).toBe("RIM.LOBBY");
    expect(result.currentUserId).toBe("user-from-auth");
    const loaded = await store.loadProductSnapshot(context.currentUserId);
    expect(loaded.snapshot.controlState).toBe("RIM.LOBBY");
  });

  it("authenticates through Stage 3 then executes through Stage 5", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      IDENTITY_ALLOW_DEV_AUTH: process.env.IDENTITY_ALLOW_DEV_AUTH,
      IDENTITY_DEV_AUTH_SECRET: process.env.IDENTITY_DEV_AUTH_SECRET,
    };
    process.env.NODE_ENV = "development";
    process.env.IDENTITY_ALLOW_DEV_AUTH = "true";
    process.env.IDENTITY_DEV_AUTH_SECRET = "secret";
    try {
      const sql = new MemorySqlClient();
      const productStore = new PostgresProductStore(sql);
      const result = await handleAuthenticatedProductRequest({
        attempt: { method: "development", secret: "secret", telegramUserId: "42" },
        event: { name: "APP.NORMAL_OPEN", payload: { serverState: {} } },
        identityStore: new PostgresIdentityStore(sql),
        productStore,
        clientClaimedUserId: "spoofed-user",
        clock: { nowMs: () => 1_000_000 },
      });
      expect(result.status).toBe("APPLIED");
      expect(result.snapshot.controlState).toBe("RIM.LOBBY");
      expect(result.currentUserId).not.toBe("spoofed-user");
      expect(result.currentUserId).not.toBe("42");
      const loaded = await productStore.loadProductSnapshot(result.currentUserId);
      expect(loaded.snapshot.controlState).toBe("RIM.LOBBY");
    } finally {
      restoreEnv("NODE_ENV", previous.NODE_ENV);
      restoreEnv("IDENTITY_ALLOW_DEV_AUTH", previous.IDENTITY_ALLOW_DEV_AUTH);
      restoreEnv("IDENTITY_DEV_AUTH_SECRET", previous.IDENTITY_DEV_AUTH_SECRET);
    }
  });
});
