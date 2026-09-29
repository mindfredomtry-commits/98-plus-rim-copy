import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  type ExecutionProbability,
  type ThreeSuggestions,
} from "@98plus/product-model";
import { FakeRimAiAdapter, type FakeRimAiStep } from "@98plus/application";
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

async function start(steps: readonly FakeRimAiStep[] = [], contextFailures = 0) {
  const runtime = createCreateBanContactRuntime({
    rimAi: new FakeRimAiAdapter(steps),
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

describe("Feature 8 RIM vertical", () => {
  it("keeps the frozen engine counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(57);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(342);
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
    expect(chat.rimChat?.selectedContactId).toBeNull();
    expect(chat.rimChat?.askRimOrigin).toBeNull();
    expect(chat.rimChat?.messages[0]).toEqual({
      kind: "RIM",
      text: "выбери человека и я предложу новые запреты",
    });
    const chatId = chat.rimChat?.id;

    const selecting = await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT");
    expect(selecting.controlState).toBe("RIM.SELECT_CONTACT");
    const ready = await dispatch(app.url, USER_A_TG, "RIM.SELECT_CONTACT", { contactId: other });
    expect(ready.controlState).toBe("RIM.CHAT");
    expect(ready.rimChat?.id).toBe(chatId);
    expect(ready.rimChat?.selectedContactId).toBe(other);
    expect(ready.rimChat?.relationshipContext?.status).toBe("ready");
    expect(
      ready.rimChat?.messages.some(
        (message) => message.kind === "RIM" && message.text.includes("я могу предложить 3 запрета"),
      ),
    ).toBe(true);
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

  it("retries a failed context build and a failed AI call on the same logical request", async () => {
    const app = await start(
      [
        { kind: "FAILURE", failure: { code: "RIM_AI_FAILED" } as never },
        { kind: "MESSAGE", text: "повтор" },
      ],
      1,
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
    expect(aiFailed.rimChat?.aiOperation.status).toBe("FAILED");
    const requestId =
      aiFailed.rimChat?.aiOperation.status === "FAILED"
        ? aiFailed.rimChat.aiOperation.requestId
        : null;
    const userMessages = aiFailed.rimChat?.messages.filter((message) => message.kind === "USER");
    expect(userMessages).toHaveLength(1);
    const recovered = await dispatch(app.url, USER_A_TG, "RIM.PRESS_RETRY_AI", {
      failedRequestId: requestId,
    });
    expect(recovered.rimChat?.aiOperation.status).toBe("IDLE");
    expect(recovered.rimChat?.messages.filter((message) => message.kind === "USER")).toHaveLength(
      1,
    );
    expect(recovered.rimChat?.messages.at(-1)).toEqual({ kind: "RIM", text: "повтор" });
    expect(
      recovered.rimChat?.aiOperation.status === "IDLE" ||
        recovered.rimChat?.aiOperation.status === "FAILED"
        ? requestId
        : null,
    ).toBe(requestId);
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
});
