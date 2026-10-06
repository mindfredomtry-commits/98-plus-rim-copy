import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  CANONICAL_EVENT_DEFINITIONS,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  PRODUCT_CONTROL_STATE_DEFINITIONS,
  PENDING_EXTERNAL_ENTRY_TTL_MS,
} from "@98plus/product-model";
import { TELEGRAM_INIT_DATA_MAX_AGE_SECONDS } from "./freshness.ts";
import { IDENTITY_STAGE, STAGE_3_EXCLUDES } from "./stage.ts";

describe("Stage 3 identity boundary", () => {
  it("does not change canonical Product Control State or Event counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(PRODUCT_CONTROL_STATE_DEFINITIONS).toHaveLength(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(CANONICAL_EVENT_DEFINITIONS).toHaveLength(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(358);
  });

  it("does not add authentication Product States or Events", () => {
    expect(
      PRODUCT_CONTROL_STATE_DEFINITIONS.some((definition) => definition.state.startsWith("AUTH.")),
    ).toBe(false);
    expect(
      CANONICAL_EVENT_DEFINITIONS.some((definition) => definition.name.startsWith("AUTH.")),
    ).toBe(false);
  });

  it("leaves the Product Kernel at Stage 2 and keeps auth freshness independent of External Entry TTL", () => {
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(STAGE_3_EXCLUDES).toContain("external-entry");
    expect(STAGE_3_EXCLUDES).toContain("e-41-pending-expired");
    expect(STAGE_3_EXCLUDES).toContain("e-44-share-link-opened");
    expect(TELEGRAM_INIT_DATA_MAX_AGE_SECONDS).not.toBe(PENDING_EXTERNAL_ENTRY_TTL_MS / 1000);
    expect(TELEGRAM_INIT_DATA_MAX_AGE_SECONDS).toBe(86_400);
    expect(PENDING_EXTERNAL_ENTRY_TTL_MS).toBe(60_000);
  });

  it("does not force RIM.LOBBY as a consequence of authentication success", async () => {
    const { authenticate } = await import("./authenticate.ts");
    const { InMemoryIdentityStore } = await import("./in-memory-store.ts");
    const { createTelegramInitData } = await import("./create-init-data.ts");
    const context = await authenticate(
      { method: "telegram", initData: createTelegramInitData({ id: 3 }) },
      {
        environment: "development",
        telegramBotToken: "test-bot-token",
        authFreshnessSeconds: TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
        allowDevelopmentAuth: false,
        developmentAuthSecret: null,
      },
      new InMemoryIdentityStore(),
      { nowSeconds: () => 1_700_000_000 },
    );
    expect("controlState" in context).toBe(false);
    expect(JSON.stringify(context)).not.toContain("RIM.LOBBY");
  });
});
