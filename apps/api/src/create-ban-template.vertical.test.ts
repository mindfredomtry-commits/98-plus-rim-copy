import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_STAGE } from "@98plus/application";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  emptySnapshot,
  reduce,
  type DurationMinutes,
  type ShareAttemptId,
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  CREATE_BAN_CONTACT_STAGE,
  STAGE_11_EXCLUDES,
  TEMPLATE_CREATE_BAN_STAGE,
  buildTelegramShareInvocation,
  invokeTelegramShareMessage,
  telegramShareOutcomeToEventName,
} from "./index.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";
import {
  BAN_ID,
  INCOMING_ITEM_ID,
  SHARE_ATTEMPT_ID,
  USER_ID,
  defaultEvent,
  incomingItem,
  kernelContext,
  makeBan,
  shareOp,
  validCreateDraft,
  withControlState,
  withEntities,
} from "../../../packages/product-model/src/kernel.fixtures.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const BAN_TEXT = "template ban text";
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
          seedTelegramUserIds: [USER_A_TG, USER_B_TG],
        }
      : { runtime, seedTelegramUserIds: [USER_A_TG, USER_B_TG] },
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
  sessionBody: Record<string, unknown> = { openIfNeeded: true },
): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify(sessionBody),
  });
  const body = (await response.json()) as { diagnostics?: TestUiDiagnostics; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.diagnostics!;
}

async function dispatch(
  url: string,
  telegramUserId: string,
  name: string,
  payload: Record<string, unknown> = {},
): Promise<{
  httpStatus: number;
  diagnostics: TestUiDiagnostics | null;
  executionStatus?: string;
  error: { code?: string; reason?: string; message?: string } | null;
}> {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const body = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    executionStatus?: string;
    error?: { code?: string; reason?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: body.diagnostics ?? null,
    error: body.error ?? null,
    ...(body.executionStatus === undefined ? {} : { executionStatus: body.executionStatus }),
  };
}

function requireDiagnostics(result: Awaited<ReturnType<typeof dispatch>>): TestUiDiagnostics {
  expect(result.httpStatus, JSON.stringify(result.error)).toBe(200);
  expect(result.diagnostics).not.toBeNull();
  return result.diagnostics!;
}

type BanJson = {
  id: string;
  senderId: string;
  receiverId: string | null;
  banText: string;
  durationMinutes: number;
  acceptance: string;
  status: string | null;
  boundViaTelegramShareLink: boolean;
};

type ShareJson = {
  attemptId: string;
  token: string;
  status: string;
  createdBanId: string | null;
  draft: { banText: string; durationMinutes: number | null; selectedContactId: string | null };
};

function bansOf(diagnostics: TestUiDiagnostics): BanJson[] {
  return diagnostics.bans as BanJson[];
}

function sharesOf(diagnostics: TestUiDiagnostics): ShareJson[] {
  return diagnostics.shareOperations as ShareJson[];
}

async function reachWho(url: string): Promise<TestUiDiagnostics> {
  await session(url, USER_A_TG);
  return requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START"));
}

async function reachWhatTemplate(url: string): Promise<TestUiDiagnostics> {
  await reachWho(url);
  return requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE"));
}

async function reachConfirmTemplate(
  url: string,
  text: string = BAN_TEXT,
  durationMinutes: number = 10,
): Promise<TestUiDiagnostics> {
  await reachWhatTemplate(url);
  requireDiagnostics(
    await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: text }),
  );
  requireDiagnostics(
    await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes }),
  );
  return requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
}

async function reachSharePending(url: string): Promise<TestUiDiagnostics> {
  await reachConfirmTemplate(url);
  return requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"));
}

