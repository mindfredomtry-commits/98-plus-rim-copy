import { describe, expect, it } from "vitest";
import { PersistenceTestKit } from "../../../persistence/src/test-kit.ts";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  counterAllocator,
  emptySnapshot,
  type BanStatus,
  type RimAiResult,
  type Role,
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
  makeBan,
  makeChat,
  pendingAi,
  readyContext,
  statusItem,
  withChat,
  withControlState,
  withEntities,
} from "../../../product-model/src/kernel.fixtures.ts";
import { statusControlState } from "../../../product-model/src/kernel/snapshot.ts";
import type { ProductSnapshot, RimChatId } from "@98plus/product-model";
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
import {
  FakeRimAiAdapter,
  type FakeConversationInitStep,
  type FakeRimAiStep,
} from "./fake-rim-ai-adapter.ts";
import {
  reconcileRimInitialization,
  type RimInitializationObservation,
} from "./initialize-rim-conversation.ts";
import { recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import {
  providerModelFacingTurn,
  type RimAiPort,
  type RimAiRequest,
  type RimAiResponseObserver,
} from "./rim-ai-port.ts";
import {
  assertProviderReadyInitialization,
  PRODUCT_SEMANTICS_MVP15,
  PRODUCT_SEMANTICS_UNAVAILABLE,
  RIM_PROMPT_UNAVAILABLE,
  RIM_PROMPT_V1,
  type RimConversationInitializationPort,
  type RimConversationInitializationRequest,
} from "./rim-conversation-port.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type RimProviderAttemptId,
  type RimProviderInitialization,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";

const ORDINARY_INTRO = "я могу предложить 3 запрета, написать?";
const ASK_INTRO = "что хочешь спросить?";

class RecordingFake extends FakeRimAiAdapter {
  readonly respondRequests: RimAiRequest[] = [];

  override async respond(
    request: RimAiRequest,
    observer?: RimAiResponseObserver,
  ): Promise<RimAiResult> {
    this.respondRequests.push(request);
    return super.respond(request, observer);
  }
}

function attempt(value: string): RimProviderAttemptId {
  return value as RimProviderAttemptId;
}

function conversation(value: string): ProviderConversationId {
  return value as ProviderConversationId;
}

function hold(then: "SUCCESS" | "LOST", conversationId?: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const step: FakeConversationInitStep = {
    kind: "HOLD",
    gate,
    onEntered: markEntered,
    then,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
  return { step, release: () => release(), entered };
}

function senderTools(
  app: Awaited<ReturnType<typeof productApp>>,
  rimAi: RimAiPort,
  log?: RimInitializationObservation[],
  remainingFailures = 0,
) {
  return {
    context: authContext(SENDER_ID, "tg-sender"),
    deps: {
      store: app.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(1),
    },
    rimAi,
    contextFailures: { remainingFailures },
    loadSources: async () => [],
    ...(log === undefined ? {} : { initializationLog: log }),
  };
}

async function ordinarySelected() {
  const app = await productApp();
  await openLobby(app.sender);
  await app.sender(eventOf("RIM.PRESS_START_CHAT"));
  await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
  const selected = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
  return { app, selected };
}

async function harness() {
  const kit = PersistenceTestKit.inMemory();
  kit.establishIdentity(USER_ID, "tg-user");
  kit.establishIdentity(CONTACT_A, "tg-contact");
  const context = authContext(USER_ID, "tg-user");
  const deps: ProductExecutorDependencies = {
    store: kit.store,
    clock: { nowMs: () => 2_000_000 },
    allocateId: counterAllocator(1),
  };
  return { kit, store: kit.store, context, deps };
}

function readyOrdinary(): ProductSnapshot {
  return withChat(
    withControlState(emptySnapshot(), "RIM.CHAT"),
    makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "RIM", text: ORDINARY_INTRO }],
    }),
  );
}

