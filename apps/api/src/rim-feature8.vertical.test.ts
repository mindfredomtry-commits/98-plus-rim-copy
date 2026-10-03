import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  type ExecutionProbability,
  type ThreeSuggestions,
} from "@98plus/product-model";
import {
  FakeRimAiAdapter,
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type FakeRimAiStep,
  type RimAiPort,
  type RimAiRequest,
  type RimConversationInitializationPort,
} from "@98plus/application";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import { listenCreateBanContactServer } from "./http.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  userIdOf,
} from "./runtime.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const DEV_SECRET = "test-secret";
const PROPOSALS: ThreeSuggestions = [
  { banText: "запрет один", executionProbability: 0.1 as ExecutionProbability },
  { banText: "запрет два", executionProbability: 0.4 as ExecutionProbability },
  { banText: "запрет три", executionProbability: 0.9 as ExecutionProbability },
];

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;
const started: Started[] = [];

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

async function start(
  steps: readonly FakeRimAiStep[] = [],
  contextFailures = 0,
  observed?: { seen: RimAiRequest[]; initializations: number },
) {
  const fake = new FakeRimAiAdapter(steps);
  const recording: RimAiPort & RimConversationInitializationPort = {
    async respond(request, observer) {
      observed?.seen.push(request);
      return fake.respond(request, observer);
    },
    async initialize(request) {
      if (observed) {
        observed.initializations += 1;
      }
      return fake.initialize(request);
    },
  };
  const runtime = createCreateBanContactRuntime({
    rimAi: observed ? recording : fake,
    rimContextFailures: { remainingFailures: contextFailures },
  });
  const app = await listenCreateBanContactServer({
    runtime,
    seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG],
  });
  started.push(app);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_C_TG);
  return app;
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
): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const body = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    error?: { message?: string };
  };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.diagnostics!;
}

function contactId(app: Started, telegramUserId: string): string {
  const userId = userIdOf(app.runtime, telegramUserId);
  expect(userId).toBeTruthy();
  return userId!;
}

type BanView = {
  id: string;
  senderId: string;
  receiverId: string | null;
  banText: string;
  durationMinutes: number;
  sourceProposalId: string | null;
};

type IncomingView = {
  id: string;
  ownerId: string;
  banId: string;
  kind: string;
};

