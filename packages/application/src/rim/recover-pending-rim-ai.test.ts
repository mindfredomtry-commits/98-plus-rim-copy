import { describe, expect, it } from "vitest";
import {
  PersistenceError,
  type CommitOwnedTransitionInput,
  type ProductStore,
} from "@98plus/persistence";
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
  type TransitionResult,
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
  failedAi,
  makeChat,
  pendingAi,
  pendingOp,
  readyContext,
  validCreateDraft,
  withChat,
  withControlState,
  withOperation,
} from "../../../product-model/src/kernel.fixtures.ts";
import { ApplicationError } from "../errors.ts";
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
  PRODUCT_SEMANTICS_MVP15,
  RIM_PROMPT_V1,
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
const CREATED_RESPONSE_ID = "resp-created-1" as ProviderResponseId;
const OTHER_RESPONSE_ID = "resp-other-1" as ProviderResponseId;

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

function refuseRetrievedObservation(store: ProductStore): ProductStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "saveRimProviderRuntime") {
        return async (userId: UserId, expectedRevision: number, runtime: unknown) => {
          const parsed = parseRimProviderRuntime(runtime);
          if (
            parsed.status === "PRESENT" &&
            parsed.runtime.attempt?.submissionState === "completed-retrieved"
          ) {
            throw new PersistenceError("REVISION_CONFLICT", "lost retrieval observation");
          }
          return target.saveRimProviderRuntime(userId, expectedRevision, runtime);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
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
      if (prop === "commitOwnedTransition") {
        return async (input: CommitOwnedTransitionInput) => {
          if (interrupt) {
            throw new Error("interrupted before product completion");
          }
          return target.commitOwnedTransition(input);
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

function invalidBody(): Awaited<ReturnType<RimAiPort["respond"]>> {
  return {
    kind: "BAN_PROPOSALS",
    message: "сломан",
    proposals: [],
  } as unknown as Awaited<ReturnType<RimAiPort["respond"]>>;
}

function failedChat(text = "привет"): RimChat {
  return makeChat({
    selectedContactId: CONTACT_A,
    relationshipContext: readyContext(),
    messages: [{ kind: "USER", text }],
    aiOperation: failedAi({ code: RIM_AI_OUTPUT_INVALID } as never, {
      userMessage: text,
      rimChatId: CHAT_ID,
    }),
  });
}

function localAttemptRuntime(
  chat: RimChat,
  submission: RimProviderAttempt["submissionState"],
  providerStatus?: RetrievedProviderStatus,
): RimProviderRuntime {
  const base = localRuntime(chat);
  const requestId = base.attempt?.requestId ?? AI_REQUEST_ID;
  const providerAttempt: RimProviderAttempt =
    submission === "completed-retrieved"
      ? {
          requestId,
          attemptId: attempt("attempt-local"),
          submissionState: submission,
          responseId: RESPONSE_ID,
          providerStatus: providerStatus ?? "completed",
          clientRequestId: null,
        }
      : submission === "response-id-known"
        ? {
            requestId,
            attemptId: attempt("attempt-local"),
            submissionState: submission,
            responseId: RESPONSE_ID,
            clientRequestId: null,
          }
        : {
            requestId,
            attemptId: attempt("attempt-local"),
            submissionState: submission,
            clientRequestId: null,
          };
  return { ...base, attempt: providerAttempt };
}

function assertLocalRetry(request: RimAiRequest | undefined, text: string): void {
  expect(request?.continuityMode).toBe("local-canonical-history");
  if (request?.continuityMode !== "local-canonical-history") {
    throw new Error("expected local retry");
  }
  expect("conversationId" in request).toBe(false);
  expect(request.canonicalHistory.filter((entry) => entry.kind === "USER")).toEqual([
    { kind: "USER", text },
  ]);
}

function supersedeOnNextLoad(
  inner: ProductStore,
  armOn: RimProviderAttempt["submissionState"],
  replacement: RimProviderRuntime,
): ProductStore {
  let armed = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "saveRimProviderRuntime") {
        return async (userId: UserId, expectedRevision: number, runtime: unknown) => {
          const saved = await target.saveRimProviderRuntime(userId, expectedRevision, runtime);
          const parsed = parseRimProviderRuntime(runtime);
          if (parsed.status === "PRESENT" && parsed.runtime.attempt?.submissionState === armOn) {
            armed = true;
          }
          return saved;
        };
      }
      if (prop === "loadProductSnapshot") {
        return async (userId: UserId) => {
          if (!armed) {
            return target.loadProductSnapshot(userId);
          }
          armed = false;
          const current = await target.loadProductSnapshot(userId);
          return target.saveRimProviderRuntime(userId, current.revision, replacement);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
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

  it("retries an invalid returned body locally when E-54 reloads a new store", async () => {
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
    let initialized = false;
    const followed = await continueRimEffects(retried, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: kit.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(90),
      },
      rimAi: port(restartSeen),
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(initialized).toBe(false);
    expect(seen).toHaveLength(1);
    expect(restartSeen).toHaveLength(1);
    expect(restartSeen[0]?.continuityMode).toBe("local-canonical-history");
    expect(restartSeen[0] && "conversationId" in restartSeen[0]).toBe(false);
    expect(followed.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(followed.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(followed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(followed.traces.some((trace) => trace.eventId === "E-64")).toBe(false);
    expect(followed.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["почему так"]);
    const after = await readRuntime(kit.store, SENDER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attemptId);
    expect(after.runtime.attempt?.attemptId).not.toBe(attemptId);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "returned-body-observed",
      requestId: chat.aiOperation.requestId,
    });
    expect(storedConversationId(after.runtime.initialization)).toBe(
      storedConversationId(durable.runtime.initialization),
    );
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

  it("retrieves a response-id-known attempt after E-54 and does not submit the USER turn again", async () => {
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
    const known: RimProviderAttempt = {
      requestId: current.attempt.requestId,
      attemptId: current.attempt.attemptId,
      submissionState: "response-id-known",
      responseId: RESPONSE_ID,
      clientRequestId: current.attempt.clientRequestId,
    };
    await app.store.saveRimProviderRuntime(SENDER_ID, loaded.revision, {
      rimChatId: current.rimChatId,
      selectedContactId: current.selectedContactId,
      contextRequestId: current.contextRequestId,
      initialization: current.initialization,
      attempt: known,
      continuityMode: current.continuityMode,
      retiredAttemptId: current.retiredAttemptId,
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
      parseRimProviderRuntime((await app.store.loadProductSnapshot(SENDER_ID)).rimProviderRuntime),
      chat.id,
    );
    expect(after?.continuityMode).toBe("provider-conversation");
    expect(after?.retiredAttemptId).toBeNull();
    expect(after?.attempt?.attemptId).toBe(current.attempt.attemptId);
  });
});

describe("DC-02 ambiguity transition", () => {
  it("keeps the frozen Product counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
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
    expect(request.rimPrompt).toBe(RIM_PROMPT_V1);
    expect(request.productSemantics).toBe(PRODUCT_SEMANTICS_MVP15);
    if (
      request.rimPrompt.availability === "available" &&
      request.productSemantics.availability === "available"
    ) {
      expect(request.rimPrompt.text).toBe(RIM_PROMPT_V1.text);
      expect(request.productSemantics.text).toBe(PRODUCT_SEMANTICS_MVP15.text);
    }
    expect(assertProviderReadySemantics(request)).toEqual({
      rimPrompt: RIM_PROMPT_V1,
      productSemantics: PRODUCT_SEMANTICS_MVP15,
    });
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

  it("stores a provider response id before the semantic body and keeps it through E-58", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          const created = await observer.onResponseCreated(CREATED_RESPONSE_ID);
          expect(created.accepted).toBe(true);
          const during = await readRuntime(store, USER_ID);
          expect(during.runtime.continuityMode).toBe("provider-conversation");
          expect(during.runtime.attempt).toMatchObject({
            attemptId: attempt("attempt-1"),
            requestId: AI_REQUEST_ID,
            submissionState: "response-id-known",
            responseId: CREATED_RESPONSE_ID,
          });
          expect(during.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
          return { kind: "MESSAGE", text: "готово" };
        },
      },
      retrieval: null,
    });
    expect(seen).toHaveLength(1);
    const request = seen[0];
    if (request?.continuityMode !== "provider-conversation") {
      throw new Error("expected provider continuation");
    }
    expect(request.conversationId).toBe("conv-stored-1");
    expect(request.conversationId).not.toBe(CREATED_RESPONSE_ID);
    expect(request.userMessage).toBe("привет");
    expect(request.messages.filter((message) => message.kind === "USER")).toEqual([
      { kind: "USER", text: "привет" },
    ]);
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "returned-body-observed",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
  });

  it("stores a local response id before the semantic body without a conversation id", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          const created = await observer.onResponseCreated(CREATED_RESPONSE_ID);
          expect(created.accepted).toBe(true);
          const during = await readRuntime(store, USER_ID);
          expect(during.runtime.continuityMode).toBe("local-canonical-history");
          expect(during.runtime.attempt).toMatchObject({
            attemptId: attempt("attempt-local"),
            submissionState: "response-id-known",
            responseId: CREATED_RESPONSE_ID,
          });
          return { kind: "MESSAGE", text: "локально" };
        },
      },
      retrieval: null,
    });
    const request = seen[0];
    if (request?.continuityMode !== "local-canonical-history") {
      throw new Error("expected local execution");
    }
    expect("conversationId" in request).toBe(false);
    expect("userMessage" in request).toBe(false);
    expect(localModelFacingHistory(request).filter((entry) => entry.kind === "USER")).toEqual([
      { kind: "USER", text: "привет" },
    ]);
    expect(CREATED_RESPONSE_ID).not.toBe(
      storedConversationId((await readRuntime(store, USER_ID)).runtime.initialization),
    );
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "returned-body-observed",
      responseId: CREATED_RESPONSE_ID,
    });
  });

  it("keeps the response id when the completed local body is invalid", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const failed = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(_request, observer) {
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          return {
            kind: "BAN_PROPOSALS",
            message: "сломан",
            proposals: [],
          } as unknown as Awaited<ReturnType<RimAiPort["respond"]>>;
        },
      },
      retrieval: null,
    });
    expect(failed?.event.name).toBe("RIM.AI_REQUEST_FAILED");
    expect(failed?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "returned-body-observed",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
  });

  it("does not fall back after a provider throw once the response id is durable", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const thrown = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          throw new Error("stream lost");
        },
      },
      retrieval: null,
    });
    expect(thrown).toBeNull();
    expect(seen).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      requestId: AI_REQUEST_ID,
      submissionState: "response-id-known",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const again = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(again).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(after.runtime);
  });

  it("does not start another local attempt after a throw once the response id is durable", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    const thrown = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          throw new Error("stream lost");
        },
      },
      retrieval: null,
    });
    expect(thrown).toBeNull();
    expect(seen).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "response-id-known",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(after.runtime);
  });

  it("treats a repeated response id as idempotent and completes that body once", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(_request, observer) {
          const first = await observer.onResponseCreated(CREATED_RESPONSE_ID);
          const afterFirst = await store.loadProductSnapshot(USER_ID);
          const second = await observer.onResponseCreated(CREATED_RESPONSE_ID);
          const afterSecond = await store.loadProductSnapshot(USER_ID);
          expect(first.accepted).toBe(true);
          expect(second.accepted).toBe(true);
          expect(afterSecond.revision).toBe(afterFirst.revision);
          const during = parseRimProviderRuntime(afterSecond.rimProviderRuntime);
          expect(during.status === "PRESENT" && during.runtime.attempt).toMatchObject({
            submissionState: "response-id-known",
            responseId: CREATED_RESPONSE_ID,
          });
          return { kind: "MESSAGE", text: "готово" };
        },
      },
      retrieval: null,
    });
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(0);
    expect((await readRuntime(store, USER_ID)).runtime.attempt).toMatchObject({
      submissionState: "returned-body-observed",
      responseId: CREATED_RESPONSE_ID,
    });
  });

  it("discards a provider body after a conflicting response id and keeps the first id", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          expect((await observer.onResponseCreated(OTHER_RESPONSE_ID)).accepted).toBe(false);
          return { kind: "MESSAGE", text: "чужое" };
        },
      },
      retrieval: null,
    });
    expect(settled).toBeNull();
    expect(seen).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "response-id-known",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(after.runtime);
  });

  it("discards a local body after a conflicting response id and does not start another attempt", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(chat),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          expect(request.continuityMode).toBe("local-canonical-history");
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          expect((await observer.onResponseCreated(OTHER_RESPONSE_ID)).accepted).toBe(false);
          return { kind: "MESSAGE", text: "чужое" };
        },
      },
      retrieval: null,
    });
    expect(settled).toBeNull();
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-local"),
      submissionState: "response-id-known",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
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

  it("discards an invalid body after a conflicting response id", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(_request, observer) {
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          expect((await observer.onResponseCreated(OTHER_RESPONSE_ID)).accepted).toBe(false);
          return {
            kind: "BAN_PROPOSALS",
            message: "сломан",
            proposals: [],
          } as unknown as Awaited<ReturnType<RimAiPort["respond"]>>;
        },
      },
      retrieval: null,
    });
    expect(settled).toBeNull();
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "response-id-known",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("does not fall back when a conflicting response id is followed by a throw", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const thrown = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(request, observer) {
          seen.push(request);
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
          expect((await observer.onResponseCreated(OTHER_RESPONSE_ID)).accepted).toBe(false);
          throw new Error("stream lost");
        },
      },
      retrieval: null,
    });
    expect(thrown).toBeNull();
    expect(seen).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "response-id-known",
      responseId: CREATED_RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
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

  it("discards the body when the response-id CAS cannot be reconciled", async () => {
    const opened = await installPending();
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "not-submitted"),
    );
    let responseIdSaves = 0;
    const store = new Proxy(opened.store, {
      get(target, prop, receiver) {
        if (prop === "saveRimProviderRuntime") {
          return async (userId: UserId, expectedRevision: number, runtime: unknown) => {
            const parsed = parseRimProviderRuntime(runtime);
            if (
              parsed.status === "PRESENT" &&
              parsed.runtime.attempt?.submissionState === "response-id-known"
            ) {
              responseIdSaves += 1;
              throw new PersistenceError("REVISION_CONFLICT", "unreconciled response id");
            }
            return target.saveRimProviderRuntime(userId, expectedRevision, runtime);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: { ...opened.deps, store },
      rimAi: {
        async respond(_request, observer) {
          expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(false);
          return { kind: "MESSAGE", text: "нельзя" };
        },
      },
      retrieval: null,
    });
    expect(responseIdSaves).toBe(2);
    expect(settled).toBeNull();
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "acceptance-unknown",
    });
    expect(after.runtime.attempt).not.toHaveProperty("responseId");
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("keeps a legacy body authoritative when no response id is observed", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    let observed = false;
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: {
        async respond(_request, _observer) {
          observed = true;
          return { kind: "MESSAGE", text: "без идентификатора" };
        },
      },
      retrieval: null,
    });
    expect(observed).toBe(true);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "returned-body-observed",
    });
    expect(after.runtime.attempt).not.toHaveProperty("responseId");
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
  });

  it.each(["request", "chat", "attempt"] as const)(
    "does not apply a response id when the %s changed before the CAS",
    async (kind) => {
      const opened = await installPending();
      const seeded = runtimeFor(opened.chat, "not-submitted");
      await opened.store.saveRimProviderRuntime(
        USER_ID,
        (await opened.store.loadProductSnapshot(USER_ID)).revision,
        seeded,
      );
      const settled = await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: {
          async respond(_request, observer) {
            const loaded = await opened.store.loadProductSnapshot(USER_ID);
            const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
            if (parsed.status !== "PRESENT" || !parsed.runtime.attempt) {
              throw new Error("expected the claimed attempt");
            }
            if (kind === "request") {
              const replaced = makeChat({
                ...opened.chat,
                aiOperation: pendingAi({
                  requestId: "ai-other" as AiRequestId,
                  userMessage: "привет",
                  rimChatId: opened.chat.id,
                }),
              });
              await opened.kit.installFixtureSnapshot(USER_ID, chatSnapshot(replaced));
            } else if (kind === "chat") {
              const moved = makeChat({
                ...opened.chat,
                id: "chat-other" as RimChatId,
                aiOperation: pendingAi({
                  userMessage: "привет",
                  rimChatId: "chat-other" as RimChatId,
                }),
              });
              await opened.kit.installFixtureSnapshot(USER_ID, chatSnapshot(moved));
            } else {
              await opened.store.saveRimProviderRuntime(USER_ID, loaded.revision, {
                ...parsed.runtime,
                attempt: {
                  requestId: parsed.runtime.attempt.requestId,
                  attemptId: attempt("attempt-replaced"),
                  submissionState: "acceptance-unknown",
                  clientRequestId: parsed.runtime.attempt.clientRequestId,
                },
              });
            }
            expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(false);
            return { kind: "MESSAGE", text: "нельзя" };
          },
        },
        retrieval: null,
      });
      expect(settled).toBeNull();
      const after = await readRuntime(opened.store, USER_ID);
      expect(after.runtime.attempt?.submissionState).not.toBe("response-id-known");
      expect(after.runtime.attempt).not.toHaveProperty("responseId");
      expect(after.runtime.continuityMode).toBe("provider-conversation");
      if (kind === "attempt") {
        expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-replaced"));
        expect(after.runtime.attempt?.submissionState).toBe("acceptance-unknown");
      }
      if (kind === "chat") {
        expect(after.runtime.rimChatId).toBe(opened.chat.id);
      }
    },
  );

  it("retrieves a live-observed response id on restart without responding again", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: {
          async respond(request, observer) {
            seen.push(request);
            expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
            throw new Error("stream lost");
          },
        },
        retrieval: null,
      }),
    ).toBeNull();
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "из ответа" }, retrieved),
    });
    expect(seen).toHaveLength(1);
    expect(retrieved).toEqual([CREATED_RESPONSE_ID]);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(settled?.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect((await readRuntime(store, USER_ID)).runtime.attempt).toMatchObject({
      submissionState: "completed-retrieved",
      responseId: CREATED_RESPONSE_ID,
      providerStatus: "completed",
    });
  });

  it("retrieves a returned body that retained a response id", async () => {
    const { store, context, deps, chat } = await installPending();
    const base = runtimeFor(chat, "acceptance-unknown");
    if (!base.attempt) {
      throw new Error("expected an attempt");
    }
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      {
        ...base,
        attempt: {
          requestId: base.attempt.requestId,
          attemptId: base.attempt.attemptId,
          submissionState: "returned-body-observed",
          responseId: CREATED_RESPONSE_ID,
          clientRequestId: base.attempt.clientRequestId,
        },
      },
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "заново" }, retrieved),
    });
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([CREATED_RESPONSE_ID]);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect((await readRuntime(store, USER_ID)).runtime.continuityMode).toBe(
      "provider-conversation",
    );
  });

  it("does not retrieve a historical returned body that has no response id", async () => {
    const { store, context, deps, chat } = await installPending();
    const before = runtimeFor(chat, "returned-body-observed");
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      before,
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: retrieval("completed", { kind: "MESSAGE", text: "нельзя" }, retrieved),
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([]);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(before);
    expect(
      (await store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation.status,
    ).toBe("PENDING");
  });

  it("records queued and in-progress observations and retrieves them again", async () => {
    for (const status of ["queued", "in_progress"] as const) {
      const { store, context, deps, chat } = await installPending();
      await store.saveRimProviderRuntime(
        USER_ID,
        (await store.loadProductSnapshot(USER_ID)).revision,
        runtimeFor(chat, "response-id-known"),
      );
      const seen: RimAiRequest[] = [];
      const retrieved: ProviderResponseId[] = [];
      const steps = [
        { providerStatus: status },
        { providerStatus: "completed" as const, output: { kind: "MESSAGE", text: "готово" } },
      ];
      let index = 0;
      const portRetrieval: RimProviderRetrievalPort = {
        async retrieve(responseId) {
          retrieved.push(responseId);
          const step = steps[index] ?? steps[steps.length - 1];
          index += 1;
          if (!step) {
            throw new Error("missing retrieval step");
          }
          return {
            responseId,
            providerStatus: step.providerStatus,
            ...(step.output === undefined ? {} : { output: step.output }),
          };
        },
      };
      expect(
        await recoverPendingRimAi({
          context,
          deps,
          rimAi: port(seen),
          retrieval: portRetrieval,
        }),
      ).toBeNull();
      const during = await readRuntime(store, USER_ID);
      expect(during.runtime.attempt).toMatchObject({
        submissionState: "completed-retrieved",
        responseId: RESPONSE_ID,
        providerStatus: status,
      });
      expect(during.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      const settled = await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: portRetrieval,
      });
      expect(seen).toEqual([]);
      expect(retrieved).toEqual([RESPONSE_ID, RESPONSE_ID]);
      expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    }
  });

  it("leaves a completed retrieval with no output pending and retrieves it again", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "response-id-known"),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    let calls = 0;
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: {
        async retrieve(responseId) {
          retrieved.push(responseId);
          calls += 1;
          if (calls === 1) {
            return { responseId, providerStatus: "completed" };
          }
          return {
            responseId,
            providerStatus: "completed",
            output: { kind: "MESSAGE", text: "появилось" },
          };
        },
      },
    });
    expect(settled).toBeNull();
    expect((await readRuntime(store, USER_ID)).runtime.attempt).toMatchObject({
      submissionState: "completed-retrieved",
      providerStatus: "completed",
    });
    expect(
      (await store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation.status,
    ).toBe("PENDING");
    const finished = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: {
        async retrieve(responseId) {
          retrieved.push(responseId);
          return {
            responseId,
            providerStatus: "completed",
            output: { kind: "MESSAGE", text: "появилось" },
          };
        },
      },
    });
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([RESPONSE_ID, RESPONSE_ID]);
    expect(finished?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
  });

  it.each(["failed", "cancelled", "incomplete"] as const)(
    "dispatches E-59 for %s only after the retrieval observation commits",
    async (status) => {
      const { store, context, deps, chat } = await installPending();
      await store.saveRimProviderRuntime(
        USER_ID,
        (await store.loadProductSnapshot(USER_ID)).revision,
        runtimeFor(chat, "response-id-known"),
      );
      const seen: RimAiRequest[] = [];
      const settled = await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: retrieval(status),
      });
      expect(seen).toEqual([]);
      expect(settled?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
      expect(settled?.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
      expect((await readRuntime(store, USER_ID)).runtime.attempt).toMatchObject({
        submissionState: "completed-retrieved",
        responseId: RESPONSE_ID,
        providerStatus: status,
      });
    },
  );

  it("keeps the response id when retrieval transport fails and allows a later retrieve", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = runtimeFor(chat, "response-id-known");
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      seeded,
    );
    const seen: RimAiRequest[] = [];
    const thrown = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: {
        async retrieve() {
          throw new Error("transport down");
        },
      },
    });
    expect(thrown).toBeNull();
    expect(seen).toEqual([]);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(seeded);
    expect(
      (await store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation.status,
    ).toBe("PENDING");
    const retrieved: ProviderResponseId[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "позже" }, retrieved),
    });
    expect(retrieved).toEqual([RESPONSE_ID]);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
  });

  it("does not dispatch when the retrieval observation CAS loses", async () => {
    const opened = await installPending();
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "response-id-known"),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: { ...opened.deps, store: refuseRetrievedObservation(opened.store) },
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "частное" }),
    });
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "response-id-known",
      responseId: RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(after.loaded.snapshot.extended.rimChat?.messages.at(-1)?.kind).not.toBe("RIM");
  });

  it("does not dispatch a losing retrieval when the stored status already matches", async () => {
    const opened = await installPending();
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "completed-retrieved", { providerStatus: "completed" }),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: { ...opened.deps, store: refuseRetrievedObservation(opened.store) },
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "частное" }),
    });
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.attempt).toMatchObject({
      submissionState: "completed-retrieved",
      providerStatus: "completed",
      responseId: RESPONSE_ID,
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("does not dispatch when the saved retrieval snapshot no longer matches the attempt", async () => {
    const opened = await installPending();
    const seeded = runtimeFor(opened.chat, "response-id-known");
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      seeded,
    );
    const seen: RimAiRequest[] = [];
    const store = new Proxy(opened.store, {
      get(target, prop, receiver) {
        if (prop === "saveRimProviderRuntime") {
          return async (userId: UserId, _expectedRevision: number, runtime: unknown) => {
            const current = await target.loadProductSnapshot(userId);
            const parsed = parseRimProviderRuntime(runtime);
            if (parsed.status !== "PRESENT" || !parsed.runtime.attempt) {
              throw new Error("expected a retrieval observation");
            }
            const chat = current.snapshot.extended.rimChat;
            if (!chat || chat.aiOperation.status !== "PENDING") {
              throw new Error("expected a pending chat");
            }
            const replaced = makeChat({
              ...chat,
              aiOperation: pendingAi({
                requestId: "ai-other" as AiRequestId,
                userMessage: "привет",
                rimChatId: chat.id,
              }),
            });
            return {
              ...current,
              revision: current.revision + 1,
              snapshot: chatSnapshot(replaced),
              rimProviderRuntime: runtime,
            };
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: { ...opened.deps, store },
        rimAi: port(seen),
        retrieval: retrieval("completed", { kind: "MESSAGE", text: "чужой" }),
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(seeded);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it.each(["chat", "attempt", "identity"] as const)(
    "does not dispatch when the saved retrieval %s no longer matches",
    async (kind) => {
      const opened = await installPending();
      const seeded = runtimeFor(opened.chat, "response-id-known");
      await opened.store.saveRimProviderRuntime(
        USER_ID,
        (await opened.store.loadProductSnapshot(USER_ID)).revision,
        seeded,
      );
      const seen: RimAiRequest[] = [];
      const store = new Proxy(opened.store, {
        get(target, prop, receiver) {
          if (prop === "saveRimProviderRuntime") {
            return async (userId: UserId, _expectedRevision: number, runtime: unknown) => {
              const current = await target.loadProductSnapshot(userId);
              const parsed = parseRimProviderRuntime(runtime);
              if (
                parsed.status !== "PRESENT" ||
                parsed.runtime.attempt?.submissionState !== "completed-retrieved"
              ) {
                throw new Error("expected the retrieval observation");
              }
              if (kind === "chat") {
                const moved = makeChat({
                  ...opened.chat,
                  id: "chat-other" as RimChatId,
                });
                return {
                  ...current,
                  revision: current.revision + 1,
                  snapshot: chatSnapshot(moved),
                  rimProviderRuntime: runtime,
                };
              }
              const savedAttempt =
                kind === "attempt"
                  ? { ...parsed.runtime.attempt, attemptId: attempt("attempt-other") }
                  : parsed.runtime.attempt;
              return {
                ...current,
                revision: current.revision + 1,
                rimProviderRuntime: {
                  ...parsed.runtime,
                  ...(kind === "identity"
                    ? { continuityMode: "local-canonical-history" as const }
                    : {}),
                  attempt: savedAttempt,
                },
              };
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      expect(
        await recoverPendingRimAi({
          context: opened.context,
          deps: { ...opened.deps, store },
          rimAi: port(seen),
          retrieval: retrieval("completed", { kind: "MESSAGE", text: "чужой" }),
        }),
      ).toBeNull();
      expect(seen).toEqual([]);
      expect((await readRuntime(opened.store, USER_ID)).runtime).toEqual(seeded);
    },
  );

  it("does not save or dispatch a retrieved response id that does not match", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = runtimeFor(chat, "response-id-known");
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      seeded,
    );
    const seen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: {
          async retrieve() {
            return {
              responseId: OTHER_RESPONSE_ID,
              providerStatus: "completed",
              output: { kind: "MESSAGE", text: "чужой" },
            };
          },
        },
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(seeded);
    expect(
      (await store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation.status,
    ).toBe("PENDING");
  });

  it("leaves the response id unchanged when retrieve returns null", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = runtimeFor(chat, "response-id-known");
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      seeded,
    );
    const seen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: {
          async retrieve() {
            return null;
          },
        },
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(seeded);
  });

  it("does not retrieve a known response while Create Ban is frozen, and retrieves it after Back", async () => {
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
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      installed.revision,
      runtimeFor(chat, "response-id-known"),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    expect(
      await recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: retrieval("completed", { kind: "MESSAGE", text: "после" }, retrieved),
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([]);
    const restored = await executeProductEvent(
      { context: opened.context, event: eventOf("CREATE_BAN.PRESS_BACK") },
      opened.deps,
    );
    expect(restored.snapshot.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "после" }, retrieved),
    });
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([RESPONSE_ID]);
    expect(settled?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    expect(userTexts(settled?.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect((await readRuntime(opened.store, USER_ID)).runtime.continuityMode).toBe(
      "provider-conversation",
    );
  });

  it("retrieves a provider response id without using the conversation id or changing mode", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "response-id-known"),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "провайдер" }, retrieved),
    });
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([RESPONSE_ID]);
    expect(retrieved[0]).not.toBe("conv-stored-1");
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
  });

  it("retrieves a local response id without a conversation id or a mode change", async () => {
    const { store, context, deps, chat } = await installPending();
    const local = localRuntime(chat);
    if (!local.attempt) {
      throw new Error("expected a local attempt");
    }
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      {
        ...local,
        attempt: {
          requestId: local.attempt.requestId,
          attemptId: local.attempt.attemptId,
          submissionState: "response-id-known",
          responseId: CREATED_RESPONSE_ID,
          clientRequestId: null,
        },
      },
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "локально" }, retrieved),
    });
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([CREATED_RESPONSE_ID]);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const after = await readRuntime(store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-retired"));
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-local"));
  });

  it("retrieves the first response id after a conflicting live observation", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "not-submitted"),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: {
          async respond(request, observer) {
            seen.push(request);
            expect((await observer.onResponseCreated(CREATED_RESPONSE_ID)).accepted).toBe(true);
            expect((await observer.onResponseCreated(OTHER_RESPONSE_ID)).accepted).toBe(false);
            return { kind: "MESSAGE", text: "отброшено" };
          },
        },
        retrieval: retrieval("completed", { kind: "MESSAGE", text: "не сейчас" }, retrieved),
      }),
    ).toBeNull();
    expect(retrieved).toEqual([]);
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "из A" }, retrieved),
    });
    expect(seen).toHaveLength(1);
    expect(retrieved).toEqual([CREATED_RESPONSE_ID]);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(settled?.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "из A",
    });
  });

  it("does not respond or fail when a known response has no retrieval port", async () => {
    const { store, context, deps, chat } = await installPending();
    const seeded = runtimeFor(chat, "response-id-known");
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      seeded,
    );
    const seen: RimAiRequest[] = [];
    expect(
      await recoverPendingRimAi({
        context,
        deps,
        rimAi: port(seen),
        retrieval: null,
      }),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect((await readRuntime(store, USER_ID)).runtime).toEqual(seeded);
    expect(
      (await store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation.status,
    ).toBe("PENDING");
  });

  it("finishes a stored completed observation from a fresh retrieve", async () => {
    const { store, context, deps, chat } = await installPending();
    await store.saveRimProviderRuntime(
      USER_ID,
      (await store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(chat, "completed-retrieved", { providerStatus: "completed" }),
    );
    const seen: RimAiRequest[] = [];
    const retrieved: ProviderResponseId[] = [];
    const settled = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "свежее" }, retrieved),
    });
    expect(seen).toEqual([]);
    expect(retrieved).toEqual([RESPONSE_ID]);
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(settled?.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "свежее",
    });
  });
});

