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
  type ContextRequestId,
  type ExecutionProbability,
  type ProductSnapshot,
  type ProposalId,
  type RimChat,
  type RimChatId,
  type UserId,
} from "@98plus/product-model";
import {
  AI_REQUEST_ID,
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  REQUEST_ID,
  STATUS_ITEM_ID,
  USER_ID,
  defaultEvent,
  makeChat,
  pendingAi,
  pendingOp,
  readyContext,
  validCreateDraft,
  withChat,
  withControlState,
  withOperation,
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
import {
  localModelFacingHistory,
  projectLocalCanonicalHistory,
  type RimAiPort,
  type RimAiRequest,
} from "./rim-ai-port.ts";
import {
  assertProviderReadySemantics,
  PRODUCT_SEMANTICS_UNAVAILABLE,
  RIM_PROMPT_UNAVAILABLE,
  type RimConversationInitializationPort,
} from "./rim-conversation-port.ts";
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

function storedConversationId(initialization: RimProviderRuntime["initialization"]): string {
  if (initialization.submissionState !== "stored") {
    throw new Error("expected stored initialization");
  }
  return initialization.conversationId;
}

function localRuntime(chat: RimChat, attemptId = "attempt-local"): RimProviderRuntime {
  const requestId =
    chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : AI_REQUEST_ID;
  return {
    ...runtimeFor(chat, "not-submitted"),
    continuityMode: "local-canonical-history",
    retiredAttemptId: attempt("attempt-retired"),
    attempt: {
      requestId,
      attemptId: attempt(attemptId),
      submissionState: "not-submitted",
      clientRequestId: null,
    },
  };
}

const localSeparatesConversationId: "conversationId" extends keyof Extract<
  RimAiRequest,
  { continuityMode: "local-canonical-history" }
>
  ? never
  : true = true;

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

function interruptAfterReturnedBody(inner: ProductStore): ProductStore {
  let interrupt = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "saveRimProviderRuntime") {
        return async (userId: UserId, expectedRevision: number, runtime: unknown) => {
          const saved = await target.saveRimProviderRuntime(userId, expectedRevision, runtime);
          const parsed = parseRimProviderRuntime(runtime);
          if (
            parsed.status === "PRESENT" &&
            parsed.runtime.attempt?.submissionState === "returned-body-observed"
          ) {
            interrupt = true;
          }
          return saved;
        };
      }
      if (prop === "persistTransition") {
        return async (input: Parameters<ProductStore["persistTransition"]>[0]) => {
          if (interrupt) {
            throw new Error("interrupted before product completion");
          }
          return target.persistTransition(input);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
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
    expect(states).toEqual(["not-submitted", "acceptance-unknown", "returned-body-observed"]);
    expect(order).toEqual(["respond"]);
    expect(seen[0]?.continuityMode).toBe("provider-conversation");
    if (seen[0]?.continuityMode !== "provider-conversation") {
      throw new Error("expected provider continuation");
    }
    expect("canonicalHistory" in seen[0]).toBe(false);
    expect(seen[0].requestId).toBe(effect.requestId);
    expect(seen[0].userMessage).toBe("привет");
    expect(userTexts(settled.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(settled.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(settled.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    expect(settled.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(settled.event.name).not.toBe("RIM.PRESS_RETRY_AI");
    const after = await readRuntime(app.store, SENDER_ID);
    expect(seen[0].conversationId).toBe(storedConversationId(after.runtime.initialization));
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt?.submissionState).toBe("returned-body-observed");
    expect(after.runtime.attempt).not.toHaveProperty("responseId");
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
    expect(after.runtime.attempt?.submissionState).toBe("returned-body-observed");
  });

  it("executes the transitioned local attempt once, without a second USER or Conversation", async () => {
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
      rimAi: {
        async respond(request) {
          seen.push(request);
          const loaded = await store.loadProductSnapshot(USER_ID);
          const runtime = applicableRimProviderRuntime(
            parseRimProviderRuntime(loaded.rimProviderRuntime),
            request.rimChatId,
          );
          expect(runtime?.continuityMode).toBe("local-canonical-history");
          expect(runtime?.attempt?.submissionState).toBe("acceptance-unknown");
          expect(runtime?.attempt?.requestId).toBe(AI_REQUEST_ID);
          expect(runtime?.retiredAttemptId).toBe(attempt("attempt-1"));
          return { kind: "MESSAGE", text: "слышу" };
        },
      },
      conversation,
      retrieval: null,
    });
    expect(first?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(first?.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(first?.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(initialized).toBe(false);
    expect(seen).toHaveLength(1);
    const local = seen[0];
    expect(local?.continuityMode).toBe("local-canonical-history");
    expect(local && "conversationId" in local).toBe(false);
    expect(local?.requestId).toBe(AI_REQUEST_ID);
    expect(local && "userMessage" in local).toBe(false);
    const transitioned = await readRuntime(store, USER_ID);
    const nextAttempt = transitioned.runtime.attempt;
    expect(transitioned.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(userTexts(transitioned.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(transitioned.runtime.continuityMode).toBe("local-canonical-history");
    expect(transitioned.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(nextAttempt?.attemptId).not.toBe(attempt("attempt-1"));
    expect(nextAttempt).toMatchObject({
      requestId: AI_REQUEST_ID,
      submissionState: "returned-body-observed",
    });
    expect(transitioned.runtime.initialization).toEqual(before.initialization);
    expect(transitioned.runtime.rimChatId).toBe(chat.id);
    expect(transitioned.runtime.selectedContactId).toBe(chat.selectedContactId);
    expect(transitioned.runtime.contextRequestId).toBe(before.contextRequestId);
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
    expect(seen).toHaveLength(1);
    expect(initialized).toBe(false);
    expect(settled.runtime).toEqual(transitioned.runtime);
    expect(settled.runtime.continuityMode).toBe("local-canonical-history");
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

  it("executes local history after a live provider throw, without E-59, Retry, or C1", async () => {
    const seen: RimAiRequest[] = [];
    const observed: { store: ProductStore | null } = { store: null };
    let providerAttemptId: string | undefined;
    let localAttemptId: string | undefined;
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
          if (seen.length === 1) {
            providerAttemptId = runtime?.attempt?.attemptId;
            expect(request.continuityMode).toBe("provider-conversation");
            throw new FakeRimAiFailure({
              code: "RIM_AI_FAILED",
              message: "provider down",
            } as never);
          }
          localAttemptId = runtime?.attempt?.attemptId;
          expect(runtime?.continuityMode).toBe("local-canonical-history");
          expect(runtime?.attempt?.submissionState).toBe("acceptance-unknown");
          expect(request.continuityMode).toBe("local-canonical-history");
          return { kind: "MESSAGE", text: "локально" };
        },
      },
      observed,
    );
    const chat = failed.snapshot.extended.rimChat;
    expect(failed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(failed.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    expect(failed.traces.some((trace) => trace.eventId === "E-58")).toBe(true);
    expect(failed.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(chat?.aiOperation.status).toBe("IDLE");
    const after = await readRuntime(app.store, SENDER_ID);
    const requestId = after.runtime.attempt?.requestId;
    expect(seen).toHaveLength(2);
    const providerTurn = seen[0];
    const localTurn = seen[1];
    expect(providerTurn?.continuityMode).toBe("provider-conversation");
    if (providerTurn?.continuityMode !== "provider-conversation") {
      throw new Error("expected provider continuation");
    }
    expect(localTurn?.continuityMode).toBe("local-canonical-history");
    expect(localTurn && "conversationId" in localTurn).toBe(false);
    expect(localTurn?.requestId).toBe(providerTurn.requestId);
    expect(localTurn?.requestId).toBe(requestId);
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["почему так"]);
    expect(after.loaded.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "локально",
    });
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(providerAttemptId).toBeTruthy();
    expect(localAttemptId).toBeTruthy();
    expect(localAttemptId).not.toBe(providerAttemptId);
    expect(after.runtime.retiredAttemptId).toBe(providerAttemptId);
    expect(after.runtime.attempt?.attemptId).toBe(localAttemptId);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "returned-body-observed",
      requestId,
    });
    expect(storedConversationId(after.runtime.initialization)).toBe(providerTurn.conversationId);
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
    expect(seen).toHaveLength(2);
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

  it("does not enter local mode for a restarted returned-body-observed attempt", async () => {
    const { store, context, chat } = await installPending();
    const seeded = await store.loadProductSnapshot(USER_ID);
    const before = runtimeFor(chat, "returned-body-observed");
    await store.saveRimProviderRuntime(USER_ID, seeded.revision, before);
    const seen: RimAiRequest[] = [];
    const recovered = await recoverPendingRimAi({
      context,
      deps: {
        store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(50),
      },
      rimAi: port(seen),
      retrieval: null,
    });
    expect(recovered).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime).toEqual(before);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("does not enter local mode when E-54 reloads an invalid returned body from a new store", async () => {
    const seen: RimAiRequest[] = [];
    const { app, failed } = await failPendingSend({
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
    if (!chat || chat.aiOperation.status !== "FAILED") {
      throw new Error("expected a failed RIM chat");
    }
    const source = await app.store.loadProductSnapshot(SENDER_ID);
    const durable = parseRimProviderRuntime(source.rimProviderRuntime);
    if (durable.status !== "PRESENT" || !durable.runtime.attempt) {
      throw new Error("expected durable runtime");
    }
    expect(durable.runtime.continuityMode).toBe("provider-conversation");
    expect(durable.runtime.attempt.submissionState).toBe("returned-body-observed");
    const attemptId = durable.runtime.attempt.attemptId;
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(SENDER_ID, "tg-sender");
    kit.establishIdentity(RECEIVER_ID, "tg-receiver");
    const installed = await kit.installFixtureSnapshot(SENDER_ID, source.snapshot);
    await kit.store.saveRimProviderRuntime(
      SENDER_ID,
      installed.revision,
      source.rimProviderRuntime,
    );
    const memory = kit.memoryStore;
    if (!memory) {
      throw new Error("expected a memory store");
    }
    const restarted = await productApp(memory);
    const retried = await restarted.sender(
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: chat.aiOperation.requestId }),
    );
    expect(retried.traces.some((trace) => trace.eventId === "E-54")).toBe(true);
    const restartSeen: RimAiRequest[] = [];
    const followed = await continueRimEffects(retried, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: kit.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(90),
      },
      rimAi: port(restartSeen),
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(seen).toHaveLength(1);
    expect(restartSeen).toEqual([]);
    expect(followed.event.name).toBe("RIM.PRESS_RETRY_AI");
    expect(followed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(followed.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: chat.aiOperation.requestId,
    });
    expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["почему так"]);
    const after = await readRuntime(kit.store, SENDER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "returned-body-observed",
      attemptId,
      requestId: chat.aiOperation.requestId,
    });
  });

  it("does not enter local mode when dispatch is interrupted after a returned body is stored", async () => {
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
    const seen: RimAiRequest[] = [];
    await expect(
      continueRimEffects(sent, {
        context,
        deps: {
          store: interruptAfterReturnedBody(app.store),
          clock: { nowMs: () => 2_000_000 },
          allocateId: counterAllocator(1),
        },
        rimAi: {
          async respond(request) {
            seen.push(request);
            return { kind: "MESSAGE", text: "слышу" };
          },
        },
        contextFailures: { remainingFailures: 0 },
        loadSources: async () => [],
      }),
    ).rejects.toThrow("interrupted before product completion");
    const durable = await readRuntime(app.store, SENDER_ID);
    expect(durable.runtime.continuityMode).toBe("provider-conversation");
    expect(durable.runtime.retiredAttemptId).toBeNull();
    expect(durable.runtime.attempt?.submissionState).toBe("returned-body-observed");
    expect(durable.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(userTexts(durable.loaded.snapshot.extended.rimChat)).toEqual(["почему так"]);
    const again: RimAiRequest[] = [];
    const recovered = await recoverPendingRimAi({
      context,
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(80),
      },
      rimAi: port(again),
      retrieval: null,
    });
    expect(recovered).toBeNull();
    expect(seen).toHaveLength(1);
    expect(again).toEqual([]);
    const after = await readRuntime(app.store, SENDER_ID);
    expect(after.runtime).toEqual(durable.runtime);
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["почему так"]);
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
      if (!current?.attempt || current.attempt.submissionState !== "returned-body-observed") {
        throw new Error("expected returned-body-observed");
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
    expect(seen).toEqual([]);
    const resumed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: null,
    });
    const kept = await readRuntime(opened.store, USER_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    expect(seen[0] && "conversationId" in seen[0]).toBe(false);
    expect(seen[0]?.requestId).toBe(AI_REQUEST_ID);
    expect(resumed?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(kept.runtime.continuityMode).toBe("local-canonical-history");
    expect(kept.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(kept.runtime.attempt?.attemptId).toBe(attempt("attempt-local"));
    expect(storedConversationId(kept.runtime.initialization)).toBe("conv-stored-1");
    expect(kept.loaded.snapshot.extended.rimChat?.id).toBe(chat.id);

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
    expect(seen).toHaveLength(1);
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

  it.each(["acceptance-unknown", "returned-body-observed"] as const)(
    "does not execute a frozen local %s attempt when Back restores the chat",
    async (submissionState) => {
      const chat = pendingChat();
      const opened = await installPending(chat);
      const seeded: RimProviderRuntime = {
        ...localRuntime(chat),
        attempt: {
          requestId: AI_REQUEST_ID,
          attemptId: attempt("attempt-local"),
          submissionState,
          clientRequestId: null,
        },
      };
      await opened.store.saveRimProviderRuntime(USER_ID, opened.installed.revision, seeded);
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
      expect(seen).toEqual([]);
      const restored = await executeProductEvent(
        { context: opened.context, event: eventOf("CREATE_BAN.PRESS_BACK") },
        opened.deps,
      );
      expect(restored.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      expect(
        await recoverPendingRimAi({
          context: opened.context,
          deps: opened.deps,
          rimAi: port(seen),
          retrieval: null,
        }),
      ).toBeNull();
      expect(seen).toEqual([]);
      const kept = await readRuntime(opened.store, USER_ID);
      expect(kept.runtime).toEqual(seeded);
      expect(kept.runtime.continuityMode).toBe("local-canonical-history");
      expect(kept.runtime.attempt?.submissionState).toBe(submissionState);
      expect(kept.runtime.attempt?.attemptId).toBe(attempt("attempt-local"));
      expect(kept.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
        status: "PENDING",
        requestId: AI_REQUEST_ID,
      });
    },
  );

  it("executes one seeded local attempt from frozen canonical history", async () => {
    expect(localSeparatesConversationId).toBe(true);
    const origin = {
      sourceStatusItemId: STATUS_ITEM_ID,
      banId: BAN_ID,
      status: "BANTASTIC" as const,
      sourceRole: "RECEIVER" as const,
    };
    const proposals = [
      {
        proposalId: "p-1" as ProposalId,
        banText: "не обсуждать работу",
        executionProbability: 0.2 as ExecutionProbability,
      },
      {
        proposalId: "p-2" as ProposalId,
        banText: "не опаздывать",
        executionProbability: 0.5 as ExecutionProbability,
      },
      {
        proposalId: "p-3" as ProposalId,
        banText: "не повышать голос",
        executionProbability: 0.8 as ExecutionProbability,
      },
    ] as const;
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      askRimOrigin: origin,
      messages: [
        { kind: "USER", text: "раньше" },
        { kind: "RIM", text: "ответ" },
        { kind: "BAN_PROPOSALS", message: "три", proposals },
        { kind: "USER", text: "сейчас" },
      ],
      aiOperation: pendingAi({ userMessage: "сейчас" }),
    });
    const opened = await installPending(chat);
    const seeded = localRuntime(chat);
    await opened.store.saveRimProviderRuntime(USER_ID, opened.installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    const saves: unknown[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: { ...opened.deps, store: watchSaves(opened.store, saves, { count: 0 }) },
      rimAi: {
        async respond(request) {
          seen.push(request);
          const during = await readRuntime(opened.store, USER_ID);
          expect(during.runtime.attempt).toMatchObject({
            attemptId: attempt("attempt-local"),
            submissionState: "acceptance-unknown",
            requestId: AI_REQUEST_ID,
          });
          return { kind: "MESSAGE", text: "дальше" };
        },
      },
      retrieval: null,
    });
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const request = seen[0];
    if (request?.continuityMode !== "local-canonical-history") {
      throw new Error("expected local execution");
    }
    expect(request.relationshipContext).toEqual(chat.relationshipContext?.data);
    expect(request.conversationalOrigin).toEqual(origin);
    expect(request.rimPrompt).toBe(RIM_PROMPT_UNAVAILABLE);
    expect(request.productSemantics).toBe(PRODUCT_SEMANTICS_UNAVAILABLE);
    expect(() => assertProviderReadySemantics(request)).toThrow(/not provider-ready/);
    expect(request.canonicalHistory).toEqual(projectLocalCanonicalHistory(chat.messages));
    expect("userMessage" in request).toBe(false);
    const facing = localModelFacingHistory(request);
    expect(facing).toBe(request.canonicalHistory);
    expect(facing.filter((entry) => entry.kind === "USER" && entry.text === "сейчас")).toHaveLength(
      1,
    );
    expect(facing.filter((entry) => entry.kind === "USER")).toEqual([
      { kind: "USER", text: "раньше" },
      { kind: "USER", text: "сейчас" },
    ]);
    expect(request.canonicalHistory).toContainEqual({ kind: "RIM", text: "ответ" });
    expect(request.canonicalHistory).toContainEqual({
      kind: "BAN_PROPOSALS",
      message: "три",
      proposals: [
        { banText: "не обсуждать работу", executionProbability: 0.2 },
        { banText: "не опаздывать", executionProbability: 0.5 },
        { banText: "не повышать голос", executionProbability: 0.8 },
      ],
    });
    expect(JSON.stringify(request.canonicalHistory)).not.toContain("proposalId");
    expect(JSON.stringify(request.canonicalHistory)).not.toContain("скрытый-поток");
    expect(Object.keys(request)).not.toContain("conversationId");
    const states = saves.map((saved) => {
      const parsed = parseRimProviderRuntime(saved);
      return parsed.status === "PRESENT" ? parsed.runtime.attempt?.submissionState : parsed.status;
    });
    expect(states).toEqual(["acceptance-unknown", "returned-body-observed"]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-local"));
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["раньше", "сейчас"]);
  });

  it("keeps an ordinary local request without origin and completes BAN_PROPOSALS once", async () => {
    const chat = pendingChat("предложи");
    const opened = await installPending(chat);
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      opened.installed.revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, {
        kind: "BAN_PROPOSALS",
        message: "три запрета",
        proposals: [
          { banText: "не обсуждать работу", executionProbability: 0.2 },
          { banText: "не опаздывать", executionProbability: 0.5 },
          { banText: "не повышать голос", executionProbability: 0.8 },
        ],
      }),
      retrieval: null,
    });
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    if (seen[0]?.continuityMode !== "local-canonical-history") {
      throw new Error("expected local execution");
    }
    expect(seen[0].conversationalOrigin).toBeNull();
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const message = settled?.snapshot.extended.rimChat?.messages.at(-1);
    expect(message?.kind).toBe("BAN_PROPOSALS");
    if (message?.kind !== "BAN_PROPOSALS") {
      return;
    }
    expect(new Set(message.proposals.map((item) => item.proposalId)).size).toBe(3);
    expect(message.proposals.map((item) => item.proposalId)).not.toContain("provider-1");
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-local"));
  });

  it("does not execute a local attempt when the frozen RelationshipContext is missing", async () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: {
        selectedContactId: CONTACT_A,
        status: "error",
        requestId: REQUEST_ID,
        data: null,
        failure: { code: "CONTEXT_FAILED", message: "missing" } as never,
      },
      messages: [{ kind: "USER", text: "привет" }],
      aiOperation: pendingAi({ userMessage: "привет" }),
    });
    const opened = await installPending(chat);
    const seeded = localRuntime(chat);
    await opened.store.saveRimProviderRuntime(USER_ID, opened.installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect((await readRuntime(opened.store, USER_ID)).runtime).toEqual(seeded);
  });

  it("does not execute a local attempt when the pending request leaves the frozen context", async () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "привет" }],
      aiOperation: pendingAi({
        userMessage: "привет",
        contextRequestId: "context-other" as ContextRequestId,
      }),
    });
    const opened = await installPending(chat);
    const seeded = localRuntime(chat);
    await opened.store.saveRimProviderRuntime(USER_ID, opened.installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    let initialized = false;
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        conversation: {
          async initialize() {
            initialized = true;
            throw new Error("initializer called");
          },
        },
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect(initialized).toBe(false);
    expect((await readRuntime(opened.store, USER_ID)).runtime).toEqual(seeded);
  });

  it("fails closed when a local runtime context id differs from the ready context", async () => {
    const chat = pendingChat();
    const opened = await installPending(chat);
    const seeded: RimProviderRuntime = {
      ...localRuntime(chat),
      contextRequestId: "context-other" as ContextRequestId,
    };
    await opened.store.saveRimProviderRuntime(USER_ID, opened.installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    let initialized = false;
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        conversation: {
          async initialize() {
            initialized = true;
            throw new Error("initializer called");
          },
        },
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect(initialized).toBe(false);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(seeded);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
    expect(after.runtime.contextRequestId).toBe("context-other");
    expect(after.loaded.snapshot.extended.rimChat?.relationshipContext?.requestId).toBe(REQUEST_ID);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: AI_REQUEST_ID,
    });
  });

  it("lets exactly one caller execute a local attempt", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    const tools = {
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    };
    const [first, second] = await Promise.all([
      recoverPendingRimAi(tools),
      recoverPendingRimAi(tools),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    const completions = [first, second].filter(
      (result) => result?.event.name === "RIM.AI_RESULT_RECEIVED",
    );
    expect(completions).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-local"));
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("stores a local returned body before E-58 and does not execute it again", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    await expect(
      recoverPendingRimAi({
        context,
        deps: { ...deps, store: interruptAfterReturnedBody(store) },
        rimAi: port(seen),
        retrieval: null,
      }),
    ).rejects.toThrow("interrupted before product completion");
    const durable = await readRuntime(store, USER_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0] && "conversationId" in seen[0]).toBe(false);
    expect(durable.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "returned-body-observed",
      requestId: AI_REQUEST_ID,
    });
    expect(durable.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const again = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(again).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(durable.runtime);
  });

  it("terminally fails invalid local output without another attempt or mode change", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    const failed = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen, { kind: "BAN_PROPOSALS", message: "сломан", proposals: [] }),
      retrieval: null,
    });
    expect(failed?.event.name).toBe("RIM.AI_REQUEST_FAILED");
    expect(failed?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "returned-body-observed",
    });
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("leaves a thrown local call pending on the same acceptance-unknown attempt", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    let initialized = false;
    const thrown = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request) {
          seen.push(request);
          throw new Error("local down");
        },
      },
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      retrieval: null,
    });
    expect(thrown).toBeNull();
    expect(initialized).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    expect(seen[0] && "conversationId" in seen[0]).toBe(false);
    const after = await readRuntime(store, USER_ID);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: AI_REQUEST_ID,
    });
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "acceptance-unknown",
      requestId: AI_REQUEST_ID,
    });
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
    const retried = await executeProductEvent(
      {
        context,
        event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      },
      deps,
    );
    expect(retried.status).toBe("KERNEL_INVARIANT");
    expect(retried.outcome).toBe("KERNEL_INVARIANT");
    expect(retried.persisted).toBe(false);
    expect(retried.effects).toEqual([]);
    expect(retried.traces).toEqual([]);
    expect(retried.kernelError?.code).toBe("NO_BRANCH_MATCHED");
    expect(retried.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const kitRestart = PersistenceTestKit.inMemory();
    kitRestart.establishIdentity(USER_ID, "tg-user");
    const source = await store.loadProductSnapshot(USER_ID);
    const installed = await kitRestart.installFixtureSnapshot(USER_ID, source.snapshot);
    await kitRestart.store.saveRimProviderRuntime(
      USER_ID,
      installed.revision,
      source.rimProviderRuntime,
    );
    const restartSeen: RimAiRequest[] = [];
    const restarted = await recoverPendingRimAi({
      context,
      deps: {
        store: kitRestart.store,
        clock: deps.clock,
        allocateId: counterAllocator(80),
      },
      rimAi: port(restartSeen),
      retrieval: null,
    });
    expect(restarted).toBeNull();
    expect(restartSeen).toEqual([]);
    const kept = await readRuntime(kitRestart.store, USER_ID);
    expect(kept.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: AI_REQUEST_ID,
    });
    expect(kept.runtime).toEqual(after.runtime);
  });

  it("executes a later USER turn through the same local chat without C1", async () => {
    const seen: RimAiRequest[] = [];
    let calls = 0;
    const { app, failed } = await failPendingSend({
      async respond(request) {
        seen.push(request);
        calls += 1;
        if (calls === 1) {
          throw new FakeRimAiFailure({
            code: "RIM_AI_FAILED",
            message: "provider down",
          } as never);
        }
        return { kind: "MESSAGE", text: "первый" };
      },
    });
    expect(failed.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    const firstChat = failed.snapshot.extended.rimChat;
    const contextRequestId = firstChat?.relationshipContext?.requestId;
    const chatId = firstChat?.id;
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "ещё" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    const settled = await continueRimEffects(sent, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(400),
      },
      rimAi: {
        async respond(request) {
          seen.push(request);
          const loaded = await app.store.loadProductSnapshot(SENDER_ID);
          const messages = loaded.snapshot.extended.rimChat?.messages ?? [];
          if (request.continuityMode === "local-canonical-history") {
            expect(request.canonicalHistory).toEqual(projectLocalCanonicalHistory(messages));
          }
          return { kind: "MESSAGE", text: "второй" };
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(seen).toHaveLength(3);
    const providerTurn = seen[0];
    const firstLocal = seen[1];
    const later = seen[2];
    if (providerTurn?.continuityMode !== "provider-conversation") {
      throw new Error("expected the retired provider turn");
    }
    if (
      firstLocal?.continuityMode !== "local-canonical-history" ||
      later?.continuityMode !== "local-canonical-history"
    ) {
      throw new Error("expected later local execution");
    }
    expect(later.requestId).not.toBe(firstLocal.requestId);
    expect("userMessage" in later).toBe(false);
    expect(
      localModelFacingHistory(later).filter(
        (entry) => entry.kind === "USER" && entry.text === "ещё",
      ),
    ).toHaveLength(1);
    expect(later.rimChatId).toBe(chatId);
    expect(later.contextRequestId).toBe(contextRequestId);
    expect(later.relationshipContext).toEqual(firstLocal.relationshipContext);
    expect(later.conversationalOrigin).toBeNull();
    expect("conversationId" in later).toBe(false);
    expect("conversationId" in firstLocal).toBe(false);
    expect(JSON.stringify(later)).not.toContain(providerTurn.conversationId);
    const userTurns = later.canonicalHistory.filter((entry) => entry.kind === "USER");
    expect(userTurns.filter((entry) => entry.text === "ещё")).toHaveLength(1);
    expect(later.canonicalHistory).toContainEqual({ kind: "RIM", text: "первый" });
    expect(userTexts(settled.snapshot.extended.rimChat)).toEqual(["почему так", "ещё"]);
    expect(settled.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "второй",
    });
    const after = await readRuntime(app.store, SENDER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(storedConversationId(after.runtime.initialization)).toBe(providerTurn.conversationId);
    expect(after.runtime.rimChatId).toBe(chatId);
  });

  it("does not execute local history after a successful Ban terminates the chat", async () => {
    const chat = pendingChat();
    const confirmBase = withOperation(
      withControlState(chatSnapshot(chat), "CREATE_BAN.CONFIRM.RIM"),
      pendingOp({ originatingState: "CREATE_BAN.CONFIRM.RIM" }),
    );
    const confirmWorld: ProductSnapshot = {
      ...confirmBase,
      extended: {
        ...confirmBase.extended,
        rimChat: chat,
        createBanDraft: validCreateDraft("RIM"),
        savedFrozenRimChat: chat,
      },
    };
    const opened = await harness();
    const installed = await opened.kit.installFixtureSnapshot(USER_ID, confirmWorld);
    const seeded = localRuntime(chat);
    await opened.store.saveRimProviderRuntime(USER_ID, installed.revision, seeded);
    const seen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    const banned = await executeProductEvent(
      { context: opened.context, event: defaultEvent("CREATE_BAN.SEND_CONFIRMED") },
      opened.deps,
    );
    expect(banned.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(banned.snapshot.extended.rimChat).toBeNull();
    expect(banned.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.rimChatId).toBe(chat.id);
  });
});
