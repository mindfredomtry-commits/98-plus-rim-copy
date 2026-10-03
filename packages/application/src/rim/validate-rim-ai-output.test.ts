import { describe, expect, it } from "vitest";
import { counterAllocator, type AiRequestId, type RimMessage } from "@98plus/product-model";
import type { ApplicationExecutionResult } from "../execute.ts";
import {
  authContext,
  eventOf,
  openLobby,
  productApp,
  RECEIVER_ID,
  SENDER_ID,
} from "../test-harness.ts";
import { continueRimEffects, type RimContextFailures } from "./continue-rim.ts";
import { FakeRimAiAdapter, FakeRimAiFailure } from "./fake-rim-ai-adapter.ts";
import type { RimAiPort, RimAiRequest, RimAiResponseObserver } from "./rim-ai-port.ts";
import type { ProviderResponseId } from "./rim-provider-runtime.ts";
import { applicableRimProviderRuntime, parseRimProviderRuntime } from "./rim-provider-runtime.ts";
import { RIM_AI_OUTPUT_INVALID, type RimAiOutputRejection } from "./validate-rim-ai-output.ts";

const VALID_PROPOSALS = [
  { banText: "  не обсуждать работу  ", executionProbability: 0, proposalId: "provider-1" },
  { banText: "не опаздывать", executionProbability: 0.5, proposalId: "provider-2" },
  { banText: "не повышать голос", executionProbability: 1 },
];

function proposalIds(messages: readonly RimMessage[]): string[] {
  return messages.flatMap((message) =>
    message.kind === "BAN_PROPOSALS" ? message.proposals.map((item) => item.proposalId) : [],
  );
}

function userMessages(messages: readonly RimMessage[]): RimMessage[] {
  return messages.filter((message) => message.kind === "USER");
}

function rimTools(
  store: Awaited<ReturnType<typeof productApp>>["store"],
  rimAi: RimAiPort,
  contextFailures: RimContextFailures = { remainingFailures: 0 },
) {
  return {
    context: authContext(SENDER_ID, "tg-sender"),
    deps: {
      store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(1),
    },
    rimAi,
    contextFailures,
    loadSources: async () => [],
  };
}

function portReturning(output: unknown, seen: RimAiRequest[] = []): RimAiPort {
  return {
    async respond(request) {
      seen.push(request);
      return output as Awaited<ReturnType<RimAiPort["respond"]>>;
    },
  };
}

async function readyChat() {
  const app = await productApp();
  await openLobby(app.sender);
  await app.sender(eventOf("RIM.PRESS_START_CHAT"));
  await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
  const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
  const ready = await continueRimEffects(selected, rimTools(app.store, portReturning(null)));
  expect(ready.status).toBe("APPLIED");
  expect(ready.snapshot.extended.rimChat?.relationshipContext?.status).toBe("ready");
  expect(ready.snapshot.extended.rimChat?.askRimOrigin).toBeNull();
  return app;
}

async function sendOutput(output: unknown, text = "привет") {
  const app = await readyChat();
  const seen: RimAiRequest[] = [];
  await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: text }));
  const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
  expect(sent.status).toBe("APPLIED");
  expect(sent.pendingExternalEffects[0]?.effect.type).toBe("REQUEST_RIM_AI");
  const settled = await continueRimEffects(sent, rimTools(app.store, portReturning(output, seen)));
  return { app, seen, sent, settled };
}

function chatOf(result: ApplicationExecutionResult) {
  const chat = result.snapshot.extended.rimChat;
  if (!chat) {
    throw new Error("expected a RIM Chat");
  }
  return chat;
}

