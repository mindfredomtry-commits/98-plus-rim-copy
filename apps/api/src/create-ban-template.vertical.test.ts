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
  eventOf,
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

async function session(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ openIfNeeded: true }),
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
};

type ShareJson = {
  attemptId: string;
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
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
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

  it("10–12. E-08 creates Share op + OPEN_TELEGRAM_SHARE, no Ban, telegramShare attached", async () => {
    const app = await start();
    await reachConfirmTemplate(app.url);
    const pending = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(pending.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(bansOf(pending)).toEqual([]);
    expect(pending.effects).toContain("OPEN_TELEGRAM_SHARE");
    expect(pending.pendingExternalEffects).toContain("OPEN_TELEGRAM_SHARE");
    const shares = sharesOf(pending);
    expect(shares).toHaveLength(1);
    expect(shares[0]?.status).toBe("ACTIVE");
    expect(shares[0]?.createdBanId).toBeNull();
    expect(shares[0]?.draft.banText).toBe(BAN_TEXT);
    expect(shares[0]?.draft.selectedContactId).toBeNull();
    expect(pending.telegramShare?.api).toBe("shareMessage");
    expect(pending.telegramShare?.preparedMessageId).toMatch(/^mock-prepared-/);
    expect(pending.telegramShare?.attemptId).toBe(shares[0]?.attemptId);
    expect(pending.activeShareAttemptId).toBe(shares[0]?.attemptId);
  });

  it("13–16. matching E-12 creates exactly one Template Ban → CB-10; duplicate creates none", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
    expect(bansOf(pending)).toEqual([]);
    const success = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: attemptId,
        result: {},
      }),
    );
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    const created = bansOf(success);
    expect(created).toHaveLength(1);
    expect(created[0]?.banText).toBe(BAN_TEXT);
    expect(created[0]?.receiverId).toBeNull();
    expect(sharesOf(success)[0]?.status).toBe("CONFIRMED");
    expect(sharesOf(success)[0]?.createdBanId).toBe(created[0]?.id);

    const duplicate = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: attemptId,
        result: {},
      }),
    );
    expect(bansOf(duplicate)).toHaveLength(1);
    expect(duplicate.controlState).toBe("CREATE_BAN.SUCCESS");
  });

  it("17–19. E-13 creates no Ban, returns CB-07 with draft; late E-12 creates no Ban", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
    const cancelled = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CANCELLED", {
        shareAttemptId: attemptId,
      }),
    );
    expect(cancelled.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE");
    expect(bansOf(cancelled)).toEqual([]);
    expect(cancelled.createBanDraft?.banText).toBe(BAN_TEXT);
    expect(cancelled.createBanDraft?.durationMinutes).toBe(10);
    expect(sharesOf(cancelled).find((s) => s.attemptId === attemptId)?.status).toBe("CANCELLED");

    const late = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
      shareAttemptId: attemptId,
      result: {},
    });
    expect(requireDiagnostics(late).controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE");
    expect(bansOf(requireDiagnostics(late))).toEqual([]);
    expect(late.executionStatus).not.toBe("APPLIED");
  });

  it("20–21. E-32 during CB-09 creates no Ban; late E-12 creates no Ban", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
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
    expect(closed.snapshot.extended.createBanDraft).toBeNull();
    expect(Object.keys(closed.snapshot.extended.entities.bans)).toEqual([]);
    const share = closed.snapshot.extended.entities.shareOperations[attemptId as ShareAttemptId];
    expect(share?.status).toBe("CANCELLED");

    const late = await executeAuthenticatedEvent(app.runtime, context, {
      name: "CREATE_BAN.SHARE_CONFIRMED",
      payload: { shareAttemptId: attemptId, result: {} },
    });
    expect(late.status).not.toBe("APPLIED");
    expect(Object.keys(late.snapshot.extended.entities.bans)).toEqual([]);
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

    const late = reduce(
      displaced.snapshot,
      eventOf("CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: SHARE_ATTEMPT_ID,
        result: {} as import("@98plus/product-model").ShareResult,
      }),
      kernelContext(),
    );
    expect(late.outcome).not.toBe("APPLIED");
    expect(Object.keys(late.snapshot.extended.entities.bans).filter((id) => id !== BAN_ID)).toEqual(
      [],
    );
    expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(late.controlState).not.toBe("CREATE_BAN.SUCCESS");
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

  it("26–27. mismatched / already-applied Share results cannot create another Ban", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const attemptId = pending.activeShareAttemptId!;
    const mismatch = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
      shareAttemptId: "other-share-attempt",
      result: {},
    });
    expect(requireDiagnostics(mismatch).controlState).toBe(
      "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING",
    );
    expect(bansOf(requireDiagnostics(mismatch))).toEqual([]);
    expect(mismatch.executionStatus).not.toBe("APPLIED");

    const success = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: attemptId,
        result: {},
      }),
    );
    expect(bansOf(success)).toHaveLength(1);
    const again = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: attemptId,
        result: {},
      }),
    );
    expect(bansOf(again)).toHaveLength(1);
  });

  it("28–29. CB-10 + E-09 with/without Notifications", async () => {
    const emptyApp = await start();
    const pending = await reachSharePending(emptyApp.url);
    const emptySuccess = requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: pending.activeShareAttemptId,
        result: {},
      }),
    );
    expect(emptySuccess.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(emptySuccess.hasUnprocessedNotifications).toBe(false);
    const lobby = requireDiagnostics(
      await dispatch(emptyApp.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
    expect(lobby.controlState).toBe("RIM.LOBBY");

    const app = await start();
    await session(app.url, USER_A_TG);
    const aId = userIdOf(app.runtime, USER_A_TG)!;
    await session(app.url, USER_B_TG);
    grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
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

    const aPending = await reachSharePending(app.url);
    const aSuccess = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: aPending.activeShareAttemptId,
        result: {},
      }),
    );
    expect(aSuccess.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(aSuccess.hasUnprocessedNotifications).toBe(true);
    const next = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
    expect(next.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(next.activeNotificationItemId).not.toBeNull();
  });

  it("30. receiver is NOT invented during Template Ban creation", async () => {
    const app = await start();
    const pending = await reachSharePending(app.url);
    const success = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: pending.activeShareAttemptId,
        result: {},
      }),
    );
    expect(bansOf(success)[0]?.receiverId).toBeNull();
    expect(sharesOf(success)[0]?.draft.selectedContactId).toBeNull();
  });

  it("31. CONTACT Create Ban still creates Ban with real receiver", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    const bId =
      who.contacts.find((c) => c.telegramUserId === USER_B_TG)?.userId ??
      userIdOf(app.runtime, USER_B_TG);
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
    expect(telegramShareOutcomeToEventName(outcome!)).toBe("CREATE_BAN.SHARE_CONFIRMED");
  });

  it("TEST UI chrome reports Stage 11 and Template screens", async () => {
    const app = await start();
    const html = await (await fetch(app.url)).text();
    expect(html).toContain("98+ TEST UI — implemented through Stage 13A");
    expect(html).toContain("webApp.shareMessage");
    expect(html).toContain("CREATE_BAN.SHARE_CONFIRMED");
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
    expect(disk).toContain("CREATE_BAN.SHARE_CONFIRMED");
    expect(disk).toContain("CREATE_BAN.SHARE_CANCELLED");
  });

  it("new Share attempt after cancel uses a fresh attempt id", async () => {
    const app = await start();
    const first = await reachSharePending(app.url);
    const firstId = first.activeShareAttemptId!;
    requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_CANCELLED", {
        shareAttemptId: firstId,
      }),
    );
    const second = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(second.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(second.activeShareAttemptId).not.toBe(firstId);
    expect(sharesOf(second).filter((s) => s.status === "ACTIVE")).toHaveLength(1);
  });
});
