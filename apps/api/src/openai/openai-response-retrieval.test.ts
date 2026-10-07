import { describe, expect, it } from "vitest";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  RIM_AI_OUTPUT_INVALID,
  validateRimAiOutput,
  type ProviderConversationId,
  type ProviderResponseId,
  type RimAiRequest,
  type RimProviderAttemptId,
  type RimProviderRuntime,
} from "@98plus/application";
import type { RimChat } from "@98plus/product-model";
import { grantContactBetweenTelegramUsers } from "../seed-contact.ts";
import { executeIncomingOverboardVertical } from "../overboard.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  openLobbyIfNeeded,
  seedRegisteredUsers,
  userIdOf,
} from "../runtime.ts";
import {
  OpenAiResponseRetriever,
  type OpenAiRetrievedResponse,
} from "./openai-response-retrieval.ts";

const RESPONSE_ID = "resp_known_durable" as ProviderResponseId;
const OTHER_ID = "resp_other_provider";
const SECRET = "test-secret";

const MESSAGE = { type: "MESSAGE", text: "слышу" };
const PROPOSALS = {
  type: "BAN_PROPOSALS",
  message: "три запрета",
  proposals: [
    { banText: "не обсуждать работу", executionProbability: 0.2 },
    { banText: "не опаздывать", executionProbability: 0.5 },
    { banText: "не повышать голос", executionProbability: 0.8 },
  ],
};

type RecordedRetrieve = {
  responseId: string;
  options: { maxRetries?: number; idempotencyKey?: string; timeout?: number };
};

function envelope(output: unknown): string {
  return JSON.stringify({ output });
}

function recording(response: OpenAiRetrievedResponse | Error) {
  const calls: RecordedRetrieve[] = [];
  let creates = 0;
  let conversations = 0;
  const client = {
    responses: {
      async retrieve(responseId: string, options: { maxRetries: 0 }) {
        calls.push({ responseId, options });
        if (response instanceof Error) {
          throw response;
        }
        return response;
      },
      async create() {
        creates += 1;
        return { id: "resp_created" };
      },
    },
    conversations: {
      async create() {
        conversations += 1;
        return { id: "conv_created" };
      },
    },
  };
  return {
    calls,
    creates: () => creates,
    conversations: () => conversations,
    client,
  };
}

function retrieverFor(response: OpenAiRetrievedResponse | Error) {
  const transport = recording(response);
  return { transport, retriever: new OpenAiResponseRetriever(transport.client) };
}

