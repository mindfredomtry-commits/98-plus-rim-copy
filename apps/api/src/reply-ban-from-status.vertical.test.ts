import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_STAGE } from "@98plus/application";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  emptySnapshot,
  reduce,
  type CanonicalEvent,
  type DurationMinutes,
  type ProductSnapshot,
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  REPLY_BAN_FROM_STATUS_STAGE,
  STAGE_8_EXCLUDES,
  STAGE_9_EXCLUDES,
  STAGE_10_EXCLUDES,
  TIMER_CHECK_STATUS_STAGE,
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
import type { ContactSendOrchestration } from "./contact-send.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";
import {
  BAN_ID,
  OP_ID,
  OTHER_USER,
  REPLY_BAN_ID,
  STATUS_ITEM_ID,
  USER_ID,
  eventOf,
  kernelContext,
  makeBan,
  pendingOp,
  statusItem,
  withControlState,
  withEntities,
  withOperation,
} from "../../../packages/product-model/src/kernel.fixtures.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const BAN_TEXT = "не пропускай зал";
const REPLY_TEXT = "ответный запрет";
const REPLY_DURATION = 15;
const BAN_DURATION = 10;
const DEV_SECRET = "test-secret";
const AUTHORITATIVE_NOW = 8_000_000;
const DURATION_MS = BAN_DURATION * 60 * 1000;

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

function clockAt(now: { value: number }): CreateBanContactRuntime {
  return createCreateBanContactRuntime({
    clock: { nowMs: () => now.value },
  });
}

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
  const app = await listenCreateBanContactServer(
    runtime === undefined ? {} : { runtime, seedTelegramUserIds: [USER_A_TG, USER_B_TG] },
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
  orchestration: ContactSendOrchestration | null;
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
    orchestration?: ContactSendOrchestration;
    error?: { code?: string; reason?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: body.diagnostics ?? null,
    orchestration: body.orchestration ?? null,
    error: body.error ?? null,
    ...(body.executionStatus === undefined ? {} : { executionStatus: body.executionStatus }),
  };
}

function requireDiagnostics(result: Awaited<ReturnType<typeof dispatch>>): TestUiDiagnostics {
  expect(result.httpStatus, JSON.stringify(result.error)).toBe(200);
  expect(result.diagnostics).not.toBeNull();
  return result.diagnostics!;
}