function runtimeFor(
  chat: NonNullable<ProductSnapshot["extended"]["rimChat"]>,
  initialization: RimProviderInitialization,
): RimProviderRuntime {
  const requestId = chat.relationshipContext?.requestId ?? REQUEST_ID;
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    contextRequestId: requestId,
    initialization,
    attempt: null,
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

function statusWorld(status: BanStatus, role: Role): ProductSnapshot {
  const item = statusItem({
    role,
    status,
    ownerId: USER_ID,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const snapshot = withEntities(
    withControlState(emptySnapshot(), statusControlState(status, role)),
    {
      bans: {
        [BAN_ID]: makeBan({
          senderId: role === "SENDER" ? USER_ID : CONTACT_A,
          receiverId: role === "RECEIVER" ? USER_ID : CONTACT_A,
          status,
          acceptance: status === "OVERBOARD" ? "PENDING" : "ACCEPTED",
        }),
      },
      notificationItems: { [item.id]: item },
    },
  );
  return {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: item.id },
  };
}

async function presentRuntime(store: ProductExecutorDependencies["store"], userId: UserId) {
  const loaded = await store.loadProductSnapshot(userId);
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  if (parsed.status !== "PRESENT") {
    throw new Error(`expected a provider runtime, got ${parsed.status}`);
  }
  return { loaded, runtime: parsed.runtime };
}

describe("DC-01 conversation initialization", () => {
  it("keeps the frozen Product counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
  });

  it("stores one conversation after E-56 and does not call respond", async () => {
    const { app, selected } = await ordinarySelected();
    const before = await app.store.loadProductSnapshot(SENDER_ID);
    expect(before.rimProviderRuntime).toBeNull();
    expect(selected.snapshot.extended.rimChat?.relationshipContext?.status).toBe("loading");
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-live-1" }]);
    const blocked = await reconcileRimInitialization({
      ...senderTools(app, fake, log),
    });
    expect(blocked).toBeNull();
    expect(log).toEqual([]);
    expect((await app.store.loadProductSnapshot(SENDER_ID)).rimProviderRuntime).toBeNull();

    const ready = await continueRimEffects(selected, senderTools(app, fake, log));
    expect(ready.status).toBe("APPLIED");
    expect(ready.event.name).toBe("RIM.CONTEXT_READY");
    expect(ready.snapshot.extended.rimChat?.messages).toEqual([
      { kind: "RIM", text: ORDINARY_INTRO },
    ]);
    expect(log).toEqual([
      "initialization-runtime-created",
      "initialization-claimed",
      "initialization-stored",
    ]);
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.respondRequests).toEqual([]);
    const request = fake.initializationRequests[0];
    expect(request?.rimPrompt).toBe(RIM_PROMPT_V1);
    expect(request?.productSemantics).toBe(PRODUCT_SEMANTICS_MVP15);
    if (
      request?.rimPrompt.availability === "available" &&
      request.productSemantics.availability === "available"
    ) {
      expect(request.rimPrompt.text).toBe(RIM_PROMPT_V1.text);
      expect(request.productSemantics.text).toBe(PRODUCT_SEMANTICS_MVP15.text);
    }
    expect(request?.origin).toBeNull();
    const readyContextData = ready.snapshot.extended.rimChat?.relationshipContext;
    expect(readyContextData?.status).toBe("ready");
    if (readyContextData?.status === "ready") {
      expect(request?.relationshipContext).toEqual(readyContextData.data);
    }
    const { runtime } = await presentRuntime(app.store, SENDER_ID);
    expect(runtime.initialization).toEqual({
      submissionState: "stored",
      attemptId: request?.attemptId,
      conversationId: conversation("conv-live-1"),
      clientRequestId: request?.clientRequestId,
    });
    expect(runtime.attempt).toBeNull();
    expect(runtime.continuityMode).toBe("provider-conversation");
    expect(runtime.retiredAttemptId).toBeNull();
    expect(runtime.rimChatId).toBe(ready.snapshot.extended.rimChat?.id);
    const again = await reconcileRimInitialization(senderTools(app, fake, log));
    expect(again).toBeNull();
    expect(fake.initializationRequests).toHaveLength(1);
  });

  it("initializes Ask RIM after its E-56 with the applicable origin", async () => {
    const opened = await harness();
    await opened.kit.installFixtureSnapshot(USER_ID, statusWorld("BANTASTIC", "RECEIVER"));
    const pressed = await executeProductEvent(
      { context: opened.context, event: eventOf("NOTIFICATIONS.PRESS_ASK_RIM") },
      opened.deps,
    );
    expect(pressed.status).toBe("APPLIED");
    expect(pressed.snapshot.controlState).toBe("RIM.CHAT");
    expect(pressed.snapshot.extended.rimChat?.relationshipContext?.status).toBe("loading");
    expect((await opened.store.loadProductSnapshot(USER_ID)).rimProviderRuntime).toBeNull();
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-ask-1" }]);
    const ready = await continueRimEffects(pressed, {
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
      initializationLog: log,
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(ready.event.name).toBe("RIM.CONTEXT_READY");
    expect(ready.snapshot.extended.rimChat?.messages).toEqual([{ kind: "RIM", text: ASK_INTRO }]);
    expect(fake.respondRequests).toEqual([]);
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.initializationRequests[0]?.origin).toEqual(
      ready.snapshot.extended.rimChat?.askRimOrigin,
    );
    expect(fake.initializationRequests[0]?.origin).not.toBeNull();
    expect(fake.initializationRequests[0]?.rimPrompt).toBe(RIM_PROMPT_V1);
    expect(fake.initializationRequests[0]?.productSemantics).toBe(PRODUCT_SEMANTICS_MVP15);
    const askContext = ready.snapshot.extended.rimChat?.relationshipContext;
    expect(askContext?.status).toBe("ready");
    if (askContext?.status === "ready") {
      expect(fake.initializationRequests[0]?.relationshipContext).toEqual(askContext.data);
    }
    expect(log).toEqual([
      "initialization-runtime-created",
      "initialization-claimed",
      "initialization-stored",
    ]);
    const { runtime } = await presentRuntime(opened.store, USER_ID);
    expect(runtime.initialization.submissionState).toBe("stored");
    if (runtime.initialization.submissionState !== "stored") {
      return;
    }
    expect(runtime.initialization.conversationId).toBe(conversation("conv-ask-1"));
    expect(runtime.attempt).toBeNull();
    const item = ready.snapshot.extended.entities.notificationItems[STATUS_ITEM_ID];
    expect(item?.lifecycle.status).toBe("UNPROCESSED");
  });

  it("starts a fresh provider conversation for a new Ask RIM chat after a local chat", async () => {
    const opened = await harness();
    await opened.kit.installFixtureSnapshot(USER_ID, statusWorld("BANTASTIC", "RECEIVER"));
    const installed = await opened.store.loadProductSnapshot(USER_ID);
    const oldChatId = "chat-old" as RimChatId;
    await opened.store.saveRimProviderRuntime(USER_ID, installed.revision, {
      rimChatId: oldChatId,
      selectedContactId: CONTACT_A,
      contextRequestId: REQUEST_ID,
      initialization: {
        submissionState: "stored",
        attemptId: attempt("init-old"),
        conversationId: conversation("conv-retired"),
        clientRequestId: null,
      },
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-old"),
        submissionState: "returned-body-observed",
        clientRequestId: null,
      },
      continuityMode: "local-canonical-history",
      retiredAttemptId: attempt("attempt-retired"),
    });
    const pressed = await executeProductEvent(
      { context: opened.context, event: eventOf("NOTIFICATIONS.PRESS_ASK_RIM") },
      opened.deps,
    );
    const fake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-ask-new" }]);
    const ready = await continueRimEffects(pressed, {
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    const chat = ready.snapshot.extended.rimChat;
    expect(ready.event.name).toBe("RIM.CONTEXT_READY");
    expect(chat?.id).not.toBe(oldChatId);
    expect(chat?.askRimOrigin).toEqual({
      sourceStatusItemId: STATUS_ITEM_ID,
      banId: BAN_ID,
      status: "BANTASTIC",
      sourceRole: "RECEIVER",
    });
    expect(fake.respondRequests).toEqual([]);
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.initializationRequests[0]?.rimChatId).toBe(chat?.id);
    expect(fake.initializationRequests[0]?.origin).toEqual(chat?.askRimOrigin);
    const { runtime } = await presentRuntime(opened.store, USER_ID);
    expect(runtime.rimChatId).toBe(chat?.id);
    expect(runtime.continuityMode).toBe("provider-conversation");
    expect(runtime.retiredAttemptId).toBeNull();
    expect(runtime.attempt).toBeNull();
    expect(runtime.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: conversation("conv-ask-new"),
    });
    if (runtime.initialization.submissionState !== "stored") {
      throw new Error("expected stored initialization");
    }
    expect(runtime.initialization.attemptId).not.toBe(attempt("init-old"));
    expect(runtime.initialization.conversationId).not.toBe(conversation("conv-retired"));
    expect(JSON.stringify(runtime)).not.toContain("local-canonical-history");
  });

  it("does not initialize a failed context or a pre-contact screen", async () => {
    const failedApp = await ordinarySelected();
    const failedFake = new RecordingFake();
    const failed = await continueRimEffects(
      failedApp.selected,
      senderTools(failedApp.app, failedFake, [], 1),
    );
    expect(failed.event.name).toBe("RIM.CONTEXT_FAILED");
    expect(failedFake.initializationRequests).toEqual([]);
    expect(
      (await failedApp.app.store.loadProductSnapshot(SENDER_ID)).rimProviderRuntime,
    ).toBeNull();

    const app = await productApp();
    await openLobby(app.sender);
    const started = await app.sender(eventOf("RIM.PRESS_START_CHAT"));
    const picked = await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    expect(started.snapshot.extended.rimChat).toBeNull();
    expect(picked.snapshot.extended.rimChat).toBeNull();
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake();
    const tools = senderTools(app, fake, log);
    expect(await continueRimEffects(started, tools)).toBe(started);
    expect(await continueRimEffects(picked, tools)).toBe(picked);
    expect(await reconcileRimInitialization(tools)).toBeNull();
    expect(log).toEqual([]);
    expect(fake.initializationRequests).toEqual([]);
    expect((await app.store.loadProductSnapshot(SENDER_ID)).rimProviderRuntime).toBeNull();
  });

  it("claims acceptance-unknown before the provider create and lets only one claimant call it", async () => {
    const opened = await harness();
    const chat = readyOrdinary().extended.rimChat;
    if (!chat) {
      throw new Error("expected a ready chat");
    }
    await opened.kit.installFixtureSnapshot(USER_ID, readyOrdinary());
    let seenAcceptanceUnknown = false;
    const port: RimConversationInitializationPort = {
      async initialize(request) {
        const loaded = await opened.store.loadProductSnapshot(USER_ID);
        const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
        expect(parsed.status).toBe("PRESENT");
        if (parsed.status === "PRESENT") {
          expect(parsed.runtime.initialization.submissionState).toBe("acceptance-unknown");
          expect(parsed.runtime.initialization.attemptId).toBe(request.attemptId);
          expect(parsed.runtime.initialization.clientRequestId).toBe(request.clientRequestId);
          seenAcceptanceUnknown = true;
        }
        return { conversationId: conversation("conv-claimed") };
      },
    };
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake();
    const settled = await reconcileRimInitialization({
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
      conversation: port,
      initializationLog: log,
    });
    expect(settled).toBeNull();
    expect(seenAcceptanceUnknown).toBe(true);
    expect(fake.initializationRequests).toEqual([]);
    expect(fake.respondRequests).toEqual([]);
    expect(log).toEqual([
      "initialization-runtime-created",
      "initialization-claimed",
      "initialization-stored",
    ]);

    const raced = await harness();
    await raced.kit.installFixtureSnapshot(USER_ID, readyOrdinary());
    const gate = hold("SUCCESS", "conv-once");
    const racing = new RecordingFake([], [gate.step]);
    const raceLog: RimInitializationObservation[] = [];
    const raceTools = {
      context: raced.context,
      deps: raced.deps,
      rimAi: racing,
      initializationLog: raceLog,
    };
    const first = reconcileRimInitialization(raceTools);
    const second = reconcileRimInitialization(raceTools);
    try {
      await gate.entered;
      expect(racing.initializationRequests).toHaveLength(1);
      gate.release();
      expect(await first).toBeNull();
      expect(await second).toBeNull();
    } finally {
      gate.release();
      await Promise.all([first, second]);
    }
    expect(racing.initializationRequests).toHaveLength(1);
    expect(racing.respondRequests).toEqual([]);
    const { runtime } = await presentRuntime(raced.store, USER_ID);
    expect(runtime.initialization.submissionState).toBe("stored");
    expect(raceLog.filter((item) => item === "initialization-claimed")).toEqual([
      "initialization-claimed",
    ]);
    expect(raceLog).not.toContain("e64-dispatched");
  });

  it("terminates an ordinary chat when create acceptance is lost and starts a fresh runtime later", async () => {
    const { app, selected } = await ordinarySelected();
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake(
      [{ kind: "FAILURE", failure: { code: "RIM_AI_FAILED", message: "unused" } as never }],
      [{ kind: "LOST" }],
    );
    const tools = senderTools(app, fake, log);
    const ended = await continueRimEffects(selected, tools);
    expect(ended.status).toBe("APPLIED");
    expect(ended.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
    expect(ended.traces[0]?.branch).toBe("ordinary-current");
    expect(ended.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.respondRequests).toEqual([]);
    expect(log).toEqual([
      "initialization-runtime-created",
      "initialization-claimed",
      "initialization-acceptance-unknown",
      "e64-dispatched",
    ]);
    const kept = await presentRuntime(app.store, SENDER_ID);
    expect(kept.runtime.initialization.submissionState).toBe("acceptance-unknown");
    expect(
      applicableRimProviderRuntime(
        parseRimProviderRuntime(kept.loaded.rimProviderRuntime),
        kept.loaded.snapshot.extended.rimChat?.id ?? null,
      ),
    ).toBeNull();
    const oldChatId = kept.runtime.rimChatId;
    const oldAttempt =
      kept.runtime.initialization.submissionState === "acceptance-unknown"
        ? kept.runtime.initialization.attemptId
        : null;
    const oldClient = kept.runtime.initialization.clientRequestId;

    const again = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    expect(again.snapshot.extended.rimChat?.id).not.toBe(oldChatId);
    const restarted = await continueRimEffects(again, tools);
    expect(restarted.event.name).toBe("RIM.CONTEXT_READY");
    expect(fake.initializationRequests).toHaveLength(2);
    expect(fake.respondRequests).toEqual([]);
    const next = await presentRuntime(app.store, SENDER_ID);
    expect(next.runtime.rimChatId).toBe(restarted.snapshot.extended.rimChat?.id);
    expect(next.runtime.rimChatId).not.toBe(oldChatId);
    expect(next.runtime.initialization.submissionState).toBe("stored");
    expect(next.runtime.initialization.attemptId).not.toBe(oldAttempt);
    expect(next.runtime.initialization.clientRequestId).not.toBe(oldClient);
    expect(next.runtime.attempt).toBeNull();
    if (next.runtime.initialization.submissionState === "stored") {
      expect(next.runtime.initialization.conversationId).not.toBe(
        conversation(`fake-conversation-${oldAttempt}`),
      );
    }
  });

  it("recovers each crash boundary without a second create", async () => {
    const created = await harness();
    await created.kit.installFixtureSnapshot(USER_ID, readyOrdinary());
    const createdLog: RimInitializationObservation[] = [];
    const createdFake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-a" }]);
    expect(
      await reconcileRimInitialization({
        context: created.context,
        deps: created.deps,
        rimAi: createdFake,
        initializationLog: createdLog,
      }),
    ).toBeNull();
    expect(createdLog[0]).toBe("initialization-runtime-created");
    expect(createdFake.initializationRequests).toHaveLength(1);
    expect(
      (await presentRuntime(created.store, USER_ID)).runtime.initialization.submissionState,
    ).toBe("stored");

    const claimed = await harness();
    const claimedChat = readyOrdinary().extended.rimChat;
    if (!claimedChat) {
      throw new Error("expected a ready chat");
    }
    const claimedInstall = await claimed.kit.installFixtureSnapshot(USER_ID, readyOrdinary());
    await claimed.store.saveRimProviderRuntime(
      USER_ID,
      claimedInstall.revision,
      runtimeFor(claimedChat, {
        submissionState: "not-submitted",
        attemptId: attempt("init-seed"),
        clientRequestId: "client-seed",
      }),
    );
    const claimedFake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-b" }]);
    expect(
      await reconcileRimInitialization({
        context: claimed.context,
        deps: claimed.deps,
        rimAi: claimedFake,
      }),
    ).toBeNull();
    expect(claimedFake.initializationRequests).toHaveLength(1);
    expect(claimedFake.initializationRequests[0]?.attemptId).toBe(attempt("init-seed"));
    expect(claimedFake.initializationRequests[0]?.clientRequestId).toBe("client-seed");
    const claimedRuntime = (await presentRuntime(claimed.store, USER_ID)).runtime;
    expect(claimedRuntime.initialization).toEqual({
      submissionState: "stored",
      attemptId: attempt("init-seed"),
      conversationId: conversation("conv-b"),
      clientRequestId: "client-seed",
    });

    const lost = await harness();
    const lostChat = readyOrdinary().extended.rimChat;
    if (!lostChat) {
      throw new Error("expected a ready chat");
    }
    const lostInstall = await lost.kit.installFixtureSnapshot(USER_ID, readyOrdinary());
    await lost.store.saveRimProviderRuntime(
      USER_ID,
      lostInstall.revision,
      runtimeFor(lostChat, {
        submissionState: "acceptance-unknown",
        attemptId: attempt("init-lost"),
        clientRequestId: "client-lost",
      }),
    );
    const lostFake = new RecordingFake(
      [],
      [{ kind: "SUCCESS", conversationId: "conv-should-not" }],
    );
    const lostLog: RimInitializationObservation[] = [];
    const ended = await reconcileRimInitialization({
      context: lost.context,
      deps: lost.deps,
      rimAi: lostFake,
      initializationLog: lostLog,
    });
    expect(lostFake.initializationRequests).toEqual([]);
    expect(ended?.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
    expect(ended?.traces[0]?.branch).toBe("ordinary-current");
    expect(ended?.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
    expect(ended?.snapshot.extended.rimChat).toBeNull();
    expect(lostLog).toEqual(["initialization-acceptance-unknown", "e64-dispatched"]);
    const lostRuntime = await presentRuntime(lost.store, USER_ID);
    expect(lostRuntime.runtime.initialization.submissionState).toBe("acceptance-unknown");
    expect(
      applicableRimProviderRuntime(
        parseRimProviderRuntime(lostRuntime.loaded.rimProviderRuntime),
        null,
      ),
    ).toBeNull();

    const kept = await harness();
    const keptChat = readyOrdinary().extended.rimChat;
    if (!keptChat) {
      throw new Error("expected a ready chat");
    }
    const keptInstall = await kept.kit.installFixtureSnapshot(USER_ID, readyOrdinary());
    await kept.store.saveRimProviderRuntime(
      USER_ID,
      keptInstall.revision,
      runtimeFor(keptChat, {
        submissionState: "stored",
        attemptId: attempt("init-kept"),
        conversationId: conversation("conv-kept"),
        clientRequestId: "client-kept",
      }),
    );
    const keptFake = new RecordingFake();
    const keptLog: RimInitializationObservation[] = [];
    expect(
      await reconcileRimInitialization({
        context: kept.context,
        deps: kept.deps,
        rimAi: keptFake,
        initializationLog: keptLog,
      }),
    ).toBeNull();
    expect(keptFake.initializationRequests).toEqual([]);
    expect(keptLog).toEqual([]);
    const keptLoaded = await kept.store.loadProductSnapshot(USER_ID);
    expect(keptLoaded.snapshot.extended.rimChat?.id).toBe(CHAT_ID);
    expect((await presentRuntime(kept.store, USER_ID)).runtime.initialization).toMatchObject({
      conversationId: conversation("conv-kept"),
    });
  });

  it("discards a late conversation id after the chat has been replaced", async () => {
    const { app, selected } = await ordinarySelected();
    const gate = hold("SUCCESS", "conv-old");
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake([], [gate.step]);
    const tools = senderTools(app, fake, log);
    const running = continueRimEffects(selected, tools);
    try {
      await gate.entered;
      await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
      const changed = await app.sender(eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }));
      const born = changed.snapshot.extended.rimChat;
      expect(born?.id).not.toBe(fake.initializationRequests[0]?.rimChatId);
      expect(born?.relationshipContext?.status).toBe("loading");
      if (!born?.relationshipContext) {
        throw new Error("expected a born chat");
      }
      const current = await app.store.loadProductSnapshot(SENDER_ID);
      await app.store.saveRimProviderRuntime(SENDER_ID, current.revision, {
        rimChatId: born.id,
        selectedContactId: born.selectedContactId,
        contextRequestId: born.relationshipContext.requestId,
        initialization: {
          submissionState: "stored",
          attemptId: attempt("init-new"),
          conversationId: conversation("conv-new"),
          clientRequestId: "client-new",
        },
        attempt: null,
      });
      gate.release();
      const finished = await running;
      expect(finished.event.name).toBe("RIM.CONTEXT_READY");
    } finally {
      gate.release();
      await running;
    }
    expect(fake.initializationRequests).toHaveLength(1);
    expect(log).toContain("stale-initialization-success-discarded");
    expect(log).not.toContain("e64-dispatched");
    expect(log).not.toContain("initialization-stored");
    const loaded = await app.store.loadProductSnapshot(SENDER_ID);
    expect(loaded.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_B);
    const { runtime } = await presentRuntime(app.store, SENDER_ID);
    expect(runtime.rimChatId).toBe(loaded.snapshot.extended.rimChat?.id);
    expect(runtime.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: conversation("conv-new"),
      attemptId: attempt("init-new"),
      clientRequestId: "client-new",
    });
    expect(runtime.attempt).toBeNull();
  });

  it("does not submit a USER turn until initialization is stored", async () => {
    const { app, selected } = await ordinarySelected();
    const gate = hold("LOST");
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake([], [gate.step]);
    const tools = senderTools(app, fake, log);
    const running = continueRimEffects(selected, tools);
    let sending: Promise<unknown> = Promise.resolve();
    try {
      await gate.entered;
      const draft = await app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "привет" }));
      expect(draft.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
      const sent = await app.sender(eventOf("RIM.PRESS_SEND"));
      expect(sent.status).toBe("APPLIED");
      expect(sent.event.name).toBe("RIM.PRESS_SEND");
      expect(sent.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      expect(sent.snapshot.extended.rimChat?.messages).toContainEqual({
        kind: "USER",
        text: "привет",
      });
      expect(fake.respondRequests).toEqual([]);
      expect(fake.initializationRequests).toHaveLength(1);
      sending = continueRimEffects(sent, tools);
      gate.release();
      await running;
      await sending;
    } finally {
      gate.release();
      await Promise.all([running, sending]);
    }
    expect(fake.respondRequests).toEqual([]);
    expect(fake.initializationRequests).toHaveLength(1);
    const loaded = await app.store.loadProductSnapshot(SENDER_ID);
    expect(loaded.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
    expect(loaded.snapshot.extended.rimChat).toBeNull();
    expect(log).toContain("e64-dispatched");

    const readyApp = await ordinarySelected();
    const readyLog: RimInitializationObservation[] = [];
    const readyFake = new RecordingFake(
      [],
      [{ kind: "SUCCESS", conversationId: "conv-then-user" }],
    );
    const readyTools = senderTools(readyApp.app, readyFake, readyLog);
    await continueRimEffects(readyApp.selected, readyTools);
    const stored = await presentRuntime(readyApp.app.store, SENDER_ID);
    await readyApp.app.sender(eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "после" }));
    const sent = await readyApp.app.sender(eventOf("RIM.PRESS_SEND"));
    const settled = await continueRimEffects(sent, readyTools);
    expect(readyFake.respondRequests).toHaveLength(1);
    expect(readyFake.initializationRequests).toHaveLength(1);
    const turn = readyFake.respondRequests[0];
    const initialized = readyFake.initializationRequests[0];
    expect(turn?.continuityMode).toBe("provider-conversation");
    if (turn?.continuityMode !== "provider-conversation") {
      throw new Error("expected provider continuation");
    }
    expect(turn.conversationId).toBe(conversation("conv-then-user"));
    expect(turn && "rimPrompt" in turn).toBe(false);
    expect(turn && "productSemantics" in turn).toBe(false);
    expect(turn?.contextRequestId).toBe(initialized?.contextRequestId);
    expect(turn?.relationshipContext).toEqual(initialized?.relationshipContext);
    expect(turn?.conversationalOrigin).toBeNull();
    expect(turn?.userMessage).toBe("после");
    const facing = providerModelFacingTurn(turn);
    expect(facing).toEqual({
      conversationId: conversation("conv-then-user"),
      userMessage: "после",
    });
    expect(Object.keys(facing).sort()).toEqual(["conversationId", "userMessage"]);
    expect(JSON.stringify(facing).split("после").length - 1).toBe(1);
    expect(JSON.stringify(facing)).not.toContain("relationshipContext");
    expect(JSON.stringify(facing)).not.toContain("conversationalOrigin");
    expect(JSON.stringify(facing)).not.toContain("rimPrompt");
    expect(JSON.stringify(facing)).not.toContain("productSemantics");
    expect(JSON.stringify(facing)).not.toContain(RIM_PROMPT_V1.text.slice(0, 40));
    expect(settled.event.name).toBe("RIM.AI_RESULT_RECEIVED");
    const after = await presentRuntime(readyApp.app.store, SENDER_ID);
    expect(after.runtime.initialization).toEqual(stored.runtime.initialization);
    expect(after.runtime.attempt?.submissionState).toBe("returned-body-observed");
  });

  it("initializes with the approved semantic pair and rejects unavailable fixtures", async () => {
    expect(RIM_PROMPT_UNAVAILABLE).toEqual({ availability: "unavailable" });
    expect(PRODUCT_SEMANTICS_UNAVAILABLE).toEqual({ availability: "unavailable" });
    expect(Object.keys(RIM_PROMPT_UNAVAILABLE)).toEqual(["availability"]);
    expect(Object.keys(PRODUCT_SEMANTICS_UNAVAILABLE)).toEqual(["availability"]);
    const { app, selected } = await ordinarySelected();
    const fake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-guard" }]);
    await continueRimEffects(selected, senderTools(app, fake));
    const request = fake.initializationRequests[0];
    if (!request) {
      throw new Error("expected an initialization request");
    }
    expect(request.rimPrompt).toBe(RIM_PROMPT_V1);
    expect(request.productSemantics).toBe(PRODUCT_SEMANTICS_MVP15);
    expect(assertProviderReadyInitialization(request)).toMatchObject({
      rimPrompt: RIM_PROMPT_V1,
      productSemantics: PRODUCT_SEMANTICS_MVP15,
      origin: null,
    });
    const storedChat = (await app.store.loadProductSnapshot(SENDER_ID)).snapshot.extended.rimChat;
    const storedContext = storedChat?.relationshipContext;
    expect(storedContext?.status).toBe("ready");
    if (storedContext?.status === "ready") {
      expect(request.relationshipContext).toEqual(storedContext.data);
      expect(request.contextRequestId).toBe(storedContext.requestId);
      expect(request.rimChatId).toBe(storedChat?.id);
      expect(request.selectedContactId).toBe(storedChat?.selectedContactId);
    }
    expect(request.origin).toBeNull();
    const unavailable: RimConversationInitializationRequest = {
      ...request,
      rimPrompt: RIM_PROMPT_UNAVAILABLE,
      productSemantics: PRODUCT_SEMANTICS_UNAVAILABLE,
    };
    expect(() => assertProviderReadyInitialization(unavailable)).toThrow(/not provider-ready/);
    expect(fake.respondRequests).toEqual([]);
  });

  it("does not dispatch E-64 for a USER attempt whose acceptance is unknown", async () => {
    const opened = await harness();
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "привет" }],
      aiOperation: pendingAi({ userMessage: "привет", rimChatId: CHAT_ID }),
    });
    const installed = await opened.kit.installFixtureSnapshot(
      USER_ID,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
    );
    await opened.store.saveRimProviderRuntime(USER_ID, installed.revision, {
      rimChatId: chat.id,
      selectedContactId: chat.selectedContactId,
      contextRequestId: REQUEST_ID,
      initialization: {
        submissionState: "stored",
        attemptId: attempt("init-user"),
        conversationId: conversation("conv-user"),
        clientRequestId: "client-init",
      },
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: attempt("attempt-user"),
        submissionState: "acceptance-unknown",
        clientRequestId: "client-user",
      },
    });
    const log: RimInitializationObservation[] = [];
    let initialized = false;
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: {
        async respond(request) {
          seen.push(request);
          throw new Error("respond called");
        },
      },
      conversation: {
        async initialize() {
          initialized = true;
          throw new Error("initializer called");
        },
      },
      initializationLog: log,
      retrieval: null,
    });
    expect(settled).toBeNull();
    expect(initialized).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    expect(seen[0] && "conversationId" in seen[0]).toBe(false);
    expect(log).toEqual([]);
    const loaded = await opened.store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("RIM.CHAT");
    expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const runtime = (await presentRuntime(opened.store, USER_ID)).runtime;
    const localAttemptId = runtime.attempt?.attemptId;
    expect(runtime.initialization).toEqual({
      submissionState: "stored",
      attemptId: attempt("init-user"),
      conversationId: conversation("conv-user"),
      clientRequestId: "client-init",
    });
    expect(runtime.continuityMode).toBe("local-canonical-history");
    expect(runtime.retiredAttemptId).toBe(attempt("attempt-user"));
    expect(localAttemptId).not.toBe(attempt("attempt-user"));
    expect(runtime.attempt).toMatchObject({
      requestId: AI_REQUEST_ID,
      submissionState: "acceptance-unknown",
    });
    expect(loaded.snapshot.extended.rimChat?.messages).toEqual([{ kind: "USER", text: "привет" }]);
    const again = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: {
        async respond(request) {
          seen.push(request);
          throw new Error("respond called");
        },
      },
      initializationLog: log,
      retrieval: null,
    });
    expect(again).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await presentRuntime(opened.store, USER_ID)).runtime.attempt?.attemptId).toBe(
      localAttemptId,
    );
  });

  it("routes pending USER work without a runtime through initialization and still does not respond", async () => {
    const opened = await harness();
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "привет" }],
      aiOperation: pendingAi({ userMessage: "привет", rimChatId: CHAT_ID }),
    });
    await opened.kit.installFixtureSnapshot(
      USER_ID,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
    );
    const log: RimInitializationObservation[] = [];
    const seen: RimAiRequest[] = [];
    const settled = await recoverPendingRimAi({
      context: opened.context,
      deps: opened.deps,
      rimAi: {
        async respond(request) {
          seen.push(request);
          const text =
            request.continuityMode === "provider-conversation"
              ? request.userMessage
              : (request.canonicalHistory.find((entry) => entry.kind === "USER")?.text ?? "");
          return { kind: "MESSAGE", text };
        },
      },
      initializationLog: log,
      retrieval: null,
    });
    expect(settled).toBeNull();
    expect(seen).toEqual([]);
    expect(log).toEqual([
      "initialization-runtime-created",
      "initialization-claimed",
      "initialization-stored",
    ]);
    const loaded = await opened.store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const runtime = (await presentRuntime(opened.store, USER_ID)).runtime;
    expect(runtime.initialization.submissionState).toBe("stored");
    expect(runtime.attempt).toBeNull();
    expect(runtime.continuityMode).toBe("provider-conversation");
    expect(runtime.retiredAttemptId).toBeNull();
  });

  it("keeps an ordinary selector on Select Contact when initialization is unrecoverable", async () => {
    const { app, selected } = await ordinarySelected();
    const gate = hold("LOST");
    const fake = new RecordingFake([], [gate.step]);
    const log: RimInitializationObservation[] = [];
    const running = continueRimEffects(selected, senderTools(app, fake, log));
    try {
      await gate.entered;
      const selector = await app.sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
      expect(selector.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(selector.snapshot.extended.rimChat?.id).toBe(
        fake.initializationRequests[0]?.rimChatId,
      );
      gate.release();
      const ended = await running;
      expect(ended.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
      expect(ended.traces[0]?.branch).toBe("ordinary-current");
      expect(ended.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(ended.snapshot.extended.rimChat).toBeNull();
    } finally {
      gate.release();
      await running;
    }
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.respondRequests).toEqual([]);
  });

  it("restores the exact Ask RIM status when initialization acceptance is lost", async () => {
    const opened = await harness();
    const source = statusWorld("BANFLICT", "SENDER");
    const sourceId = source.extended.activeNotificationItemId;
    await opened.kit.installFixtureSnapshot(USER_ID, source);
    const pressed = await executeProductEvent(
      { context: opened.context, event: eventOf("NOTIFICATIONS.PRESS_ASK_RIM") },
      opened.deps,
    );
    const fake = new RecordingFake([], [{ kind: "LOST" }]);
    const log: RimInitializationObservation[] = [];
    const ended = await continueRimEffects(pressed, {
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
      initializationLog: log,
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    expect(ended.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
    expect(ended.traces[0]?.branch).toBe("ask-rim-current");
    expect(ended.snapshot.controlState).toBe(statusControlState("BANFLICT", "SENDER"));
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.snapshot.extended.activeNotificationItemId).toBe(sourceId);
    expect(
      ended.snapshot.extended.entities.notificationItems[sourceId ?? ""]?.lifecycle.status,
    ).toBe("UNPROCESSED");
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.respondRequests).toEqual([]);
    expect(log).toContain("e64-dispatched");
    expect(
      applicableRimProviderRuntime(
        parseRimProviderRuntime(
          (await opened.store.loadProductSnapshot(USER_ID)).rimProviderRuntime,
        ),
        null,
      ),
    ).toBeNull();
  });

  it("returns Ask RIM to its valid status when the selector is open during an unrecoverable create", async () => {
    const opened = await harness();
    const source = statusWorld("BANTASTIC", "RECEIVER");
    const sourceId = source.extended.activeNotificationItemId;
    await opened.kit.installFixtureSnapshot(USER_ID, source);
    const pressed = await executeProductEvent(
      { context: opened.context, event: eventOf("NOTIFICATIONS.PRESS_ASK_RIM") },
      opened.deps,
    );
    const gate = hold("LOST");
    const fake = new RecordingFake([], [gate.step]);
    const running = continueRimEffects(pressed, {
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
      contextFailures: { remainingFailures: 0 },
      loadSources: async () => [],
    });
    try {
      await gate.entered;
      const selector = await executeProductEvent(
        { context: opened.context, event: eventOf("RIM.PRESS_SELECT_CONTACT") },
        opened.deps,
      );
      expect(selector.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(selector.snapshot.extended.rimChat?.askRimOrigin).not.toBeNull();
      gate.release();
      const ended = await running;
      expect(ended.traces[0]?.branch).toBe("ask-rim-current");
      expect(ended.snapshot.controlState).toBe(statusControlState("BANTASTIC", "RECEIVER"));
      expect(ended.snapshot.extended.rimChat).toBeNull();
      expect(ended.snapshot.extended.activeNotificationItemId).toBe(sourceId);
      expect(
        ended.snapshot.extended.entities.notificationItems[sourceId ?? ""]?.lifecycle.status,
      ).toBe("UNPROCESSED");
    } finally {
      gate.release();
      await running;
    }
  });

  it("sends an invalid Ask RIM origin to the lobby without inventing a status", async () => {
    const opened = await harness();
    const item = statusItem({
      lifecycle: { status: "PROCESSED" },
      role: "RECEIVER",
      status: "BANTASTIC",
      ownerId: USER_ID,
    });
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      askRimOrigin: {
        sourceStatusItemId: item.id,
        banId: BAN_ID,
        status: "BANTASTIC",
        sourceRole: "RECEIVER",
      },
    });
    const snapshot = withChat(
      withEntities(withControlState(emptySnapshot(), "RIM.CHAT"), {
        bans: {
          [BAN_ID]: makeBan({
            senderId: CONTACT_A,
            receiverId: USER_ID,
            status: "BANTASTIC",
            acceptance: "ACCEPTED",
          }),
        },
        notificationItems: { [item.id]: item },
      }),
      chat,
    );
    const installed = await opened.kit.installFixtureSnapshot(USER_ID, snapshot);
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      installed.revision,
      runtimeFor(chat, {
        submissionState: "acceptance-unknown",
        attemptId: attempt("init-invalid"),
        clientRequestId: "client-invalid",
      }),
    );
    const fake = new RecordingFake([], [{ kind: "SUCCESS", conversationId: "conv-invalid" }]);
    const ended = await reconcileRimInitialization({
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
    });
    expect(fake.initializationRequests).toEqual([]);
    expect(ended?.traces[0]?.branch).toBe("ask-rim-origin-invalid");
    expect(ended?.snapshot.controlState).toBe("RIM.LOBBY");
    expect(ended?.snapshot.extended.rimChat).toBeNull();
    expect(ended?.snapshot.extended.activeNotificationItemId).toBeNull();
    expect(ended?.snapshot.extended.entities.notificationItems[item.id]?.lifecycle.status).toBe(
      "PROCESSED",
    );
    expect(Object.keys(ended?.snapshot.extended.entities.notificationItems ?? {})).toEqual([
      item.id,
    ]);
  });

  it("does not emit E-64 while a frozen Create Ban is active", async () => {
    const opened = await harness();
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
    });
    const frozen: ProductSnapshot = {
      ...withControlState(emptySnapshot(), "CREATE_BAN.WHAT.RIM"),
      extended: {
        ...withChat(emptySnapshot(), chat).extended,
        rimChat: chat,
        savedFrozenRimChat: chat,
      },
    };
    const installed = await opened.kit.installFixtureSnapshot(USER_ID, frozen);
    await opened.store.saveRimProviderRuntime(
      USER_ID,
      installed.revision,
      runtimeFor(chat, {
        submissionState: "acceptance-unknown",
        attemptId: attempt("init-frozen"),
        clientRequestId: "client-frozen",
      }),
    );
    const log: RimInitializationObservation[] = [];
    const fake = new RecordingFake();
    const settled = await reconcileRimInitialization({
      context: opened.context,
      deps: opened.deps,
      rimAi: fake,
      initializationLog: log,
    });
    expect(settled).toBeNull();
    expect(fake.initializationRequests).toEqual([]);
    expect(log).toEqual([]);
    const loaded = await opened.store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(loaded.snapshot.extended.savedFrozenRimChat?.id).toBe(chat.id);
    expect(loaded.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(
      (await presentRuntime(opened.store, USER_ID)).runtime.initialization.submissionState,
    ).toBe("acceptance-unknown");
  });

  it("does not consume a USER respond script while creating a conversation", async () => {
    const { app, selected } = await ordinarySelected();
    const steps: FakeRimAiStep[] = [
      { kind: "FAILURE", failure: { code: "RIM_AI_FAILED", message: "later" } as never },
    ];
    const fake = new RecordingFake(steps, [{ kind: "SUCCESS", conversationId: "conv-separate" }]);
    const ready = await continueRimEffects(selected, senderTools(app, fake));
    expect(ready.event.name).toBe("RIM.CONTEXT_READY");
    expect(fake.initializationRequests).toHaveLength(1);
    expect(fake.respondRequests).toEqual([]);
    const { runtime } = await presentRuntime(app.store, SENDER_ID);
    expect(runtime.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: conversation("conv-separate"),
    });
  });
});