describe("OpenAiResponseRetriever", () => {
  it("retrieves the requested response once with maxRetries 0", async () => {
    const { transport, retriever } = retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(MESSAGE),
    });
    const result = await retriever.retrieve(RESPONSE_ID);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.responseId).toBe(RESPONSE_ID);
    expect(transport.calls[0]?.options).toEqual({ maxRetries: 0 });
    expect(Object.keys(transport.calls[0]?.options ?? {})).toEqual(["maxRetries"]);
    expect(Object.hasOwn(transport.calls[0]?.options ?? {}, "idempotencyKey")).toBe(false);
    expect(Object.hasOwn(transport.calls[0]?.options ?? {}, "timeout")).toBe(false);
    expect(transport.creates()).toBe(0);
    expect(transport.conversations()).toBe(0);
    expect(JSON.stringify(transport.calls)).not.toContain("semantic-user");
    expect(result).toEqual({
      responseId: RESPONSE_ID,
      providerStatus: "completed",
      output: MESSAGE,
    });
  });

  it("maps queued and in_progress without output", async () => {
    for (const status of ["queued", "in_progress"] as const) {
      const { transport, retriever } = retrieverFor({
        id: RESPONSE_ID,
        status,
        output_text: envelope(MESSAGE),
      });
      const result = await retriever.retrieve(RESPONSE_ID);
      expect(transport.calls).toHaveLength(1);
      expect(result).toEqual({ responseId: RESPONSE_ID, providerStatus: status });
      expect(result && "output" in result).toBe(false);
      expect(transport.creates()).toBe(0);
    }
  });

  it("maps failed, cancelled, and incomplete without a canonical body", async () => {
    for (const status of ["failed", "cancelled", "incomplete"] as const) {
      const { transport, retriever } = retrieverFor({
        id: RESPONSE_ID,
        status,
        output_text: envelope(MESSAGE),
      });
      const result = await retriever.retrieve(RESPONSE_ID);
      expect(transport.calls).toHaveLength(1);
      expect(result).toEqual({ responseId: RESPONSE_ID, providerStatus: status });
      expect(result && "output" in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain("слышу");
      expect(transport.creates()).toBe(0);
    }
  });

  it("returns null for an unknown provider status", async () => {
    const { transport, retriever } = retrieverFor({
      id: RESPONSE_ID,
      status: "expired",
      output_text: envelope(MESSAGE),
    });
    await expect(retriever.retrieve(RESPONSE_ID)).resolves.toBeNull();
    expect(transport.calls).toHaveLength(1);
    expect(transport.creates()).toBe(0);
    expect(transport.conversations()).toBe(0);
  });

  it("returns the raw completed candidate without repairing it", async () => {
    const message = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(MESSAGE),
    }).retriever.retrieve(RESPONSE_ID);
    expect(message?.output).toEqual(MESSAGE);
    expect(validateRimAiOutput(message?.output)).toEqual({
      ok: true,
      result: { kind: "MESSAGE", text: "слышу" },
    });

    const ban = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(PROPOSALS),
    }).retriever.retrieve(RESPONSE_ID);
    expect(ban?.output).toEqual(PROPOSALS);
    expect(JSON.stringify(ban?.output)).not.toContain("proposalId");
    expect(JSON.stringify(ban?.output)).not.toContain("duration");
    expect(validateRimAiOutput(ban?.output)).toEqual({
      ok: true,
      result: { kind: "BAN_PROPOSALS", message: PROPOSALS.message, proposals: PROPOSALS.proposals },
    });

    const short = {
      type: "BAN_PROPOSALS",
      message: "мало",
      proposals: [{ banText: "один", executionProbability: 0.4 }],
    };
    const unrepaired = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(short),
    }).retriever.retrieve(RESPONSE_ID);
    expect(unrepaired?.providerStatus).toBe("completed");
    expect(unrepaired?.output).toEqual(short);
    expect(validateRimAiOutput(unrepaired?.output)).toEqual({
      ok: false,
      reason: "proposal-count",
    });

    const high = {
      type: "BAN_PROPOSALS",
      message: "выше",
      proposals: [
        { banText: "а", executionProbability: 1.5 },
        { banText: "б", executionProbability: 0.2 },
        { banText: "в", executionProbability: 0.3 },
      ],
    };
    const unclamped = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(high),
    }).retriever.retrieve(RESPONSE_ID);
    expect(unclamped?.output).toEqual(high);
    expect(validateRimAiOutput(unclamped?.output)).toEqual({
      ok: false,
      reason: "proposal-probability",
    });

    const blank = { type: "MESSAGE", text: "   " };
    const invalidMessage = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(blank),
    }).retriever.retrieve(RESPONSE_ID);
    expect(invalidMessage?.output).toEqual(blank);
    expect(validateRimAiOutput(invalidMessage?.output)).toEqual({
      ok: false,
      reason: "message-text",
    });

    const malformed = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: "not-json{",
    }).retriever.retrieve(RESPONSE_ID);
    expect(malformed).toEqual({
      responseId: RESPONSE_ID,
      providerStatus: "completed",
      output: "not-json{",
    });
    expect(validateRimAiOutput(malformed?.output)).toEqual({ ok: false, reason: "not-an-object" });

    const missing = JSON.stringify({ type: "MESSAGE", text: "без конверта" });
    const unwrapped = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
      output_text: missing,
    }).retriever.retrieve(RESPONSE_ID);
    expect(unwrapped?.output).toBe(missing);
    expect(validateRimAiOutput(unwrapped?.output)).toEqual({ ok: false, reason: "not-an-object" });

    const absent = await retrieverFor({
      id: RESPONSE_ID,
      status: "completed",
    }).retriever.retrieve(RESPONSE_ID);
    expect(absent).toEqual({
      responseId: RESPONSE_ID,
      providerStatus: "completed",
      output: null,
    });
    expect(validateRimAiOutput(absent?.output)).toEqual({ ok: false, reason: "not-an-object" });
  });

  it("fails closed when the provider id does not match", async () => {
    const mismatch = retrieverFor({
      id: OTHER_ID,
      status: "completed",
      output_text: envelope(MESSAGE),
    });
    await expect(mismatch.retriever.retrieve(RESPONSE_ID)).resolves.toBeNull();
    expect(mismatch.transport.calls).toEqual([
      { responseId: RESPONSE_ID, options: { maxRetries: 0 } },
    ]);
    expect(mismatch.transport.creates()).toBe(0);
    expect(JSON.stringify(mismatch.transport.calls)).not.toContain(OTHER_ID);

    const missing = retrieverFor({ status: "completed", output_text: envelope(MESSAGE) });
    await expect(missing.retriever.retrieve(RESPONSE_ID)).resolves.toBeNull();
    expect(missing.transport.calls).toHaveLength(1);
    expect(missing.transport.creates()).toBe(0);
  });

  it("propagates a provider exception without a second retrieve or generation", async () => {
    const { transport, retriever } = retrieverFor(new Error("socket closed"));
    await expect(retriever.retrieve(RESPONSE_ID)).rejects.toThrow("socket closed");
    expect(transport.calls).toHaveLength(1);
    expect(transport.creates()).toBe(0);
    expect(transport.conversations()).toBe(0);
  });
});

