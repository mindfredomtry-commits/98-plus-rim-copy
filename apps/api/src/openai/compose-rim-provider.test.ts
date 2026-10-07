import { describe, expect, it } from "vitest";
import { OpenAI } from "openai";
import {
  applicableRimProviderRuntime,
  FakeRimAiAdapter,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type ProviderResponseId,
  type RimProviderAttemptId,
  type RimProviderRuntime,
} from "@98plus/application";
import type { RimChat } from "@98plus/product-model";
import { grantContactBetweenTelegramUsers } from "../seed-contact.ts";
import { executeIncomingOverboardVertical } from "../overboard.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  developmentIdentityConfig,
  executeAuthenticatedEvent,
  openLobbyIfNeeded,
  seedRegisteredUsers,
  userIdOf,
  type CreateBanContactRuntime,
} from "../runtime.ts";
import { type OpenAiSdkClient } from "./compose-rim-provider.ts";
import { OpenAiConversationInitializer } from "./openai-conversation-initialization.ts";
import { createOpenAiClient, type OpenAiClientConstruction } from "./openai-client.ts";
import { OpenAiResponseGenerator } from "./openai-response-generation.ts";
import { OpenAiResponseRetriever } from "./openai-response-retrieval.ts";
import { RimProviderConfigError } from "./rim-provider-config.ts";

const FAKE_KEY = "test-openai-key";
const FAKE_MODEL = "configured-composition-model";
const SECRET = "test-secret";
const RESPONSE_ID = "resp_composed" as ProviderResponseId;

const OPENAI_ENV = {
  RIM_PROVIDER: "openai",
  OPENAI_API_KEY: FAKE_KEY,
  OPENAI_MODEL: FAKE_MODEL,
};

type RecordedGenerate = {
  model?: string;
  conversation?: string;
  input?: unknown;
  store?: boolean;
  stream?: boolean;
};

function completedStream() {
  return {
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      yield {
        type: "response.created",
        response: { id: RESPONSE_ID, status: "in_progress" },
      };
      yield {
        type: "response.completed",
        response: {
          id: RESPONSE_ID,
          status: "completed",
          output_text: JSON.stringify({ output: { type: "MESSAGE", text: "слышу" } }),
        },
      };
    },
  };
}

function recordingSdk() {
  const conversations: unknown[] = [];
  const generates: RecordedGenerate[] = [];
  const retrieves: string[] = [];
  const client = {
    conversations: {
      async create(body: unknown) {
        conversations.push(body);
        return { id: "conv_composed" };
      },
    },
    responses: {
      async create(body: RecordedGenerate) {
        generates.push(body);
        return completedStream();
      },
      async retrieve(responseId: string) {
        retrieves.push(responseId);
        return { id: responseId, status: "queued", output_text: "" };
      },
    },
  };
  return { client, conversations, generates, retrieves };
}

function openaiRuntime(recording = recordingSdk()) {
  const constructed: string[] = [];
  const runtime = createCreateBanContactRuntime({
    config: developmentIdentityConfig(SECRET),
    env: OPENAI_ENV,
    createOpenAiClient: (apiKey) => {
      constructed.push(apiKey);
      return recording.client as unknown as OpenAiSdkClient;
    },
  });
  return { runtime, recording, constructed };
}

