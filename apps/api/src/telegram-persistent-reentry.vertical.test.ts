import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import {
  EXTERNAL_ENTRY_STAGE,
  TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_TEXT,
  TELEGRAM_PERSISTENT_REENTRY_STAGE,
  requestWriteAccessOutcomeToEventName,
} from "./index.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import { deliverPendingTelegramPersistentReentryBootstrap } from "./telegram-persistent-reentry.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const BAN_TEXT = "reentry qualifying ban";
const DEV_SECRET = "test-secret";

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

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
  const app = await listenCreateBanContactServer(
    runtime === undefined
      ? {
          runtime: createCreateBanContactRuntime({ telegramSharePrepare: "mock" }),
          seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG],
        }
      : { runtime, seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG] },
  );
  started.push(app);
  return app;
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
    executionStatus?: string;
    error?: { code?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: json.diagnostics ?? null,
    executionStatus: json.executionStatus,
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
  };
  return {
    httpStatus: response.status,
    requestId: json.requestId ?? null,
    diagnostics: json.diagnostics ?? null,
    error: json.error ?? null,
  };
}

async function createShareBoundBan(
  url: string,
  senderTg: string = USER_A_TG,
): Promise<{ banId: string; token: string }> {
  const opened = await session(url, senderTg);
  if (opened.controlState === "CREATE_BAN.SUCCESS") {
    await dispatch(url, senderTg, "CREATE_BAN.PRESS_FORBID_MORE");
  } else if (opened.controlState === "RIM.LOBBY" || opened.controlState === null) {
    await dispatch(url, senderTg, "CREATE_BAN.PRESS_START");
  } else if (opened.controlState !== "CREATE_BAN.WHO") {
    await dispatch(url, senderTg, "APP.FULL_CLOSE");
    await session(url, senderTg, { openIfNeeded: true });
    await dispatch(url, senderTg, "CREATE_BAN.PRESS_START");
  }
  const template = await dispatch(url, senderTg, "CREATE_BAN.SELECT_TEMPLATE", {
    templateContext: {},
  });
  expect(template.diagnostics?.controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
  await dispatch(url, senderTg, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, senderTg, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  await dispatch(url, senderTg, "CREATE_BAN.PRESS_NEXT");
  const pending = (await dispatch(url, senderTg, "CREATE_BAN.PRESS_FORBID")).diagnostics!;
  expect(pending.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
  const share = (
    pending.shareOperations as Array<{
      attemptId: string;
      token: string;
      status: string;
    }>
  ).find((operation) => operation.status === "ACTIVE");
  expect(
    share,
    JSON.stringify({ state: pending.controlState, ops: pending.shareOperations }),
  ).toBeTruthy();
  const receiver = await session(url, USER_B_TG, {
    openIfNeeded: true,
    startParam: `share_${share!.token}`,
  });
  expect(receiver.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
  const ban = (receiver.bans as Array<{ id: string }>)[0];
  expect(ban?.id).toBeTruthy();
  return { banId: ban!.id, token: share!.token };
}

async function openShareAsReceiver(url: string, token: string): Promise<TestUiDiagnostics> {
  return session(url, USER_B_TG, {
    openIfNeeded: true,
    startParam: `share_${token}`,
  });
}

async function qualifyViaOverboard(url: string): Promise<TestUiDiagnostics> {
  const result = await dispatch(url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
  expect(result.httpStatus).toBe(200);
  expect(result.diagnostics).not.toBeNull();
  return result.diagnostics!;
}

describe("Stage 13A Telegram Persistent Re-entry vertical", () => {
  it("keeps frozen 30 / 59 / 359 and TELEGRAM_PERSISTENT_REENTRY_STAGE = 13A", async () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(58);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(358);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(EXTERNAL_ENTRY_STAGE).toBe(12);
    expect(TELEGRAM_PERSISTENT_REENTRY_STAGE).toBe("13A");
    expect(requestWriteAccessOutcomeToEventName(true)).toBe("TELEGRAM_PERSISTENT_REENTRY.GRANTED");
    expect(requestWriteAccessOutcomeToEventName(false)).toBe(
      "TELEGRAM_PERSISTENT_REENTRY.DECLINED",
    );
    const app = await start();
    const meta = await (await fetch(`${app.url}/api/meta`)).json();
    expect(meta.TELEGRAM_PERSISTENT_REENTRY_STAGE).toBe("13A");
    expect(meta.CANONICAL_EVENT_COUNT).toBe(58);
    expect(meta.MATRIX_RULE_COUNT).toBe(358);
  });

  it("E-45 alone leaves eligible false", async () => {
    const runtime = createCreateBanContactRuntime({ telegramSharePrepare: "mock" });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    const receiver = await openShareAsReceiver(app.url, created.token);
    expect(receiver.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(receiver.telegramPersistentReentryEligible).toBe(false);
    expect(receiver.telegramPersistentReentryEstablished).toBe(false);
    expect(receiver.telegramPersistentReentry.showCta).toBe(false);
    const ban = (receiver.bans as Array<{ boundViaTelegramShareLink?: boolean }>)[0];
    expect(ban?.boundViaTelegramShareLink).toBe(true);
  });

  it("qualifying E-20 after share-bound ban → eligible; survives FULL_CLOSE + NORMAL_OPEN", async () => {
    const app = await start();
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    const afterOverboard = await qualifyViaOverboard(app.url);
    expect(afterOverboard.telegramPersistentReentryEligible).toBe(true);
    expect(afterOverboard.telegramPersistentReentryEstablished).toBe(false);
    expect(afterOverboard.telegramPersistentReentry.showCta).toBe(true);
    expect(afterOverboard.telegramPersistentReentry.label).toBe("Закрепить 98+");
    expect(afterOverboard.telegramPersistentReentry.api).toBe("requestWriteAccess");

    await dispatch(app.url, USER_B_TG, "APP.FULL_CLOSE");
    const reopened = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(reopened.telegramPersistentReentryEligible).toBe(true);
    expect(reopened.telegramPersistentReentryEstablished).toBe(false);
    expect(reopened.telegramPersistentReentry.showCta).toBe(true);
  });

  it("E-30 FROM_STATUS does not qualify — product-model CORE covers authority", async () => {
    // Authoritative: packages/product-model/src/telegram-persistent-reentry.test.ts #11
    // (E-30 FROM_STATUS never emits SET_TELEGRAM_PERSISTENT_REENTRY_ELIGIBLE).
    const app = await start();
    const created = await createShareBoundBan(app.url);
    const receiver = await openShareAsReceiver(app.url, created.token);
    expect(receiver.telegramPersistentReentryEligible).toBe(false);
    expect(
      (receiver.bans as Array<{ boundViaTelegramShareLink?: boolean }>)[0]
        ?.boundViaTelegramShareLink,
    ).toBe(true);
  });

  it("E-61 → established, one bootstrap intent, CTA gone; duplicate E-61 → no second bootstrap", async () => {
    const runtime = createCreateBanContactRuntime({ telegramSharePrepare: "mock" });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    await qualifyViaOverboard(app.url);
    const began = await beginReentry(app.url, USER_B_TG);
    expect(began.httpStatus).toBe(200);
    expect(began.requestId).toBeTruthy();
    expect(began.diagnostics?.telegramPersistentReentryActiveRequestId).toBe(began.requestId);

    const granted = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(granted.httpStatus).toBe(200);
    expect(granted.diagnostics?.telegramPersistentReentryEstablished).toBe(true);
    expect(granted.diagnostics?.telegramPersistentReentryEligible).toBe(false);
    expect(granted.diagnostics?.telegramPersistentReentryBootstrapSent).toBe(true);
    expect(granted.diagnostics?.telegramPersistentReentry.showCta).toBe(false);
    expect(granted.diagnostics?.telegramPersistentReentryActiveRequestId).toBeNull();
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
    expect(runtime.telegramPersistentReentryBootstrapIntents[0]?.text).toBe(
      TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_TEXT,
    );
    expect(runtime.telegramPersistentReentryBootstrapIntents[0]?.mode).toBe("mock");

    const duplicate = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(duplicate.httpStatus).toBe(200);
    expect(duplicate.diagnostics?.telegramPersistentReentryEstablished).toBe(true);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
  });

  it("E-62 → eligible remains true; same surface CTA hidden; later RIM.LOBBY shows CTA", async () => {
    const runtime = createCreateBanContactRuntime({ telegramSharePrepare: "mock" });
    const app = await start(runtime);
    const first = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, first.token);
    const qualified = await qualifyViaOverboard(app.url);
    expect(qualified.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(qualified.telegramPersistentReentry.showCta).toBe(true);

    const began = await beginReentry(app.url, USER_B_TG);
    const declined = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.DECLINED", {
      requestId: began.requestId!,
    });
    expect(declined.diagnostics?.telegramPersistentReentryEligible).toBe(true);
    expect(declined.diagnostics?.telegramPersistentReentryEstablished).toBe(false);
    expect(declined.diagnostics?.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(declined.diagnostics?.telegramPersistentReentry.showCta).toBe(false);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(0);

    await dispatch(app.url, USER_B_TG, "APP.FULL_CLOSE");
    const reopened = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(reopened.telegramPersistentReentryEligible).toBe(true);
    expect(reopened.telegramPersistentReentryEstablished).toBe(false);
    expect(reopened.controlState).toBe("RIM.LOBBY");
    expect(reopened.telegramPersistentReentry.showCta).toBe(true);
  });

  it("late E-20 after newer entry sets eligible without restoring old UI", async () => {
    // Authoritative late-result semantics: product-model telegram-persistent-reentry.test.ts.
    // Vertical: qualifying E-20 sets eligible while staying on Notification Status, not Success UI.
    const app = await start();
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    const qualified = await qualifyViaOverboard(app.url);
    expect(qualified.telegramPersistentReentryEligible).toBe(true);
    expect(qualified.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(qualified.controlState).not.toBe("CREATE_BAN.SUCCESS");
  });

  it("corrective: send failure leaves established=true and bootstrapSent=false; session retries", async () => {
    const runtime = createCreateBanContactRuntime({
      telegramSharePrepare: "mock",
      telegramPersistentReentryBootstrapSend: "fail-once",
    });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    await qualifyViaOverboard(app.url);
    const began = await beginReentry(app.url, USER_B_TG);
    const controlBefore = began.diagnostics?.controlState ?? null;

    const granted = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(granted.httpStatus).toBe(200);
    expect(granted.diagnostics?.telegramPersistentReentryEstablished).toBe(true);
    expect(granted.diagnostics?.telegramPersistentReentryEligible).toBe(false);
    expect(granted.diagnostics?.telegramPersistentReentryBootstrapSent).toBe(false);
    expect(granted.diagnostics?.controlState).toBe(controlBefore);
    expect(granted.diagnostics?.error?.code).toBe("BOOTSTRAP_SEND_FAILED");
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(0);

    const loaded = await runtime.productStore.loadProductSnapshot(
      granted.diagnostics!.currentUserId as import("@98plus/product-model").UserId,
    );
    expect(loaded.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
    expect(loaded.telegramPersistentReentryBootstrapSent).toBe(false);

    await dispatch(app.url, USER_B_TG, "APP.FULL_CLOSE");
    const reopened = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(reopened.telegramPersistentReentryEstablished).toBe(true);
    expect(reopened.telegramPersistentReentryBootstrapSent).toBe(true);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);

    const again = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(again.telegramPersistentReentryBootstrapSent).toBe(true);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
  });

  it("corrective: live mode + missing TELEGRAM_BOT_TOKEN does not mock success", async () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const runtime = createCreateBanContactRuntime({
        telegramSharePrepare: "mock",
        telegramPersistentReentryBootstrapMode: "live",
        telegramPersistentReentryBootstrapSend: "success",
      });
      const app = await start(runtime);
      const created = await createShareBoundBan(app.url);
      await openShareAsReceiver(app.url, created.token);
      await qualifyViaOverboard(app.url);
      const began = await beginReentry(app.url, USER_B_TG);
      const granted = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
        requestId: began.requestId!,
      });
      expect(granted.diagnostics?.telegramPersistentReentryEstablished).toBe(true);
      expect(granted.diagnostics?.telegramPersistentReentryBootstrapSent).toBe(false);
      expect(granted.diagnostics?.error?.code).toBe("TELEGRAM_BOT_TOKEN_MISSING");
      expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previous;
      }
    }
  });

  it("corrective: duplicate E-61 after completion does not send a second bootstrap", async () => {
    const runtime = createCreateBanContactRuntime({ telegramSharePrepare: "mock" });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    await qualifyViaOverboard(app.url);
    const began = await beginReentry(app.url, USER_B_TG);
    await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
    await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
    const snap = await session(app.url, USER_B_TG);
    expect(snap.telegramPersistentReentryBootstrapSent).toBe(true);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
  });

  it("corrective pass 2: concurrent deliverPending — exactly one claim and one send", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runtime = createCreateBanContactRuntime({
      telegramSharePrepare: "mock",
      telegramPersistentReentryBootstrapSend: "fail-once",
    });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    await qualifyViaOverboard(app.url);
    const began = await beginReentry(app.url, USER_B_TG);
    const granted = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(granted.diagnostics?.telegramPersistentReentryEstablished).toBe(true);
    expect(granted.diagnostics?.telegramPersistentReentryBootstrapSent).toBe(false);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(0);

    Object.assign(runtime, {
      telegramPersistentReentryBootstrapSend: "success",
      telegramPersistentReentryBootstrapAfterClaim: async () => {
        await gate;
      },
    });

    const context = await authenticateRuntime(runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const pending = Promise.all([
      deliverPendingTelegramPersistentReentryBootstrap(runtime, context),
      deliverPendingTelegramPersistentReentryBootstrap(runtime, context),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseGate?.();
    const results = await pending;
    expect(results.filter((result) => result.status === "SENT")).toHaveLength(1);
    expect(results.filter((result) => result.status === "ALREADY_CLAIMED")).toHaveLength(1);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
    const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(loaded.telegramPersistentReentryBootstrapSent).toBe(true);
    expect(loaded.telegramPersistentReentryBootstrapClaimedUntilMs).toBeNull();
    expect(loaded.telegramPersistentReentryBootstrapClaimToken).toBeNull();

    const again = await deliverPendingTelegramPersistentReentryBootstrap(runtime, context);
    expect(again.status).toBe("ALREADY_SENT");
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
  });

  it("corrective pass 3: stale owner mark/release cannot mutate reclaimed claim", async () => {
    const runtime = createCreateBanContactRuntime({
      telegramSharePrepare: "mock",
      telegramPersistentReentryBootstrapSend: "fail-once",
    });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    await qualifyViaOverboard(app.url);
    const began = await beginReentry(app.url, USER_B_TG);
    await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });

    const context = await authenticateRuntime(runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });

    const claimA = await runtime.productStore.claimTelegramPersistentReentryBootstrapDelivery(
      context.currentUserId,
      10_000,
      60_000,
    );
    expect(claimA.status).toBe("CLAIMED");
    if (claimA.status !== "CLAIMED") {
      throw new Error("expected CLAIMED A");
    }

    const claimB = await runtime.productStore.claimTelegramPersistentReentryBootstrapDelivery(
      context.currentUserId,
      claimA.claimedUntilMs + 1,
      60_000,
    );
    expect(claimB.status).toBe("CLAIMED");
    if (claimB.status !== "CLAIMED") {
      throw new Error("expected CLAIMED B");
    }
    expect(claimB.claimToken).not.toBe(claimA.claimToken);

    const staleComplete = await runtime.productStore.markTelegramPersistentReentryBootstrapSent(
      context.currentUserId,
      claimA.claimToken,
    );
    expect(staleComplete.status).toBe("STALE_CLAIM");
    const afterStaleComplete = await runtime.productStore.loadProductSnapshot(
      context.currentUserId,
    );
    expect(afterStaleComplete.telegramPersistentReentryBootstrapSent).toBe(false);
    expect(afterStaleComplete.telegramPersistentReentryBootstrapClaimToken).toBe(claimB.claimToken);

    const staleRelease = await runtime.productStore.releaseTelegramPersistentReentryBootstrapClaim(
      context.currentUserId,
      claimA.claimToken,
    );
    expect(staleRelease.status).toBe("STALE_CLAIM");
    const afterStaleRelease = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(afterStaleRelease.telegramPersistentReentryBootstrapClaimToken).toBe(claimB.claimToken);
    expect(afterStaleRelease.telegramPersistentReentryBootstrapSent).toBe(false);
    expect(afterStaleRelease.telegramPersistentReentryBootstrapClaimedUntilMs).toBe(
      claimB.claimedUntilMs,
    );

    const ownerComplete = await runtime.productStore.markTelegramPersistentReentryBootstrapSent(
      context.currentUserId,
      claimB.claimToken,
    );
    expect(ownerComplete.status).toBe("MARKED");
    const completed = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(completed.telegramPersistentReentryBootstrapSent).toBe(true);
    expect(completed.telegramPersistentReentryBootstrapClaimToken).toBeNull();
    expect(completed.telegramPersistentReentryBootstrapClaimedUntilMs).toBeNull();

    Object.assign(runtime, { telegramPersistentReentryBootstrapSend: "success" });
    const delivery = await deliverPendingTelegramPersistentReentryBootstrap(runtime, context);
    expect(delivery.status).toBe("ALREADY_SENT");
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(0);
  });

  it("corrective pass 2: concurrent POST /api/session retries — one bootstrap send", async () => {
    const runtime = createCreateBanContactRuntime({
      telegramSharePrepare: "mock",
      telegramPersistentReentryBootstrapSend: "fail-once",
    });
    const app = await start(runtime);
    const created = await createShareBoundBan(app.url);
    await openShareAsReceiver(app.url, created.token);
    await qualifyViaOverboard(app.url);
    const began = await beginReentry(app.url, USER_B_TG);
    const granted = await dispatch(app.url, USER_B_TG, "TELEGRAM_PERSISTENT_REENTRY.GRANTED", {
      requestId: began.requestId!,
    });
    expect(granted.diagnostics?.telegramPersistentReentryEstablished).toBe(true);
    expect(granted.diagnostics?.telegramPersistentReentryBootstrapSent).toBe(false);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(0);

    const [first, second] = await Promise.all([
      session(app.url, USER_B_TG, { openIfNeeded: true }),
      session(app.url, USER_B_TG, { openIfNeeded: true }),
    ]);
    expect(
      first.telegramPersistentReentryBootstrapSent || second.telegramPersistentReentryBootstrapSent,
    ).toBe(true);
    expect(runtime.telegramPersistentReentryBootstrapIntents).toHaveLength(1);
  });
});
