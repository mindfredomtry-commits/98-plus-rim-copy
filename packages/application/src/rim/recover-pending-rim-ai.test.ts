import { describe, expect, it } from "vitest";
import { PersistenceError, type ProductStore } from "@98plus/persistence";
import { PersistenceTestKit } from "../../../persistence/src/test-kit.ts";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  counterAllocator,
  emptySnapshot,
  type AiRequestId,
  type ProductSnapshot,
  type RimChat,
  type RimChatId,
  type UserId,
} from "@98plus/product-model";
import {
  AI_REQUEST_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  REQUEST_ID,
  USER_ID,
  makeChat,
  pendingAi,
  readyContext,
  withChat,
  withControlState,
} from "../../../product-model/src/kernel.fixtures.ts";
import { executeProductEvent, type ProductExecutorDependencies } from "../execute.ts";
import {
  authContext,
  eventOf,
  openLobby,
  productApp,
  RECEIVER_ID,
  SENDER_ID,
} from "../test-harness.ts";
import { continueRimEffects } from "./continue-rim.ts";
import { FakeRimAiFailure } from "./fake-rim-ai-adapter.ts";
import { recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import type { RimAiPort, RimAiRequest } from "./rim-ai-port.ts";
import type { RimConversationInitializationPort } from "./rim-conversation-port.ts";
import type { RimProviderRetrievalPort } from "./rim-provider-retrieval.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderResponseId,
  type RetrievedProviderStatus,
  type ProviderConversationId,
  type RimProviderAttempt,
  type RimProviderAttemptId,
  type RimProviderInitialization,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";
import { RIM_AI_OUTPUT_INVALID } from "./validate-rim-ai-output.ts";

const RESPONSE_ID = "resp-known-1" as ProviderResponseId;

function attempt(value: string): RimProviderAttemptId {
  return value as RimProviderAttemptId;
}

function userTexts(chat: RimChat | null | undefined): string[] {
  return (chat?.messages ?? []).flatMap((message) =>
    message.kind === "USER" ? [message.text] : [],
  );
}

function pendingChat(text = "привет"): RimChat {
  return makeChat({
    selectedContactId: CONTACT_A,
    relationshipContext: readyContext(),
    messages: [{ kind: "USER", text }],
    aiOperation: pendingAi({ userMessage: text, rimChatId: CHAT_ID }),
  });
}

function runtimeFor(
  chat: RimChat,
  submission: RimProviderAttempt["submissionState"],
  extras: Partial<RimProviderAttempt> = {},
): RimProviderRuntime {
  const initialization: RimProviderInitialization = {
    submissionState: "stored",
    attemptId: attempt("init-1"),
    conversationId: "conv-stored-1" as ProviderConversationId,
    clientRequestId: null,
  };
  const requestId =
    chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : AI_REQUEST_ID;
  const providerAttempt: RimProviderAttempt =
    submission === "completed-retrieved"
      ? {
          requestId,
          attemptId: attempt("attempt-1"),
          submissionState: "completed-retrieved",
          responseId: RESPONSE_ID,
          providerStatus:
            (extras as { providerStatus?: RetrievedProviderStatus }).providerStatus ?? "completed",
          clientRequestId: "client-1",
        }
      : submission === "response-id-known"
        ? {
            requestId,
            attemptId: attempt("attempt-1"),
            submissionState: "response-id-known",
            responseId: RESPONSE_ID,
            clientRequestId: "client-1",
          }
        : {
            requestId,
            attemptId: attempt("attempt-1"),
            submissionState: submission,
            clientRequestId: "client-1",
          };
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId ?? CONTACT_A,
    contextRequestId: chat.relationshipContext?.requestId ?? REQUEST_ID,
    initialization,
    attempt: providerAttempt,
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

function chatSnapshot(
  chat: RimChat,
  control: ProductSnapshot["controlState"] = "RIM.CHAT",
): ProductSnapshot {
  return withChat(withControlState(emptySnapshot(), control), chat);
}

async function harness() {
  const kit = PersistenceTestKit.inMemory();
  kit.establishIdentity(USER_ID, "tg-user");
  kit.establishIdentity(CONTACT_A, "tg-contact");
  const store = kit.store;
  const context = authContext(USER_ID, "tg-user");
  const deps: ProductExecutorDependencies = {
    store,
    clock: { nowMs: () => 2_000_000 },
    allocateId: counterAllocator(1),
  };
  return { kit, store, context, deps };
}

function port(
  seen: RimAiRequest[] = [],
  output: unknown = { kind: "MESSAGE", text: "слышу" },
): RimAiPort {
  return {
    async respond(request) {
      seen.push(request);
      return output as Awaited<ReturnType<RimAiPort["respond"]>>;
    },
  };
}

function retrieval(
  status: RetrievedProviderStatus,
  output?: unknown,
  seen: ProviderResponseId[] = [],
): RimProviderRetrievalPort {
  return {
    async retrieve(responseId) {
      seen.push(responseId);
      return {
        responseId,
        providerStatus: status,
        ...(output === undefined ? {} : { output }),
      };
    },
  };
}

function watchSaves(
  inner: ProductStore,
  saves: unknown[],
  conflicts: { count: number },
): ProductStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "saveRimProviderRuntime") {
        return async (userId: UserId, expectedRevision: number, runtime: unknown) => {
          try {
            const saved = await target.saveRimProviderRuntime(userId, expectedRevision, runtime);
            saves.push(runtime);
            return saved;
          } catch (error) {
            if (error instanceof PersistenceError && error.code === "REVISION_CONFLICT") {
              conflicts.count += 1;
            }
            throw error;
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

async function readRuntime(store: ProductStore, userId: UserId) {
  const loaded = await store.loadProductSnapshot(userId);
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  if (parsed.status !== "PRESENT") {
    throw new Error(`expected a provider runtime, got ${parsed.status}`);
  }
  return { loaded, runtime: parsed.runtime };
}

async function installPending(
  chat = pendingChat(),
  control: ProductSnapshot["controlState"] = "RIM.CHAT",
) {
  const opened = await harness();
  const installed = await opened.kit.installFixtureSnapshot(USER_ID, chatSnapshot(chat, control));
  return { ...opened, installed, chat };
}

async function failPendingSend(rimAi: RimAiPort, observed?: { store: ProductStore | null }) {
  const app = await productApp();
  if (observed) {
    observed.store = app.store;
  }
  await openLobby(app.sender);
  await app.sender(eventOf("RIM.PRESS_START_CHAT"));
  await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
  const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
  const context = authContext(SENDER_ID, "tg-sender");
  const deps: ProductExecutorDependencies = {
    store: app.store,
    clock: { nowMs: () => 2_000_000 },
    allocateId: counterAllocator(1),
  };
  await continueRimEffects(selected, {
    context,
    deps,
    rimAi: port(),
    contextFailures: { remainingFailures: 0 },
    loadSources: async () => [],
  });
  await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "почему так" }));
  const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
  const tools = {
    context,
    deps,
    rimAi,
    retrieval: null,
    contextFailures: { remainingFailures: 0 },
    loadSources: async () => [],
  };
  const failed = await continueRimEffects(sent, tools);
  return { app, tools, failed };
}

describe("pending RIM AI recovery", () => {
  it("claims a fresh request before the provider call and keeps one USER message", async () => {
    const app = await productApp();
    await openLobby(app.sender);
    await app.sender(eventOf("RIM.PRESS_START_CHAT"));
    await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    await continueRimEffects(selected, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(1),
      },
      rimAi: port(),
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    const effect = sent.pendingExternalEffects[0]?.effect;
    expect(effect?.type).toBe("REQUEST_RIM_AI");
    if (effect?.type !== "REQUEST_RIM_AI") {
      return;
    }
    const order: string[] = [];
    const saves: unknown[] = [];
    const conflicts = { count: 0 };
    const seen: RimAiRequest[] = [];
    const store = watchSaves(app.store, saves, conflicts);
    const settled = await continueRimEffects(sent, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(50),
      },
      rimAi: {
        async respond(request) {
          order.push("respond");
          const loaded = await app.store.loadProductSnapshot(SENDER_ID);
          const runtime = applicableRimProviderRuntime(
            parseRimProviderRuntime(loaded.rimProviderRuntime),
            request.rimChatId,
          );
          expect(runtime?.attempt?.submissionState).toBe("acceptance-unknown");
          expect(runtime?.continuityMode).toBe("provider-conversation");
          expect(runtime?.retiredAttemptId).toBeNull();
          expect(runtime?.attempt).not.toHaveProperty("responseId");
          seen.push(request);
          return { kind: "MESSAGE", text: "слышу" };
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    const states = saves.map((saved) => {
      const parsed = parseRimProviderRuntime(saved);
      return parsed.status === "PRESENT" ? parsed.runtime.attempt?.submissionState : parsed.status;
    });
    expect(states).toEqual(["not-submitted", "acceptance-unknown"]);
    expect(order).toEqual(["respond"]);
    expect(seen[0]?.requestId).toBe(effect.requestId);
    expect(seen[0]?.userMessage).toBe("привет");
    expect(userTexts(settled.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(settled.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(settled.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    expect(settled.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(settled.event.name).not.toBe("RIM.PRESS_RETRY_AI");
  });

  it("recovers not-submitted on the same request without a second USER message or E-54", async () => {
    const app = await productApp();
    await openLobby(app.sender);
    await app.sender(eventOf("RIM.PRESS_START_CHAT"));
    await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    const ready = await continueRimEffects(selected, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(1),
      },
      rimAi: port(),
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    const chat = sent.snapshot.extended.rimChat;
    expect(chat?.aiOperation.status).toBe("PENDING");
    if (!chat || chat.aiOperation.status !== "PENDING") {
      return;
    }
    const before = userTexts(chat);
    await app.store.saveRimProviderRuntime(
      SENDER_ID,
      sent.revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(80),
      },
      rimAi: port(seen),
      retrieval: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe(chat.aiOperation.requestId);
    expect(userTexts(settled?.snapshot.extended.rimChat)).toEqual(before);
    expect(settled?.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    expect(settled?.traces.some((trace) => trace.eventId === "E-52")).toBe(false);
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(ready.snapshot.extended.rimChat?.id).toBe(chat.id);
  });

  it("lets exactly one of two recoverers claim, and the revision loser does not submit", async () => {
    const { store, context, deps, kit, chat } = await installPending();
    const seeded = await kit.store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    expect(seeded.revision).toBeGreaterThan(0);
    const saves: unknown[] = [];
    const conflicts = { count: 0 };
    const watched = watchSaves(store, saves, conflicts);
    const seen: RimAiRequest[] = [];
    const tools = {
      context,
      deps: { ...deps, store: watched },
      rimAi: port(seen),
      retrieval: null,
    };
    const [first, second] = await Promise.all([
      recoverPendingRimAi(tools),
      recoverPendingRimAi(tools),
    ]);
    const claimSaves = saves.filter((saved) => {
      const parsed = parseRimProviderRuntime(saved);
      return (
        parsed.status === "PRESENT" &&
        parsed.runtime.attempt?.submissionState === "acceptance-unknown"
      );
    });
    expect(conflicts.count).toBe(0);
    expect(claimSaves).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const completions = [first, second].filter(
      (result) => result?.event.name === "RIM.AI_RESULT_RECEIVED",
    );
    expect(completions).toHaveLength(1);
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("does not submit or transition while the claimed provider attempt is still in this process", async () => {
    const app = await productApp();
    await openLobby(app.sender);
    await app.sender(eventOf("RIM.PRESS_START_CHAT"));
    await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    await continueRimEffects(selected, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(1),
      },
      rimAi: port(),
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => undefined;
    const claimedGate = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const seen: RimAiRequest[] = [];
    const running = continueRimEffects(sent, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(90),
      },
      rimAi: {
        async respond(request) {
          seen.push(request);
          claimed();
          await gate;
          return { kind: "MESSAGE", text: "слышу" };
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await claimedGate;
    const during = await readRuntime(app.store, SENDER_ID);
    const liveAttemptId = during.runtime.attempt?.attemptId;
    expect(during.runtime.continuityMode).toBe("provider-conversation");
    expect(during.runtime.retiredAttemptId).toBeNull();
    expect(during.runtime.attempt?.submissionState).toBe("acceptance-unknown");
    const recovered = await recoverPendingRimAi({
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(91),
      },
      rimAi: port(seen),
      retrieval: null,
    });
    const held = await readRuntime(app.store, SENDER_ID);
    expect(recovered).toBeNull();
    expect(seen).toHaveLength(1);
    expect(held.runtime.continuityMode).toBe("provider-conversation");
    expect(held.runtime.retiredAttemptId).toBeNull();
    expect(held.runtime.attempt?.attemptId).toBe(liveAttemptId);
    expect(held.runtime.attempt?.submissionState).toBe("acceptance-unknown");
    release();
    const settled = await running;
    const after = await readRuntime(app.store, SENDER_ID);
    expect(seen).toHaveLength(1);
    expect(settled.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(settled.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(settled.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt?.attemptId).toBe(liveAttemptId);
  });

  it("reaches the same local row from a restarted acceptance-unknown request without a live flight", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = await store.loadProductSnapshot(USER_ID);
    const before = runtimeFor(chat, "acceptance-unknown");
    await store.saveRimProviderRuntime(USER_ID, seeded.revision, before);
    const seen: RimAiRequest[] = [];
    let initialized = false;
    const conversation: RimConversationInitializationPort = {
      async initialize() {
        initialized = true;
        throw new Error("initializer called");
      },
    };
    const first = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      conversation,
      retrieval: null,
    });
    expect(first).toBeNull();
    expect(seen).toEqual([]);
    expect(initialized).toBe(false);
    const transitioned = await readRuntime(store, USER_ID);
    const nextAttempt = transitioned.runtime.attempt;
    expect(transitioned.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(userTexts(transitioned.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(transitioned.runtime.continuityMode).toBe("local-canonical-history");
    expect(transitioned.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(nextAttempt?.attemptId).not.toBe(attempt("attempt-1"));
    expect(nextAttempt).toMatchObject({
      requestId: AI_REQUEST_ID,
      submissionState: "not-submitted",
    });
    expect(transitioned.runtime.initialization).toEqual(before.initialization);
    expect(transitioned.runtime.rimChatId).toBe(chat.id);
    expect(transitioned.runtime.selectedContactId).toBe(chat.selectedContactId);
    expect(transitioned.runtime.contextRequestId).toBe(before.contextRequestId);
    expect(transitioned.loaded.snapshot.controlState).toBe("RIM.CHAT");
    const reloaded = await readRuntime(store, USER_ID);
    expect(reloaded.runtime).toEqual(transitioned.runtime);
    for (let time = 0; time < 2; time += 1) {
      const again = await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        conversation,
        retrieval: null,
      });
      expect(again).toBeNull();
    }
    const settled = await readRuntime(store, USER_ID);
    expect(seen).toEqual([]);
    expect(initialized).toBe(false);
    expect(settled.runtime).toEqual(transitioned.runtime);
    expect(settled.runtime.continuityMode).toBe("local-canonical-history");
    expect(settled.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(userTexts(settled.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("retrieves a known response without submitting the USER turn", async () => {
    const cases: RetrievedProviderStatus[] = [
      "queued",
      "in_progress",
      "failed",
      "cancelled",
      "incomplete",
    ];
    for (const status of cases) {
      const { store, context, deps, chat } = await installPending();
      const seeded = await store.loadProductSnapshot(USER_ID);
      await store.saveRimProviderRuntime(
        USER_ID,
        seeded.revision,
        runtimeFor(chat, "response-id-known"),
      );
      const seen: RimAiRequest[] = [];
      const retrieved: ProviderResponseId[] = [];
      const settled = await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: retrieval(status, undefined, retrieved),
      });
      const loaded = await store.loadProductSnapshot(USER_ID);
      expect(seen).toEqual([]);
      expect(retrieved).toEqual([RESPONSE_ID]);
      if (status === "queued" || status === "in_progress") {
        expect(settled).toBeNull();
        expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      } else {
        expect(settled?.event.name).toBe("RIM.AI_REQUEST_FAILED");
        expect(settled?.traces.some((trace) => trace.eventId === "E-59")).toBe(true);
        expect(settled?.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
        expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
        expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
      }
    }
  });

  it("applies a retrieved completed body through Pass 1", async () => {
    const valid = await installPending();
    const seeded = await valid.store.loadProductSnapshot(USER_ID);
    await valid.store.saveRimProviderRuntime(
      USER_ID,
      seeded.revision,
      runtimeFor(valid.chat, "completed-retrieved", { providerStatus: "queued" }),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: valid.context,
      deps: valid.deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "слышу" }),
    });
    expect(seen).toEqual([]);
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled?.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(
      valid.chat.aiOperation.status === "PENDING" &&
        settled?.snapshot.extended.rimChat?.messages.at(-1),
    ).toEqual({
      kind: "RIM",
      text: "слышу",
    });

    const invalid = await installPending();
    const invalidSeed = await invalid.store.loadProductSnapshot(USER_ID);
    await invalid.store.saveRimProviderRuntime(
      USER_ID,
      invalidSeed.revision,
      runtimeFor(invalid.chat, "response-id-known"),
    );
    const failed = await recoverPendingRimAi({
      context: invalid.context,
      deps: invalid.deps,
      rimAi: port(),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "   " }),
    });
    expect(failed?.event.name).toBe("RIM.AI_REQUEST_FAILED");
    expect(failed?.traces.some((trace) => trace.eventId === "E-59")).toBe(true);
    expect(failed?.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "FAILED",
      failure: { code: RIM_AI_OUTPUT_INVALID },
    });
    expect(userTexts(failed?.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("does not invent a completion from a stored status when nothing can be retrieved", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = await store.loadProductSnapshot(USER_ID);
    await store.saveRimProviderRuntime(
      USER_ID,
      seeded.revision,
      runtimeFor(chat, "completed-retrieved", { providerStatus: "completed" }),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("does not recover a frozen chat, and does recover the same chat after E-07", async () => {
    const chat = pendingChat();
    const base = chatSnapshot(chat);
    const frozen: ProductSnapshot = {
      ...withControlState(base, "CREATE_BAN.WHAT.RIM"),
      extended: {
        ...base.extended,
        rimChat: chat,
        savedFrozenRimChat: chat,
      },
    };
    const opened = await harness();
    const installed = await opened.kit.installFixtureSnapshot(USER_ID, frozen);
    const { store, context, deps } = opened;
    await store.saveRimProviderRuntime(
      USER_ID,
      installed.revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const blocked = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(blocked).toBeNull();
    expect(seen).toEqual([]);
    const restored = await executeProductEvent(
      { context, event: eventOf("CREATE_BAN.PRESS_BACK") },
      deps,
    );
    expect(restored.status).toBe("APPLIED");
    expect(restored.snapshot.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(restored.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(restored.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(seen).toHaveLength(1);
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(userTexts(settled?.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(restored.snapshot.extended.rimChat?.id).toBe(chat.id);
  });

  it("recovers a pending request while Select Contact is open, and skips an in-flight effect", async () => {
    const chat = pendingChat();
    const { store, context, deps, installed } = await installPending(chat, "RIM.SELECT_CONTACT");
    await store.saveRimProviderRuntime(
      USER_ID,
      installed.revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const skipped = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
      inFlightRequestIds: [AI_REQUEST_ID],
    });
    expect(skipped).toBeNull();
    expect(seen).toEqual([]);
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(seen).toHaveLength(1);
    expect(settled?.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
    expect(settled?.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(userTexts(settled?.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("fails closed for a terminated chat, another chat, a newer request, and absent or invalid runtime", async () => {
    const seen: RimAiRequest[] = [];
    const terminated = await installPending(pendingChat(), null);
    await terminated.store.saveRimProviderRuntime(
      USER_ID,
      terminated.installed.revision,
      runtimeFor(terminated.chat, "not-submitted"),
    );
    expect(
      await recoverPendingRimAi({
        context: terminated.context,
        deps: terminated.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();

    const otherChat = pendingChat();
    const moved = makeChat({
      ...otherChat,
      id: "chat-new" as RimChatId,
    });
    const sameContact = await installPending(moved);
    await sameContact.store.saveRimProviderRuntime(
      USER_ID,
      sameContact.installed.revision,
      runtimeFor(otherChat, "not-submitted"),
    );
    expect(
      await recoverPendingRimAi({
        context: sameContact.context,
        deps: sameContact.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();

    const different = pendingChat();
    const changed = makeChat({
      ...different,
      id: "chat-other-contact" as RimChatId,
      selectedContactId: CONTACT_B,
    });
    const otherContact = await installPending(changed);
    await otherContact.store.saveRimProviderRuntime(
      USER_ID,
      otherContact.installed.revision,
      runtimeFor(different, "not-submitted"),
    );
    expect(
      await recoverPendingRimAi({
        context: otherContact.context,
        deps: otherContact.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();

    const newer = pendingChat();
    const newerId = "ai-newer" as AiRequestId;
    const newerChat = makeChat({
      ...newer,
      aiOperation: pendingAi({ requestId: newerId, userMessage: "привет" }),
    });
    const replaced = await installPending(newerChat);
    await replaced.store.saveRimProviderRuntime(
      USER_ID,
      replaced.installed.revision,
      runtimeFor(newer, "not-submitted"),
    );
    expect(
      await recoverPendingRimAi({
        context: replaced.context,
        deps: replaced.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(
      (await replaced.store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation,
    ).toMatchObject({
      status: "PENDING",
      requestId: newerId,
    });

    const absent = await installPending();
    expect(
      await recoverPendingRimAi({
        context: absent.context,
        deps: absent.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();

    const invalid = await installPending();
    await invalid.store.saveRimProviderRuntime(USER_ID, invalid.installed.revision, {
      corrupt: true,
    });
    expect(
      await recoverPendingRimAi({
        context: invalid.context,
        deps: invalid.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect(
      (await invalid.store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation
        .status,
    ).toBe("PENDING");
  });

  it("falls back to local history when the live provider call throws, without E-59 or Retry", async () => {
    const seen: RimAiRequest[] = [];
    const observed: { store: ProductStore | null } = { store: null };
    let providerAttemptId: string | undefined;
    const { app, failed } = await failPendingSend(
      {
        async respond(request) {
          seen.push(request);
          const loaded = await observed.store?.loadProductSnapshot(SENDER_ID);
          const runtime = loaded
            ? applicableRimProviderRuntime(
                parseRimProviderRuntime(loaded.rimProviderRuntime),
                request.rimChatId,
              )
            : null;
          providerAttemptId = runtime?.attempt?.attemptId;
          throw new FakeRimAiFailure({
            code: "RIM_AI_FAILED",
            message: "provider down",
          } as never);
        },
      },
      observed,
    );
    const chat = failed.snapshot.extended.rimChat;
    expect(failed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(failed.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    expect(failed.event.name).toBe("RIM.PRESS_SEND");
    expect(chat?.aiOperation.status).toBe("PENDING");
    if (!chat || chat.aiOperation.status !== "PENDING") {
      return;
    }
    const requestId = chat.aiOperation.requestId;
    const after = await readRuntime(app.store, SENDER_ID);
    expect(seen).toHaveLength(1);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId,
    });
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["почему так"]);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(providerAttemptId).toBeTruthy();
    expect(after.runtime.retiredAttemptId).toBe(providerAttemptId);
    expect(after.runtime.attempt?.attemptId).not.toBe(providerAttemptId);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "not-submitted",
      requestId,
    });
    expect(after.runtime.initialization.submissionState).toBe("stored");
    const again = await recoverPendingRimAi({
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(200),
      },
      rimAi: port(seen),
      retrieval: null,
    });
    expect(again).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await readRuntime(app.store, SENDER_ID)).runtime).toEqual(after.runtime);
  });

  it("does not transition a thrown provider call after Back has ended the chat", async () => {
    const app = await productApp();
    await openLobby(app.sender);
    await app.sender(eventOf("RIM.PRESS_START_CHAT"));
    await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    const context = authContext(SENDER_ID, "tg-sender");
    const deps: ProductExecutorDependencies = {
      store: app.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(1),
    };
    await continueRimEffects(selected, {
      context,
      deps,
      rimAi: port(),
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "почему так" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const seen: RimAiRequest[] = [];
    const running = continueRimEffects(sent, {
      context,
      deps,
      rimAi: {
        async respond(request) {
          seen.push(request);
          entered();
          await gate;
          throw new FakeRimAiFailure({
            code: "RIM_AI_FAILED",
            message: "provider down",
          } as never);
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await enteredGate;
    const during = await readRuntime(app.store, SENDER_ID);
    expect(during.runtime.continuityMode).toBe("provider-conversation");
    expect(during.runtime.attempt?.submissionState).toBe("acceptance-unknown");
    const backed = await app.sender(eventOf("RIM.PRESS_BACK"));
    expect(backed.snapshot.controlState).toBe("RIM.LOBBY");
    expect(backed.snapshot.extended.rimChat).toBeNull();
    release();
    await running;
    const after = await readRuntime(app.store, SENDER_ID);
    expect(seen).toHaveLength(1);
    expect(after.loaded.snapshot.controlState).toBe("RIM.LOBBY");
    expect(after.loaded.snapshot.extended.rimChat).toBeNull();
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toEqual(during.runtime.attempt);
  });

  it.each(["response-id-known", "completed-retrieved"] as const)(
    "retrieves a %s attempt after E-54 and does not submit the USER turn again",
    async (submissionState) => {
      const seen: RimAiRequest[] = [];
      const { app, tools, failed } = await failPendingSend({
        async respond(request) {
          seen.push(request);
          return {
            kind: "BAN_PROPOSALS",
            message: "сломан",
            proposals: [],
          } as unknown as Awaited<ReturnType<RimAiPort["respond"]>>;
        },
      });
      const chat = failed.snapshot.extended.rimChat;
      if (!chat || chat.aiOperation.status !== "FAILED" || !chat.selectedContactId) {
        throw new Error("expected a failed RIM chat");
      }
      const loaded = await app.store.loadProductSnapshot(SENDER_ID);
      const current = applicableRimProviderRuntime(
        parseRimProviderRuntime(loaded.rimProviderRuntime),
        chat.id,
      );
      if (!current?.attempt || current.attempt.submissionState !== "acceptance-unknown") {
        throw new Error("expected acceptance-unknown");
      }
      const known: RimProviderAttempt =
        submissionState === "response-id-known"
          ? {
              requestId: current.attempt.requestId,
              attemptId: current.attempt.attemptId,
              submissionState,
              responseId: RESPONSE_ID,
              clientRequestId: current.attempt.clientRequestId,
            }
          : {
              requestId: current.attempt.requestId,
              attemptId: current.attempt.attemptId,
              submissionState,
              responseId: RESPONSE_ID,
              providerStatus: "completed",
              clientRequestId: current.attempt.clientRequestId,
            };
      await app.store.saveRimProviderRuntime(SENDER_ID, loaded.revision, {
        rimChatId: current.rimChatId,
        selectedContactId: current.selectedContactId,
        contextRequestId: current.contextRequestId,
        initialization: current.initialization,
        attempt: known,
      });
      const retrieved: ProviderResponseId[] = [];
      const retried = await app.sender(
        eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: chat.aiOperation.requestId }),
      );
      const followed = await continueRimEffects(retried, {
        ...tools,
        retrieval: retrieval("completed", { kind: "MESSAGE", text: "из ответа" }, retrieved),
      });
      expect(seen).toHaveLength(1);
      expect(retrieved).toEqual([RESPONSE_ID]);
      expect(followed.event.name).toBe("RIM.AI_RESULT_RECEIVED");
      expect(followed.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
      expect(followed.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
      expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["почему так"]);
      expect(followed.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
        kind: "RIM",
        text: "из ответа",
      });
      const after = applicableRimProviderRuntime(
        parseRimProviderRuntime(
          (await app.store.loadProductSnapshot(SENDER_ID)).rimProviderRuntime,
        ),
        chat.id,
      );
      expect(after?.continuityMode).toBe("provider-conversation");
      expect(after?.retiredAttemptId).toBeNull();
      expect(after?.attempt?.attemptId).toBe(current.attempt.attemptId);
    },
  );
});

describe("DC-02 ambiguity transition", () => {
  it("keeps the frozen Product counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
  });

  it("does not switch a known response id off the retrieval path", async () => {
    const known = await installPending();
    const knownSeed = await known.store.loadProductSnapshot(USER_ID);
    await known.store.saveRimProviderRuntime(
      USER_ID,
      knownSeed.revision,
      runtimeFor(known.chat, "response-id-known"),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    let initialized = false;
    const settled = await recoverPendingRimAi({
      context: known.context,
      deps: known.deps,
      rimAi: port(seen),
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "из ответа" }, retrieved),
    });
    const after = await readRuntime(known.store, USER_ID);
    expect(initialized).toBe(false);
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([RESPONSE_ID]);
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled?.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(settled?.traces.some((trace) => trace.eventId === "E-64")).toBe(false);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
    expect(after.runtime.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: "conv-stored-1",
    });
  });

  it("does not switch a completed-retrieved attempt to local mode", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = await store.loadProductSnapshot(USER_ID);
    await store.saveRimProviderRuntime(
      USER_ID,
      seeded.revision,
      runtimeFor(chat, "completed-retrieved", { providerStatus: "completed" }),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    const after = await readRuntime(store, USER_ID);
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "completed-retrieved",
      responseId: RESPONSE_ID,
    });
  });

  it("keeps initialization acceptance-unknown on E-64 and never enters local mode", async () => {
    const { store, context, deps, chat, installed } = await installPending();
    const seeded: RimProviderRuntime = {
      rimChatId: chat.id,
      selectedContactId: chat.selectedContactId ?? CONTACT_A,
      contextRequestId: REQUEST_ID,
      initialization: {
        submissionState: "acceptance-unknown",
        attemptId: attempt("init-lost"),
        clientRequestId: "client-init",
      },
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-1"),
        submissionState: "acceptance-unknown",
        clientRequestId: "client-1",
      },
      continuityMode: "provider-conversation",
      retiredAttemptId: null,
    };
    await store.saveRimProviderRuntime(USER_ID, installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    let initialized = false;
    const ended = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      retrieval: null,
    });
    const after = await readRuntime(store, USER_ID);
    expect(ended?.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
    expect(ended?.traces.some((trace) => trace.eventId === "E-64")).toBe(true);
    expect(ended?.snapshot.extended.rimChat).toBeNull();
    expect(initialized).toBe(false);
    expect(seen).toEqual([]);
    expect(after.runtime).toEqual(seeded);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
  });

  it("does not create a USER attempt when the pending request has none", async () => {
    const { store, context, deps, chat, installed } = await installPending();
    const seeded = runtimeFor(chat, "not-submitted");
    await store.saveRimProviderRuntime(USER_ID, installed.revision, { ...seeded, attempt: null });
    const seen: RimAiRequest[] = [];
    let initialized = false;
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      retrieval: null,
    });
    const after = await readRuntime(store, USER_ID);
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    expect(initialized).toBe(false);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(after.runtime.attempt).toBeNull();
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.initialization).toEqual(seeded.initialization);
  });

  it("does not transition a frozen chat", async () => {
    const chat = pendingChat();
    const base = chatSnapshot(chat);
    const frozen: ProductSnapshot = {
      ...withControlState(base, "CREATE_BAN.WHAT.RIM"),
      extended: {
        ...base.extended,
        rimChat: chat,
        savedFrozenRimChat: chat,
      },
    };
    const opened = await harness();
    const installed = await opened.kit.installFixtureSnapshot(USER_ID, frozen);
    const seeded = runtimeFor(chat, "acceptance-unknown");
    await opened.store.saveRimProviderRuntime(USER_ID, installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    const blocked = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: null,
    });
    const after = await readRuntime(opened.store, USER_ID);
    expect(blocked).toBeNull();
    expect(seen).toEqual([]);
    expect(after.runtime).toEqual(seeded);
    expect(after.loaded.snapshot.controlState).toBe("CREATE_BAN.WHAT.RIM");
  });

  it("does not transition a stale chat or a different RimChat", async () => {
    const stale = await installPending(pendingChat(), "RIM.LOBBY");
    const staleRuntime = runtimeFor(stale.chat, "acceptance-unknown");
    await stale.store.saveRimProviderRuntime(USER_ID, stale.installed.revision, staleRuntime);
    const staleSeen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context: stale.context,
        deps: stale.deps,
        rimAi: port(staleSeen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(staleSeen).toEqual([]);
    expect((await readRuntime(stale.store, USER_ID)).runtime).toEqual(staleRuntime);

    const current = pendingChat();
    const moved = makeChat({
      ...current,
      id: "chat-other" as RimChatId,
      aiOperation: pendingAi({ userMessage: "привет", rimChatId: "chat-other" as RimChatId }),
    });
    const other = await installPending(moved);
    await other.store.saveRimProviderRuntime(
      USER_ID,
      other.installed.revision,
      runtimeFor(current, "acceptance-unknown"),
    );
    const seen: RimAiRequest[] = [];
    const initialized: string[] = [];
    expect(
      await recoverPendingRimAi({
        context: other.context,
        deps: other.deps,
        rimAi: port(seen),
        conversation: {
          async initialize(request) {
            initialized.push(request.rimChatId);
            return { conversationId: "conv-other" as ProviderConversationId };
          },
        },
        retrieval: null,
      }),
    ).toBeNull();
    const after = await readRuntime(other.store, USER_ID);
    expect(seen).toEqual([]);
    expect(initialized).toEqual(["chat-other"]);
    expect(after.runtime.rimChatId).toBe(moved.id);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toBeNull();
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("preserves local mode for the same contact and does not give it to a new RimChat", async () => {
    const chat = pendingChat();
    const opened = await installPending(chat);
    const local: RimProviderRuntime = {
      ...runtimeFor(chat, "not-submitted"),
      continuityMode: "local-canonical-history",
      retiredAttemptId: attempt("attempt-retired"),
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-local"),
        submissionState: "not-submitted",
        clientRequestId: null,
      },
    };
    await opened.store.saveRimProviderRuntime(USER_ID, opened.installed.revision, local);
    const base = chatSnapshot(chat);
    const frozen: ProductSnapshot = {
      ...withControlState(base, "CREATE_BAN.WHAT.RIM"),
      extended: {
        ...base.extended,
        rimChat: chat,
        savedFrozenRimChat: chat,
      },
    };
    await opened.kit.installFixtureSnapshot(USER_ID, frozen);
    const seen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    const restored = await executeProductEvent(
      { context: opened.context, event: eventOf("CREATE_BAN.PRESS_BACK") },
      opened.deps,
    );
    expect(restored.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(restored.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_A);
    expect(restored.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    const kept = await readRuntime(opened.store, USER_ID);
    expect(seen).toEqual([]);
    expect(kept.runtime).toEqual(local);
    expect(kept.runtime.continuityMode).toBe("local-canonical-history");

    const started = makeChat({
      id: "chat-next" as RimChatId,
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [],
      aiOperation: { status: "IDLE" },
    });
    await opened.kit.installFixtureSnapshot(USER_ID, chatSnapshot(started));
    const initialized: string[] = [];
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        conversation: {
          async initialize(request) {
            initialized.push(request.rimChatId);
            return { conversationId: "conv-next" as ProviderConversationId };
          },
        },
        retrieval: null,
      }),
    ).toBeNull();
    const next = await readRuntime(opened.store, USER_ID);
    expect(seen).toEqual([]);
    expect(initialized).toEqual(["chat-next"]);
    expect(next.runtime.rimChatId).toBe(started.id);
    expect(next.runtime.selectedContactId).toBe(CONTACT_A);
    expect(next.runtime.continuityMode).toBe("provider-conversation");
    expect(next.runtime.retiredAttemptId).toBeNull();
    expect(next.runtime.attempt).toBeNull();
    expect(next.runtime.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: "conv-next",
    });
  });
});