describe("RIM provider selection", () => {
  it("keeps unset and fake providers on Fake without an OpenAI client", () => {
    const constructed: string[] = [];
    const createOpenAiClient = (apiKey: string) => {
      constructed.push(apiKey);
      throw new Error("OpenAI client must not be constructed");
    };
    const omitted = createCreateBanContactRuntime({ createOpenAiClient });
    const unset = createCreateBanContactRuntime({ env: {}, createOpenAiClient });
    const fake = createCreateBanContactRuntime({
      env: {
        RIM_PROVIDER: "fake",
        OPENAI_API_KEY: FAKE_KEY,
        OPENAI_MODEL: FAKE_MODEL,
      },
      createOpenAiClient,
    });
    for (const runtime of [omitted, unset, fake]) {
      expect(runtime.rimProvider).toBe("fake");
      expect(runtime.rimModel).toBeNull();
      expect(runtime.rimAi).toBeInstanceOf(FakeRimAiAdapter);
      expect(runtime.rimConversationInitialization).toBeNull();
      expect(runtime.rimProviderRetrieval).toBeNull();
    }
    expect(constructed).toEqual([]);
    expect(JSON.stringify(unset.rimProvider)).not.toContain(FAKE_KEY);
  });

  it("selects all three OpenAI capabilities from one client", () => {
    const { runtime, recording, constructed } = openaiRuntime();
    expect(constructed).toEqual([FAKE_KEY]);
    expect(runtime.rimProvider).toBe("openai");
    expect(runtime.rimModel).toBe(FAKE_MODEL);
    expect(runtime.rimAi).toBeInstanceOf(OpenAiResponseGenerator);
    expect(runtime.rimAi).not.toBeInstanceOf(FakeRimAiAdapter);
    expect(runtime.rimConversationInitialization).toBeInstanceOf(OpenAiConversationInitializer);
    expect(runtime.rimConversationInitialization).not.toBeInstanceOf(FakeRimAiAdapter);
    expect(runtime.rimProviderRetrieval).toBeInstanceOf(OpenAiResponseRetriever);
    expect(runtime.rimProviderRetrieval).not.toBeNull();
    expect(recording.conversations).toHaveLength(0);
    expect(recording.generates).toHaveLength(0);
    expect(recording.retrieves).toHaveLength(0);
    expect(
      JSON.stringify({ provider: runtime.rimProvider, model: runtime.rimModel }),
    ).not.toContain(FAKE_KEY);
    expect(runtime).not.toHaveProperty("apiKey");
  });

  it("uses the Pass 1 client factory once when no test factory is injected", () => {
    const seen: OpenAiClientConstruction[] = [];
    class RecordingClient extends OpenAI {
      constructor(options: OpenAiClientConstruction) {
        seen.push(options);
        super(options);
      }
    }
    const runtime = createCreateBanContactRuntime({
      env: OPENAI_ENV,
      createOpenAiClient: (apiKey) => createOpenAiClient(apiKey, RecordingClient),
    });
    expect(seen).toEqual([{ apiKey: FAKE_KEY, maxRetries: 0 }]);
    expect(runtime.rimAi).toBeInstanceOf(OpenAiResponseGenerator);
    expect(runtime.rimModel).toBe(FAKE_MODEL);
    expect(runtime.rimProviderRetrieval).toBeInstanceOf(OpenAiResponseRetriever);
  });

  it("fails closed when openai configuration is incomplete", () => {
    const constructed: string[] = [];
    const createOpenAiClient = () => {
      constructed.push("called");
      throw new Error("client");
    };
    expect(() =>
      createCreateBanContactRuntime({
        env: { RIM_PROVIDER: "openai", OPENAI_MODEL: FAKE_MODEL },
        createOpenAiClient,
      }),
    ).toThrow(expect.objectContaining({ code: "OPENAI_API_KEY_REQUIRED" }));
    expect(() =>
      createCreateBanContactRuntime({
        env: { RIM_PROVIDER: "openai", OPENAI_API_KEY: FAKE_KEY },
        createOpenAiClient,
      }),
    ).toThrow(expect.objectContaining({ code: "OPENAI_MODEL_REQUIRED" }));
    expect(() =>
      createCreateBanContactRuntime({
        env: { RIM_PROVIDER: "anthropic", OPENAI_API_KEY: FAKE_KEY, OPENAI_MODEL: FAKE_MODEL },
        createOpenAiClient,
      }),
    ).toThrow(RimProviderConfigError);
    expect(constructed).toEqual([]);
  });

  it("does not replace an explicit test port with OpenAI", () => {
    const rimAi = new FakeRimAiAdapter();
    const constructed: string[] = [];
    const runtime = createCreateBanContactRuntime({
      rimAi,
      env: OPENAI_ENV,
      createOpenAiClient: () => {
        constructed.push(FAKE_KEY);
        throw new Error("client");
      },
    });
    expect(runtime.rimAi).toBe(rimAi);
    expect(runtime.rimProviderRetrieval).toBeNull();
    expect(runtime.rimConversationInitialization).toBeNull();
    expect(constructed).toEqual([]);
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
      attemptId: "init-composition" as RimProviderAttemptId,
      conversationId: "conv_composed" as ProviderConversationId,
      clientRequestId: null,
    },
    attempt: {
      requestId: chat.aiOperation.requestId,
      attemptId: "attempt-composition" as RimProviderAttemptId,
      submissionState: "response-id-known",
      responseId,
      clientRequestId: null,
    },
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

async function selectedContact(runtime: CreateBanContactRuntime) {
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
  const selected = await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.SELECT_CONTACT",
    payload: { contactId },
  });
  const chat = selected.last.snapshot.extended.rimChat;
  if (!chat) {
    throw new Error("expected a RIM chat");
  }
  return { context, chat };
}

describe("OpenAI runtime routing", () => {
  it("initializes and generates through the shared OpenAI client", async () => {
    const { runtime, recording, constructed } = openaiRuntime();
    const { context, chat } = await selectedContact(runtime);
    const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    const initialized = applicableRimProviderRuntime(
      parseRimProviderRuntime(loaded.rimProviderRuntime),
      chat.id,
    );
    expect(constructed).toEqual([FAKE_KEY]);
    expect(recording.conversations).toHaveLength(1);
    expect(recording.generates).toHaveLength(0);
    expect(recording.retrieves).toHaveLength(0);
    expect(initialized?.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: "conv_composed",
    });
    expect(initialized?.continuityMode).toBe("provider-conversation");

    await executeIncomingOverboardVertical(runtime, context, {
      name: "RIM.CHANGE_INPUT_DRAFT",
      payload: { inputDraft: "привет" },
    });
    const sent = await executeIncomingOverboardVertical(runtime, context, {
      name: "RIM.PRESS_SEND",
      payload: {},
    });
    expect(recording.generates).toEqual([
      expect.objectContaining({
        model: FAKE_MODEL,
        conversation: "conv_composed",
        input: "привет",
        store: true,
        stream: true,
      }),
    ]);
    expect(recording.conversations).toHaveLength(1);
    expect(recording.retrieves).toHaveLength(0);
    expect(sent.last.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(
      sent.last.snapshot.extended.rimChat?.messages.filter((message) => message.kind === "USER"),
    ).toEqual([{ kind: "USER", text: "привет" }]);
    expect(sent.last.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "слышу",
    });

    await runtime.rimProviderRetrieval?.retrieve(RESPONSE_ID);
    expect(recording.retrieves).toEqual([RESPONSE_ID]);
    expect(recording.generates).toHaveLength(1);
    expect(recording.conversations).toHaveLength(1);
  });

  it("retrieves a known response through the runtime recovery path", async () => {
    const { runtime, recording } = openaiRuntime();
    const { context, chat } = await selectedContact(runtime);
    const sent = await executeAuthenticatedEvent(runtime, context, {
      name: "RIM.CHANGE_INPUT_DRAFT",
      payload: { inputDraft: "привет" },
    });
    const pending = await executeAuthenticatedEvent(runtime, context, {
      name: "RIM.PRESS_SEND",
      payload: {},
    });
    const pendingChat = pending.snapshot.extended.rimChat;
    if (!pendingChat || pendingChat.aiOperation.status !== "PENDING") {
      throw new Error("expected a pending RIM chat");
    }
    expect(sent.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(recording.generates).toHaveLength(0);
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      pending.revision,
      knownRuntime(pendingChat, RESPONSE_ID),
    );
    const opened = await openLobbyIfNeeded(runtime, context);
    expect(recording.retrieves).toEqual([RESPONSE_ID]);
    expect(recording.generates).toHaveLength(0);
    expect(recording.conversations).toHaveLength(1);
    expect(opened.execution).toBeNull();
    expect(opened.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const stored = applicableRimProviderRuntime(
      parseRimProviderRuntime(opened.loaded.rimProviderRuntime),
      chat.id,
    );
    expect(stored?.attempt).toMatchObject({
      submissionState: "completed-retrieved",
      responseId: RESPONSE_ID,
      providerStatus: "queued",
    });
    expect(stored?.continuityMode).toBe("provider-conversation");
  });
});
