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
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  STAGE_6_EXCLUDES,
  STAGE_7_EXCLUDES,
} from "./index.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  seedRegisteredUsers,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import type { ContactSendOrchestration } from "./contact-send.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const BAN_TEXT = "не пропускай зал";
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
    runtime === undefined ? {} : { runtime, seedTelegramUserIds: [] },
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
  extras: { clientClaimedUserId?: string } = {},
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
    body: JSON.stringify({
      name,
      payload,
      ...(extras.clientClaimedUserId === undefined
        ? {}
        : { clientClaimedUserId: extras.clientClaimedUserId }),
    }),
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
  lifecycle: { status: string; display?: string };
};

function bansOf(diagnostics: TestUiDiagnostics): BanJson[] {
  return diagnostics.bans as BanJson[];
}

function incomingOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return diagnostics.incomingItems as NotificationJson[];
}

function itemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return diagnostics.notificationItems as NotificationJson[];
}

function timerItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "TIMER");
}

function statusItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "STATUS");
}

function overboardOperationsOf(diagnostics: TestUiDiagnostics) {
  return Object.values(diagnostics.pendingOperations).filter(
    (operation) => operation.kind === "OVERBOARD",
  );
}

async function reachConfirm(url: string, app: Started): Promise<{ bId: string }> {
  await session(url, USER_A_TG);
  await session(url, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  const opened = await session(url, USER_A_TG);
  expect(opened.controlState).toBe("RIM.LOBBY");
  const who = requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  expect(who.controlState).toBe("CREATE_BAN.WHO");
  const listed = who.contacts.find((contact) => contact.telegramUserId === USER_B_TG);
  const bId = listed?.userId ?? userIdOf(app.runtime, USER_B_TG);
  expect(bId).toBeTruthy();
  const what = requireDiagnostics(
    await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  expect(what.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  const confirm = requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
  return { bId: bId! };
}

async function createRealIncomingFromA(app: Started): Promise<{
  a: TestUiDiagnostics;
  bId: string;
  ban: BanJson;
}> {
  const { bId } = await reachConfirm(app.url, app);
  const forbid = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  const a = requireDiagnostics(forbid);
  expect(forbid.orchestration).not.toBeNull();
  expect(a.controlState).toBe("CREATE_BAN.SUCCESS");
  const created = bansOf(a);
  expect(created).toHaveLength(1);
  return { a, bId, ban: created[0]! };
}

async function openIncomingAsB(app: Started): Promise<{
  lobby: TestUiDiagnostics;
  incoming: TestUiDiagnostics;
  incomingItem: NotificationJson;
}> {
  const lobby = await session(app.url, USER_B_TG);
  expect(lobby.controlState).toBe("RIM.LOBBY");
  const opened = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  const incomingItem = incomingOf(opened)[0];
  expect(incomingItem).toBeTruthy();
  return { lobby, incoming: opened, incomingItem: incomingItem! };
}

describe("Stage 7 Notifications Incoming Ban OVERBOARD vertical", () => {
  it("keeps frozen 30 / 60 / 360 and adds INCOMING_OVERBOARD_STAGE = 7 only", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(APPLICATION_STAGE).toBe(5);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(INCOMING_OVERBOARD_STAGE).toBe(7);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
    expect(STAGE_6_EXCLUDES).toContain("incoming-ban-processing-ui");
    expect(STAGE_7_EXCLUDES).not.toContain("incoming-ban-processing-ui");
    expect(STAGE_7_EXCLUDES).not.toContain("overboard-action");
    expect(STAGE_7_EXCLUDES).toContain("reply-ban-from-incoming-ban");
    expect(STAGE_7_EXCLUDES).not.toContain("status-processing");
    expect(STAGE_7_EXCLUDES).toContain("reply-ban-from-status");
    expect(STAGE_7_EXCLUDES).toContain("timer-processing");
    expect(STAGE_7_EXCLUDES).toContain("check");
  });

  it("A–C. Stage 6 User A creates a real PENDING CONTACT Ban and User B owns durable Incoming", async () => {
    const e60 = MATRIX_CONTRACT_ROWS.filter(
      (row) => row.state === "RIM.LOBBY" && row.eventName === "RIM.PRESS_NOTIFICATIONS",
    );
    expect(e60).toHaveLength(1);
    expect(e60[0]).toMatchObject({
      eventId: "E-60",
      branch: "unprocessed-items-exist",
      nextState: "RESULT_OF_NOTIFICATIONS_SELECT_NEXT",
    });
    const app = await start();
    const { a, bId, ban } = await createRealIncomingFromA(app);
    expect(a.currentUserId).not.toBe(USER_A_TG);
    expect(ban.senderId).toBe(a.currentUserId);
    expect(ban.receiverId).toBe(bId);
    expect(ban.acceptance).toBe("PENDING");
    expect(ban.status).toBeNull();
    const asB = await session(app.url, USER_B_TG);
    expect(asB.currentUserId).toBe(bId);
    expect(asB.currentUserId).not.toBe(USER_B_TG);
    expect(incomingOf(asB)).toHaveLength(1);
    expect(incomingOf(asB)[0]?.ownerId).toBe(bId);
    expect(incomingOf(asB)[0]?.banId).toBe(ban.id);
    expect(incomingOf(asB)[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    const reloaded = await snapshot(app.url, USER_B_TG);
    expect(incomingOf(reloaded)).toHaveLength(1);
    expect(incomingOf(reloaded)[0]?.id).toBe(incomingOf(asB)[0]?.id);
  });

  it("D / E. Notifications entry exists only when the frozen queue condition is satisfied", async () => {
    const app = await start();
    const { a } = await createRealIncomingFromA(app);
    expect(a.hasUnprocessedNotifications).toBe(false);
    const asB = await session(app.url, USER_B_TG);
    expect(asB.hasUnprocessedNotifications).toBe(true);
    const screens = await fetch(`${app.url}/test-ui/product-screens.js`);
    const source = await screens.text();
    expect(source).toContain("hasUnprocessedNotifications");
    expect(source).toContain("RIM.PRESS_NOTIFICATIONS");
  });

  it("F–I. User B Notifications uses E-60 then Kernel E-43 fifo-incoming-ban", async () => {
    const fifo = MATRIX_CONTRACT_ROWS.find(
      (row) => row.eventName === "NOTIFICATIONS.SELECT_NEXT" && row.branch === "fifo-incoming-ban",
    );
    expect(fifo).toMatchObject({
      eventId: "E-43",
      nextState: "NOTIFICATIONS.INCOMING_BAN",
    });
    const app = await start();
    const { ban, bId } = await createRealIncomingFromA(app);
    const { lobby, incoming, incomingItem } = await openIncomingAsB(app);
    expect(lobby.hasUnprocessedNotifications).toBe(true);
    expect(incoming.lastEvent).toEqual({ id: "E-60", name: "RIM.PRESS_NOTIFICATIONS" });
    expect(incoming.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incoming.kernelOutcome).toBe("APPLIED");
    expect(incoming.persisted).toBe(true);
    expect(incoming.activeNotificationItemId).toBe(incomingItem.id);
    expect(incomingItem.ownerId).toBe(bId);
    expect(incomingItem.banId).toBe(ban.id);
    expect(incomingItem.lifecycle.status).toBe("UNPROCESSED");
    expect(incomingOf(incoming)).toHaveLength(1);
    expect(incoming.priorities.statusItemId).toBeNull();
    expect(incoming.priorities.timerItemId).toBeNull();
  });

  it("G / Y. selection is not a frontend FIFO and no parallel navigation state exists", async () => {
    const screensPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../miniapp/src/test-ui/product-screens.ts",
    );
    const htmlPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../miniapp/src/test-ui.html",
    );
    const screens = readFileSync(screensPath, "utf8");
    const html = readFileSync(htmlPath, "utf8");
    expect(screens).toContain("only screen selector");
    expect(screens).not.toContain("fifoSequence");
    expect(screens).not.toContain("history.pushState");
    expect(screens).not.toContain("currentScreen");
    expect(html).not.toContain("history.pushState");
    expect(html).not.toContain("localStorage");
    expect(html).toContain('data-nav="controlState"');
  });

  it("K–R. OVERBOARD is E-15 then backend E-20 to N-05 with frozen Ban/lifecycle facts", async () => {
    const e15 = MATRIX_CONTRACT_ROWS.find(
      (row) =>
        row.state === "NOTIFICATIONS.INCOMING_BAN" &&
        row.eventName === "NOTIFICATIONS.PRESS_OVERBOARD",
    );
    const e20 = MATRIX_CONTRACT_ROWS.find(
      (row) =>
        row.state === "NOTIFICATIONS.INCOMING_BAN" &&
        row.eventName === "NOTIFICATIONS.OVERBOARD_CONFIRMED",
    );
    expect(e15).toMatchObject({
      eventId: "E-15",
      nextState: "NOTIFICATIONS.INCOMING_BAN",
      result: "STAY",
    });
    expect(e20).toMatchObject({
      eventId: "E-20",
      nextState: "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER",
    });
    const app = await start();
    const { ban, bId } = await createRealIncomingFromA(app);
    const { incoming, incomingItem } = await openIncomingAsB(app);
    expect(incomingItem.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    const pressed = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    const result = requireDiagnostics(pressed);
    expect(pressed.orchestration).not.toBeNull();
    expect(pressed.orchestration?.userEvent.eventName).toBe("NOTIFICATIONS.PRESS_OVERBOARD");
    expect(pressed.orchestration?.userEvent.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(pressed.orchestration?.userEvent.correlatedOperationId).toBeTruthy();
    expect(pressed.orchestration?.serverEvent.eventName).toBe("NOTIFICATIONS.OVERBOARD_CONFIRMED");
    expect(pressed.orchestration?.serverEvent.correlatedOperationId).toBe(
      pressed.orchestration?.userEvent.correlatedOperationId,
    );
    expect(result.lastEvent).toEqual({
      id: "E-20",
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
    });
    expect(result.previousEvent).toEqual({
      id: "E-15",
      name: "NOTIFICATIONS.PRESS_OVERBOARD",
    });
    expect(result.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(result.kernelOutcome).toBe("APPLIED");
    expect(result.persisted).toBe(true);
    const afterBan = bansOf(result)[0];
    expect(afterBan?.id).toBe(ban.id);
    expect(afterBan?.acceptance).toBe("PENDING");
    expect(afterBan?.status).toBe("OVERBOARD");
    expect(afterBan?.senderId).toBe(ban.senderId);
    expect(afterBan?.receiverId).toBe(bId);
    const processedIncoming = incomingOf(result).find((item) => item.id === incomingItem.id);
    expect(processedIncoming?.lifecycle).toEqual({ status: "PROCESSED" });
    expect(incomingOf(result)).toHaveLength(1);
    expect(result.domainTimers).toEqual([]);
    expect(result.checkPairs).toEqual([]);
    expect(timerItemsOf(result)).toEqual([]);
    const statuses = statusItemsOf(result);
    const receiverStatus = statuses.find((item) => item.role === "RECEIVER");
    expect(receiverStatus?.ownerId).toBe(bId);
    expect(receiverStatus?.status).toBe("OVERBOARD");
    expect(statuses.filter((item) => item.ownerId === bId)).toHaveLength(1);
    expect(result.priorities.statusItemId).toBe(receiverStatus?.id);
    expect(result.priorities.timerItemId).toBeNull();
    expect(result.activeNotificationItemId).toBe(receiverStatus?.id);
    expect(result.activeNotificationItemId).toBe(result.priorities.statusItemId);
    expect(itemsOf(result).some((item) => item.id === result.activeNotificationItemId)).toBe(true);
    expect(incoming.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const overboard = overboardOperationsOf(result);
    expect(overboard).toHaveLength(1);
    expect(overboard[0]?.operationId).toBe(pressed.orchestration?.userEvent.correlatedOperationId);
    expect(overboard[0]?.kind).toBe("OVERBOARD");
    expect(overboard[0]?.originatingItemId).toBe(incomingItem.id);
    expect(overboard[0]?.resultApplied).toBe(true);
    expect(overboard[0]?.originatingState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(overboard[0]?.supersededByExternalEntry).toBe(false);
  });

  it("E-15 then E-20 retains the same OVERBOARD operation with resultApplied true across persist/reload", async () => {
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    const { incomingItem } = await openIncomingAsB(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const press = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.PRESS_OVERBOARD",
      payload: {},
    });
    expect(press.status).toBe("APPLIED");
    expect(press.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const started = Object.values(press.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "OVERBOARD",
    );
    expect(started?.resultApplied).toBe(false);
    expect(started?.originatingItemId).toBe(incomingItem.id);
    expect(press.persisted).toBe(true);
    const persistedPress = await snapshot(app.url, USER_B_TG);
    expect(overboardOperationsOf(persistedPress)).toHaveLength(1);
    expect(overboardOperationsOf(persistedPress)[0]?.operationId).toBe(started?.operationId);
    expect(overboardOperationsOf(persistedPress)[0]?.resultApplied).toBe(false);
    const confirmed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      payload: {
        operationId: started!.operationId,
        sourceItemId: incomingItem.id,
        banId: ban.id,
      },
    });
    expect(confirmed.status).toBe("APPLIED");
    expect(confirmed.outcome).toBe("APPLIED");
    expect(confirmed.persisted).toBe(true);
    expect(confirmed.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const afterReduce = confirmed.snapshot.runtime.pendingOperations[started!.operationId];
    expect(afterReduce).toMatchObject({
      operationId: started!.operationId,
      kind: "OVERBOARD",
      originatingItemId: incomingItem.id,
      originatingState: "NOTIFICATIONS.INCOMING_BAN",
      resultApplied: true,
      supersededByExternalEntry: false,
    });
    const persisted = await snapshot(app.url, USER_B_TG);
    expect(overboardOperationsOf(persisted)[0]?.operationId).toBe(started?.operationId);
    expect(overboardOperationsOf(persisted)[0]?.resultApplied).toBe(true);
    const reloaded = await snapshot(app.url, USER_B_TG);
    expect(overboardOperationsOf(reloaded)).toHaveLength(1);
    expect(overboardOperationsOf(reloaded)[0]?.operationId).toBe(started?.operationId);
    expect(overboardOperationsOf(reloaded)[0]?.resultApplied).toBe(true);
  });

  it("S / U. reload preserves OVERBOARD and User A / User B Ban views converge", async () => {
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    await openIncomingAsB(app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
    const reloadedB = await snapshot(app.url, USER_B_TG);
    expect(reloadedB.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(bansOf(reloadedB)[0]?.id).toBe(ban.id);
    expect(bansOf(reloadedB)[0]?.acceptance).toBe("PENDING");
    expect(bansOf(reloadedB)[0]?.status).toBe("OVERBOARD");
    expect(incomingOf(reloadedB)[0]?.lifecycle).toEqual({ status: "PROCESSED" });
    expect(reloadedB.domainTimers).toEqual([]);
    expect(reloadedB.checkPairs).toEqual([]);
    expect(timerItemsOf(reloadedB)).toEqual([]);
    const reloadedA = await snapshot(app.url, USER_A_TG);
    expect(bansOf(reloadedA)[0]?.id).toBe(ban.id);
    expect(bansOf(reloadedA)[0]?.acceptance).toBe("PENDING");
    expect(bansOf(reloadedA)[0]?.status).toBe("OVERBOARD");
    expect(reloadedA.domainTimers).toEqual([]);
    expect(reloadedA.checkPairs).toEqual([]);
    const receiverOnB = statusItemsOf(reloadedB).find((item) => item.role === "RECEIVER");
    const senderOnA = statusItemsOf(reloadedA).find((item) => item.role === "SENDER");
    expect(receiverOnB).toBeTruthy();
    expect(senderOnA).toBeTruthy();
    expect(reloadedB.activeNotificationItemId).toBe(receiverOnB?.id);
    expect(reloadedB.priorities.statusItemId).toBe(receiverOnB?.id);
    expect(itemsOf(reloadedB).some((item) => item.id === reloadedB.activeNotificationItemId)).toBe(
      true,
    );
    expect(senderOnA?.id).not.toBe(reloadedB.activeNotificationItemId);
    expect(itemsOf(reloadedA).some((item) => item.id === reloadedB.activeNotificationItemId)).toBe(
      false,
    );
    const reloadedOverboard = overboardOperationsOf(reloadedB);
    expect(reloadedOverboard).toHaveLength(1);
    expect(reloadedOverboard[0]?.kind).toBe("OVERBOARD");
    expect(reloadedOverboard[0]?.resultApplied).toBe(true);
  });

  it("T. duplicate / late OVERBOARD cannot duplicate Ban, Incoming, Status, Timer, or CheckPair", async () => {
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    const { incomingItem } = await openIncomingAsB(app);
    const first = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    const after = requireDiagnostics(first);
    const receiverAfter = statusItemsOf(after).find((item) => item.role === "RECEIVER");
    expect(after.activeNotificationItemId).toBe(receiverAfter?.id);
    const operationId = first.orchestration?.userEvent.pendingOperationId;
    expect(operationId).toBeTruthy();
    const secondPress = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    expect(secondPress.diagnostics?.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(bansOf(secondPress.diagnostics!).filter((item) => item.id === ban.id)).toHaveLength(1);
    expect(incomingOf(secondPress.diagnostics!)).toHaveLength(1);
    expect(
      statusItemsOf(secondPress.diagnostics!).filter((item) => item.role === "RECEIVER"),
    ).toHaveLength(1);
    expect(secondPress.diagnostics?.activeNotificationItemId).toBe(receiverAfter?.id);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const late = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      payload: {
        operationId,
        sourceItemId: incomingItem.id,
        banId: ban.id,
      },
    });
    expect(Object.keys(late.snapshot.extended.entities.bans)).toHaveLength(1);
    expect(
      Object.values(late.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "INCOMING_BAN",
      ),
    ).toHaveLength(1);
    expect(
      Object.values(late.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS" && item.role === "RECEIVER",
      ),
    ).toHaveLength(1);
    expect(Object.values(late.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(Object.values(late.snapshot.extended.entities.checkPairs)).toEqual([]);
    expect(after.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(overboardOperationsOf(after)).toHaveLength(1);
    expect(overboardOperationsOf(after)[0]?.operationId).toBe(operationId);
    expect(overboardOperationsOf(after)[0]?.resultApplied).toBe(true);
    expect(late.outcome).not.toBe("APPLIED");
    expect(late.effects).toEqual([]);
    expect(late.snapshot.extended.priorities.statusItemId).toBe(receiverAfter?.id);
    expect(late.snapshot.extended.activeNotificationItemId).toBe(receiverAfter?.id);
    expect(late.snapshot.runtime.pendingOperations[operationId!]?.resultApplied).toBe(true);
  });

  it("V. client-supplied UserId cannot process another user's Incoming", async () => {
    const app = await start();
    await createRealIncomingFromA(app);
    const asB = await session(app.url, USER_B_TG);
    const spoofed = asB.currentUserId;
    const asA = await session(app.url, USER_A_TG);
    const attempted = await dispatch(
      app.url,
      USER_A_TG,
      "RIM.PRESS_NOTIFICATIONS",
      {},
      { clientClaimedUserId: spoofed },
    );
    expect(attempted.diagnostics?.currentUserId).toBe(asA.currentUserId);
    expect(attempted.diagnostics?.currentUserId).not.toBe(spoofed);
    expect(incomingOf(await snapshot(app.url, USER_B_TG))[0]?.lifecycle.status).toBe("UNPROCESSED");
    const overboard = await dispatch(
      app.url,
      USER_A_TG,
      "NOTIFICATIONS.PRESS_OVERBOARD",
      {},
      { clientClaimedUserId: spoofed },
    );
    expect(overboard.diagnostics?.currentUserId).toBe(asA.currentUserId);
    expect(bansOf(await snapshot(app.url, USER_B_TG))[0]?.status).toBeNull();
  });

  it("X. E-10 / E-11 / E-20 / E-21 / E-43 remain server-only on the public transport", async () => {
    const app = await start();
    await session(app.url, USER_B_TG);
    for (const name of [
      "CREATE_BAN.SEND_CONFIRMED",
      "CREATE_BAN.SEND_FAILED",
      "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      "NOTIFICATIONS.ACTION_FAILED",
      "NOTIFICATIONS.SELECT_NEXT",
    ]) {
      const blocked = await dispatch(app.url, USER_B_TG, name, { operationId: "operation-1" });
      expect(blocked.httpStatus).toBe(400);
      expect(blocked.error?.code).toBe("SERVER_RESULT_NOT_ACCEPTED");
    }
  });

  it("empty-queue E-60 has no Matrix branch and does not invent Incoming", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    const empty = await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS");
    expect(empty.diagnostics?.controlState).toBe("RIM.LOBBY");
    expect(empty.diagnostics?.applicationStatus).toBe("KERNEL_INVARIANT");
    expect(empty.diagnostics?.error?.code).toBe("KERNEL_INVARIANT");
    expect(empty.diagnostics?.persisted).toBe(false);
    expect(incomingOf(empty.diagnostics!)).toEqual([]);
  });

  it("OVERBOARD server failure leaves Incoming unprocessed (E-21)", async () => {
    const runtime = createCreateBanContactRuntime({ overboardCompletion: "failure" });
    await seedRegisteredUsers(runtime);
    const app = await start(runtime);
    await createRealIncomingFromA(app);
    await openIncomingAsB(app);
    const failed = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    const diagnostics = requireDiagnostics(failed);
    expect(failed.orchestration?.serverEvent.eventName).toBe("NOTIFICATIONS.ACTION_FAILED");
    expect(diagnostics.lastEvent).toEqual({ id: "E-21", name: "NOTIFICATIONS.ACTION_FAILED" });
    expect(diagnostics.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingOf(diagnostics)[0]?.lifecycle.status).toBe("UNPROCESSED");
    expect(bansOf(diagnostics)[0]?.status).toBeNull();
    expect(statusItemsOf(diagnostics)).toEqual([]);
    expect(overboardOperationsOf(diagnostics)).toEqual([]);
    expect(diagnostics.domainTimers).toEqual([]);
    expect(diagnostics.checkPairs).toEqual([]);
  });

  it("E-21 then retry E-15 starts a new attempt that E-20 can confirm", async () => {
    const runtime = createCreateBanContactRuntime({ overboardCompletion: "fail-once" });
    await seedRegisteredUsers(runtime);
    const app = await start(runtime);
    const { ban, bId } = await createRealIncomingFromA(app);
    const { incomingItem } = await openIncomingAsB(app);
    const failed = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    const afterFailure = requireDiagnostics(failed);
    const attempt1 = failed.orchestration?.userEvent.correlatedOperationId;
    expect(attempt1).toBeTruthy();
    expect(failed.orchestration?.serverEvent.eventName).toBe("NOTIFICATIONS.ACTION_FAILED");
    expect(afterFailure.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingOf(afterFailure)[0]?.lifecycle.status).toBe("UNPROCESSED");
    expect(bansOf(afterFailure)[0]?.acceptance).toBe("PENDING");
    expect(bansOf(afterFailure)[0]?.status).toBeNull();
    expect(statusItemsOf(afterFailure)).toEqual([]);
    expect(overboardOperationsOf(afterFailure)).toEqual([]);

    const reloaded = await snapshot(app.url, USER_B_TG);
    expect(reloaded.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingOf(reloaded)[0]?.lifecycle.status).toBe("UNPROCESSED");
    expect(overboardOperationsOf(reloaded)).toEqual([]);

    const retried = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    const afterRetry = requireDiagnostics(retried);
    const attempt2 = retried.orchestration?.userEvent.correlatedOperationId;
    expect(retried.orchestration?.serverEvent.eventName).toBe("NOTIFICATIONS.OVERBOARD_CONFIRMED");
    expect(attempt2).toBeTruthy();
    expect(attempt2).not.toBe(attempt1);
    expect(afterRetry.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(afterRetry.kernelOutcome).toBe("APPLIED");
    expect(bansOf(afterRetry)[0]?.id).toBe(ban.id);
    expect(bansOf(afterRetry)[0]?.acceptance).toBe("PENDING");
    expect(bansOf(afterRetry)[0]?.status).toBe("OVERBOARD");
    expect(incomingOf(afterRetry)[0]?.lifecycle).toEqual({ status: "PROCESSED" });
    const statuses = statusItemsOf(afterRetry);
    const receiver = statuses.find((item) => item.role === "RECEIVER");
    expect(receiver?.ownerId).toBe(bId);
    expect(afterRetry.priorities.statusItemId).toBe(receiver?.id);
    expect(afterRetry.activeNotificationItemId).toBe(receiver?.id);
    expect(afterRetry.domainTimers).toEqual([]);
    expect(afterRetry.checkPairs).toEqual([]);
    expect(timerItemsOf(afterRetry)).toEqual([]);
    const confirmedOp = overboardOperationsOf(afterRetry);
    expect(confirmedOp).toHaveLength(1);
    expect(confirmedOp[0]?.operationId).toBe(attempt2);
    expect(confirmedOp[0]?.resultApplied).toBe(true);

    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const staleSuccess = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      payload: {
        operationId: attempt1,
        sourceItemId: incomingItem.id,
        banId: ban.id,
      },
    });
    expect(staleSuccess.outcome).not.toBe("APPLIED");
    expect(staleSuccess.effects).toEqual([]);
    expect(Object.keys(staleSuccess.snapshot.extended.entities.bans)).toHaveLength(1);
    expect(
      Object.values(staleSuccess.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS" && item.role === "RECEIVER",
      ),
    ).toHaveLength(1);
    expect(staleSuccess.snapshot.runtime.pendingOperations[attempt2!]?.resultApplied).toBe(true);

    const staleFailure = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.ACTION_FAILED",
      payload: {
        operationId: attempt1,
        sourceItemId: incomingItem.id,
        failure: { code: "STALE_OVERBOARD_FAILED" },
      },
    });
    expect(staleFailure.outcome).not.toBe("APPLIED");
    expect(staleFailure.snapshot.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(staleFailure.snapshot.extended.entities.bans[ban.id]?.status).toBe("OVERBOARD");
    expect(staleFailure.snapshot.runtime.pendingOperations[attempt2!]?.resultApplied).toBe(true);

    const duplicate = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      payload: {
        operationId: attempt2,
        sourceItemId: incomingItem.id,
        banId: ban.id,
      },
    });
    expect(duplicate.outcome).not.toBe("APPLIED");
    expect(
      Object.values(duplicate.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS" && item.role === "RECEIVER",
      ),
    ).toHaveLength(1);
    expect(duplicate.snapshot.extended.priorities.statusItemId).toBe(receiver?.id);
    expect(duplicate.snapshot.extended.activeNotificationItemId).toBe(receiver?.id);

    const asA = await snapshot(app.url, USER_A_TG);
    expect(bansOf(asA)[0]?.acceptance).toBe("PENDING");
    expect(bansOf(asA)[0]?.status).toBe("OVERBOARD");
    expect(statusItemsOf(asA).find((item) => item.role === "SENDER")).toBeTruthy();
  });

  it("old E-20/E-21 for attempt #1 cannot confirm or cancel attempt #2", async () => {
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    const { incomingItem } = await openIncomingAsB(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const press1 = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.PRESS_OVERBOARD",
      payload: {},
    });
    const attempt1 = Object.values(press1.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "OVERBOARD",
    );
    expect(attempt1?.resultApplied).toBe(false);
    const failed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.ACTION_FAILED",
      payload: {
        operationId: attempt1!.operationId,
        sourceItemId: incomingItem.id,
        failure: { code: "OVERBOARD_FAILED" },
      },
    });
    expect(failed.status).toBe("APPLIED");
    expect(Object.keys(failed.snapshot.runtime.pendingOperations)).toEqual([]);
    const press2 = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.PRESS_OVERBOARD",
      payload: {},
    });
    expect(press2.status).toBe("APPLIED");
    const attempt2 = Object.values(press2.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "OVERBOARD" && !operation.resultApplied,
    );
    expect(attempt2?.operationId).not.toBe(attempt1?.operationId);
    const staleSuccess = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      payload: {
        operationId: attempt1!.operationId,
        sourceItemId: incomingItem.id,
        banId: ban.id,
      },
    });
    expect(staleSuccess.outcome).not.toBe("APPLIED");
    expect(staleSuccess.snapshot.extended.entities.bans[ban.id]?.status).toBeNull();
    expect(
      staleSuccess.snapshot.runtime.pendingOperations[attempt2!.operationId]?.resultApplied,
    ).toBe(false);
    const staleFailure = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.ACTION_FAILED",
      payload: {
        operationId: attempt1!.operationId,
        sourceItemId: incomingItem.id,
        failure: { code: "OVERBOARD_FAILED" },
      },
    });
    expect(staleFailure.outcome).not.toBe("APPLIED");
    expect(staleFailure.snapshot.runtime.pendingOperations[attempt2!.operationId]).toBeDefined();
    expect(incomingOf(await snapshot(app.url, USER_B_TG))[0]?.lifecycle.status).toBe("UNPROCESSED");
    const confirmed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
      payload: {
        operationId: attempt2!.operationId,
        sourceItemId: incomingItem.id,
        banId: ban.id,
      },
    });
    expect(confirmed.status).toBe("APPLIED");
    expect(confirmed.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(confirmed.snapshot.extended.entities.bans[ban.id]?.status).toBe("OVERBOARD");
    expect(confirmed.snapshot.runtime.pendingOperations[attempt2!.operationId]?.resultApplied).toBe(
      true,
    );
  });

  it("failure persist reload then retry OVERBOARD still applies", async () => {
    const runtime = createCreateBanContactRuntime({ overboardCompletion: "fail-once" });
    await seedRegisteredUsers(runtime);
    const app = await start(runtime);
    await createRealIncomingFromA(app);
    await openIncomingAsB(app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
    const afterReload = await snapshot(app.url, USER_B_TG);
    expect(afterReload.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingOf(afterReload)[0]?.lifecycle.status).toBe("UNPROCESSED");
    expect(overboardOperationsOf(afterReload)).toEqual([]);
    const retry = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(retry.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(overboardOperationsOf(retry)[0]?.resultApplied).toBe(true);
    expect(bansOf(retry)[0]?.status).toBe("OVERBOARD");
  });

  it("К ЗАПРЕТАМ is E-19 then Kernel E-43; empty queue returns to Lobby", async () => {
    const e19 = MATRIX_CONTRACT_ROWS.find(
      (row) =>
        row.state === "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER" &&
        row.eventName === "NOTIFICATIONS.PRESS_TO_BANS",
    );
    expect(e19).toMatchObject({
      eventId: "E-19",
      branch: "active-status-unprocessed",
      nextState: "RESULT_OF_NOTIFICATIONS_SELECT_NEXT",
    });
    const app = await start();
    const { ban, bId } = await createRealIncomingFromA(app);
    await openIncomingAsB(app);
    const overboard = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const receiverBefore = statusItemsOf(overboard).find((item) => item.role === "RECEIVER");
    expect(overboard.priorities.statusItemId).toBe(receiverBefore?.id);
    expect(overboard.activeNotificationItemId).toBe(receiverBefore?.id);
    const left = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS");
    const after = requireDiagnostics(left);
    expect(after.lastEvent).toEqual({ id: "E-19", name: "NOTIFICATIONS.PRESS_TO_BANS" });
    expect(after.controlState).toBe("RIM.LOBBY");
    expect(after.kernelOutcome).toBe("APPLIED");
    expect(after.activeNotificationItemId).toBeNull();
    expect(after.hasUnprocessedNotifications).toBe(false);
    const receiverAfter = statusItemsOf(after).find((item) => item.role === "RECEIVER");
    expect(receiverAfter?.id).toBe(receiverBefore?.id);
    expect(receiverAfter?.lifecycle.status).toBe("PROCESSED");
    expect(after.priorities.statusItemId).toBe(receiverBefore?.id);
    expect(bansOf(after)[0]?.id).toBe(ban.id);
    expect(bansOf(after)[0]?.acceptance).toBe("PENDING");
    expect(bansOf(after)[0]?.status).toBe("OVERBOARD");
    expect(incomingOf(after)[0]?.lifecycle).toEqual({ status: "PROCESSED" });
    expect(overboardOperationsOf(after)[0]?.resultApplied).toBe(true);
    expect(after.domainTimers).toEqual([]);
    expect(after.checkPairs).toEqual([]);
    expect(timerItemsOf(after)).toEqual([]);

    const reloadedB = await snapshot(app.url, USER_B_TG);
    expect(reloadedB.controlState).toBe("RIM.LOBBY");
    expect(reloadedB.activeNotificationItemId).toBeNull();
    expect(
      statusItemsOf(reloadedB).find((item) => item.role === "RECEIVER")?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(overboardOperationsOf(reloadedB)[0]?.resultApplied).toBe(true);

    const reloadedA = await snapshot(app.url, USER_A_TG);
    const sender = statusItemsOf(reloadedA).find((item) => item.role === "SENDER");
    expect(sender).toBeTruthy();
    expect(sender?.lifecycle.status).toBe("UNPROCESSED");
    expect(sender?.id).not.toBe(receiverBefore?.id);
    expect(bansOf(reloadedA)[0]?.status).toBe("OVERBOARD");
    expect(bansOf(reloadedA)[0]?.acceptance).toBe("PENDING");
    expect(reloadedA.currentUserId).not.toBe(bId);
  });

  it("К ЗАПРЕТАМ continues to the next Incoming when another unprocessed item exists", async () => {
    const app = await start();
    const first = await createRealIncomingFromA(app);
    const more = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
    expect(more.controlState).toBe("RIM.LOBBY");
    const { bId } = await reachConfirm(app.url, app);
    const secondSuccess = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    const secondBan = bansOf(secondSuccess).find((item) => item.id !== first.ban.id);
    expect(secondBan).toBeTruthy();
    expect(bId).toBe(first.bId);
    await session(app.url, USER_B_TG);
    const opened = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"),
    );
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingOf(opened)).toHaveLength(2);
    const firstIncomingId = opened.activeNotificationItemId;
    expect(firstIncomingId).toBeTruthy();
    const overboard = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const next = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(next.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(next.activeNotificationItemId).not.toBe(firstIncomingId);
    expect(next.activeNotificationItemId).toBeTruthy();
    const remaining = incomingOf(next).find((item) => item.lifecycle.status === "UNPROCESSED");
    expect(remaining?.id).toBe(next.activeNotificationItemId);
    expect(remaining?.banId).toBe(secondBan?.id);
    expect(bansOf(next).some((item) => item.status === "OVERBOARD")).toBe(true);
    expect(statusItemsOf(next).find((item) => item.role === "RECEIVER")?.lifecycle.status).toBe(
      "PROCESSED",
    );
  });

  it("Z. Stage 8 surfaces are not registered in Stage 7 composition", async () => {
    const app = await start();
    const meta = await fetch(`${app.url}/api/meta`);
    const body = (await meta.json()) as {
      IMPLEMENTATION_STAGE: number;
      CREATE_BAN_CONTACT_STAGE: number;
      INCOMING_OVERBOARD_STAGE: number;
      STAGE_7_EXCLUDES: readonly string[];
    };
    expect(body).toMatchObject({
      IMPLEMENTATION_STAGE: 2,
      CREATE_BAN_CONTACT_STAGE: 6,
      INCOMING_OVERBOARD_STAGE: 7,
    });
    expect(body.STAGE_7_EXCLUDES).toEqual(
      expect.arrayContaining(["timer-processing", "check", "reply-ban-from-status"]),
    );
    expect(body.STAGE_7_EXCLUDES).toContain("reply-ban-from-incoming-ban");
    expect(body.STAGE_7_EXCLUDES).not.toContain("status-processing");
    const screens = await fetch(`${app.url}/test-ui/product-screens.js`);
    const source = await screens.text();
    expect(source).toContain("IncomingBanTestScreen");
    expect(source).toContain("StatusOverboardReceiverTestScreen");
    // Shared product-screens.js includes Stage 10 FROM_STATUS; Stage 7 meta still excludes it.
    expect(source).toContain("REPLY_BAN.WHAT.FROM_STATUS");
    expect(body.STAGE_7_EXCLUDES).toContain("reply-ban-from-status");
    expect(source).toContain("NOTIFICATIONS.CHECK.RECEIVER");
  });
});