function knownRuntime(chat: RimChat, responseId: ProviderResponseId): RimProviderRuntime {
  if (chat.aiOperation.status !== "PENDING" || !chat.selectedContactId) {
    throw new Error("expected a pending RIM chat");
  }
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    contextRequestId: chat.aiOperation.snapshot.contextRequestId,
    initialization: {
      submissionState: "stored",
      attemptId: "init-retrieval" as RimProviderAttemptId,
      conversationId: "conv-retrieval" as ProviderConversationId,
      clientRequestId: null,
    },
    attempt: {
      requestId: chat.aiOperation.requestId,
      attemptId: "attempt-retrieval" as RimProviderAttemptId,
      submissionState: "response-id-known",
      responseId,
      clientRequestId: null,
    },
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

async function pendingKnownChat(response: OpenAiRetrievedResponse | Error) {
  const transport = recording(response);
  const seen: RimAiRequest[] = [];
  const runtime = createCreateBanContactRuntime({
    rimAi: {
      async respond(request) {
        seen.push(request);
        return { kind: "MESSAGE", text: "нельзя-генерировать" };
      },
    },
    rimProviderRetrieval: new OpenAiResponseRetriever(transport.client),
  });
  await seedRegisteredUsers(runtime, ["1001", "1002"]);
  const context = await authenticateRuntime(runtime, {
    method: "development",
    secret: SECRET,
    telegramUserId: "1001",
  });
  await grantContactBetweenTelegramUsers(runtime, "1001", "1002");
  const contactId = await userIdOf(runtime, "1002");
  expect(contactId).toBeTruthy();
  await openLobbyIfNeeded(runtime, context);
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.PRESS_START_CHAT",
    payload: {},
  });
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.PRESS_SELECT_CONTACT",
    payload: {},
  });
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.SELECT_CONTACT",
    payload: { contactId },
  });
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.CHANGE_INPUT_DRAFT",
    payload: { inputDraft: "привет" },
  });
  const sent = await executeAuthenticatedEvent(runtime, context, {
    name: "RIM.PRESS_SEND",
    payload: {},
  });
  const chat = sent.snapshot.extended.rimChat;
  if (!chat || chat.aiOperation.status !== "PENDING" || !chat.selectedContactId) {
    throw new Error("expected a pending RIM chat");
  }
  await runtime.productStore.saveRimProviderRuntime(
    context.currentUserId,
    sent.revision,
    knownRuntime(chat, RESPONSE_ID),
  );
  return { runtime, context, chat, seen, transport };
}

