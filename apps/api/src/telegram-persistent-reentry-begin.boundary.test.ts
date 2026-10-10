import { afterEach, describe, expect, it } from "vitest";
import {
  emptySnapshot,
  PRODUCT_CONTROL_STATES,
  TELEGRAM_PERSISTENT_REENTRY_CTA_STATES,
  type ProductControlState,
  type ProductSnapshot,
  type UserId,
} from "@98plus/product-model";
import { PersistenceTestKit } from "../../../packages/persistence/src/test-kit.ts";
import {
  beginTelegramPersistentReentryRequest,
  TelegramPersistentReentryError,
} from "./telegram-persistent-reentry.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  DEFAULT_DEV_AUTH_SECRET,
  seedRegisteredUsers,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import { listenCreateBanContactServer } from "./http.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";

const USER_TG = "1002";
const USER_A_TG = "1001";
const CTA_WHITELIST = new Set<string>(TELEGRAM_PERSISTENT_REENTRY_CTA_STATES);
const BAN_TEXT = "reentry qualifying ban";
const DEV_SECRET = DEFAULT_DEV_AUTH_SECRET;

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;
const started: Started[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const app = started.pop();
    if (app) {
      await app.close();
    }
  }
});

function withControlState(
  snapshot: ProductSnapshot,
  controlState: ProductControlState | null,
): ProductSnapshot {
  if (controlState === snapshot.controlState) {
    return snapshot;
  }
  return {
    ...snapshot,
    controlState,
    extended: {
      ...snapshot.extended,
      telegramPersistentReentryCtaSurfaceGeneration:
        snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration + 1,
    },
  };
}

function eligibleWorld(
  state: ProductControlState,
  patch: Partial<{
    established: boolean;
    surfaceGeneration: number;
    consumedSurfaceGeneration: number | null;
    activeRequestId: string | null;
  }> = {},
): ProductSnapshot {
  const base = withControlState(emptySnapshot(), state);
  return {
    ...base,
    extended: {
      ...base.extended,
      telegramPersistentReentryEligible: true,
      telegramPersistentReentryEstablished: patch.established ?? false,
      telegramPersistentReentryActiveRequestId: patch.activeRequestId ?? null,
      ...(patch.surfaceGeneration !== undefined
        ? { telegramPersistentReentryCtaSurfaceGeneration: patch.surfaceGeneration }
        : {}),
      ...(patch.consumedSurfaceGeneration !== undefined
        ? {
            telegramPersistentReentryCtaConsumedSurfaceGeneration: patch.consumedSurfaceGeneration,
          }
        : {}),
    },
  };
}

async function runtimeWithUser(): Promise<{
  runtime: CreateBanContactRuntime;
  context: Awaited<ReturnType<typeof authenticateRuntime>>;
  kit: PersistenceTestKit;
  userId: UserId;
}> {
  const runtime = createCreateBanContactRuntime({ telegramSharePrepare: "mock" });
  await seedRegisteredUsers(runtime, [USER_TG]);
  const context = await authenticateRuntime(runtime, {
    method: "development",
    secret: DEV_SECRET,
    telegramUserId: USER_TG,
  });
  const kit = PersistenceTestKit.postgres(runtime.sql);
  return { runtime, context, kit, userId: context.currentUserId };
}

function authHeaders(telegramUserId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-98-auth-method": "development",
    "x-98-dev-secret": DEV_SECRET,
    "x-98-dev-telegram-user-id": telegramUserId,
  };
}

async function session(
  url: string,
  telegramUserId: string,
  body: Record<string, unknown> = { openIfNeeded: true },
): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { diagnostics?: TestUiDiagnostics };
  expect(response.status, JSON.stringify(json)).toBe(200);
  return json.diagnostics!;
}

async function dispatch(
  url: string,
  telegramUserId: string,
  name: string,
  payload: Record<string, unknown> = {},
) {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const json = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    error?: { code?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: json.diagnostics ?? null,
    error: json.error ?? null,
  };
}

async function beginReentry(url: string, telegramUserId: string) {
  const response = await fetch(`${url}/api/telegram-persistent-reentry/begin`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: "{}",
  });
  const json = (await response.json()) as {
    requestId?: string;
    diagnostics?: TestUiDiagnostics;
    error?: { code?: string; message?: string };
    telegramPersistentReentryActiveRequestId?: string | null;
  };
  return {
    httpStatus: response.status,
    requestId: json.requestId ?? null,
    diagnostics: json.diagnostics ?? null,
    error: json.error ?? null,
    activeRequestId: json.telegramPersistentReentryActiveRequestId ?? null,
  };
}