function assertValidationFailure(
  settled: ApplicationExecutionResult,
  reason: RimAiOutputRejection,
  userText = "привет",
) {
  expect(settled.status).toBe("APPLIED");
  expect(settled.event.name).toBe("RIM.AI_REQUEST_FAILED");
  expect(settled.traces.some((trace) => trace.eventId === "E-58")).toBe(false);
  expect(settled.traces.some((trace) => trace.eventId === "E-59")).toBe(true);
  const chat = chatOf(settled);
  expect(chat.aiOperation.status).toBe("FAILED");
  if (chat.aiOperation.status !== "FAILED") {
    return chat;
  }
  expect(chat.aiOperation.failure).toMatchObject({
    code: RIM_AI_OUTPUT_INVALID,
    message: reason,
  });
  expect(chat.messages.at(-1)).toEqual({ kind: "USER", text: userText });
  expect(userMessages(chat.messages)).toEqual([{ kind: "USER", text: userText }]);
  expect(chat.messages.some((message) => message.kind === "BAN_PROPOSALS")).toBe(false);
  expect(proposalIds(chat.messages)).toEqual([]);
  return chat;
}

const invalidCases: ReadonlyArray<{
  name: string;
  output: unknown;
  reason: RimAiOutputRejection;
}> = [
  {
    name: "unknown response type",
    output: { type: "STREAM", text: "позже" },
    reason: "response-type",
  },
  { name: "missing response type", output: { text: "просто текст" }, reason: "response-type" },
  {
    name: "disagreeing type and kind",
    output: { type: "MESSAGE", kind: "BAN_PROPOSALS", text: "спор" },
    reason: "response-type",
  },
  { name: "non-object output", output: "MESSAGE hello", reason: "not-an-object" },
  { name: "missing MESSAGE text", output: { type: "MESSAGE" }, reason: "message-text" },
  { name: "empty MESSAGE text", output: { kind: "MESSAGE", text: "" }, reason: "message-text" },
  {
    name: "whitespace MESSAGE text",
    output: { kind: "MESSAGE", text: "   " },
    reason: "message-text",
  },
  {
    name: "non-string MESSAGE text",
    output: { kind: "MESSAGE", text: 12 },
    reason: "message-text",
  },
  {
    name: "missing BAN_PROPOSALS message",
    output: { type: "BAN_PROPOSALS", proposals: VALID_PROPOSALS },
    reason: "ban-message",
  },
  {
    name: "empty BAN_PROPOSALS message",
    output: { kind: "BAN_PROPOSALS", message: "", proposals: VALID_PROPOSALS },
    reason: "ban-message",
  },
  {
    name: "whitespace BAN_PROPOSALS message",
    output: { kind: "BAN_PROPOSALS", message: "  \n", proposals: VALID_PROPOSALS },
    reason: "ban-message",
  },
  {
    name: "one proposal",
    output: {
      kind: "BAN_PROPOSALS",
      message: "мало",
      proposals: [VALID_PROPOSALS[0]],
    },
    reason: "proposal-count",
  },
  {
    name: "two proposals",
    output: {
      kind: "BAN_PROPOSALS",
      message: "мало",
      proposals: [VALID_PROPOSALS[0], VALID_PROPOSALS[1]],
    },
    reason: "proposal-count",
  },
  {
    name: "four proposals",
    output: {
      kind: "BAN_PROPOSALS",
      message: "много",
      proposals: [...VALID_PROPOSALS, { banText: "четвёртый", executionProbability: 0.2 }],
    },
    reason: "proposal-count",
  },
  {
    name: "missing banText",
    output: {
      kind: "BAN_PROPOSALS",
      message: "текст",
      proposals: [{ executionProbability: 0.2 }, VALID_PROPOSALS[1], VALID_PROPOSALS[2]],
    },
    reason: "proposal-ban-text",
  },
  {
    name: "empty banText",
    output: {
      kind: "BAN_PROPOSALS",
      message: "текст",
      proposals: [
        VALID_PROPOSALS[0],
        { banText: "   ", executionProbability: 0.4 },
        VALID_PROPOSALS[2],
      ],
    },
    reason: "proposal-ban-text",
  },
  {
    name: "missing executionProbability",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [VALID_PROPOSALS[0], { banText: "не молчать" }, VALID_PROPOSALS[2]],
    },
    reason: "proposal-probability",
  },
  {
    name: "string executionProbability",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [
        VALID_PROPOSALS[0],
        VALID_PROPOSALS[1],
        { banText: "не молчать", executionProbability: "0.4" },
      ],
    },
    reason: "proposal-probability",
  },
  {
    name: "NaN executionProbability",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [
        { banText: "не молчать", executionProbability: Number.NaN },
        VALID_PROPOSALS[1],
        VALID_PROPOSALS[2],
      ],
    },
    reason: "proposal-probability",
  },
  {
    name: "infinite executionProbability",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [
        VALID_PROPOSALS[0],
        { banText: "не молчать", executionProbability: Number.POSITIVE_INFINITY },
        VALID_PROPOSALS[2],
      ],
    },
    reason: "proposal-probability",
  },
  {
    name: "negative executionProbability",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [
        VALID_PROPOSALS[0],
        VALID_PROPOSALS[1],
        { banText: "не молчать", executionProbability: -0.01 },
      ],
    },
    reason: "proposal-probability",
  },
  {
    name: "executionProbability above one",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [
        VALID_PROPOSALS[0],
        VALID_PROPOSALS[1],
        { banText: "не молчать", executionProbability: 1.01 },
      ],
    },
    reason: "proposal-probability",
  },
  {
    name: "null executionProbability",
    output: {
      kind: "BAN_PROPOSALS",
      message: "вероятность",
      proposals: [
        VALID_PROPOSALS[0],
        { banText: "не молчать", executionProbability: null },
        VALID_PROPOSALS[2],
      ],
    },
    reason: "proposal-probability",
  },
];