describe("known response retrieval recovery", () => {
  it("completes a retrieved MESSAGE through Application validation", async () => {
    const pending = await pendingKnownChat({
      id: RESPONSE_ID,
      status: "completed",
      output_text: envelope(MESSAGE),
    });
    const opened = await openLobbyIfNeeded(pending.runtime, pending.context);
    const loaded = await pending.runtime.productStore.loadProductSnapshot(
      pending.context.currentUserId,
    );
    const runtime = applicableRimProviderRuntime(
      parseRimProviderRuntime(loaded.rimProviderRuntime),
      pending.chat.id,
    );
    expect(pending.seen).toEqual([]);
    expect(pending.transport.calls).toEqual([
      { responseId: RESPONSE_ID, options: { maxRetries: 0 } },
    ]);
    expect(pending.transport.creates()).toBe(0);
    expect(pending.transport.conversations()).toBe(0);
    expect(opened.execution?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(opened.execution?.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(opened.execution?.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(
      loaded.snapshot.extended.rimChat?.messages.filter((message) => message.kind === "USER"),
    ).toEqual([{ kind: "USER", text: "привет" }]);
    expect(loaded.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "слышу",
    });
    expect(runtime?.continuityMode).toBe("provider-conversation");
    expect(runtime?.retiredAttemptId).toBeNull();
    expect(runtime?.attempt).toMatchObject({
      submissionState: "completed-retrieved",
      responseId: RESPONSE_ID,
      providerStatus: "completed",
    });
  });

  it("leaves queued and in_progress pending", async () => {
    for (const status of ["queued", "in_progress"] as const) {
      const pending = await pendingKnownChat({
        id: RESPONSE_ID,
        status,
        output_text: envelope(MESSAGE),
      });
      const opened = await openLobbyIfNeeded(pending.runtime, pending.context);
      const loaded = await pending.runtime.productStore.loadProductSnapshot(
        pending.context.currentUserId,
      );
      const runtime = applicableRimProviderRuntime(
        parseRimProviderRuntime(loaded.rimProviderRuntime),
        pending.chat.id,
      );
      expect(opened.execution).toBeNull();
      expect(pending.seen).toEqual([]);
      expect(pending.transport.calls).toHaveLength(1);
      expect(pending.transport.creates()).toBe(0);
      expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      expect(
        loaded.snapshot.extended.rimChat?.messages.filter((message) => message.kind === "USER"),
      ).toEqual([{ kind: "USER", text: "привет" }]);
      expect(runtime?.continuityMode).toBe("provider-conversation");
      expect(runtime?.attempt).toMatchObject({
        submissionState: "completed-retrieved",
        responseId: RESPONSE_ID,
        providerStatus: status,
      });
    }
  });

  it("dispatches the existing terminal failure for failed, cancelled, and incomplete", async () => {
    for (const status of ["failed", "cancelled", "incomplete"] as const) {
      const pending = await pendingKnownChat({
        id: RESPONSE_ID,
        status,
        output_text: envelope(MESSAGE),
      });
      const opened = await openLobbyIfNeeded(pending.runtime, pending.context);
      const loaded = await pending.runtime.productStore.loadProductSnapshot(
        pending.context.currentUserId,
      );
      expect(pending.seen).toEqual([]);
      expect(pending.transport.creates()).toBe(0);
      expect(pending.transport.calls).toHaveLength(1);
      expect(opened.execution?.event.name).toBe("RIM.AI_REQUEST_FAILED");
      expect(opened.execution?.traces.some((trace) => trace.eventId === "E-59")).toBe(true);
      expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
      expect(
        loaded.snapshot.extended.rimChat?.messages.filter((message) => message.kind === "USER"),
      ).toEqual([{ kind: "USER", text: "привет" }]);
    }
  });

  it("sends a completed unusable body to Application validation", async () => {
    const pending = await pendingKnownChat({
      id: RESPONSE_ID,
      status: "completed",
      output_text: "not-json{",
    });
    const opened = await openLobbyIfNeeded(pending.runtime, pending.context);
    expect(pending.seen).toEqual([]);
    expect(pending.transport.creates()).toBe(0);
    expect(opened.execution?.event.name).toBe("RIM.AI_REQUEST_FAILED");
    expect(opened.execution?.traces.some((trace) => trace.eventId === "E-59")).toBe(true);
    expect(opened.execution?.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "FAILED",
      failure: { code: RIM_AI_OUTPUT_INVALID },
    });
    expect(
      opened.execution?.snapshot.extended.rimChat?.messages.filter(
        (message) => message.kind === "USER",
      ),
    ).toEqual([{ kind: "USER", text: "привет" }]);
  });

  it("keeps the durable response id when retrieval fails or the provider id conflicts", async () => {
    const thrown = await pendingKnownChat(new Error("socket closed"));
    const failedOpen = await openLobbyIfNeeded(thrown.runtime, thrown.context);
    const failedLoaded = await thrown.runtime.productStore.loadProductSnapshot(
      thrown.context.currentUserId,
    );
    const failedRuntime = applicableRimProviderRuntime(
      parseRimProviderRuntime(failedLoaded.rimProviderRuntime),
      thrown.chat.id,
    );
    expect(failedOpen.execution).toBeNull();
    expect(thrown.seen).toEqual([]);
    expect(thrown.transport.calls).toHaveLength(1);
    expect(thrown.transport.creates()).toBe(0);
    expect(failedLoaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(failedRuntime?.attempt).toMatchObject({
      submissionState: "response-id-known",
      responseId: RESPONSE_ID,
    });

    const mismatch = await pendingKnownChat({
      id: OTHER_ID,
      status: "completed",
      output_text: envelope(MESSAGE),
    });
    const mismatchOpen = await openLobbyIfNeeded(mismatch.runtime, mismatch.context);
    const mismatchLoaded = await mismatch.runtime.productStore.loadProductSnapshot(
      mismatch.context.currentUserId,
    );
    const mismatchRuntime = applicableRimProviderRuntime(
      parseRimProviderRuntime(mismatchLoaded.rimProviderRuntime),
      mismatch.chat.id,
    );
    expect(mismatchOpen.execution).toBeNull();
    expect(mismatch.seen).toEqual([]);
    expect(mismatch.transport.calls).toHaveLength(1);
    expect(mismatch.transport.creates()).toBe(0);
    expect(mismatchLoaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(mismatchRuntime?.attempt).toMatchObject({
      submissionState: "response-id-known",
      responseId: RESPONSE_ID,
    });
    expect(JSON.stringify(mismatchRuntime)).not.toContain(OTHER_ID);
  });
});