describe("MVP10 corrective Pass 1 — begin CTA opportunity boundary", () => {
  it("A–D. begin succeeds on each of the four whitelist surfaces when opportunity is open", async () => {
    for (const state of TELEGRAM_PERSISTENT_REENTRY_CTA_STATES) {
      const { runtime, context, kit, userId } = await runtimeWithUser();
      await kit.installFixtureSnapshot(userId, eligibleWorld(state));
      const began = await beginTelegramPersistentReentryRequest(runtime, context);
      expect(began.requestId).toBeTruthy();
      expect(began.activeRequestId).toBe(began.requestId);
      expect(began.eligible).toBe(true);
      expect(began.established).toBe(false);
      expect(began.diagnostics.controlState).toBe(state);
    }
  });

  it("E. begin rejected on every other canonical Product Control State; no activeRequestId", async () => {
    expect(PRODUCT_CONTROL_STATES).toHaveLength(30);
    for (const state of PRODUCT_CONTROL_STATES) {
      if (CTA_WHITELIST.has(state)) {
        continue;
      }
      const { runtime, context, kit, userId } = await runtimeWithUser();
      await kit.installFixtureSnapshot(userId, eligibleWorld(state));
      await expect(beginTelegramPersistentReentryRequest(runtime, context)).rejects.toMatchObject({
        code: "REENTRY_NOT_ELIGIBLE",
      });
      const loaded = await runtime.productStore.loadProductSnapshot(userId);
      expect(loaded.snapshot.extended.telegramPersistentReentryActiveRequestId).toBeNull();
      expect(loaded.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
      expect(loaded.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
      expect(loaded.snapshot.controlState).toBe(state);
    }
  });

  it("F–H. N-05 decline consumes opportunity; immediate begin rejected without mutating generations", async () => {
    const runtime = createCreateBanContactRuntime({ telegramSharePrepare: "mock" });
    const app = await listenCreateBanContactServer({
      runtime,
      seedTelegramUserIds: [USER_A_TG, USER_TG],
    });
    started.push(app);

    await session(app.url, USER_A_TG);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START");
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE", { templateContext: {} });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    const pending = (await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID")).diagnostics!;
    const share = (
      pending.shareOperations as Array<{ attemptId: string; token: string; status: string }>
    ).find((operation) => operation.status === "ACTIVE")!;
    await session(app.url, USER_TG, { openIfNeeded: true, startParam: `share_${share.token}` });
    await dispatch(app.url, USER_TG, "REPLY_BAN.PRESS_BACK");
    const qualified = (await dispatch(app.url, USER_TG, "NOTIFICATIONS.PRESS_OVERBOARD"))
      .diagnostics!;
    expect(qualified.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(qualified.telegramPersistentReentry.showCta).toBe(true);

    const first = await beginReentry(app.url, USER_TG);
    expect(first.httpStatus).toBe(200);
    expect(first.requestId).toBeTruthy();

    const declined = await dispatch(app.url, USER_TG, "TELEGRAM_PERSISTENT_REENTRY.DECLINED", {
      requestId: first.requestId!,
    });
    expect(declined.diagnostics?.telegramPersistentReentryEligible).toBe(true);
    expect(declined.diagnostics?.telegramPersistentReentry.showCta).toBe(false);
    expect(declined.diagnostics?.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");

    const userId = declined.diagnostics!.currentUserId as UserId;
    const beforeSecond = await runtime.productStore.loadProductSnapshot(userId);
    const genBefore = beforeSecond.snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration;
    const consumedBefore =
      beforeSecond.snapshot.extended.telegramPersistentReentryCtaConsumedSurfaceGeneration;

    const second = await beginReentry(app.url, USER_TG);
    expect(second.httpStatus).toBe(400);
    expect(second.error?.code).toBe("REENTRY_NOT_ELIGIBLE");
    expect(second.requestId).toBeNull();

    const afterSecond = await runtime.productStore.loadProductSnapshot(userId);
    expect(afterSecond.snapshot.extended.telegramPersistentReentryActiveRequestId).toBeNull();
    expect(afterSecond.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(afterSecond.snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration).toBe(
      genBefore,
    );
    expect(
      afterSecond.snapshot.extended.telegramPersistentReentryCtaConsumedSurfaceGeneration,
    ).toBe(consumedBefore);
  });

  it("G. after decline, later RIM.LOBBY allows begin without another E-20/E-30", async () => {
    const { runtime, context, kit, userId } = await runtimeWithUser();
    const n05 = eligibleWorld("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
      surfaceGeneration: 3,
      consumedSurfaceGeneration: 3,
    });
    await kit.installFixtureSnapshot(userId, n05);
    await expect(beginTelegramPersistentReentryRequest(runtime, context)).rejects.toBeInstanceOf(
      TelegramPersistentReentryError,
    );

    const laterRim = withControlState(n05, "RIM.LOBBY");
    expect(laterRim.extended.telegramPersistentReentryEligible).toBe(true);
    expect(laterRim.extended.telegramPersistentReentryCtaConsumedSurfaceGeneration).toBe(3);
    expect(laterRim.extended.telegramPersistentReentryCtaSurfaceGeneration).toBeGreaterThan(3);
    await kit.installFixtureSnapshot(userId, laterRim);
    const began = await beginTelegramPersistentReentryRequest(runtime, context);
    expect(began.requestId).toBeTruthy();
    expect(began.activeRequestId).toBe(began.requestId);
  });

  it("I. established=true: begin rejected on all four whitelist states", async () => {
    for (const state of TELEGRAM_PERSISTENT_REENTRY_CTA_STATES) {
      const { runtime, context, kit, userId } = await runtimeWithUser();
      await kit.installFixtureSnapshot(userId, eligibleWorld(state, { established: true }));
      // Force eligible true + established true (eligibleWorld sets eligible true).
      const loaded = await runtime.productStore.loadProductSnapshot(userId);
      expect(loaded.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
      await expect(beginTelegramPersistentReentryRequest(runtime, context)).rejects.toMatchObject({
        code: "REENTRY_NOT_ELIGIBLE",
      });
      const after = await runtime.productStore.loadProductSnapshot(userId);
      expect(after.snapshot.extended.telegramPersistentReentryActiveRequestId).toBeNull();
    }
  });
});
