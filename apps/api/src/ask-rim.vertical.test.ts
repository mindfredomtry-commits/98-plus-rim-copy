import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  type RimAiResult,
} from "@98plus/product-model";
import {
  FakeRimAiAdapter,
  type FakeRimAiStep,
  type RimAiPort,
  type RimAiRequest,
  type RimAiResponseObserver,
} from "@98plus/application";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import { listenCreateBanContactServer } from "./http.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";
import { createCreateBanContactRuntime, userIdOf } from "./runtime.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const DEV_SECRET = "test-secret";
const BAN_TEXT = "не пропускай зал";
const ASK_TEXT = "что хочешь спросить?";
const ORDINARY_INTRO = "я могу предложить 3 запрета, написать?";

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;
const started: Started[] = [];

class RecordingRimAi implements RimAiPort {
  readonly requests: RimAiRequest[] = [];

  constructor(private readonly inner: RimAiPort) {}

  async respond(request: RimAiRequest, observer: RimAiResponseObserver): Promise<RimAiResult> {
    this.requests.push(request);
    return this.inner.respond(request, observer);
  }
}

afterEach(async () => {
  while (started.length > 0) {
    const app = started.pop();
    if (app) await app.close();
  }
});

function authHeaders(telegramUserId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-98-auth-method": "development",
    "x-98-dev-secret": DEV_SECRET,
    "x-98-dev-telegram-user-id": telegramUserId,
  };
}

async function start(steps: readonly FakeRimAiStep[] = [], contextFailures = 0) {
  const rimAi = new RecordingRimAi(new FakeRimAiAdapter(steps));
  const runtime = createCreateBanContactRuntime({
    rimAi,
    rimContextFailures: { remainingFailures: contextFailures },
  });
  const app = await listenCreateBanContactServer({
    runtime,
    seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG],
  });
  started.push(app);
  await grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  await grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_C_TG);
  await grantContactBetweenTelegramUsers(app.runtime, USER_B_TG, USER_C_TG);
  return { app, rimAi };
}

async function session(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ openIfNeeded: true }),
  });
  const body = (await response.json()) as { diagnostics: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics;
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
}> {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const body = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    executionStatus?: string;
    error?: { message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: body.diagnostics ?? null,
    ...(body.executionStatus === undefined ? {} : { executionStatus: body.executionStatus }),
  };
}

function requireDiagnostics(result: Awaited<ReturnType<typeof dispatch>>): TestUiDiagnostics {
  expect(result.httpStatus, JSON.stringify(result)).toBe(200);
  expect(result.diagnostics).not.toBeNull();
  return result.diagnostics!;
}