describe("Stage 11 Template Create Ban + Telegram Share vertical", () => {
  it("keeps frozen contracts and exposes TEMPLATE_CREATE_BAN_STAGE = 11", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(APPLICATION_STAGE).toBe(5);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(TEMPLATE_CREATE_BAN_STAGE).toBe(11);
    expect(STAGE_11_EXCLUDES).toContain("external-entry");
    expect(STAGE_11_EXCLUDES).not.toContain("template-create-ban");
    expect(STAGE_11_EXCLUDES).not.toContain("telegram-share");
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
  });

  it("1. CB-01 + E-03 → CB-03", async () => {
    const app = await start();
    const who = await reachWho(app.url);
    expect(who.controlState).toBe("CREATE_BAN.WHO");
    const what = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE"),
    );
    expect(what.controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    expect(what.createBanDraft?.origin).toBe("TEMPLATE");
    expect(what.createBanDraft?.selectedContactId).toBeNull();
  });

  it("2–3. Template banText and duration editing", async () => {
    const app = await start();
    await reachWhatTemplate(app.url);
    const text = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT }),
    );
    expect(text.createBanDraft?.banText).toBe(BAN_TEXT);
    const duration = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 21 }),
    );
    expect(duration.createBanDraft?.durationMinutes).toBe(21);
  });

  it("4–7. invalid empty/whitespace banText, duration <3, >60, non-integer stay CB-03", async () => {
    const app = await start();
    await reachWhatTemplate(app.url);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "   " });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
    const empty = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    expect(requireDiagnostics(empty).controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    expect(requireDiagnostics(empty).matrixResult).toBe("IGNORE_NOT_ALLOWED");
    expect(empty.executionStatus).toBe("APPLIED");

    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 2 });
    const low = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    expect(requireDiagnostics(low).controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    expect(requireDiagnostics(low).matrixResult).toBe("IGNORE_NOT_ALLOWED");

    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 61 });
    const high = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    expect(requireDiagnostics(high).controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    expect(requireDiagnostics(high).matrixResult).toBe("IGNORE_NOT_ALLOWED");

    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10.5 });
    const nonInt = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    expect(requireDiagnostics(nonInt).controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    expect(requireDiagnostics(nonInt).matrixResult).toBe("IGNORE_NOT_ALLOWED");
  });

  it("8. valid CB-03 + E-06 → CB-07", async () => {
    const app = await start();
    const confirm = await reachConfirmTemplate(app.url);
    expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE");
    expect(confirm.createBanDraft?.banText).toBe(BAN_TEXT);
    expect(confirm.createBanDraft?.durationMinutes).toBe(10);
  });

  it("9. CB-07 + E-07 → CB-03 with preserved draft", async () => {
    const app = await start();
    await reachConfirmTemplate(app.url, "keep me", 12);
    const back = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK"));
    expect(back.controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    expect(back.createBanDraft?.banText).toBe("keep me");
    expect(back.createBanDraft?.durationMinutes).toBe(12);
  });

  it("10–12. E-08 creates one unbound Ban, ACTIVE share, SHARE_PENDING, and OPEN_TELEGRAM_SHARE", async () => {
    const app = await start();
    await reachConfirmTemplate(app.url);
    const pending = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(pending.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    const bans = bansOf(pending);
    expect(bans).toHaveLength(1);
    expect(bans[0]?.receiverId).toBeNull();
    expect(bans[0]?.senderId).toBe(await userIdOf(app.runtime, USER_A_TG));
    expect(bans[0]?.boundViaTelegramShareLink).toBe(false);
    expect(pending.successfulBanId).toBe(bans[0]?.id);
    expect(pending.effects).toContain("OPEN_TELEGRAM_SHARE");
    expect(pending.pendingExternalEffects).toContain("OPEN_TELEGRAM_SHARE");
    const shares = sharesOf(pending);
    expect(shares).toHaveLength(1);
    expect(shares[0]?.status).toBe("ACTIVE");
    expect(shares[0]?.createdBanId).toBe(bans[0]?.id);
    expect(shares[0]?.draft.banText).toBe(BAN_TEXT);
    expect(shares[0]?.draft.selectedContactId).toBeNull();
    expect(pending.telegramShare?.api).toBe("shareMessage");
    expect(pending.telegramShare?.preparedMessageId).toMatch(/^mock-prepared-/);
    expect(pending.telegramShare?.attemptId).toBe(shares[0]?.attemptId);
    expect(pending.activeShareAttemptId).toBe(shares[0]?.attemptId);
  });

  it("13–16. share callback cannot mint; recipient claim binds the existing Ban", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
    const token = sharesOf(pending)[0]?.token;
    const createdId = bansOf(pending)[0]?.id;
    expect(bansOf(pending)).toHaveLength(1);
    const callback = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
      shareAttemptId: attemptId,
      result: {},
    });
    expect(callback.httpStatus).toBe(400);
    expect(callback.error?.code).toBe("INVALID_EVENT");
    const senderAfterCallback = await session(app.url, USER_A_TG, { openIfNeeded: false });
    expect(bansOf(senderAfterCallback)).toHaveLength(1);
    expect(bansOf(senderAfterCallback)[0]?.id).toBe(createdId);
    expect(senderAfterCallback.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");

    const receiver = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${token}`,
    });
    const created = bansOf(receiver);
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe(createdId);
    expect(created[0]?.banText).toBe(BAN_TEXT);
    expect(created[0]?.senderId).toBe(await userIdOf(app.runtime, USER_A_TG));
    expect(created[0]?.receiverId).toBe(await userIdOf(app.runtime, USER_B_TG));
    expect(receiver.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(receiver.incomingItems).toHaveLength(1);

    const sender = await app.runtime.productStore.loadProductSnapshot(
      (await userIdOf(app.runtime, USER_A_TG))!,
    );
    expect(sender.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    const returned = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_RETURNED", {
        shareAttemptId: attemptId,
      }),
    );
    expect(returned.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(bansOf(returned)).toHaveLength(1);
    expect(bansOf(returned)[0]?.id).toBe(created[0]?.id);
    expect(bansOf(returned)[0]?.receiverId).toBe(await userIdOf(app.runtime, USER_B_TG));
    expect(sharesOf(returned).find((share) => share.attemptId === attemptId)?.status).toBe(
      "CONFIRMED",
    );
    expect(sender.snapshot.extended.successfulBanId).toBe(created[0]?.id);
    expect(
      sender.snapshot.extended.entities.shareOperations[attemptId as ShareAttemptId]?.status,
    ).toBe("CONFIRMED");

    const again = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${token}`,
    });
    expect(bansOf(again)).toHaveLength(1);
    expect(again.incomingItems).toHaveLength(1);
  });

  it("17–19. callback false / E-13 does not cancel the created Ban or share", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
    const banId = bansOf(pending)[0]?.id;
    const cancelled = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CANCELLED", {
      shareAttemptId: attemptId,
    });
    expect(cancelled.httpStatus).toBe(200);
    expect(cancelled.executionStatus).toBe("APPLIED");
    expect(cancelled.executionStatus).not.toBe("KERNEL_INVARIANT");
    expect(cancelled.diagnostics?.matrixResult).toBe("IGNORE_NOT_ALLOWED");
    const durable = await session(app.url, USER_A_TG, { openIfNeeded: false });
    expect(durable.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(bansOf(durable)[0]?.id).toBe(banId);
    const share = sharesOf(durable).find((item) => item.attemptId === attemptId);
    expect(share?.status).toBe("ACTIVE");
    expect(share?.createdBanId).toBe(banId);
    expect(share?.token).toBeTruthy();
    const success = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_RETURNED", {
        shareAttemptId: attemptId,
      }),
    );
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(bansOf(success)[0]?.id).toBe(banId);
    expect(sharesOf(success).find((item) => item.attemptId === attemptId)?.token).toBe(
      share?.token,
    );
  });

  it("20–21. closing from SUCCESS preserves the Ban and claimable token", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
    const banId = bansOf(pending)[0]?.id;
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const closed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.FULL_CLOSE",
      payload: {},
    });
    expect(closed.status).toBe("APPLIED");
    expect(closed.snapshot.controlState).toBeNull();
    expect(Object.keys(closed.snapshot.extended.entities.bans)).toEqual([banId]);
    const share = closed.snapshot.extended.entities.shareOperations[attemptId as ShareAttemptId];
    expect(share?.status).toBe("ACTIVE");
    expect(share?.createdBanId).toBe(banId);
    const durable = await app.runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(Object.keys(durable.snapshot.extended.entities.bans)).toEqual([banId]);
    expect(
      durable.snapshot.extended.entities.shareOperations[attemptId as ShareAttemptId]?.status,
    ).toBe("ACTIVE");
  });

  it("22–23. E-45 Guard A supersedes CB-09; late E-12 creates no Template Ban", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        createBanDraft: validCreateDraft("TEMPLATE"),
      },
    };
    snapshot = withEntities(snapshot, {
      bans: { [BAN_ID]: makeBan({ receiverId: USER_ID }) },
      shareOperations: {
        [SHARE_ATTEMPT_ID]: shareOp({
          draft: {
            origin: "TEMPLATE",
            selectedContactId: null,
            banText: "share ban",
            durationMinutes: 21 as DurationMinutes,
            proposalId: null,
          },
        }),
      },
      notificationItems: {
        [INCOMING_ITEM_ID]: incomingItem({
          ownerId: USER_ID,
          banId: BAN_ID,
          lifecycle: { status: "UNPROCESSED", display: "WAITING" },
        }),
      },
    });
    const displaced = reduce(
      snapshot,
      defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED"),
      kernelContext(),
    );
    expect(displaced.outcome).toBe("APPLIED");
    expect(displaced.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(displaced.snapshot.extended.createBanDraft).toBeNull();

    expect(Object.keys(displaced.snapshot.extended.entities.bans)).toEqual([BAN_ID]);
    expect(displaced.controlState).not.toBe("CREATE_BAN.SUCCESS");
  });

  it("24. E-45 Guard B preserves CB-09", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        createBanDraft: validCreateDraft("TEMPLATE"),
      },
    };
    snapshot = withEntities(snapshot, {
      bans: { [BAN_ID]: makeBan({ receiverId: USER_ID }) },
      shareOperations: { [SHARE_ATTEMPT_ID]: shareOp() },
      notificationItems: {
        [INCOMING_ITEM_ID]: incomingItem({
          ownerId: USER_ID,
          banId: BAN_ID,
          lifecycle: { status: "PROCESSED" },
        }),
      },
    });
    const stayed = reduce(snapshot, defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED"), kernelContext());
    expect(stayed.outcome).toBe("APPLIED");
    expect(stayed.result).toBe("STAY");
    expect(stayed.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(stayed.snapshot.extended.createBanDraft).not.toBeNull();
    expect(stayed.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "ACTIVE",
    );
  });

  it("25. E-46 preserves CB-09", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        createBanDraft: validCreateDraft("TEMPLATE"),
      },
    };
    snapshot = withEntities(snapshot, {
      shareOperations: { [SHARE_ATTEMPT_ID]: shareOp() },
    });
    const stayed = reduce(snapshot, defaultEvent("TELEGRAM_SHARE_LINK.REJECTED"), kernelContext());
    expect(stayed.outcome).toBe("APPLIED");
    expect(stayed.result).toBe("STAY");
    expect(stayed.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(stayed.snapshot.extended.createBanDraft).not.toBeNull();
  });

  it("26–27. a client callback cannot mint, including a repeated callback", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const first = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
      shareAttemptId: "other-share-attempt",
      result: {},
    });
    const second = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
      shareAttemptId: pending.activeShareAttemptId,
      result: {},
    });
    expect(first.httpStatus).toBe(400);
    expect(second.httpStatus).toBe(400);
    const durable = await session(app.url, USER_A_TG, { openIfNeeded: false });
    expect(durable.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(bansOf(durable)).toHaveLength(1);
  });

  it("28–29. CONTACT E-10 still reaches SUCCESS; E-09 follows the notification queue", async () => {
    const emptyApp = await start();
    await session(emptyApp.url, USER_A_TG);
    await session(emptyApp.url, USER_B_TG);
    await grantContactBetweenTelegramUsers(emptyApp.runtime, USER_A_TG, USER_B_TG);
    const bId = (await userIdOf(emptyApp.runtime, USER_B_TG))!;
    requireDiagnostics(await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
    );
    requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "contact" }),
    );
    requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", {
        durationMinutes: 10,
      }),
    );
    requireDiagnostics(await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
    const emptySuccess = requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(emptySuccess.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(emptySuccess.hasUnprocessedNotifications).toBe(false);
    const lobby = requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
    expect(lobby.controlState).toBe("RIM.LOBBY");

    const app = await start();
    await session(app.url, USER_A_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    await session(app.url, USER_B_TG);
    await grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_START"));
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: aId }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "from B" }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 }),
    );
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_NEXT"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_FORBID"));

    const contactBId = (await userIdOf(app.runtime, USER_B_TG))!;
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: contactBId }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "from A" }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 }),
    );
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
    const aSuccess = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(aSuccess.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(aSuccess.hasUnprocessedNotifications).toBe(true);
    const next = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
    expect(next.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(next.activeNotificationItemId).not.toBeNull();
  });

  it("30. E-08 creates an unbound Ban; claim binds the authenticated opener", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    expect(bansOf(pending)).toHaveLength(1);
    expect(bansOf(pending)[0]?.receiverId).toBeNull();
    expect(sharesOf(pending)[0]?.draft.selectedContactId).toBeNull();
    expect(sharesOf(pending)[0]?.createdBanId).toBe(bansOf(pending)[0]?.id);
    const token = sharesOf(pending)[0]?.token;
    const receiver = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${token}`,
    });
    expect(bansOf(receiver)[0]).toMatchObject({
      senderId: await userIdOf(app.runtime, USER_A_TG),
      receiverId: await userIdOf(app.runtime, USER_B_TG),
      acceptance: "PENDING",
      status: null,
      boundViaTelegramShareLink: true,
    });
  });

  it("31. CONTACT Create Ban still creates Ban with real receiver", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    await grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    const bId =
      who.contacts.find((c) => c.telegramUserId === USER_B_TG)?.userId ??
      (await userIdOf(app.runtime, USER_B_TG));
    expect(bId).toBeTruthy();
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "contact" }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 }),
    );
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
    const success = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(bansOf(success)[0]?.receiverId).toBe(bId);
  });

  it("adapter boundary: mock prepare + shareMessage callback maps to E-12/E-13", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const invocation = await buildTelegramShareInvocation(
      app.runtime,
      {
        controlState: pending.controlState,
        extended: {
          createBanDraft: pending.createBanDraft,
          entities: {
            shareOperations: Object.fromEntries(
              sharesOf(pending).map((share) => [share.attemptId, share]),
            ),
          },
        },
      } as never,
      USER_A_TG,
    );
    expect(invocation?.api).toBe("shareMessage");
    expect(invocation?.preparedMessageId).toBeTruthy();
    const outcome = await invokeTelegramShareMessage(
      {
        shareMessage: (_id, callback) => {
          callback?.(true);
        },
      },
      invocation!.preparedMessageId,
    );
    expect(outcome).toBe("CONFIRMED");
    expect(telegramShareOutcomeToEventName(outcome!)).toBeNull();
    expect(telegramShareOutcomeToEventName("CANCELLED")).toBe("CREATE_BAN.SHARE_CANCELLED");
  });

  it("TEST UI chrome reports Stage 11 and Template screens", async () => {
    const app = await start();
    const html = await (await fetch(app.url)).text();
    expect(html).toContain("98+ TEST UI — implemented through Stage 13A");
    expect(html).toContain("webApp.shareMessage");
    expect(html).not.toContain("CREATE_BAN.SHARE_CONFIRMED");
    expect(html).toContain("CREATE_BAN.SHARE_CANCELLED");
    const screens = await (await fetch(`${app.url}/test-ui/product-screens.js`)).text();
    expect(screens).toContain("CreateBanWhatTemplateTestScreen");
    expect(screens).toContain("CreateBanConfirmTemplateTestScreen");
    expect(screens).toContain("CreateBanSharePendingTestScreen");
    expect(screens).toContain("CREATE_BAN.SELECT_TEMPLATE");
    const disk = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../miniapp/src/test-ui.html"),
      "utf8",
    );
    expect(disk).toContain("shareMessage");
    expect(disk).not.toContain("CREATE_BAN.SHARE_CONFIRMED");
    expect(disk).toContain("CREATE_BAN.SHARE_CANCELLED");
    expect(disk).toContain("createShareReturnLatch");
    expect(disk).toContain("CREATE_BAN.SHARE_RETURNED");
    const shareCall = disk.slice(disk.indexOf("webApp.shareMessage"));
    const callbackBody = shareCall.slice(0, shareCall.indexOf("});"));
    expect(callbackBody).toContain("callback:true");
    expect(callbackBody).not.toContain("SHARE_RETURNED");
    expect(callbackBody).not.toContain("SHARE_CANCELLED");
  });

  it("E-66 moves SHARE_PENDING to Success without mutating the Ban", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    expect(pending.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    const attemptId = pending.activeShareAttemptId!;
    const banId = bansOf(pending)[0]?.id;
    const success = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_RETURNED", {
        shareAttemptId: attemptId,
      }),
    );
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(bansOf(success)).toHaveLength(1);
    expect(bansOf(success)[0]?.id).toBe(banId);
    expect(bansOf(success)[0]?.receiverId).toBeNull();
    expect(sharesOf(success).find((share) => share.attemptId === attemptId)?.status).toBe("ACTIVE");
    const duplicate = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_RETURNED", {
      shareAttemptId: attemptId,
    });
    expect(duplicate.httpStatus).toBe(200);
    expect(duplicate.executionStatus).toBe("NOT_APPLIED");
    const durable = await session(app.url, USER_A_TG, { openIfNeeded: false });
    expect(durable.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(bansOf(durable)).toHaveLength(1);
  });

  it("a repeated FORBID after SUCCESS does not create another Ban", async () => {
    const app = await start();
    const first = await reachSharePending(app.url);
    const firstId = bansOf(first)[0]?.id;
    const second = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
    expect(second.httpStatus).toBe(200);
    expect(second.executionStatus).toBe("NOT_APPLIED");
    const durable = await session(app.url, USER_A_TG, { openIfNeeded: false });
    expect(durable.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(bansOf(durable)).toHaveLength(1);
    expect(bansOf(durable)[0]?.id).toBe(firstId);
    expect(sharesOf(durable).filter((s) => s.status === "ACTIVE")).toHaveLength(1);
  });
});