describe("RIM AI output validation gate", () => {
  it("accepts a valid MESSAGE and dispatches E-58", async () => {
    const { seen, settled } = await sendOutput({ type: "MESSAGE", text: "  слышу  тебя  " });
    expect(settled.status).toBe("APPLIED");
    expect(settled.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(settled.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    const chat = chatOf(settled);
    expect(chat.aiOperation.status).toBe("IDLE");
    expect(chat.messages.at(-1)).toEqual({ kind: "RIM", text: "  слышу  тебя  " });
    expect(userMessages(chat.messages)).toEqual([{ kind: "USER", text: "привет" }]);
    expect(proposalIds(chat.messages)).toEqual([]);
    expect(seen[0]).toMatchObject({
      userMessage: "привет",
      conversationalOrigin: null,
    });
  });

  it("accepts BAN_PROPOSALS with exactly three proposals and mints application ids", async () => {
    const { settled } = await sendOutput({
      type: "BAN_PROPOSALS",
      kind: "BAN_PROPOSALS",
      message: "  вот три  ",
      proposals: VALID_PROPOSALS,
    });
    expect(settled.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    const chat = chatOf(settled);
    const message = chat.messages.at(-1);
    expect(message?.kind).toBe("BAN_PROPOSALS");
    if (message?.kind !== "BAN_PROPOSALS") {
      return;
    }
    expect(message.message).toBe("  вот три  ");
    expect(message.proposals.map((item) => item.banText)).toEqual([
      "  не обсуждать работу  ",
      "не опаздывать",
      "не повышать голос",
    ]);
    expect(message.proposals.map((item) => item.executionProbability)).toEqual([0, 0.5, 1]);
    expect(new Set(message.proposals.map((item) => item.proposalId)).size).toBe(3);
    expect(message.proposals.map((item) => item.proposalId)).not.toContain("provider-1");
    expect(message.proposals.map((item) => item.proposalId)).not.toContain("provider-2");
    expect(chat.aiOperation.status).toBe("IDLE");
  });

  it("accepts duplicate banText without semantic grading", async () => {
    const { settled } = await sendOutput({
      kind: "BAN_PROPOSALS",
      message: "три",
      proposals: [
        { banText: "не кричать", executionProbability: 0.1 },
        { banText: "не кричать", executionProbability: 0.2 },
        { banText: "не кричать", executionProbability: 0.3 },
      ],
    });
    expect(settled.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    const message = chatOf(settled).messages.at(-1);
    expect(message?.kind).toBe("BAN_PROPOSALS");
    if (message?.kind !== "BAN_PROPOSALS") {
      return;
    }
    expect(message.proposals).toHaveLength(3);
    expect(new Set(proposalIds(chatOf(settled).messages)).size).toBe(3);
  });

  it.each(invalidCases)(
    "rejects $name through E-59 without proposalId",
    async ({ output, reason }) => {
      const { settled } = await sendOutput(output);
      assertValidationFailure(settled, reason);
    },
  );

  it("does not resubmit the USER turn when E-54 follows a validation failure", async () => {
    const app = await readyChat();
    const seen: RimAiRequest[] = [];
    const tools = rimTools(app.store, {
      async respond(request) {
        seen.push(request);
        return {
          kind: "BAN_PROPOSALS",
          message: "сломан",
          proposals: [VALID_PROPOSALS[0]],
        } as unknown as Awaited<ReturnType<RimAiPort["respond"]>>;
      },
    });
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "почему так" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    const failed = await continueRimEffects(sent, tools);
    const failedChat = assertValidationFailure(failed, "proposal-count", "почему так");
    expect(failedChat.aiOperation.status).toBe("FAILED");
    if (failedChat.aiOperation.status !== "FAILED") {
      return;
    }
    const failedRequestId = failedChat.aiOperation.requestId;
    const before = await app.store.loadProductSnapshot(SENDER_ID);
    const beforeRuntime = applicableRimProviderRuntime(
      parseRimProviderRuntime(before.rimProviderRuntime),
      failedChat.id,
    );
    expect(beforeRuntime?.continuityMode).toBe("provider-conversation");
    expect(beforeRuntime?.retiredAttemptId).toBeNull();
    expect(beforeRuntime?.attempt?.submissionState).toBe("returned-body-observed");
    expect(beforeRuntime?.attempt?.requestId).toBe(failedRequestId);
    const attemptId = beforeRuntime?.attempt?.attemptId;
    const retried = await app.sender(
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: failedRequestId as AiRequestId }),
    );
    expect(retried.status).toBe("APPLIED");
    expect(retried.traces.some((trace) => trace.eventId === "E-54")).toBe(true);
    expect(retried.pendingExternalEffects[0]?.effect.type).toBe("REQUEST_RIM_AI");
    expect(retried.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: failedRequestId,
    });
    expect(userMessages(chatOf(retried).messages)).toEqual([{ kind: "USER", text: "почему так" }]);
    const followed = await continueRimEffects(retried, tools);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe(failedRequestId);
    if (seen[0]?.continuityMode !== "provider-conversation") {
      throw new Error("expected provider continuation");
    }
    expect(seen[0].userMessage).toBe("почему так");
    expect(followed.event.name).toBe("RIM.PRESS_RETRY_AI");
    expect(followed.traces.some((trace) => trace.eventId === "E-58")).toBe(false);
    expect(followed.traces.some((trace) => trace.eventId === "E-64")).toBe(false);
    expect(followed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    const chat = chatOf(followed);
    expect(chat.aiOperation).toMatchObject({ status: "PENDING", requestId: failedRequestId });
    expect(userMessages(chat.messages)).toEqual([{ kind: "USER", text: "почему так" }]);
    expect(chat.messages.at(-1)).toEqual({ kind: "USER", text: "почему так" });
    const after = await app.store.loadProductSnapshot(SENDER_ID);
    const afterRuntime = applicableRimProviderRuntime(
      parseRimProviderRuntime(after.rimProviderRuntime),
      chat.id,
    );
    expect(afterRuntime?.continuityMode).toBe("provider-conversation");
    expect(afterRuntime?.retiredAttemptId).toBeNull();
    expect(afterRuntime?.attempt).toMatchObject({
      submissionState: "returned-body-observed",
      attemptId,
      requestId: failedRequestId,
    });
    expect(afterRuntime?.attempt).not.toHaveProperty("responseId");
  });

  it("keeps FakeRimAiAdapter on the ordinary RIM Chat path", async () => {
    const app = await readyChat();
    const fake = new FakeRimAiAdapter();
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    const messaged = await continueRimEffects(sent, rimTools(app.store, fake));
    expect(messaged.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(chatOf(messaged).messages.at(-1)).toEqual({ kind: "RIM", text: "привет" });
    expect(chatOf(messaged).askRimOrigin).toBeNull();

    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "предложи запреты" }));
    const proposedSend = await app.sender(eventOf("RIM.PRESS_SEND"));
    const proposed = await continueRimEffects(proposedSend, rimTools(app.store, fake));
    expect(proposed.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    const message = chatOf(proposed).messages.at(-1);
    expect(message?.kind).toBe("BAN_PROPOSALS");
    if (message?.kind !== "BAN_PROPOSALS") {
      return;
    }
    expect(message.message).toBe("три запрета");
    expect(message.proposals.map((item) => item.banText)).toEqual([
      "не обсуждать работу",
      "не опаздывать",
      "не повышать голос",
    ]);
    expect(new Set(message.proposals.map((item) => item.proposalId)).size).toBe(3);
    expect(userMessages(chatOf(proposed).messages)).toEqual([
      { kind: "USER", text: "привет" },
      { kind: "USER", text: "предложи запреты" },
    ]);
  });

  it("completes a thrown provider call through local history instead of E-59", async () => {
    const app = await readyChat();
    const fake = new FakeRimAiAdapter([
      {
        kind: "FAILURE",
        failure: { code: "RIM_AI_FAILED", message: "provider down" } as never,
      },
    ]);
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    const failed = await continueRimEffects(sent, rimTools(app.store, fake));
    expect(failed.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(failed.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(failed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(failed.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    const chat = chatOf(failed);
    expect(chat.aiOperation.status).toBe("IDLE");
    expect(chat.messages.at(-1)).toEqual({ kind: "RIM", text: "привет" });
    expect(proposalIds(chat.messages)).toEqual([]);
    expect(userMessages(chat.messages)).toHaveLength(1);
    const runtime = applicableRimProviderRuntime(
      parseRimProviderRuntime((await app.store.loadProductSnapshot(SENDER_ID)).rimProviderRuntime),
      chat.id,
    );
    expect(runtime?.continuityMode).toBe("local-canonical-history");
    expect(runtime?.attempt?.submissionState).toBe("returned-body-observed");
    expect(runtime?.retiredAttemptId).toBeTruthy();
    expect(runtime?.attempt?.attemptId).not.toBe(runtime?.retiredAttemptId);
  });

  it("scripts a response id before the body or a throw, and omits it when unset", async () => {
    const observed: string[] = [];
    const observer: RimAiResponseObserver = {
      async onResponseCreated(responseId: ProviderResponseId) {
        observed.push(responseId);
        return { accepted: true };
      },
    };
    const request = {} as RimAiRequest;
    const failure = { code: "RIM_AI_FAILED", message: "lost" } as never;
    const withBody = new FakeRimAiAdapter([
      { kind: "MESSAGE", text: "готово", responseId: "resp-1" },
    ]);
    await expect(withBody.respond(request, observer)).resolves.toEqual({
      kind: "MESSAGE",
      text: "готово",
    });
    const thenThrow = new FakeRimAiAdapter([{ kind: "FAILURE", failure, responseId: "resp-2" }]);
    await expect(thenThrow.respond(request, observer)).rejects.toBeInstanceOf(FakeRimAiFailure);
    const beforeId = new FakeRimAiAdapter([{ kind: "FAILURE", failure }]);
    await expect(beforeId.respond(request, observer)).rejects.toBeInstanceOf(FakeRimAiFailure);
    const legacy = new FakeRimAiAdapter([{ kind: "MESSAGE", text: "без" }]);
    await expect(legacy.respond(request, observer)).resolves.toEqual({
      kind: "MESSAGE",
      text: "без",
    });
    expect(observed).toEqual(["resp-1", "resp-2"]);
  });
});