describe("DC-03 local retry", () => {
  async function openFailed(runtime: RimProviderRuntime) {
    const opened = await installPending(failedChat());
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtime,
    );
    return opened;
  }

  async function retrievedTerminal(status: RetrievedProviderStatus, output?: unknown) {
    const opened = await installPending();
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "response-id-known"),
    );
    const failed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: retrieval(status, output),
    });
    return { opened, failed };
  }

  async function retryLocally(
    opened: Awaited<ReturnType<typeof installPending>>,
    output: unknown = { kind: "MESSAGE", text: "локально" },
  ) {
    const seen: RimAiRequest[] = [];
    let initialized = false;
    let retrieved = false;
    const retried = await executeProductEvent(
      {
        context: opened.context,
        event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      },
      opened.deps,
    );
    const followed = await continueRimEffects(retried, {
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, output),
      retrieval: {
        async retrieve() {
          retrieved = true;
          throw new Error("retired response must not be retrieved");
        },
      },
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    return { seen, initialized, retrieved, retried, followed };
  }

  it("switches a live invalid provider attempt to one local retry after E-54", async () => {
    const seen: RimAiRequest[] = [];
    let calls = 0;
    const { app, tools, failed } = await failPendingSend({
      async respond(request) {
        seen.push(request);
        calls += 1;
        if (calls === 1) {
          return invalidBody();
        }
        return { kind: "MESSAGE", text: "локально" };
      },
    });
    const chat = failed.snapshot.extended.rimChat;
    if (!chat || chat.aiOperation.status !== "FAILED") {
      throw new Error("expected E-59");
    }
    expect(failed.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    const before = await readRuntime(app.store, SENDER_ID);
    const retiredId = before.runtime.attempt?.attemptId;
    const conversationId = storedConversationId(before.runtime.initialization);
    expect(before.runtime.continuityMode).toBe("provider-conversation");
    expect(seen[0]?.continuityMode).toBe("provider-conversation");
    if (seen[0]?.continuityMode !== "provider-conversation") {
      throw new Error("expected the provider attempt");
    }
    expect(seen[0].conversationId).toBe(conversationId);
    expect(seen[0].userMessage).toBe("почему так");
    let initialized = false;
    const retried = await app.sender(
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: chat.aiOperation.requestId }),
    );
    const followed = await continueRimEffects(retried, {
      ...tools,
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
    });
    expect(initialized).toBe(false);
    expect(seen).toHaveLength(2);
    expect(
      seen.filter((request) => request.continuityMode === "provider-conversation"),
    ).toHaveLength(1);
    assertLocalRetry(seen[1], "почему так");
    expect(JSON.stringify(seen[1])).not.toContain(conversationId);
    expect(seen[1]?.requestId).toBe(chat.aiOperation.requestId);
    expect(followed.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(
      followed.traces.some((trace) => trace.eventId === "E-59" || trace.eventId === "E-64"),
    ).toBe(false);
    expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["почему так"]);
    const after = await readRuntime(app.store, SENDER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(retiredId);
    expect(after.runtime.attempt?.attemptId).not.toBe(retiredId);
    expect(after.runtime.attempt?.requestId).toBe(chat.aiOperation.requestId);
    expect(storedConversationId(after.runtime.initialization)).toBe(conversationId);
  });

  it("retries a retrieved completed invalid provider result locally after E-54", async () => {
    const { opened, failed } = await retrievedTerminal("completed", invalidBody());
    expect(failed?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    const before = await readRuntime(opened.store, USER_ID);
    expect(before.runtime.attempt?.submissionState).toBe("completed-retrieved");
    const retiredId = before.runtime.attempt?.attemptId;
    const { seen, initialized, retrieved, followed } = await retryLocally(opened);
    expect(initialized).toBe(false);
    expect(retrieved).toBe(false);
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    expect(followed.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["привет"]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(retiredId);
    expect(after.runtime.attempt?.attemptId).not.toBe(retiredId);
    expect(after.runtime.attempt?.requestId).toBe(AI_REQUEST_ID);
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
  });

  it.each(["failed", "cancelled", "incomplete"] as const)(
    "retries a retrieved provider %s result locally after E-54",
    async (status) => {
      const { opened, failed } = await retrievedTerminal(status);
      expect(failed?.event.name).toBe("RIM.AI_REQUEST_FAILED");
      expect(failed?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
      const before = await readRuntime(opened.store, USER_ID);
      expect(before.runtime.attempt).toMatchObject({
        submissionState: "completed-retrieved",
        providerStatus: status,
      });
      const { seen, initialized, retrieved, followed } = await retryLocally(opened);
      expect(initialized).toBe(false);
      expect(retrieved).toBe(false);
      expect(seen).toHaveLength(1);
      assertLocalRetry(seen[0], "привет");
      expect(followed.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
      expect(followed.traces.some((trace) => trace.eventId === "E-64")).toBe(false);
      expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["привет"]);
      const after = await readRuntime(opened.store, USER_ID);
      expect(after.runtime.continuityMode).toBe("local-canonical-history");
      expect(after.runtime.retiredAttemptId).toBe(before.runtime.attempt?.attemptId);
      expect(after.runtime.attempt?.attemptId).not.toBe(before.runtime.attempt?.attemptId);
      expect(after.runtime.attempt?.requestId).toBe(AI_REQUEST_ID);
    },
  );

  it("retries an already-local invalid attempt without leaving local mode", async () => {
    const opened = await installPending();
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      localRuntime(opened.chat),
    );
    const failed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port([], invalidBody()),
      retrieval: null,
    });
    expect(failed?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    const before = await readRuntime(opened.store, USER_ID);
    expect(before.runtime.continuityMode).toBe("local-canonical-history");
    expect(before.runtime.attempt?.submissionState).toBe("returned-body-observed");
    const retiredId = before.runtime.attempt?.attemptId;
    const { seen, initialized, retrieved, followed } = await retryLocally(opened);
    expect(initialized).toBe(false);
    expect(retrieved).toBe(false);
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    expect(followed.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["привет"]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(retiredId);
    expect(after.runtime.attempt?.attemptId).not.toBe(retiredId);
    expect(after.runtime.attempt?.requestId).toBe(AI_REQUEST_ID);
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
  });

  it("does not regenerate a local acceptance-unknown attempt on E-54", async () => {
    const opened = await openFailed(localAttemptRuntime(failedChat(), "acceptance-unknown"));
    const seen: RimAiRequest[] = [];
    const retried = await executeProductEvent(
      {
        context: opened.context,
        event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      },
      opened.deps,
    );
    expect(retried.traces.some((trace) => trace.eventId === "E-54")).toBe(true);
    const followed = await continueRimEffects(retried, {
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: null,
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(followed.event.name).toBe("RIM.PRESS_RETRY_AI");
    expect(seen).toEqual([]);
    expect(
      followed.traces.some((trace) => trace.eventId === "E-58" || trace.eventId === "E-59"),
    ).toBe(false);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(localAttemptRuntime(failedChat(), "acceptance-unknown"));
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: AI_REQUEST_ID,
    });
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("does not regenerate when E-54 retrieval transport fails or returns null", async () => {
    for (const outcome of ["throw", "null"] as const) {
      const opened = await openFailed(runtimeFor(failedChat(), "response-id-known"));
      const seen: RimAiRequest[] = [];
      const retrieved: ProviderResponseId[] = [];
      const retried = await executeProductEvent(
        {
          context: opened.context,
          event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
        },
        opened.deps,
      );
      const followed = await continueRimEffects(retried, {
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: {
          async retrieve(responseId) {
            retrieved.push(responseId);
            if (outcome === "throw") {
              throw new Error("transport down");
            }
            return null;
          },
        },
        contextFailures: { remainingFailures: 0 },
        loadSources: async () => [],
      });
      expect(followed.event.name).toBe("RIM.PRESS_RETRY_AI");
      expect(seen).toEqual([]);
      expect(retrieved).toEqual([RESPONSE_ID]);
      const after = await readRuntime(opened.store, USER_ID);
      expect(after.runtime.continuityMode).toBe("provider-conversation");
      expect(after.runtime.retiredAttemptId).toBeNull();
      expect(after.runtime.attempt).toMatchObject({
        attemptId: attempt("attempt-1"),
        submissionState: "response-id-known",
        requestId: AI_REQUEST_ID,
      });
      expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    }
  });

  it.each(["queued", "in_progress"] as const)(
    "does not regenerate when E-54 reloads a %s provider attempt",
    async (status) => {
      const opened = await openFailed(
        runtimeFor(failedChat(), "completed-retrieved", { providerStatus: status }),
      );
      const seen: RimAiRequest[] = [];
      const retried = await executeProductEvent(
        {
          context: opened.context,
          event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
        },
        opened.deps,
      );
      const followed = await continueRimEffects(retried, {
        context: opened.context,
        deps: opened.deps,
        rimAi: port(seen),
        retrieval: retrieval(status),
        contextFailures: { remainingFailures: 0 },
        loadSources: async () => [],
      });
      expect(followed.event.name).toBe("RIM.PRESS_RETRY_AI");
      expect(seen).toEqual([]);
      expect(
        followed.traces.some((trace) => trace.eventId === "E-58" || trace.eventId === "E-59"),
      ).toBe(false);
      const after = await readRuntime(opened.store, USER_ID);
      expect(after.runtime.continuityMode).toBe("provider-conversation");
      expect(after.runtime.attempt).toMatchObject({
        attemptId: attempt("attempt-1"),
        submissionState: "completed-retrieved",
        providerStatus: status,
      });
      expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
    },
  );

  it("does not regenerate a completed response whose output is not yet available", async () => {
    const opened = await installPending();
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "completed-retrieved", { providerStatus: "completed" }),
    );
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: {
        async retrieve(responseId) {
          return { responseId, providerStatus: "completed" };
        },
      },
    });
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "completed-retrieved",
      providerStatus: "completed",
    });
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("discards a late valid completion from a retired attempt", async () => {
    const opened = await installPending();
    const replacement: RimProviderRuntime = {
      ...runtimeFor(opened.chat, "not-submitted"),
      continuityMode: "local-canonical-history",
      retiredAttemptId: attempt("attempt-1"),
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-b"),
        submissionState: "not-submitted",
        clientRequestId: null,
      },
    };
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "response-id-known"),
    );
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: {
        ...opened.deps,
        store: supersedeOnNextLoad(opened.store, "completed-retrieved", replacement),
      },
      rimAi: port(),
      retrieval: retrieval("completed", { kind: "MESSAGE", text: "поздно" }),
    });
    expect(settled).toBeNull();
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(replacement);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(after.loaded.snapshot.extended.rimChat?.messages).toEqual([
      { kind: "USER", text: "привет" },
    ]);
  });

  it.each([
    { name: "invalid output", status: "completed" as const, output: invalidBody() },
    { name: "provider failure", status: "failed" as const, output: undefined },
  ])("discards a late $name from a retired attempt", async ({ status, output }) => {
    const opened = await installPending();
    const replacement: RimProviderRuntime = {
      ...runtimeFor(opened.chat, "not-submitted"),
      continuityMode: "local-canonical-history",
      retiredAttemptId: attempt("attempt-1"),
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-b"),
        submissionState: "not-submitted",
        clientRequestId: null,
      },
    };
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "response-id-known"),
    );
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: {
        ...opened.deps,
        store: supersedeOnNextLoad(opened.store, "completed-retrieved", replacement),
      },
      rimAi: port(),
      retrieval: retrieval(status, output),
    });
    expect(settled).toBeNull();
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(replacement);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("does not apply an old response retrieval after that attempt is superseded", async () => {
    const opened = await installPending();
    const replacement: RimProviderRuntime = {
      ...runtimeFor(opened.chat, "not-submitted"),
      continuityMode: "local-canonical-history",
      retiredAttemptId: attempt("attempt-1"),
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-b"),
        submissionState: "not-submitted",
        clientRequestId: null,
      },
    };
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      (await opened.store.loadProductSnapshot(USER_ID)).revision,
      runtimeFor(opened.chat, "response-id-known"),
    );
    const seen: RimAiRequest[] = [];
    const late = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: {
        async retrieve(responseId) {
          const current = await opened.store.loadProductSnapshot(USER_ID);
          await opened.store.saveRimProviderRuntime(USER_ID, current.revision, replacement);
          return {
            responseId,
            providerStatus: "completed" as const,
            output: { kind: "MESSAGE", text: "поздно" },
          };
        },
      },
    });
    expect(late).toBeNull();
    expect(seen).toEqual([]);
    expect((await readRuntime(opened.store, USER_ID)).runtime).toEqual(replacement);
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, { kind: "MESSAGE", text: "от B" }),
      retrieval: null,
    });
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(settled?.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(settled?.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "от B",
    });
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-b"));
  });

  it("emits one E-58 when the replacement attempt completes", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const { seen, followed } = await retryLocally(opened, { kind: "MESSAGE", text: "один" });
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    expect(followed.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(followed.traces.some((trace) => trace.eventId === "E-59")).toBe(false);
    expect(followed.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "один",
    });
  });

  it("emits E-59 for an invalid local retry only while that attempt is current", async () => {
    const current = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const invalid = await retryLocally(current, invalidBody());
    expect(invalid.seen).toHaveLength(1);
    assertLocalRetry(invalid.seen[0], "привет");
    expect(invalid.followed.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    expect(invalid.followed.traces.some((trace) => trace.eventId === "E-58")).toBe(false);
    expect(invalid.followed.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
    const failedRuntime = await readRuntime(current.store, USER_ID);
    expect(failedRuntime.runtime.continuityMode).toBe("local-canonical-history");
    expect(failedRuntime.runtime.attempt?.submissionState).toBe("returned-body-observed");
    expect(failedRuntime.runtime.attempt?.attemptId).not.toBe(attempt("attempt-1"));
    expect(userTexts(failedRuntime.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);

    const stale = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const replacement: RimProviderRuntime = {
      ...runtimeFor(failedChat(), "not-submitted"),
      continuityMode: "local-canonical-history",
      retiredAttemptId: attempt("attempt-b"),
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-c"),
        submissionState: "not-submitted",
        clientRequestId: null,
      },
    };
    const seen: RimAiRequest[] = [];
    const retried = await executeProductEvent(
      {
        context: stale.context,
        event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      },
      stale.deps,
    );
    const blocked = await continueRimEffects(retried, {
      context: stale.context,
      deps: {
        ...stale.deps,
        store: supersedeOnNextLoad(stale.store, "returned-body-observed", replacement),
      },
      rimAi: port(seen, invalidBody()),
      retrieval: null,
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(blocked.event.name).toBe("RIM.PRESS_RETRY_AI");
    expect(
      blocked.traces.some((trace) => trace.eventId === "E-58" || trace.eventId === "E-59"),
    ).toBe(false);
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    expect((await readRuntime(stale.store, USER_ID)).runtime).toEqual(replacement);
    const settled = await recoverPendingRimAi({
      context: stale.context,
      deps: stale.deps,
      rimAi: port([], { kind: "MESSAGE", text: "от C" }),
      retrieval: null,
    });
    expect(settled?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(settled?.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(settled?.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "от C",
    });
  });

  it("does not append a second semantic USER message on E-54", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const before = userTexts(
      (await opened.store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat,
    );
    const { followed } = await retryLocally(opened);
    expect(before).toEqual(["привет"]);
    expect(userTexts(followed.snapshot.extended.rimChat)).toEqual(["привет"]);
    expect(
      followed.snapshot.extended.rimChat?.messages.filter((message) => message.kind === "USER"),
    ).toHaveLength(1);
  });

  it("keeps the semantic USER message once in canonical local history", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const { seen } = await retryLocally(opened);
    assertLocalRetry(seen[0], "привет");
    expect(seen[0] && "userMessage" in seen[0]).toBe(false);
  });

  it("keeps a later USER turn local after the DC-03 transition", async () => {
    const seen: RimAiRequest[] = [];
    let calls = 0;
    const { app, failed } = await failPendingSend({
      async respond(request) {
        seen.push(request);
        calls += 1;
        if (calls === 1) {
          return invalidBody();
        }
        return { kind: "MESSAGE", text: "первый" };
      },
    });
    const chat = failed.snapshot.extended.rimChat;
    if (!chat || chat.aiOperation.status !== "FAILED") {
      throw new Error("expected E-59");
    }
    const before = await readRuntime(app.store, SENDER_ID);
    const conversationId = storedConversationId(before.runtime.initialization);
    const retried = await app.sender(
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: chat.aiOperation.requestId }),
    );
    await continueRimEffects(retried, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(300),
      },
      rimAi: {
        async respond(request) {
          seen.push(request);
          calls += 1;
          return { kind: "MESSAGE", text: "первый" };
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "ещё" }));
    const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
    let initialized = false;
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
          return { kind: "MESSAGE", text: "второй" };
        },
      },
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(initialized).toBe(false);
    const later = seen.at(-1);
    expect(later?.continuityMode).toBe("local-canonical-history");
    expect(later && "conversationId" in later).toBe(false);
    if (later?.continuityMode !== "local-canonical-history") {
      throw new Error("expected a later local turn");
    }
    expect(
      later.canonicalHistory.filter(
        (entry) => entry.kind === "USER" && entry.text === "почему так",
      ),
    ).toHaveLength(1);
    expect(
      later.canonicalHistory.filter((entry) => entry.kind === "USER" && entry.text === "ещё"),
    ).toHaveLength(1);
    expect(JSON.stringify(later)).not.toContain(conversationId);
    expect(
      seen.filter((request) => request.continuityMode === "provider-conversation"),
    ).toHaveLength(1);
    expect(userTexts(settled.snapshot.extended.rimChat)).toEqual(["почему так", "ещё"]);
    const after = await readRuntime(app.store, SENDER_ID);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.rimChatId).toBe(chat.id);
    expect(storedConversationId(after.runtime.initialization)).toBe(conversationId);
  });

  it("preserves local continuity across Create Ban freeze and Back", async () => {
    const seen: RimAiRequest[] = [];
    const { app, tools, failed } = await failPendingSend({
      async respond(request) {
        seen.push(request);
        return invalidBody();
      },
    });
    const chat = failed.snapshot.extended.rimChat;
    if (!chat || chat.aiOperation.status !== "FAILED") {
      throw new Error("expected E-59");
    }
    const retried = await app.sender(
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: chat.aiOperation.requestId }),
    );
    const followed = await continueRimEffects(retried, {
      ...tools,
      rimAi: port(seen, { kind: "MESSAGE", text: "локально" }),
    });
    expect(followed.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    const durable = await readRuntime(app.store, SENDER_ID);
    expect(durable.runtime.continuityMode).toBe("local-canonical-history");
    const frozenChat = durable.loaded.snapshot.extended.rimChat;
    if (!frozenChat) {
      throw new Error("expected the retried chat");
    }
    const base = durable.loaded.snapshot;
    const frozen: ProductSnapshot = {
      ...withControlState(base, "CREATE_BAN.WHAT.RIM"),
      extended: {
        ...withControlState(base, "CREATE_BAN.WHAT.RIM").extended,
        rimChat: frozenChat,
        savedFrozenRimChat: frozenChat,
      },
    };
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(SENDER_ID, "tg-sender");
    kit.establishIdentity(RECEIVER_ID, "tg-receiver");
    const installed = await kit.installFixtureSnapshot(SENDER_ID, frozen);
    await kit.store.saveRimProviderRuntime(SENDER_ID, installed.revision, durable.runtime);
    const context = authContext(SENDER_ID, "tg-sender");
    const deps: ProductExecutorDependencies = {
      store: kit.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(500),
    };
    const blocked = await recoverPendingRimAi({
      context,
      deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(blocked).toBeNull();
    expect(
      seen.filter((request) => request.continuityMode === "provider-conversation"),
    ).toHaveLength(1);
    const restored = await executeProductEvent(
      { context, event: eventOf("CREATE_BAN.PRESS_BACK") },
      deps,
    );
    expect(restored.snapshot.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(restored.snapshot.extended.rimChat?.id).toBe(frozenChat.id);
    const after = await readRuntime(kit.store, SENDER_ID);
    expect(after.runtime).toEqual(durable.runtime);
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(storedConversationId(after.runtime.initialization)).toBe(
      storedConversationId(durable.runtime.initialization),
    );
  });

  it("starts a new RIM Chat in provider mode after a local retry", async () => {
    const seen: RimAiRequest[] = [];
    const { app, tools, failed } = await failPendingSend({
      async respond(request) {
        seen.push(request);
        return invalidBody();
      },
    });
    const chat = failed.snapshot.extended.rimChat;
    if (!chat || chat.aiOperation.status !== "FAILED") {
      throw new Error("expected E-59");
    }
    const before = await readRuntime(app.store, SENDER_ID);
    const retiredConversation = storedConversationId(before.runtime.initialization);
    const retried = await app.sender(
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: chat.aiOperation.requestId }),
    );
    await continueRimEffects(retried, {
      ...tools,
      rimAi: port(seen, { kind: "MESSAGE", text: "локально" }),
    });
    const backed = await app.sender(eventOf("RIM.PRESS_BACK"));
    expect(backed.snapshot.extended.rimChat).toBeNull();
    await app.sender(eventOf("RIM.PRESS_START_CHAT"));
    await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    const created: string[] = [];
    const ready = await continueRimEffects(selected, {
      context: authContext(SENDER_ID, "tg-sender"),
      deps: {
        store: app.store,
        clock: { nowMs: () => 2_000_000 },
        allocateId: counterAllocator(700),
      },
      rimAi: port(),
      conversation: {
        async initialize() {
          created.push("conv-new-chat");
          return { conversationId: "conv-new-chat" as ProviderConversationId };
        },
      },
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    const next = ready.snapshot.extended.rimChat;
    expect(next?.id).toBeTruthy();
    expect(next?.id).not.toBe(chat.id);
    expect(created).toEqual(["conv-new-chat"]);
    const after = await readRuntime(app.store, SENDER_ID);
    expect(after.runtime.rimChatId).toBe(next?.id);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.runtime.retiredAttemptId).toBeNull();
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-new-chat");
    expect(storedConversationId(after.runtime.initialization)).not.toBe(retiredConversation);
    expect(after.runtime.attempt).toBeNull();
  });
});