async function snapshot(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/snapshot`, { headers: authHeaders(telegramUserId) });
  const body = (await response.json()) as { diagnostics: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics;
}

type NotificationJson = {
  id: string;
  ownerId: string;
  banId: string;
  kind: string;
  role?: string;
  status?: string;
  lifecycle: { status: string };
};

function statusItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return (diagnostics.notificationItems as NotificationJson[]).filter(
    (item) => item.kind === "STATUS",
  );
}

function activeStatus(diagnostics: TestUiDiagnostics): NotificationJson {
  const item = statusItemsOf(diagnostics).find(
    (candidate) => candidate.id === diagnostics.activeNotificationItemId,
  );
  expect(item).toBeTruthy();
  return item!;
}

async function userId(app: Started, telegramUserId: string): Promise<string> {
  const id = await userIdOf(app.runtime, telegramUserId);
  expect(id).toBeTruthy();
  return id!;
}

async function reachReceiverOverboard(app: Started): Promise<{
  banId: string;
  status: TestUiDiagnostics;
  statusItem: NotificationJson;
}> {
  await session(app.url, USER_A_TG);
  await session(app.url, USER_B_TG);
  const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  const bId = who.contacts.find((contact) => contact.telegramUserId === USER_B_TG)?.userId;
  expect(bId).toBe(await userId(app, USER_B_TG));
  requireDiagnostics(
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  const success = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"));
  expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
  const banId = (success.bans[0] as { id: string }).id;
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  const status = requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
  );
  expect(status.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
  const statusItem = activeStatus(status);
  expect(statusItem.lifecycle.status).toBe("UNPROCESSED");
  expect(statusItem.banId).toBe(banId);
  expect(statusItem.role).toBe("RECEIVER");
  return { banId, status, statusItem };
}

async function reachSenderOverboard(app: Started): Promise<{
  banId: string;
  statusItem: NotificationJson;
}> {
  const { banId } = await reachReceiverOverboard(app);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
  const opened = requireDiagnostics(
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
  );
  expect(opened.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.SENDER");
  const statusItem = activeStatus(opened);
  expect(statusItem.banId).toBe(banId);
  expect(statusItem.role).toBe("SENDER");
  expect(statusItem.lifecycle.status).toBe("UNPROCESSED");
  return { banId, statusItem };
}

describe("Feature 9 Ask RIM vertical", () => {
  it("keeps 30 Product Control States, 60 events, and 360 Matrix rules", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });

  it("opens Ask RIM from the receiver Status, sends with origin, and returns to that item", async () => {
    const { app, rimAi } = await start();
    const { banId, statusItem } = await reachReceiverOverboard(app);
    const senderId = await userId(app, USER_A_TG);

    const opened = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_ASK_RIM"),
    );
    expect(opened.controlState).toBe("RIM.CHAT");
    expect(opened.persisted).toBe(true);
    expect(opened.rimChat?.selectedContactId).toBe(senderId);
    expect(opened.rimChat?.askRimOrigin).toEqual({
      sourceStatusItemId: statusItem.id,
      banId,
      status: "OVERBOARD",
      sourceRole: "RECEIVER",
    });
    expect(opened.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_TEXT }]);
    expect(opened.rimChat?.aiOperation.status).toBe("IDLE");
    expect(opened.rimChat?.relationshipContext?.status).toBe("ready");
    expect(rimAi.requests).toEqual([]);
    const stillOpen = statusItemsOf(opened).find((item) => item.id === statusItem.id);
    expect(stillOpen?.lifecycle.status).toBe("UNPROCESSED");

    const stored = await snapshot(app.url, USER_B_TG);
    expect(stored.controlState).toBe("RIM.CHAT");
    expect(stored.rimChat?.id).toBe(opened.rimChat?.id);
    expect(stored.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_TEXT }]);
    expect(statusItemsOf(stored).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );

    const repeated = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_ASK_RIM");
    expect(repeated.httpStatus).toBe(200);
    expect(repeated.diagnostics?.applicationStatus).toBe("NOT_APPLIED");
    expect(repeated.diagnostics?.kernelOutcome).toBe("UNDEFINED");
    expect(repeated.diagnostics?.rimChat?.id).toBe(opened.rimChat?.id);
    expect(repeated.diagnostics?.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_TEXT }]);

    const selecting = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_SELECT_CONTACT"),
    );
    expect(selecting.controlState).toBe("RIM.SELECT_CONTACT");
    const sameChat = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_BACK"));
    expect(sameChat.controlState).toBe("RIM.CHAT");
    expect(sameChat.rimChat?.id).toBe(opened.rimChat?.id);
    expect(sameChat.rimChat?.askRimOrigin).toEqual(opened.rimChat?.askRimOrigin);

    await dispatch(app.url, USER_B_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "предложи" });
    const proposed = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_SEND"));
    const proposals = proposed.rimChat?.messages.at(-1);
    expect(proposals?.kind).toBe("BAN_PROPOSALS");
    if (proposals?.kind !== "BAN_PROPOSALS") return;
    expect(rimAi.requests).toHaveLength(1);
    expect(rimAi.requests[0]?.conversationalOrigin).toEqual(opened.rimChat?.askRimOrigin);
    if (rimAi.requests[0]?.continuityMode !== "provider-conversation") {
      throw new Error("expected provider continuation");
    }
    expect(rimAi.requests[0].userMessage).toBe("предложи");
    const proposalId = proposals.proposals[0]!.proposalId;
    const frozen = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: proposed.rimChat?.id,
        proposalId,
      }),
    );
    expect(frozen.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(frozen.savedFrozenRimChatPresent).toBe(true);
    const restored = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_BACK"),
    );
    expect(restored.controlState).toBe("RIM.CHAT");
    expect(restored.rimChat?.id).toBe(opened.rimChat?.id);
    expect(restored.rimChat?.askRimOrigin).toEqual(opened.rimChat?.askRimOrigin);
    expect(restored.savedFrozenRimChatPresent).toBe(false);

    const again = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: restored.rimChat?.id,
        proposalId,
      }),
    );
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 4 });
    const confirm = requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_NEXT"));
    expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.RIM");
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(success.rimChat).toBeNull();
    expect(success.savedFrozenRimChatPresent).toBe(false);
    expect(again.createBanDraft?.proposalId).toBe(proposalId);
    expect(statusItemsOf(success).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );

    const returned = await snapshot(app.url, USER_B_TG);
    expect(returned.rimChat).toBeNull();
    expect(
      statusItemsOf(returned).find((item) => item.id === statusItem.id)?.lifecycle.status,
    ).toBe("UNPROCESSED");
  });

  it("returns Back to the exact original unprocessed receiver Status Item", async () => {
    const { app, rimAi } = await start();
    const { statusItem } = await reachReceiverOverboard(app);
    const opened = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_ASK_RIM"),
    );
    const back = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_BACK"));
    expect(back.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(back.rimChat).toBeNull();
    expect(back.activeNotificationItemId).toBe(statusItem.id);
    expect(activeStatus(back).lifecycle.status).toBe("UNPROCESSED");
    expect(rimAi.requests).toEqual([]);
    const reloaded = await snapshot(app.url, USER_B_TG);
    expect(reloaded.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(reloaded.activeNotificationItemId).toBe(statusItem.id);
    expect(reloaded.rimChat).toBeNull();

    const reopened = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_ASK_RIM"),
    );
    expect(reopened.controlState).toBe("RIM.CHAT");
    expect(reopened.rimChat?.id).not.toBe(opened.rimChat?.id);
    expect(reopened.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_TEXT }]);
    expect(reopened.rimChat?.askRimOrigin?.sourceStatusItemId).toBe(statusItem.id);
  });

  it("adds the Ask RIM line only on the first successful context result", async () => {
    const { app, rimAi } = await start([], 1);
    const { statusItem } = await reachReceiverOverboard(app);
    const failed = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_ASK_RIM"),
    );
    expect(failed.controlState).toBe("RIM.CHAT");
    expect(failed.rimChat?.messages).toEqual([]);
    expect(failed.rimChat?.relationshipContext?.status).toBe("error");
    expect(failed.rimChat?.askRimOrigin?.sourceStatusItemId).toBe(statusItem.id);
    expect(rimAi.requests).toEqual([]);
    const ready = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_RETRY_CONTEXT", {
        failedRequestId: failed.rimChat?.relationshipContext?.requestId,
      }),
    );
    expect(ready.rimChat?.relationshipContext?.status).toBe("ready");
    expect(ready.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_TEXT }]);
    expect(ready.rimChat?.id).toBe(failed.rimChat?.id);
    expect(rimAi.requests).toEqual([]);
  });

  it("drops origin when another contact is chosen and uses the ordinary introduction", async () => {
    const { app, rimAi } = await start([{ kind: "MESSAGE", text: "слышу" }]);
    await reachReceiverOverboard(app);
    const opened = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_ASK_RIM"),
    );
    const third = await userId(app, USER_C_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_SELECT_CONTACT"));
    const changed = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.SELECT_CONTACT", { contactId: third }),
    );
    expect(changed.rimChat?.id).not.toBe(opened.rimChat?.id);
    expect(changed.rimChat?.selectedContactId).toBe(third);
    expect(changed.rimChat?.askRimOrigin).toBeNull();
    expect(changed.rimChat?.messages).toEqual([{ kind: "RIM", text: ORDINARY_INTRO }]);
    await dispatch(app.url, USER_B_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" });
    const sent = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_SEND"));
    expect(sent.rimChat?.messages.at(-1)).toEqual({ kind: "RIM", text: "слышу" });
    expect(rimAi.requests).toHaveLength(1);
    expect(rimAi.requests[0]?.conversationalOrigin).toBeNull();
    const lobby = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_BACK"));
    expect(lobby.controlState).toBe("RIM.LOBBY");
    expect(lobby.rimChat).toBeNull();
  });

  it("opens Ask RIM from the sender Status and returns to that unprocessed item", async () => {
    const { app, rimAi } = await start();
    const { banId, statusItem } = await reachSenderOverboard(app);
    const receiverId = await userId(app, USER_B_TG);
    const opened = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_ASK_RIM"),
    );
    expect(opened.controlState).toBe("RIM.CHAT");
    expect(opened.persisted).toBe(true);
    expect(opened.rimChat?.selectedContactId).toBe(receiverId);
    expect(opened.rimChat?.askRimOrigin).toEqual({
      sourceStatusItemId: statusItem.id,
      banId,
      status: "OVERBOARD",
      sourceRole: "SENDER",
    });
    expect(opened.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_TEXT }]);
    expect(rimAi.requests).toEqual([]);
    expect(statusItemsOf(opened).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );

    const back = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_BACK"));
    expect(back.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.SENDER");
    expect(back.activeNotificationItemId).toBe(statusItem.id);
    expect(back.rimChat).toBeNull();
    expect(activeStatus(back).lifecycle.status).toBe("UNPROCESSED");
    const stored = await snapshot(app.url, USER_A_TG);
    expect(stored.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.SENDER");
    expect(stored.activeNotificationItemId).toBe(statusItem.id);
    expect(statusItemsOf(stored).find((item) => item.id === statusItem.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );
  });
});