async function snapshot(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/snapshot`, { headers: authHeaders(telegramUserId) });
  const body = (await response.json()) as { diagnostics: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics;
}

type BanJson = {
  id: string;
  senderId: string;
  receiverId: string | null;
  banText: string;
  durationMinutes: number;
  acceptance: string;
  status: string | null;
};

type NotificationJson = {
  id: string;
  ownerId: string;
  banId: string;
  kind: string;
  role?: string;
  status?: string;
  checkPairId?: string;
  lifecycle: { status: string; display?: string };
};

type TimerJson = {
  id: string;
  banId: string;
  startedAt: number;
  durationMinutes: number;
  state: string;
  checkPairCreated?: boolean;
};

type PairJson = {
  id: string;
  banId: string;
  receiverAnswer: string | null;
  senderAnswer: string | null;
  resultingStatus: string | null;
};

function bansOf(diagnostics: TestUiDiagnostics): BanJson[] {
  return diagnostics.bans as BanJson[];
}

function itemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return diagnostics.notificationItems as NotificationJson[];
}

function incomingOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "INCOMING_BAN");
}

function statusItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "STATUS");
}

function timerItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "TIMER");
}

function domainTimersOf(diagnostics: TestUiDiagnostics): TimerJson[] {
  return diagnostics.domainTimers as TimerJson[];
}

function pairsOf(diagnostics: TestUiDiagnostics): PairJson[] {
  return diagnostics.checkPairs as PairJson[];
}

function activeStatusItem(diagnostics: TestUiDiagnostics): NotificationJson {
  const item = itemsOf(diagnostics).find(
    (candidate) => candidate.id === diagnostics.activeNotificationItemId,
  );
  expect(item?.kind).toBe("STATUS");
  return item!;
}

async function ensureLobby(app: Started, telegramUserId: string): Promise<TestUiDiagnostics> {
  let current = await session(app.url, telegramUserId);
  for (let guard = 0; guard < 40; guard++) {
    if (current.controlState === "RIM.LOBBY") {
      return current;
    }
    if (current.controlState === "CREATE_BAN.SUCCESS") {
      current = requireDiagnostics(
        await dispatch(app.url, telegramUserId, "CREATE_BAN.PRESS_FORBID_MORE"),
      );
      continue;
    }
    if (
      current.controlState === "REPLY_BAN.SUCCESS.FROM_INCOMING_BAN" ||
      current.controlState === "REPLY_BAN.SUCCESS.FROM_STATUS"
    ) {
      current = requireDiagnostics(
        await dispatch(app.url, telegramUserId, "REPLY_BAN.PRESS_FORBID_MORE"),
      );
      continue;
    }
    if (current.controlState === "NOTIFICATIONS.INCOMING_BAN") {
      current = requireDiagnostics(
        await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_OVERBOARD"),
      );
      continue;
    }
    if (
      current.controlState?.startsWith("NOTIFICATIONS.STATUS") ||
      current.controlState === "NOTIFICATIONS.TIMER" ||
      current.controlState === "NOTIFICATIONS.CHECK.RECEIVER" ||
      current.controlState === "NOTIFICATIONS.CHECK.SENDER"
    ) {
      current = requireDiagnostics(
        await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_TO_BANS"),
      );
      continue;
    }
    if (
      current.controlState === "REPLY_BAN.WHAT.FROM_INCOMING_BAN" ||
      current.controlState === "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN" ||
      current.controlState === "REPLY_BAN.WHAT.FROM_STATUS" ||
      current.controlState === "REPLY_BAN.CONFIRM.FROM_STATUS"
    ) {
      current = requireDiagnostics(await dispatch(app.url, telegramUserId, "REPLY_BAN.PRESS_BACK"));
      continue;
    }
    if (
      current.controlState === "CREATE_BAN.WHO" ||
      current.controlState === "CREATE_BAN.WHAT.CONTACT" ||
      current.controlState === "CREATE_BAN.CONFIRM.CONTACT"
    ) {
      current = requireDiagnostics(
        await dispatch(app.url, telegramUserId, "CREATE_BAN.PRESS_BACK"),
      );
      continue;
    }
    break;
  }
  expect(current.controlState).toBe("RIM.LOBBY");
  return current;
}

async function createRealIncomingFromA(
  app: Started,
  options: { banText?: string; durationMinutes?: number } = {},
): Promise<{ ban: BanJson; bId: string }> {
  await ensureLobby(app, USER_A_TG);
  await session(app.url, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  const listed = who.contacts.find((contact) => contact.telegramUserId === USER_B_TG);
  const bId = listed?.userId ?? userIdOf(app.runtime, USER_B_TG);
  requireDiagnostics(
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", {
    banText: options.banText ?? BAN_TEXT,
  });
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", {
    durationMinutes: options.durationMinutes ?? BAN_DURATION,
  });
  requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  const success = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"));
  expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
  const ban =
    bansOf(success).find((item) => item.banText === (options.banText ?? BAN_TEXT)) ??
    bansOf(success)[0]!;
  return { ban, bId: bId! };
}

async function openNotifications(app: Started, telegramUserId: string): Promise<TestUiDiagnostics> {
  const current = await snapshot(app.url, telegramUserId);
  if (current.controlState === "CREATE_BAN.SUCCESS") {
    return requireDiagnostics(
      await dispatch(app.url, telegramUserId, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
  }
  if (current.controlState === "RIM.LOBBY") {
    return requireDiagnostics(await dispatch(app.url, telegramUserId, "RIM.PRESS_NOTIFICATIONS"));
  }
  return current;
}

async function drainLeadingIncomingBans(
  app: Started,
  telegramUserId: string,
  opened: TestUiDiagnostics,
): Promise<TestUiDiagnostics> {
  let current = opened;
  while (current.controlState === "NOTIFICATIONS.INCOMING_BAN") {
    const overboard = requireDiagnostics(
      await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    current = requireDiagnostics(
      await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
  }
  return current;
}

async function openNotificationsPastReplyIncoming(
  app: Started,
  telegramUserId: string,
): Promise<TestUiDiagnostics> {
  const opened = await openNotifications(app, telegramUserId);
  return drainLeadingIncomingBans(app, telegramUserId, opened);
}

async function drainLeadingOverboardStatuses(
  app: Started,
  telegramUserId: string,
  opened: TestUiDiagnostics,
): Promise<TestUiDiagnostics> {
  let current = opened;
  while (
    current.controlState === "NOTIFICATIONS.STATUS.OVERBOARD.SENDER" ||
    current.controlState === "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"
  ) {
    current = requireDiagnostics(
      await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
  }
  return current;
}

async function fillReplyDraft(
  url: string,
  options: { banText?: string; durationMinutes?: number; telegramUserId?: string } = {},
): Promise<TestUiDiagnostics> {
  const telegramUserId = options.telegramUserId ?? USER_B_TG;
  const banText = options.banText ?? REPLY_TEXT;
  const durationMinutes = options.durationMinutes ?? REPLY_DURATION;
  requireDiagnostics(await dispatch(url, telegramUserId, "REPLY_BAN.CHANGE_BAN_TEXT", { banText }));
  return requireDiagnostics(
    await dispatch(url, telegramUserId, "REPLY_BAN.CHANGE_DURATION", { durationMinutes }),
  );
}

async function enterFromStatus(
  app: Started,
  telegramUserId: string,
  role: "RECEIVER" | "SENDER",
): Promise<TestUiDiagnostics> {
  const eventName =
    role === "RECEIVER" ? "NOTIFICATIONS.PRESS_REPLY_BAN" : "NOTIFICATIONS.PRESS_BAN_MORE";
  const eventId = role === "RECEIVER" ? "E-14" : "E-18";
  const what = requireDiagnostics(await dispatch(app.url, telegramUserId, eventName));
  expect(what.lastEvent).toEqual({ id: eventId, name: eventName });
  expect(what.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
  expect(what.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
  expect(what.replySource?.kind).toBe("STATUS");
  return what;
}

async function reachReceiverOverboardStatus(app: Started): Promise<{
  ban: BanJson;
  status: TestUiDiagnostics;
  statusItem: NotificationJson;
}> {
  const { ban } = await createRealIncomingFromA(app);
  await session(app.url, USER_B_TG);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  const status = requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
  );
  expect(status.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
  const statusItem = activeStatusItem(status);
  expect(statusItem.banId).toBe(ban.id);
  expect(statusItem.lifecycle.status).toBe("UNPROCESSED");
  return { ban, status, statusItem };
}

async function reachSenderOverboardStatus(app: Started): Promise<{
  ban: BanJson;
  status: TestUiDiagnostics;
  statusItem: NotificationJson;
}> {
  const { ban } = await reachReceiverOverboardStatus(app);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
  await session(app.url, USER_A_TG);
  let opened = await openNotifications(app, USER_A_TG);
  if (opened.controlState === "RIM.LOBBY") {
    opened = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
  }
  expect(opened.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.SENDER");
  const statusItem = activeStatusItem(opened);
  expect(statusItem.banId).toBe(ban.id);
  expect(statusItem.role).toBe("SENDER");
  expect(statusItem.lifecycle.status).toBe("UNPROCESSED");
  return { ban, status: opened, statusItem };
}

async function reachAcceptedSuccess(
  app: Started,
): Promise<{ ban: BanJson; success: TestUiDiagnostics }> {
  const { ban } = await createRealIncomingFromA(app);
  await session(app.url, USER_B_TG);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
  await fillReplyDraft(app.url);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
  const success = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
  expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
  return { ban, success };
}

async function reachTimer(app: Started): Promise<{ ban: BanJson }> {
  const { ban } = await reachAcceptedSuccess(app);
  const timer = requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"),
  );
  expect(timer.controlState).toBe("NOTIFICATIONS.TIMER");
  return { ban };
}

async function expireNow(now: { value: number }, app: Started): Promise<TestUiDiagnostics> {
  now.value += DURATION_MS;
  return snapshot(app.url, USER_B_TG);
}

/** Lands the second-answer user on derived Status (SENDER when A answers second). */
async function reachDerivedStatusAsSender(
  app: Started,
  now: { value: number },
  firstAnswer: string,
  secondAnswer: string,
  expected: string,
): Promise<{ ban: BanJson; status: TestUiDiagnostics; statusItem: NotificationJson }> {
  const { ban } = await reachTimer(app);
  await expireNow(now, app);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
  requireDiagnostics(await dispatch(app.url, USER_B_TG, firstAnswer));
  await session(app.url, USER_A_TG);
  await openNotificationsPastReplyIncoming(app, USER_A_TG);
  const status = requireDiagnostics(await dispatch(app.url, USER_A_TG, secondAnswer));
  expect(pairsOf(status)[0]?.resultingStatus).toBe(expected);
  expect(status.controlState).toBe(`NOTIFICATIONS.STATUS.${expected}.SENDER`);
  const statusItem = activeStatusItem(status);
  expect(statusItem.banId).toBe(ban.id);
  expect(statusItem.lifecycle.status).toBe("UNPROCESSED");
  return { ban, status, statusItem };
}

/** Lands B on derived RECEIVER Status after A answered first. */
async function reachDerivedStatusAsReceiver(
  app: Started,
  now: { value: number },
  firstAnswer: string,
  secondAnswer: string,
  expected: string,
): Promise<{ ban: BanJson; status: TestUiDiagnostics; statusItem: NotificationJson }> {
  const { ban } = await reachTimer(app);
  await expireNow(now, app);
  await session(app.url, USER_A_TG);
  await openNotificationsPastReplyIncoming(app, USER_A_TG);
  requireDiagnostics(await dispatch(app.url, USER_A_TG, firstAnswer));
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
  const status = requireDiagnostics(await dispatch(app.url, USER_B_TG, secondAnswer));
  expect(pairsOf(status)[0]?.resultingStatus).toBe(expected);
  expect(status.controlState).toBe(`NOTIFICATIONS.STATUS.${expected}.RECEIVER`);
  const statusItem = activeStatusItem(status);
  expect(statusItem.banId).toBe(ban.id);
  expect(statusItem.lifecycle.status).toBe("UNPROCESSED");
  return { ban, status, statusItem };
}

/** After A finished second answer on SENDER Status, open B's matching RECEIVER Status. */
async function openReceiverDerivedStatus(
  app: Started,
  expected: string,
): Promise<{ status: TestUiDiagnostics; statusItem: NotificationJson }> {
  await session(app.url, USER_B_TG);
  let opened = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  opened = await drainLeadingOverboardStatuses(app, USER_B_TG, opened);
  expect(opened.controlState).toBe(`NOTIFICATIONS.STATUS.${expected}.RECEIVER`);
  return { status: opened, statusItem: activeStatusItem(opened) };
}

async function reachReplyConfirmFromStatus(
  app: Started,
  telegramUserId: string,
  role: "RECEIVER" | "SENDER",
): Promise<{
  ban: BanJson;
  statusItem: NotificationJson;
  confirm: TestUiDiagnostics;
}> {
  const reached =
    role === "RECEIVER"
      ? await reachReceiverOverboardStatus(app)
      : await reachSenderOverboardStatus(app);
  const what = await enterFromStatus(app, telegramUserId, role);
  expect(what.replySource).toEqual({
    kind: "STATUS",
    itemId: reached.statusItem.id,
    banId: reached.ban.id,
  });
  await fillReplyDraft(app.url, { telegramUserId });
  const confirm = requireDiagnostics(
    await dispatch(app.url, telegramUserId, "REPLY_BAN.PRESS_NEXT"),
  );
  expect(confirm.controlState).toBe("REPLY_BAN.CONFIRM.FROM_STATUS");
  return { ban: reached.ban, statusItem: reached.statusItem, confirm };
}

function applied(snapshot: ProductSnapshot, event: CanonicalEvent) {
  return reduce(snapshot, event, kernelContext());
}

function replyConfirmFromStatusWorld(): ProductSnapshot {
  const source = statusItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } });
  let snapshot = withControlState(emptySnapshot(), "REPLY_BAN.CONFIRM.FROM_STATUS");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        banText: BAN_TEXT,
        durationMinutes: 12 as DurationMinutes,
        acceptance: "PENDING",
        status: "OVERBOARD",
      }),
    },
    notificationItems: { [source.id]: source },
  });
  snapshot = {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      activeNotificationItemId: source.id,
      replyBanDraft: { banText: "reply text", durationMinutes: 15 as DurationMinutes },
      replySource: { kind: "STATUS", itemId: source.id, banId: BAN_ID },
    },
  };
  return withOperation(
    snapshot,
    pendingOp({
      kind: "REPLY_BAN_SEND",
      originatingState: "REPLY_BAN.CONFIRM.FROM_STATUS",
      originatingItemId: source.id,
    }),
  );
}

function assertEnteredRb04(
  what: TestUiDiagnostics,
  ban: BanJson,
  statusItem: NotificationJson,
  expectedState: string,
) {
  expect(what.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
  expect(what.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
  expect(what.replySource).toEqual({
    kind: "STATUS",
    itemId: statusItem.id,
    banId: ban.id,
  });
  expect(statusItemsOf(what).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
    "UNPROCESSED",
  );
  expect(what.controlState).not.toBe(expectedState);
}

describe("Stage 10 Reply Ban FROM_STATUS vertical", () => {
  it("keeps frozen 30 / 59 / 359 and REPLY_BAN_FROM_STATUS_STAGE = 10", async () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(APPLICATION_STAGE).toBe(5);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(INCOMING_OVERBOARD_STAGE).toBe(7);
    expect(REPLY_BAN_FROM_INCOMING_STAGE).toBe(8);
    expect(TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(REPLY_BAN_FROM_STATUS_STAGE).toBe(10);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
    expect(STAGE_9_EXCLUDES).toContain("reply-ban-from-status");
    expect(STAGE_8_EXCLUDES).toContain("reply-ban-from-status");
    expect(STAGE_10_EXCLUDES).not.toContain("reply-ban-from-status");
    const app = await start();
    const meta = await fetch(`${app.url}/api/meta`);
    const body = (await meta.json()) as {
      REPLY_BAN_FROM_STATUS_STAGE: number;
      STAGE_9_EXCLUDES: readonly string[];
      STAGE_10_EXCLUDES: readonly string[];
    };
    expect(body.REPLY_BAN_FROM_STATUS_STAGE).toBe(10);
    expect(body.STAGE_9_EXCLUDES).toContain("reply-ban-from-status");
    expect(body.STAGE_10_EXCLUDES).not.toContain("reply-ban-from-status");
    const screens = await fetch(`${app.url}/test-ui/product-screens.js`);
    const source = await screens.text();
    expect(source).toContain("REPLY_BAN.WHAT.FROM_STATUS");
    expect(source).toContain("PRESS_BAN_MORE");
  });

  it("all 8 Status entries → RB-04 with STATUS source and fresh draft", async () => {
    {
      const app = await start();
      const { ban, status, statusItem } = await reachReceiverOverboardStatus(app);
      expect(status.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
      assertEnteredRb04(
        await enterFromStatus(app, USER_B_TG, "RECEIVER"),
        ban,
        statusItem,
        status.controlState!,
      );
    }
    {
      const app = await start();
      const { ban, status, statusItem } = await reachSenderOverboardStatus(app);
      expect(status.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.SENDER");
      assertEnteredRb04(
        await enterFromStatus(app, USER_A_TG, "SENDER"),
        ban,
        statusItem,
        status.controlState!,
      );
    }

    const derivedSender: Array<{
      first: string;
      second: string;
      status: string;
    }> = [
      {
        first: "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
        second: "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
        status: "BANTASTIC",
      },
      {
        first: "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
        second: "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
        status: "BANFLICT",
      },
      {
        first: "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
        second: "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
        status: "FAIR_ENOUGH",
      },
    ];

    for (const row of derivedSender) {
      const now = { value: AUTHORITATIVE_NOW };
      const app = await start(clockAt(now));
      const { ban, status, statusItem } = await reachDerivedStatusAsSender(
        app,
        now,
        row.first,
        row.second,
        row.status,
      );
      expect(status.controlState).toBe(`NOTIFICATIONS.STATUS.${row.status}.SENDER`);
      assertEnteredRb04(
        await enterFromStatus(app, USER_A_TG, "SENDER"),
        ban,
        statusItem,
        status.controlState!,
      );
    }

    for (const row of derivedSender) {
      const now = { value: AUTHORITATIVE_NOW };
      const app = await start(clockAt(now));
      const { ban, status, statusItem } = await reachDerivedStatusAsReceiver(
        app,
        now,
        row.first,
        row.second,
        row.status,
      );
      expect(status.controlState).toBe(`NOTIFICATIONS.STATUS.${row.status}.RECEIVER`);
      assertEnteredRb04(
        await enterFromStatus(app, USER_B_TG, "RECEIVER"),
        ban,
        statusItem,
        status.controlState!,
      );
    }

    {
      const now = { value: AUTHORITATIVE_NOW };
      const app = await start(clockAt(now));
      await reachDerivedStatusAsSender(
        app,
        now,
        "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
        "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
        "BANTASTIC",
      );
      const { status, statusItem } = await openReceiverDerivedStatus(app, "BANTASTIC");
      const ban = bansOf(status).find((item) => item.id === statusItem.banId)!;
      assertEnteredRb04(
        await enterFromStatus(app, USER_B_TG, "RECEIVER"),
        ban,
        statusItem,
        status.controlState!,
      );
    }
  }, 15_000);

  it("validation stays RB-04; valid Next → RB-05; Back preserves/clears draft", async () => {
    const app = await start();
    const { ban, statusItem } = await reachReceiverOverboardStatus(app);
    await enterFromStatus(app, USER_B_TG, "RECEIVER");
    const empty = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    expect(empty.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    expect(empty.matrixResult).toBe("IGNORE_NOT_ALLOWED");
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT }),
    );
    const badDuration = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"),
    );
    expect(badDuration.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    await fillReplyDraft(app.url);
    const confirm = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    expect(confirm.controlState).toBe("REPLY_BAN.CONFIRM.FROM_STATUS");
    expect(confirm.replyBanDraft).toEqual({
      banText: REPLY_TEXT,
      durationMinutes: REPLY_DURATION,
    });
    const backToWhat = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK"),
    );
    expect(backToWhat.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    expect(backToWhat.replyBanDraft).toEqual({
      banText: REPLY_TEXT,
      durationMinutes: REPLY_DURATION,
    });
    const backToStatus = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK"),
    );
    expect(backToStatus.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(backToStatus.replyBanDraft).toBeNull();
    expect(backToStatus.activeNotificationItemId).toBe(statusItem.id);
    expect(
      statusItemsOf(backToStatus).find((item) => item.id === statusItem.id)?.lifecycle.status,
    ).toBe("UNPROCESSED");
    expect(bansOf(backToStatus).find((item) => item.id === ban.id)?.status).toBe("OVERBOARD");
  });

  it("E-28 pending blocks duplicate/Back; E-31 fail-once preserves draft then retry succeeds", async () => {
    {
      const app = await start();
      await reachReplyConfirmFromStatus(app, USER_B_TG, "RECEIVER");
      const context = await authenticateRuntime(app.runtime, {
        method: "development",
        secret: DEV_SECRET,
        telegramUserId: USER_B_TG,
      });
      const press = await executeAuthenticatedEvent(app.runtime, context, {
        name: "REPLY_BAN.PRESS_FORBID",
        payload: {},
      });
      expect(press.status).toBe("APPLIED");
      expect(press.controlState).toBe("REPLY_BAN.CONFIRM.FROM_STATUS");
      const pending = Object.values(press.snapshot.runtime.pendingOperations).find(
        (operation) => operation.kind === "REPLY_BAN_SEND",
      );
      expect(pending?.resultApplied).toBe(false);
      const duplicate = await executeAuthenticatedEvent(app.runtime, context, {
        name: "REPLY_BAN.PRESS_FORBID",
        payload: {},
      });
      expect(duplicate.status).not.toBe("APPLIED");
      const back = await executeAuthenticatedEvent(app.runtime, context, {
        name: "REPLY_BAN.PRESS_BACK",
        payload: {},
      });
      expect(back.status).not.toBe("APPLIED");
      expect(back.snapshot.controlState).toBe("REPLY_BAN.CONFIRM.FROM_STATUS");
    }

    {
      const runtime = createCreateBanContactRuntime({ replyBanCompletion: "fail-once" });
      const app = await start(runtime);
      const { ban, statusItem } = await reachReplyConfirmFromStatus(app, USER_B_TG, "RECEIVER");
      const failed = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
      const afterFail = requireDiagnostics(failed);
      expect(failed.orchestration?.serverEvent.eventName).toBe("REPLY_BAN.SEND_FAILED");
      expect(afterFail.controlState).toBe("REPLY_BAN.CONFIRM.FROM_STATUS");
      expect(afterFail.replyBanDraft).toEqual({
        banText: REPLY_TEXT,
        durationMinutes: REPLY_DURATION,
      });
      expect(bansOf(afterFail).every((item) => item.banText !== REPLY_TEXT)).toBe(true);
      expect(
        statusItemsOf(afterFail).find((item) => item.id === statusItem.id)?.lifecycle.status,
      ).toBe("UNPROCESSED");
      expect(bansOf(afterFail).find((item) => item.id === ban.id)?.status).toBe("OVERBOARD");
      const retry = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
      const success = requireDiagnostics(retry);
      expect(retry.orchestration?.serverEvent.eventName).toBe("REPLY_BAN.SEND_CONFIRMED");
      expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
      expect(success.replyBanDraft).toBeNull();
    }
  });

  it("E-30 FROM_STATUS: RB-06, PROCESSED Status, one reply Ban/Incoming, no source Timer churn", async () => {
    const runtime = createCreateBanContactRuntime({
      clock: { nowMs: () => AUTHORITATIVE_NOW },
    });
    const app = await start(runtime);
    const { ban: unrelated } = await createRealIncomingFromA(app, {
      banText: "unrelated timer ban",
      durationMinutes: BAN_DURATION,
    });
    const { ban } = await createRealIncomingFromA(app, {
      banText: "status source ban",
      durationMinutes: 8,
    });

    await session(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    expect(incomingOf(await snapshot(app.url, USER_B_TG))[0]?.banId).toBe(unrelated.id);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
    await fillReplyDraft(app.url, { banText: "unrelated reply", durationMinutes: REPLY_DURATION });
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"));
    const beforeUnrelatedTimers = timerItemsOf(await snapshot(app.url, USER_B_TG)).filter(
      (item) => item.banId === unrelated.id,
    );
    const beforeUnrelatedDomain = domainTimersOf(await snapshot(app.url, USER_B_TG)).filter(
      (timer) => timer.banId === unrelated.id,
    );
    expect(beforeUnrelatedTimers).toHaveLength(1);
    expect(beforeUnrelatedDomain).toHaveLength(1);

    const opened = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(opened.activeNotificationItemId).toBe(
      incomingOf(opened).find((item) => item.banId === ban.id)?.id,
    );
    const status = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(status.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const statusItem = activeStatusItem(status);
    expect(statusItem.banId).toBe(ban.id);

    await enterFromStatus(app, USER_B_TG, "RECEIVER");
    await fillReplyDraft(app.url);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    const beforeTimers = timerItemsOf(await snapshot(app.url, USER_B_TG)).filter(
      (item) => item.banId === ban.id,
    );
    const beforeDomain = domainTimersOf(await snapshot(app.url, USER_B_TG)).filter(
      (timer) => timer.banId === ban.id,
    );
    expect(beforeTimers).toHaveLength(0);
    expect(beforeDomain).toHaveLength(0);

    const forbid = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const success = requireDiagnostics(forbid);
    expect(forbid.orchestration?.userEvent.eventName).toBe("REPLY_BAN.PRESS_FORBID");
    expect(forbid.orchestration?.serverEvent.eventName).toBe("REPLY_BAN.SEND_CONFIRMED");
    expect(success.previousEvent).toEqual({ id: "E-28", name: "REPLY_BAN.PRESS_FORBID" });
    expect(success.lastEvent).toEqual({ id: "E-30", name: "REPLY_BAN.SEND_CONFIRMED" });
    expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
    expect(success.replyBanDraft).toBeNull();
    expect(statusItemsOf(success).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
      "PROCESSED",
    );
    const replies = bansOf(success).filter(
      (item) => item.banText === REPLY_TEXT && item.id !== ban.id && item.id !== unrelated.id,
    );
    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.senderId).toBe(success.currentUserId);
    expect(reply.receiverId).toBe(ban.senderId);
    expect(reply.acceptance).toBe("PENDING");
    expect(timerItemsOf(success).filter((item) => item.banId === ban.id)).toHaveLength(
      beforeTimers.length,
    );
    expect(domainTimersOf(success).filter((timer) => timer.banId === ban.id)).toHaveLength(
      beforeDomain.length,
    );
    expect(
      timerItemsOf(success).some(
        (item) => item.banId === ban.id && success.priorities.timerItemId === item.id,
      ),
    ).toBe(false);
    expect(timerItemsOf(success).filter((item) => item.banId === unrelated.id)).toHaveLength(
      beforeUnrelatedTimers.length,
    );
    expect(domainTimersOf(success).filter((timer) => timer.banId === unrelated.id)).toHaveLength(
      beforeUnrelatedDomain.length,
    );

    const reloadedA = await snapshot(app.url, USER_A_TG);
    const replyIncoming = itemsOf(reloadedA).filter(
      (item) => item.kind === "INCOMING_BAN" && item.banId === reply.id,
    );
    expect(replyIncoming).toHaveLength(1);
    expect(replyIncoming[0]?.ownerId).toBe(reloadedA.currentUserId);
    expect(replyIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
  });

  it("duplicate E-30 and stale A/B correlation do not invent second reply Ban", async () => {
    const app = await start();
    await reachReplyConfirmFromStatus(app, USER_B_TG, "RECEIVER");
    const first = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const success = requireDiagnostics(first);
    const operationId = first.orchestration?.userEvent.correlatedOperationId;
    expect(operationId).toBeTruthy();
    const replyCount = bansOf(success).filter((item) => item.banText === REPLY_TEXT).length;
    expect(replyCount).toBe(1);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const duplicate = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId,
        replyBanId: "ban-duplicate",
        source: success.replySource,
      },
    });
    expect(duplicate.outcome).not.toBe("APPLIED");
    expect(
      Object.values(duplicate.snapshot.extended.entities.bans).filter(
        (ban) => ban.banText === REPLY_TEXT,
      ),
    ).toHaveLength(1);

    const app2 = await start();
    await reachReplyConfirmFromStatus(app2, USER_B_TG, "RECEIVER");
    const context2 = await authenticateRuntime(app2.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const pressA = await executeAuthenticatedEvent(app2.runtime, context2, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    const opA = Object.values(pressA.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    await executeAuthenticatedEvent(app2.runtime, context2, {
      name: "REPLY_BAN.SEND_FAILED",
      payload: { operationId: opA!.operationId, failure: { code: "REPLY_BAN_SEND_FAILED" } },
    });
    const pressB = await executeAuthenticatedEvent(app2.runtime, context2, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    const opB = Object.values(pressB.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    expect(opB?.operationId).not.toBe(opA?.operationId);
    const staleSuccess = await executeAuthenticatedEvent(app2.runtime, context2, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId: opA!.operationId,
        replyBanId: "ban-stale-a",
        source: pressB.snapshot.extended.replySource,
      },
    });
    expect(staleSuccess.outcome).not.toBe("APPLIED");
    const confirmedB = await executeAuthenticatedEvent(app2.runtime, context2, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId: opB!.operationId,
        replyBanId: "ban-attempt-b",
        source: pressB.snapshot.extended.replySource,
      },
    });
    expect(confirmedB.status).toBe("APPLIED");
    expect(confirmedB.controlState).toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
    expect(confirmedB.snapshot.extended.entities.bans["ban-attempt-b" as never]).toBeTruthy();
    expect(confirmedB.snapshot.extended.entities.bans["ban-stale-a" as never]).toBeUndefined();
  });

  it("FULL_CLOSE + late E-30 (HTTP) and External Entry late E-30 (Kernel) keep facts without Success UI", async () => {
    const app = await start();
    const { statusItem } = await reachReplyConfirmFromStatus(app, USER_B_TG, "RECEIVER");
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const startedSend = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    expect(startedSend.status).toBe("APPLIED");
    const pending = Object.values(startedSend.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    expect(pending?.resultApplied).toBe(false);
    const closed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.FULL_CLOSE",
      payload: {},
    });
    expect(closed.status).toBe("APPLIED");
    expect(closed.snapshot.controlState).toBeNull();
    expect(closed.snapshot.extended.replyBanDraft).toBeNull();
    const beforeLate = await app.runtime.productStore.loadProductSnapshot(context.currentUserId);
    const reloadedPending = Object.values(beforeLate.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    const late = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId: reloadedPending?.operationId,
        replyBanId: "ban-reply-status",
        source: beforeLate.snapshot.extended.replySource,
      },
    });
    expect(late.status).toBe("APPLIED");
    expect(late.snapshot.controlState).toBeNull();
    expect(late.snapshot.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
    expect(late.snapshot.extended.replyBanDraft).toBeNull();
    expect(late.snapshot.extended.entities.notificationItems[statusItem.id]?.lifecycle.status).toBe(
      "PROCESSED",
    );
    expect(late.snapshot.extended.entities.bans["ban-reply-status" as never]).toBeTruthy();
    expect(
      Object.values(late.snapshot.extended.entities.domainTimers).filter(
        (timer) => timer.banId === beforeLate.snapshot.extended.replySource?.banId,
      ),
    ).toHaveLength(0);
    const opened = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.NORMAL_OPEN",
      payload: { serverState: {} },
    });
    expect(opened.snapshot.controlState).toBe("RIM.LOBBY");
    expect(opened.snapshot.extended.replyBanDraft).toBeNull();

    // Kernel path: Stage 10 API composition excludes external-entry; late E-45 displacement via reduce.
    const displaced = {
      ...replyConfirmFromStatusWorld(),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const lateKernel = withOperation(
      displaced,
      pendingOp({
        kind: "REPLY_BAN_SEND",
        originatingState: "REPLY_BAN.CONFIRM.FROM_STATUS",
        originatingItemId: STATUS_ITEM_ID,
        supersededByExternalEntry: true,
      }),
    );
    const result = applied(
      lateKernel,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "STATUS", itemId: STATUS_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
    expect(result.snapshot.extended.entities.bans[REPLY_BAN_ID]?.banText).toBe("reply text");
    expect(
      result.snapshot.extended.entities.notificationItems[STATUS_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(Object.values(result.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(result.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
  });

  it("cross-user reload + receiver non-displacement; reply-of-reply Incoming Y still E-14/E-15", async () => {
    const app = await start();
    const beforeA = await (async () => {
      await createRealIncomingFromA(app);
      return snapshot(app.url, USER_A_TG);
    })();
    expect(beforeA.controlState).toBe("CREATE_BAN.SUCCESS");
    const beforeActive = beforeA.activeNotificationItemId;
    await session(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
    await enterFromStatus(app, USER_B_TG, "RECEIVER");
    await fillReplyDraft(app.url);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
    const reply = bansOf(success).find((item) => item.banText === REPLY_TEXT)!;
    const afterA = await snapshot(app.url, USER_A_TG);
    expect(afterA.controlState).toBe(beforeA.controlState);
    expect(afterA.activeNotificationItemId).toBe(beforeActive);
    const waiting = itemsOf(afterA).filter(
      (item) => item.kind === "INCOMING_BAN" && item.banId === reply.id,
    );
    expect(waiting).toHaveLength(1);
    expect(afterA.activeNotificationItemId).not.toBe(waiting[0]?.id);

    const reloadedB = await snapshot(app.url, USER_B_TG);
    expect(reloadedB.controlState).toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
    expect(reloadedB.replyBanDraft).toBeNull();
    expect(bansOf(reloadedB).some((item) => item.id === reply.id)).toBe(true);

    await session(app.url, USER_A_TG);
    let opened = await openNotifications(app, USER_A_TG);
    if (opened.controlState === "RIM.LOBBY") {
      opened = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    while (
      opened.controlState?.startsWith("NOTIFICATIONS.STATUS") &&
      opened.controlState !== "NOTIFICATIONS.INCOMING_BAN"
    ) {
      opened = requireDiagnostics(
        await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
      );
    }
    if (opened.controlState === "RIM.LOBBY") {
      opened = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(opened.activeNotificationItemId).toBe(
      itemsOf(opened).find((item) => item.kind === "INCOMING_BAN" && item.banId === reply.id)?.id,
    );
    const what = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(what.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(what.replySource?.banId).toBe(reply.id);
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "REPLY_BAN.PRESS_BACK"));
    const overboard = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(overboard.previousEvent).toEqual({ id: "E-15", name: "NOTIFICATIONS.PRESS_OVERBOARD" });
  });

  it("RB-06 E-29: non-empty queue uses E-43; empty → LOBBY", async () => {
    {
      const app = await start();
      await reachReplyConfirmFromStatus(app, USER_B_TG, "RECEIVER");
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
      const left = requireDiagnostics(
        await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"),
      );
      expect(left.controlState).toBe("RIM.LOBBY");
    }
    {
      const app = await start();
      await createRealIncomingFromA(app, { banText: "queued ban", durationMinutes: 9 });
      await createRealIncomingFromA(app, { banText: "status ban", durationMinutes: 8 });
      await session(app.url, USER_B_TG);
      const first = requireDiagnostics(
        await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"),
      );
      expect(first.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      const firstBanId = incomingOf(first)[0]?.banId;
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
      await enterFromStatus(app, USER_B_TG, "RECEIVER");
      await fillReplyDraft(app.url);
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
      const next = requireDiagnostics(
        await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"),
      );
      expect(next.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(next.activeNotificationItemId).toBeTruthy();
      const activeIncoming = incomingOf(next).find(
        (item) => item.id === next.activeNotificationItemId,
      );
      expect(activeIncoming?.banId).not.toBe(firstBanId);
      expect(activeIncoming?.lifecycle.status).toBe("UNPROCESSED");
      // E-29 empty/non-empty: non-empty queue continues via Notifications SELECT_NEXT (E-43).
      expect(
        [next.lastEvent?.id, next.previousEvent?.id].some((id) => id === "E-29" || id === "E-43"),
      ).toBe(true);
    }
  });

  it("multi-Ban binding: active Status Ban B binds on E-14/E-18; E-19 processes Status without Reply Ban draft", async () => {
    const app = await start();
    const banA = (
      await createRealIncomingFromA(app, { banText: "Ban A first", durationMinutes: 7 })
    ).ban;
    const banB = (
      await createRealIncomingFromA(app, { banText: "Ban B active", durationMinutes: 8 })
    ).ban;
    expect(banA.id).not.toBe(banB.id);
    await session(app.url, USER_B_TG);
    let opened = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingOf(opened)[0]?.banId).toBe(banA.id);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    opened = await snapshot(app.url, USER_B_TG);
    if (opened.controlState === "RIM.LOBBY") {
      opened = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(opened.activeNotificationItemId).toBe(
      incomingOf(opened).find((item) => item.banId === banB.id)?.id,
    );
    const status = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(status.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const statusItem = activeStatusItem(status);
    expect(statusItem.banId).toBe(banB.id);
    const what = await enterFromStatus(app, USER_B_TG, "RECEIVER");
    expect(what.replySource).toEqual({
      kind: "STATUS",
      itemId: statusItem.id,
      banId: banB.id,
    });
    expect(what.replySource?.banId).not.toBe(banA.id);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK"));

    const again = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(again.controlState).toBe("RIM.LOBBY");
    expect(again.replyBanDraft).toBeNull();
    expect(statusItemsOf(again).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
      "PROCESSED",
    );
    expect(again.controlState).not.toBe("REPLY_BAN.WHAT.FROM_STATUS");

    await session(app.url, USER_A_TG);
    let sender = await openNotifications(app, USER_A_TG);
    if (sender.controlState === "RIM.LOBBY") {
      sender = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    while (
      sender.controlState === "NOTIFICATIONS.STATUS.OVERBOARD.SENDER" &&
      activeStatusItem(sender).banId !== banB.id
    ) {
      sender = requireDiagnostics(
        await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
      );
    }
    expect(sender.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.SENDER");
    const senderStatus = activeStatusItem(sender);
    expect(senderStatus.banId).toBe(banB.id);
    const senderWhat = await enterFromStatus(app, USER_A_TG, "SENDER");
    expect(senderWhat.replySource).toEqual({
      kind: "STATUS",
      itemId: senderStatus.id,
      banId: banB.id,
    });
    expect(senderWhat.replySource?.banId).not.toBe(banA.id);
  });

  it("Stage 8/9 regression smoke: FROM_INCOMING E-30 still creates Timer; Stage 9 meta stays 9", async () => {
    expect(TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(STAGE_9_EXCLUDES).toContain("reply-ban-from-status");
    expect(STAGE_9_EXCLUDES).not.toContain("timer-processing");
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    await session(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect((await snapshot(app.url, USER_B_TG)).controlState).toBe(
      "REPLY_BAN.WHAT.FROM_INCOMING_BAN",
    );
    await fillReplyDraft(app.url);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(timerItemsOf(success).filter((item) => item.banId === ban.id)).toHaveLength(1);
    expect(domainTimersOf(success).filter((timer) => timer.banId === ban.id)).toHaveLength(1);
  });
});