describe("DC-03 retry recovery", () => {
  function rimTexts(chat: RimChat | null | undefined): string[] {
    return (chat?.messages ?? []).flatMap((message) =>
      message.kind === "RIM" ? [message.text] : [],
    );
  }

  async function saveRuntime(store: ProductStore, runtime: RimProviderRuntime): Promise<void> {
    const loaded = await store.loadProductSnapshot(USER_ID);
    await store.saveRimProviderRuntime(USER_ID, loaded.revision, runtime);
  }

  async function openFailed(runtime: RimProviderRuntime) {
    const opened = await installPending(failedChat());
    await saveRuntime(opened.store, runtime);
    return opened;
  }

  async function acceptRetry(opened: Awaited<ReturnType<typeof installPending>>) {
    return executeProductEvent(
      {
        context: opened.context,
        event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      },
      opened.deps,
    );
  }

  function localMessage(text = "локально"): Awaited<ReturnType<RimAiPort["respond"]>> {
    return { kind: "MESSAGE", text };
  }

  function crashAfterReplacementInstall(inner: ProductStore): ProductStore {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "saveRimProviderRuntime") {
          return async (userId: UserId, expectedRevision: number, runtime: unknown) => {
            const saved = await target.saveRimProviderRuntime(userId, expectedRevision, runtime);
            const parsed = parseRimProviderRuntime(runtime);
            if (
              parsed.status === "PRESENT" &&
              parsed.runtime.continuityMode === "local-canonical-history" &&
              parsed.runtime.attempt?.submissionState === "not-submitted" &&
              parsed.runtime.retryIntent === undefined &&
              parsed.runtime.retiredAttemptId !== null
            ) {
              throw new Error("crash after replacement install");
            }
            return saved;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  function supersedeBeforeOwnedCommit(
    inner: ProductStore,
    replacement: RimProviderRuntime,
  ): ProductStore {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "commitOwnedTransition") {
          return async (input: CommitOwnedTransitionInput) => {
            const current = await target.loadProductSnapshot(input.currentUserId);
            await target.saveRimProviderRuntime(input.currentUserId, current.revision, replacement);
            return target.commitOwnedTransition(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  function appliedShell(snapshot: ProductSnapshot): TransitionResult {
    return {
      outcome: "APPLIED",
      result: "NO_TRANSITION",
      controlState: snapshot.controlState,
      snapshot,
      effects: [],
      declaredEffects: [],
      traces: [],
      composition: [],
      error: null,
    } as unknown as TransitionResult;
  }

  it("does not install a replacement when E-54 was never accepted", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const before = await readRuntime(opened.store, USER_ID);
    const recovered = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: null,
    });
    expect(recovered).toBeNull();
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(before.runtime);
    expect(after.runtime.retryIntent).toBeUndefined();
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
  });

  it("rolls back E-54 and retry intent together when the commit fails", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const memory = opened.kit.memoryStore;
    if (!memory) {
      throw new Error("expected in-memory store");
    }
    const before = await opened.store.loadProductSnapshot(USER_ID);
    memory.failNextWriteAfterBans();
    const failed = await acceptRetry(opened);
    expect(failed.status).toBe("PERSISTENCE_ERROR");
    expect(failed.persisted).toBe(false);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.loaded.revision).toBe(before.revision);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
    expect(after.runtime.retryIntent).toBeUndefined();
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
    expect(after.runtime.continuityMode).toBe("provider-conversation");
  });

  it("installs exactly one local attempt after durable E-54 and before that attempt exists", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    const accepted = await acceptRetry(opened);
    expect(accepted.status).toBe("APPLIED");
    expect(accepted.traces.filter((trace) => trace.eventId === "E-54")).toHaveLength(1);
    const armed = await readRuntime(opened.store, USER_ID);
    expect(armed.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: AI_REQUEST_ID,
    });
    expect(armed.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
    expect(armed.runtime.continuityMode).toBe("provider-conversation");
    expect(armed.runtime.retryIntent).toEqual({
      rimChatId: CHAT_ID,
      contextRequestId: REQUEST_ID,
      requestId: AI_REQUEST_ID,
      attemptId: attempt("attempt-1"),
    });
    const seen: RimAiRequest[] = [];
    const followed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, localMessage()),
      retrieval: {
        async retrieve() {
          throw new Error("retired response must not be retrieved");
        },
      },
    });
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    expect(followed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(userTexts(followed?.snapshot.extended.rimChat)).toEqual(["привет"]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.retryIntent).toBeUndefined();
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(after.runtime.attempt?.attemptId).not.toBe(attempt("attempt-1"));
    expect(after.runtime.attempt?.requestId).toBe(AI_REQUEST_ID);
    expect(storedConversationId(after.runtime.initialization)).toBe("conv-stored-1");
  });

  it("does not install another attempt when recovery of an accepted retry is repeated", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "completed-retrieved"));
    await acceptRetry(opened);
    const seen: RimAiRequest[] = [];
    let nestedCalls = 0;
    const first = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: {
        async respond(request) {
          seen.push(request);
          const nested = await recoverPendingRimAi({
            context: opened.context,
            deps: opened.deps,
            rimAi: {
              async respond() {
                nestedCalls += 1;
                return localMessage("лишнее");
              },
            },
            retrieval: null,
          });
          expect(nested).toBeNull();
          return localMessage();
        },
      },
      retrieval: null,
    });
    expect(nestedCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(first?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const installed = await readRuntime(opened.store, USER_ID);
    const second = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, localMessage("ещё")),
      retrieval: null,
    });
    expect(second).toBeNull();
    expect(seen).toHaveLength(1);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.attempt?.attemptId).toBe(installed.runtime.attempt?.attemptId);
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(after.runtime.retryIntent).toBeUndefined();
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["локально"]);
  });

  it("executes the installed replacement after a crash and does not create another", async () => {
    const opened = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    await acceptRetry(opened);
    const crashing = {
      ...opened.deps,
      store: crashAfterReplacementInstall(opened.store),
    };
    await expect(
      recoverPendingRimAi({
        context: opened.context,
        deps: crashing,
        rimAi: port(),
        retrieval: null,
      }),
    ).rejects.toThrow("crash after replacement install");
    const installed = await readRuntime(opened.store, USER_ID);
    expect(installed.runtime.retryIntent).toBeUndefined();
    expect(installed.runtime.attempt?.submissionState).toBe("not-submitted");
    expect(installed.runtime.continuityMode).toBe("local-canonical-history");
    expect(installed.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(installed.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const seen: RimAiRequest[] = [];
    const followed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, localMessage()),
      retrieval: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    expect(followed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.attempt?.attemptId).toBe(installed.runtime.attempt?.attemptId);
    expect(after.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("retries a provider terminal attempt and a local terminal attempt from durable intent", async () => {
    const provider = await openFailed(runtimeFor(failedChat(), "returned-body-observed"));
    await acceptRetry(provider);
    const providerSeen: RimAiRequest[] = [];
    const providerFollowed = await recoverPendingRimAi({
      context: provider.context,
      deps: provider.deps,
      rimAi: port(providerSeen, localMessage("из провайдера")),
      retrieval: null,
    });
    expect(providerFollowed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const providerAfter = await readRuntime(provider.store, USER_ID);
    expect(providerAfter.runtime.continuityMode).toBe("local-canonical-history");
    expect(providerAfter.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
    expect(providerAfter.runtime.retryIntent).toBeUndefined();
    expect(providerSeen).toHaveLength(1);

    const local = await openFailed(localAttemptRuntime(failedChat(), "returned-body-observed"));
    await acceptRetry(local);
    const armed = await readRuntime(local.store, USER_ID);
    expect(armed.runtime.retryIntent?.attemptId).toBe(attempt("attempt-local"));
    expect(armed.runtime.continuityMode).toBe("local-canonical-history");
    const localSeen: RimAiRequest[] = [];
    const localFollowed = await recoverPendingRimAi({
      context: local.context,
      deps: local.deps,
      rimAi: port(localSeen, localMessage("ещё локально")),
      retrieval: null,
    });
    expect(localFollowed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const localAfter = await readRuntime(local.store, USER_ID);
    expect(localAfter.runtime.continuityMode).toBe("local-canonical-history");
    expect(localAfter.runtime.retiredAttemptId).toBe(attempt("attempt-local"));
    expect(localAfter.runtime.attempt?.attemptId).not.toBe(attempt("attempt-local"));
    expect(localAfter.runtime.retryIntent).toBeUndefined();
    expect(localSeen).toHaveLength(1);
    assertLocalRetry(localSeen[0], "привет");
  });

  it("does not regenerate a pending terminal attempt that has no retry intent", async () => {
    const opened = await installPending();
    const runtime = runtimeFor(opened.chat, "returned-body-observed");
    await saveRuntime(opened.store, runtime);
    const seen: RimAiRequest[] = [];
    const recovered = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen),
      retrieval: null,
    });
    expect(recovered).toBeNull();
    expect(seen).toEqual([]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(runtime);
    expect(after.runtime.continuityMode).toBe("provider-conversation");
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");

    const retrieved = await installPending();
    const completed = runtimeFor(retrieved.chat, "completed-retrieved");
    await saveRuntime(retrieved.store, completed);
    const again = await recoverPendingRimAi({
      context: retrieved.context,
      deps: retrieved.deps,
      rimAi: port(),
      retrieval: null,
    });
    expect(again).toBeNull();
    const retrievedAfter = await readRuntime(retrieved.store, USER_ID);
    expect(retrievedAfter.runtime).toEqual(completed);
    expect(retrievedAfter.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
  });

  it("does not emit E-58 when a replacement supersedes the producing attempt first", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const replacement = localRuntime(opened.chat, "attempt-b");
    const raced = await recoverPendingRimAi({
      context: opened.context,
      deps: {
        ...opened.deps,
        store: supersedeBeforeOwnedCommit(opened.store, replacement),
      },
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("поздно")),
    });
    expect(raced).toBeNull();
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime).toEqual(replacement);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual([]);
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["привет"]);
  });

  it("does not emit E-59 when a replacement supersedes the producing attempt first", async () => {
    for (const outcome of [
      { status: "failed" as const, output: undefined },
      { status: "completed" as const, output: invalidBody() },
    ]) {
      const opened = await installPending();
      await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
      const replacement = localRuntime(opened.chat, "attempt-b");
      const raced = await recoverPendingRimAi({
        context: opened.context,
        deps: {
          ...opened.deps,
          store: supersedeBeforeOwnedCommit(opened.store, replacement),
        },
        rimAi: port(),
        retrieval: retrieval(outcome.status, outcome.output),
      });
      expect(raced).toBeNull();
      const after = await readRuntime(opened.store, USER_ID);
      expect(after.runtime).toEqual(replacement);
      expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      expect(after.loaded.snapshot.extended.rimChat?.aiOperation).not.toMatchObject({
        status: "FAILED",
      });
    }
  });

  it("keeps A's committed outcome when a late supersession uses the pre-commit revision", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const before = await opened.store.loadProductSnapshot(USER_ID);
    const completed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("вовремя")),
    });
    expect(completed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(completed?.snapshot.extended.rimChat?.aiOperation).toEqual({ status: "IDLE" });
    await expect(
      opened.store.saveRimProviderRuntime(
        USER_ID,
        before.revision,
        localRuntime(opened.chat, "attempt-b"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const afterWin = await readRuntime(opened.store, USER_ID);
    expect(afterWin.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
    const lateRetry = await acceptRetry(opened);
    expect(lateRetry.persisted).toBe(false);
    expect(lateRetry.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
    const still = await readRuntime(opened.store, USER_ID);
    expect(still.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
    expect(still.loaded.snapshot.extended.rimChat?.aiOperation).toEqual({ status: "IDLE" });

    const failedOpen = await installPending();
    await saveRuntime(failedOpen.store, runtimeFor(failedOpen.chat, "response-id-known"));
    const failed = await recoverPendingRimAi({
      context: failedOpen.context,
      deps: failedOpen.deps,
      rimAi: port(),
      retrieval: retrieval("failed"),
    });
    expect(failed?.traces.filter((trace) => trace.eventId === "E-59")).toHaveLength(1);
    const accepted = await acceptRetry(failedOpen);
    expect(accepted.status).toBe("APPLIED");
    expect(accepted.traces.filter((trace) => trace.eventId === "E-54")).toHaveLength(1);
    const armed = await readRuntime(failedOpen.store, USER_ID);
    expect(armed.runtime.attempt?.attemptId).toBe(attempt("attempt-1"));
    expect(armed.runtime.retryIntent).toEqual({
      rimChatId: CHAT_ID,
      contextRequestId: REQUEST_ID,
      requestId: AI_REQUEST_ID,
      attemptId: attempt("attempt-1"),
    });
    expect(armed.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });

  it("reaches one terminal outcome after the owned product commit rolls back", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const memory = opened.kit.memoryStore;
    if (!memory) {
      throw new Error("expected in-memory store");
    }
    memory.failNextWriteAfterBans();
    await expect(
      recoverPendingRimAi({
        context: opened.context,
        deps: opened.deps,
        rimAi: port(),
        retrieval: retrieval("completed", localMessage("после сбоя")),
      }),
    ).rejects.toBeInstanceOf(ApplicationError);
    const wedged = await readRuntime(opened.store, USER_ID);
    expect(wedged.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(wedged.runtime.attempt).toMatchObject({
      attemptId: attempt("attempt-1"),
      submissionState: "completed-retrieved",
      providerStatus: "completed",
      responseId: RESPONSE_ID,
    });
    const followed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("после сбоя")),
    });
    expect(followed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(rimTexts(followed?.snapshot.extended.rimChat)).toEqual(["после сбоя"]);
    const again = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("ещё раз")),
    });
    expect(again).toBeNull();
    expect(rimTexts(followed?.snapshot.extended.rimChat)).toEqual(["после сбоя"]);
  });

  it("dispatches one E-58 when completion recovery is repeated", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const first = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("один")),
    });
    expect(first?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    const second = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("два")),
    });
    expect(second).toBeNull();
    const after = await readRuntime(opened.store, USER_ID);
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["один"]);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation).toEqual({ status: "IDLE" });
  });

  it("lets the replacement complete after the retired attempt loses ownership", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const replacement = localRuntime(opened.chat, "attempt-b");
    const raced = await recoverPendingRimAi({
      context: opened.context,
      deps: {
        ...opened.deps,
        store: supersedeBeforeOwnedCommit(opened.store, replacement),
      },
      rimAi: port(),
      retrieval: retrieval("completed", localMessage("от A")),
    });
    expect(raced).toBeNull();
    const seen: RimAiRequest[] = [];
    const followed = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: port(seen, localMessage("от B")),
      retrieval: null,
    });
    expect(seen).toHaveLength(1);
    assertLocalRetry(seen[0], "привет");
    expect(followed?.traces.filter((trace) => trace.eventId === "E-58")).toHaveLength(1);
    expect(rimTexts(followed?.snapshot.extended.rimChat)).toEqual(["от B"]);
    const after = await readRuntime(opened.store, USER_ID);
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-b"));
    expect(after.runtime.continuityMode).toBe("local-canonical-history");
  });

  it("rejects a product commit when the locked attempt is no longer authoritative", async () => {
    const opened = await installPending();
    const runtime = runtimeFor(opened.chat, "response-id-known");
    await saveRuntime(opened.store, runtime);
    const loaded = await opened.store.loadProductSnapshot(USER_ID);
    const chat = loaded.snapshot.extended.rimChat;
    if (!chat) {
      throw new Error("expected a chat");
    }
    const mutated: ProductSnapshot = {
      ...loaded.snapshot,
      extended: {
        ...loaded.snapshot.extended,
        rimChat: { ...chat, inputDraft: "should-not-commit" },
      },
    };
    const owned = await opened.store.commitOwnedTransition({
      currentUserId: USER_ID,
      expectedRevision: loaded.revision,
      result: appliedShell(mutated),
      requireAttempt: {
        rimChatId: runtime.rimChatId,
        selectedContactId: runtime.selectedContactId,
        contextRequestId: runtime.contextRequestId,
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-other"),
        continuityMode: "provider-conversation",
      },
    });
    expect(owned.status).toBe("ATTEMPT_SUPERSEDED");
    const after = await opened.store.loadProductSnapshot(USER_ID);
    expect(after.revision).toBe(loaded.revision);
    expect(after.snapshot.extended.rimChat?.inputDraft).toBe("");

    const named = {
      ...runtime,
      retryIntent: {
        rimChatId: runtime.rimChatId,
        contextRequestId: runtime.contextRequestId,
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-1"),
      },
    };
    await saveRuntime(opened.store, named);
    const current = await opened.store.loadProductSnapshot(USER_ID);
    const blocked = await opened.store.commitOwnedTransition({
      currentUserId: USER_ID,
      expectedRevision: current.revision,
      result: appliedShell(mutated),
      requireAttempt: {
        rimChatId: runtime.rimChatId,
        selectedContactId: runtime.selectedContactId,
        contextRequestId: runtime.contextRequestId,
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-1"),
        continuityMode: "provider-conversation",
      },
    });
    expect(blocked.status).toBe("ATTEMPT_SUPERSEDED");
    const still = await opened.store.loadProductSnapshot(USER_ID);
    expect(still.revision).toBe(current.revision);
    expect(still.snapshot.extended.rimChat?.inputDraft).toBe("");
    const durable = await readRuntime(opened.store, USER_ID);
    expect(durable.runtime.retryIntent?.attemptId).toBe(attempt("attempt-1"));
  });
});