async function snapshot(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/snapshot`, { headers: authHeaders(telegramUserId) });
  const body = (await response.json()) as { diagnostics: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics;
}

function bansOf(diagnostics: TestUiDiagnostics): BanView[] {
  return diagnostics.bans as BanView[];
}

function incomingOf(diagnostics: TestUiDiagnostics): IncomingView[] {
  return (diagnostics.incomingItems as IncomingView[]).filter(
    (item) => item.kind === "INCOMING_BAN",
  );
}

describe("Feature 8 RIM vertical", () => {
  it("keeps the frozen engine counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
  });

  it("runs lobby, context, fake AI, proposal, restore, and successful Ban", async () => {
    const app = await start([
      { kind: "MESSAGE", text: "слышу" },
      {
        kind: "BAN_PROPOSALS",
        message: "вот три",
        proposals: PROPOSALS,
      },
    ]);
    const opened = await session(app.url, USER_A_TG);
    expect(opened.controlState).toBe("RIM.LOBBY");
    const other = contactId(app, USER_B_TG);
    const third = contactId(app, USER_C_TG);

    const chat = await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
    expect(chat.controlState).toBe("RIM.CHAT");
    expect(chat.rimChat).toBeNull();

    const selecting = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    expect(selecting.controlState).toBe("RIM.SELECT_CONTACT");
    expect(selecting.rimChat).toBeNull();
    const ready = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: other });
    expect(ready.controlState).toBe("RIM.CHAT");
    const chatId = ready.rimChat?.id;
    expect(chatId).toBeTruthy();
    expect(ready.rimChat?.selectedContactId).toBe(other);
    expect(ready.rimChat?.askRimOrigin).toBeNull();
    expect(ready.rimChat?.relationshipContext?.status).toBe("ready");
    expect(ready.rimChat?.messages).toEqual([
      { kind: "RIM", text: "я могу предложить 3 запрета, написать?" },
    ]);
    const contextRequestId = ready.rimChat?.relationshipContext?.requestId;

    await dispatch(app.url, USER_A_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" });
    const messaged = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SEND");
    expect(messaged.rimChat?.messages.at(-1)).toEqual({ kind: "RIM", text: "слышу" });
    expect(messaged.rimChat?.relationshipContext?.requestId).toBe(contextRequestId);
    expect(messaged.rimChat?.aiOperation.status).toBe("IDLE");

    await dispatch(app.url, USER_A_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "ещё" });
    const proposed = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SEND");
    const proposals = proposed.rimChat?.messages.at(-1);
    expect(proposals?.kind).toBe("BAN_PROPOSALS");
    if (proposals?.kind !== "BAN_PROPOSALS") return;
    expect(proposals.proposals).toHaveLength(3);
    expect(proposals.proposals.map((item) => item.banText)).toEqual(
      PROPOSALS.map((item) => item.banText),
    );
    expect(new Set(proposals.proposals.map((item) => item.proposalId)).size).toBe(3);
    const proposalId = proposals.proposals[1]!.proposalId;
    const frozenMessages = proposed.rimChat?.messages;

    const what = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SUGGESTION_FORBID", {
      rimChatId: proposed.rimChat?.id,
      proposalId,
    });
    expect(what.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(what.createBanDraft?.proposalId).toBe(proposalId);
    expect(what.createBanDraft?.banText).toBe("запрет два");
    expect(what.savedFrozenRimChatPresent).toBe(true);

    const restored = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK");
    expect(restored.controlState).toBe("RIM.CHAT");
    expect(restored.rimChat?.id).toBe(chatId);
    expect(restored.rimChat?.messages).toEqual(frozenMessages);
    expect(restored.rimChat?.relationshipContext?.requestId).toBe(contextRequestId);

    const again = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SUGGESTION_FORBID", {
      rimChatId: restored.rimChat?.id,
      proposalId,
    });
    expect(again.createBanDraft?.proposalId).toBe(proposalId);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 });
    const confirm = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.RIM");
    const success = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(success.rimChat).toBeNull();
    const created = success.bans.find(
      (ban) => (ban as { sourceProposalId?: string }).sourceProposalId === proposalId,
    ) as {
      sourceProposalId?: string;
    };
    expect(created?.sourceProposalId).toBe(proposalId);
    const back = await dispatch(app.url, USER_A_TG, "RIM.PRESS_BACK");
    expect(back.rimChat).toBeNull();
    expect(back.controlState).not.toBe("RIM.CHAT");
    const lobby = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE");
    expect(lobby.controlState).toBe("RIM.LOBBY");

    const fresh = await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
    expect(fresh.controlState).toBe("RIM.CHAT");
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    const replaced = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: third });
    expect(replaced.rimChat?.id).not.toBe(chatId);
    expect(replaced.rimChat?.selectedContactId).toBe(third);
    expect(replaced.rimChat?.messages.some((message) => message.kind === "BAN_PROPOSALS")).toBe(
      false,
    );
    expect(replaced.rimChat?.relationshipContext?.status).toBe("ready");
    expect(
      replaced.rimChat?.relationshipContext?.data?.aggregates.userToContact.bansSentCount,
    ).toBe(0);
    const thirdChatId = replaced.rimChat?.id;
    const thirdRequestId = replaced.rimChat?.relationshipContext?.requestId;
    const thirdMessages = replaced.rimChat?.messages;

    const selectingSame = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    expect(selectingSame.controlState).toBe("RIM.SELECT_CONTACT");
    expect(selectingSame.rimChat?.id).toBe(thirdChatId);
    const same = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: third });
    expect(same.controlState).toBe("RIM.CHAT");
    expect(same.rimChat?.id).toBe(thirdChatId);
    expect(same.rimChat?.messages).toEqual(thirdMessages);
    expect(same.rimChat?.relationshipContext?.requestId).toBe(thirdRequestId);

    await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    const changed = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: other });
    expect(changed.controlState).toBe("RIM.CHAT");
    expect(changed.rimChat?.id).not.toBe(thirdChatId);
    expect(changed.rimChat?.selectedContactId).toBe(other);
    expect(changed.rimChat?.askRimOrigin).toBeNull();
    expect(changed.rimChat?.messages.some((message) => message.kind === "BAN_PROPOSALS")).toBe(
      false,
    );
    expect(changed.rimChat?.messages.some((message) => message.kind === "USER")).toBe(false);
    expect(changed.rimChat?.relationshipContext?.status).toBe("ready");
    expect(changed.rimChat?.relationshipContext?.requestId).not.toBe(thirdRequestId);
    expect(changed.rimChat?.relationshipContext?.data?.aggregates.userToContact.bansSentCount).toBe(
      1,
    );
    expect(changed.rimChat?.relationshipContext?.data?.recentBans[0]).toMatchObject({
      direction: "USER_TO_CONTACT",
      banText: "запрет два",
      result: { kind: "AWAITING_RESPONSE" },
    });
  });

  it("retries a failed context build and completes an ambiguous AI call through local history", async () => {
    const observed = { seen: [] as RimAiRequest[], initializations: 0 };
    const app = await start(
      [
        { kind: "FAILURE", failure: { code: "RIM_AI_FAILED" } as never },
        { kind: "MESSAGE", text: "повтор" },
      ],
      1,
      observed,
    );
    const opened = await session(app.url, USER_A_TG);
    expect(opened.controlState).toBe("RIM.LOBBY");
    const other = contactId(app, USER_B_TG);
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    const failed = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: other });
    expect(failed.rimChat?.relationshipContext?.status).toBe("error");
    const retried = await dispatch(app.url, USER_A_TG, "RIM.PRESS_RETRY_CONTEXT", {
      failedRequestId: failed.rimChat?.relationshipContext?.requestId,
    });
    expect(retried.rimChat?.relationshipContext?.status).toBe("ready");
    expect(retried.rimChat?.relationshipContext?.requestId).not.toBe(
      failed.rimChat?.relationshipContext?.requestId,
    );

    await dispatch(app.url, USER_A_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "спроси" });
    const aiFailed = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SEND");
    expect(aiFailed.rimChat?.aiOperation.status).toBe("IDLE");
    expect(aiFailed.rimChat?.messages.filter((message) => message.kind === "USER")).toEqual([
      { kind: "USER", text: "спроси" },
    ]);
    expect(aiFailed.rimChat?.messages.at(-1)).toEqual({ kind: "RIM", text: "повтор" });
    expect(observed.initializations).toBe(1);
    expect(observed.seen).toHaveLength(2);
    const providerTurn = observed.seen[0];
    const localTurn = observed.seen[1];
    expect(providerTurn?.continuityMode).toBe("provider-conversation");
    expect(localTurn?.continuityMode).toBe("local-canonical-history");
    if (
      providerTurn?.continuityMode !== "provider-conversation" ||
      localTurn?.continuityMode !== "local-canonical-history"
    ) {
      throw new Error("expected provider ambiguity to execute locally");
    }
    expect(localTurn.requestId).toBe(providerTurn.requestId);
    expect("conversationId" in localTurn).toBe(false);
    expect(JSON.stringify(localTurn)).not.toContain(providerTurn.conversationId);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const loaded = await app.runtime.productStore.loadProductSnapshot(context.currentUserId);
    const runtime = applicableRimProviderRuntime(
      parseRimProviderRuntime(loaded.rimProviderRuntime),
      aiFailed.rimChat?.id ?? null,
    );
    expect(runtime?.continuityMode).toBe("local-canonical-history");
    if (runtime?.initialization.submissionState !== "stored") {
      throw new Error("expected stored initialization");
    }
    expect(runtime.initialization.conversationId).toBe(providerTurn.conversationId);
    expect(runtime?.retiredAttemptId).toBeTruthy();
    expect(runtime?.attempt?.submissionState).toBe("returned-body-observed");
  });

  it("ignores a stale context result and a stale AI result", async () => {
    const app = await start([{ kind: "MESSAGE", text: "ok" }]);
    const opened = await session(app.url, USER_A_TG);
    expect(opened.controlState).toBe("RIM.LOBBY");
    const other = contactId(app, USER_B_TG);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    const ready = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: other });
    const chat = ready.rimChat!;
    const staleContext = await executeAuthenticatedEvent(app.runtime, context, {
      name: "RIM.CONTEXT_READY",
      payload: {
        rimChatId: "rim-chat-stale",
        selectedContactId: other,
        requestId: chat.relationshipContext?.requestId,
        relationshipContext: chat.relationshipContext?.data,
      },
    });
    expect(staleContext.result).toBe("IGNORE_NOT_ALLOWED");
    expect(staleContext.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(staleContext.snapshot.extended.rimChat?.relationshipContext?.requestId).toBe(
      chat.relationshipContext?.requestId,
    );

    await dispatch(app.url, USER_A_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" });
    const messaged = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SEND");
    const staleAi = await executeAuthenticatedEvent(app.runtime, context, {
      name: "RIM.AI_RESULT_RECEIVED",
      payload: {
        rimChatId: messaged.rimChat?.id,
        requestId: "ai-stale",
        result: { kind: "MESSAGE", text: "late" },
      },
    });
    expect(staleAi.result).toBe("IGNORE_NOT_ALLOWED");
    expect(staleAi.snapshot.extended.rimChat?.messages.at(-1)).toEqual({ kind: "RIM", text: "ok" });
  });

  it("REAL TWO-USER RIM DELIVERY creates one receiver INCOMING_BAN for the selected proposal", async () => {
    const rimE10 = MATRIX_CONTRACT_ROWS.filter(
      (row) => row.state === "CREATE_BAN.CONFIRM.RIM" && row.eventId === "E-10",
    );
    expect(rimE10).toHaveLength(1);
    expect(rimE10[0]?.effects.map((effect) => effect.type)).toEqual([
      "UPSERT_BAN",
      "UPSERT_NOTIFICATION_ITEM",
      "CLEAR_OPERATION",
      "SET_CREATE_BAN_DRAFT",
      "SET_FROZEN_RIM_CHAT",
      "SET_RIM_CHAT",
      "SET_CONTROL_STATE",
    ]);
    const contactE10 = MATRIX_CONTRACT_ROWS.find(
      (row) => row.state === "CREATE_BAN.CONFIRM.CONTACT" && row.eventId === "E-10",
    );
    expect(contactE10?.effects.map((effect) => effect.type)).toEqual([
      "UPSERT_BAN",
      "UPSERT_NOTIFICATION_ITEM",
      "CLEAR_OPERATION",
      "MARK_OPERATION_RESULT_APPLIED",
      "SET_CONTROL_STATE",
    ]);

    const selectedText = "не опаздывать";
    const app = await start([
      {
        kind: "BAN_PROPOSALS",
        message: "вот три",
        proposals: [
          { banText: "не срать и ссать", executionProbability: 0.1 as ExecutionProbability },
          { banText: selectedText, executionProbability: 0.4 as ExecutionProbability },
          { banText: "запрет три", executionProbability: 0.9 as ExecutionProbability },
        ],
      },
    ]);
    const userA = contactId(app, USER_A_TG);
    const userB = contactId(app, USER_B_TG);
    const beforeB = await snapshot(app.url, USER_B_TG);
    expect(beforeB.currentUserId).toBe(userB);
    expect(beforeB.currentUserId).not.toBe(userA);
    expect(incomingOf(beforeB)).toEqual([]);

    const opened = await session(app.url, USER_A_TG);
    expect(opened.controlState).toBe("RIM.LOBBY");
    expect(opened.currentUserId).toBe(userA);
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    const ready = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: userB });
    expect(ready.rimChat?.selectedContactId).toBe(userB);

    await dispatch(app.url, USER_A_TG, "RIM.CHANGE_INPUT_DRAFT", { inputDraft: "предложи" });
    const proposed = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SEND");
    const proposals = proposed.rimChat?.messages.at(-1);
    expect(proposals?.kind).toBe("BAN_PROPOSALS");
    if (proposals?.kind !== "BAN_PROPOSALS") return;
    const selected = proposals.proposals.find((item) => item.banText === selectedText);
    expect(selected?.proposalId).toBeTruthy();
    const proposalId = selected!.proposalId;

    const what = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SUGGESTION_FORBID", {
      rimChatId: proposed.rimChat?.id,
      proposalId,
    });
    expect(what.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(what.createBanDraft?.proposalId).toBe(proposalId);
    expect(what.createBanDraft?.banText).toBe(selectedText);
    expect(what.createBanDraft?.selectedContactId).toBe(userB);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 });
    const confirm = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.RIM");

    const forbidResponse = await fetch(`${app.url}/api/events`, {
      method: "POST",
      headers: authHeaders(USER_A_TG),
      body: JSON.stringify({ name: "CREATE_BAN.PRESS_FORBID", payload: {} }),
    });
    const forbidBody = (await forbidResponse.json()) as {
      diagnostics?: TestUiDiagnostics;
      orchestration?: {
        userEvent: { pendingOperationId: string | null; eventName: string };
        serverEvent: { eventName: string };
      };
    };
    expect(forbidResponse.status, JSON.stringify(forbidBody)).toBe(200);
    const success = forbidBody.diagnostics!;
    expect(forbidBody.orchestration?.userEvent.eventName).toBe("CREATE_BAN.PRESS_FORBID");
    expect(forbidBody.orchestration?.serverEvent.eventName).toBe("CREATE_BAN.SEND_CONFIRMED");
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(success.currentUserId).toBe(userA);
    expect(success.createBanDraft).toBeNull();
    expect(success.rimChat).toBeNull();
    expect(success.savedFrozenRimChatPresent).toBe(false);
    expect(success.effects).toEqual(
      expect.arrayContaining([
        "UPSERT_BAN",
        "UPSERT_NOTIFICATION_ITEM",
        "CLEAR_OPERATION",
        "SET_CREATE_BAN_DRAFT",
        "SET_FROZEN_RIM_CHAT",
        "SET_RIM_CHAT",
        "SET_CONTROL_STATE",
      ]),
    );
    const created = bansOf(success).find((ban) => ban.sourceProposalId === proposalId);
    expect(created).toBeTruthy();
    expect(created?.receiverId).toBe(userB);
    expect(created?.senderId).toBe(userA);
    expect(created?.banText).toBe(selectedText);
    expect(created?.sourceProposalId).toBe(proposalId);
    expect(success.successfulBanId).toBe(created?.id);
    expect(bansOf(success).filter((ban) => ban.banText === selectedText)).toHaveLength(1);

    const reloadedA = await snapshot(app.url, USER_A_TG);
    expect(reloadedA.currentUserId).toBe(userA);
    expect(reloadedA.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(reloadedA.rimChat).toBeNull();
    expect(reloadedA.savedFrozenRimChatPresent).toBe(false);
    expect(reloadedA.successfulBanId).toBe(created?.id);
    expect(bansOf(reloadedA).find((ban) => ban.id === created?.id)?.sourceProposalId).toBe(
      proposalId,
    );
    const back = await dispatch(app.url, USER_A_TG, "RIM.PRESS_BACK");
    expect(back.rimChat).toBeNull();
    expect(back.savedFrozenRimChatPresent).toBe(false);
    expect(back.controlState).not.toBe("RIM.CHAT");

    const openedB = await session(app.url, USER_B_TG);
    expect(openedB.currentUserId).toBe(userB);
    expect(openedB.currentUserId).not.toBe(userA);
    const delivered = incomingOf(openedB).filter((item) => item.banId === created?.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.ownerId).toBe(userB);
    expect(incomingOf(openedB).filter((item) => item.kind === "INCOMING_BAN")).toHaveLength(1);
    const banForB = bansOf(openedB).find((ban) => ban.id === created?.id);
    expect(banForB?.banText).toBe(selectedText);
    expect(banForB?.senderId).toBe(userA);
    expect(banForB?.receiverId).toBe(userB);
    expect(banForB?.sourceProposalId).toBe(proposalId);

    const reloadedB = await snapshot(app.url, USER_B_TG);
    expect(reloadedB.currentUserId).toBe(userB);
    const persisted = incomingOf(reloadedB).filter((item) => item.banId === created?.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(delivered[0]?.id);
    expect(persisted[0]?.ownerId).toBe(userB);
    expect(bansOf(reloadedB).find((ban) => ban.id === created?.id)?.banText).toBe(selectedText);

    const operationId = forbidBody.orchestration?.userEvent.pendingOperationId;
    expect(operationId).toBeTruthy();
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const duplicate = await executeAuthenticatedEvent(app.runtime, context, {
      name: "CREATE_BAN.SEND_CONFIRMED",
      payload: { operationId, createdBanId: created?.id },
    });
    expect(duplicate.outcome).not.toBe("APPLIED");
    const afterReplay = await snapshot(app.url, USER_B_TG);
    const replayed = incomingOf(afterReplay).filter((item) => item.banId === created?.id);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.id).toBe(delivered[0]?.id);
  });
});
