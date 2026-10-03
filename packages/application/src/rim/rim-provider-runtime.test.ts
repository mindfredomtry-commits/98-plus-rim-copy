import { describe, expect, it } from "vitest";
import { MemorySqlClient, type ProductStore } from "@98plus/persistence";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  emptySnapshot,
  reduce,
  type CanonicalEvent,
  type ExecutionContext,
  type ProductSnapshot,
  type RimChat,
  type RimChatId,
} from "@98plus/product-model";
import { PersistenceTestKit } from "../../../persistence/src/test-kit.ts";
import {
  AI_REQUEST_ID,
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  OTHER_USER,
  REQUEST_ID,
  USER_ID,
  defaultEvent,
  eventOf,
  kernelContext,
  makeBan,
  makeChat,
  pendingOp,
  proposalsMessage,
  readyContext,
  statusItem,
  validCreateDraft,
  withChat,
  withControlState,
  withEntities,
  withOperation,
} from "../../../product-model/src/kernel.fixtures.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type ProviderResponseId,
  type RimContinuityMode,
  type RimProviderAttempt,
  type RimProviderAttemptId,
  type RimProviderInitialization,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";

const CONV_ID = "conv-ready-1";
const RESPONSE_ID = "resp-ready-1";

function attemptId(value: string): RimProviderAttemptId {
  return value as RimProviderAttemptId;
}

function storedInitialization(): RimProviderInitialization {
  return {
    submissionState: "stored",
    attemptId: attemptId("init-1"),
    conversationId: CONV_ID as ProviderConversationId,
    clientRequestId: "client-init-1",
  };
}

function runtimeFor(
  chat: RimChat,
  initialization: RimProviderInitialization = storedInitialization(),
  attempt: RimProviderAttempt | null = null,
): RimProviderRuntime {
  return {
    rimChatId: chat.id,
    selectedContactId: CONTACT_A,
    contextRequestId: chat.relationshipContext?.requestId ?? REQUEST_ID,
    initialization,
    attempt,
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

function readyChat(): RimChat {
  return makeChat({
    selectedContactId: CONTACT_A,
    relationshipContext: readyContext(),
    messages: [proposalsMessage()],
  });
}

function chatSnapshot(chat: RimChat): ProductSnapshot {
  return withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat);
}

async function openStore(kind: "sql" | "memory"): Promise<{
  store: ProductStore;
  install: PersistenceTestKit["installFixtureSnapshot"];
  sessionRuntime: (userId: typeof USER_ID) => unknown;
  sessionChatJson: (userId: typeof USER_ID) => string;
}> {
  if (kind === "sql") {
    const client = new MemorySqlClient();
    const kit = PersistenceTestKit.postgres(client);
    kit.establishIdentity(USER_ID, "tg-user");
    kit.establishIdentity(CONTACT_A, "tg-contact-a");
    kit.establishIdentity(CONTACT_B, "tg-contact-b");
    kit.establishIdentity(OTHER_USER, "tg-other");
    return {
      store: kit.store,
      install: (userId, snapshot) => kit.installFixtureSnapshot(userId, snapshot),
      sessionRuntime: (userId) => client.tables.lockSession(userId)?.rimProviderRuntime,
      sessionChatJson: (userId) =>
        JSON.stringify({
          rimChat: client.tables.lockSession(userId)?.rimChat,
          savedFrozenRimChat: client.tables.lockSession(userId)?.savedFrozenRimChat,
        }),
    };
  }
  const kit = PersistenceTestKit.inMemory();
  kit.establishIdentity(USER_ID, "tg-user");
  kit.establishIdentity(CONTACT_A, "tg-contact-a");
  kit.establishIdentity(CONTACT_B, "tg-contact-b");
  kit.establishIdentity(OTHER_USER, "tg-other");
  const memory = kit.memoryStore;
  if (!memory) {
    throw new Error("expected in-memory store");
  }
  return {
    store: kit.store,
    install: (userId, snapshot) => kit.installFixtureSnapshot(userId, snapshot),
    sessionRuntime: (userId) => memory.inspect().lockSession(userId)?.rimProviderRuntime,
    sessionChatJson: (userId) =>
      JSON.stringify({
        rimChat: memory.inspect().lockSession(userId)?.rimChat,
        savedFrozenRimChat: memory.inspect().lockSession(userId)?.savedFrozenRimChat,
      }),
  };
}

async function apply(
  store: ProductStore,
  loaded: { revision: number; snapshot: ProductSnapshot },
  event: CanonicalEvent,
  context: ExecutionContext,
) {
  const result = reduce(loaded.snapshot, event, context);
  expect(result.outcome).toBe("APPLIED");
  return store.persistTransition({
    currentUserId: USER_ID,
    expectedRevision: loaded.revision,
    result,
  });
}

function presentRuntime(value: unknown, rimChatId: RimChatId | null) {
  const parsed = parseRimProviderRuntime(value);
  return applicableRimProviderRuntime(parsed, rimChatId);
}

describe.each(["sql", "memory"] as const)("RimProviderRuntime storage (%s)", (kind) => {
  it("reloads the same runtime for the same RimChatId and keeps it out of Product chat JSON", async () => {
    const harness = await openStore(kind);
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const runtime = runtimeFor(chat);
    const saved = await harness.store.saveRimProviderRuntime(USER_ID, seeded.revision, runtime);
    const reloaded = await harness.store.loadProductSnapshot(USER_ID);

    expect(presentRuntime(reloaded.rimProviderRuntime, chat.id)).toEqual(runtime);
    expect(presentRuntime(saved.rimProviderRuntime, chat.id)?.initialization).toMatchObject({
      submissionState: "stored",
      conversationId: CONV_ID,
    });
    expect(reloaded.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(reloaded.snapshot.extended).not.toHaveProperty("rimProviderRuntime");
    expect(JSON.stringify(reloaded.snapshot)).not.toContain(CONV_ID);
    expect(harness.sessionChatJson(USER_ID)).not.toContain(CONV_ID);
    expect(JSON.stringify(harness.sessionRuntime(USER_ID))).toContain(CONV_ID);
  });

  it("preserves provider runtime across a normal Product session write", async () => {
    const harness = await openStore(kind);
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const runtime = runtimeFor(chat);
    const saved = await harness.store.saveRimProviderRuntime(USER_ID, seeded.revision, runtime);
    const drafted = await apply(
      harness.store,
      saved,
      defaultEvent("RIM.CHANGE_INPUT_DRAFT"),
      kernelContext(),
    );
    const reloaded = await harness.store.loadProductSnapshot(USER_ID);

    expect(drafted.snapshot.extended.rimChat?.inputDraft).toBe("hello");
    expect(reloaded.rimProviderRuntime).toEqual(saved.rimProviderRuntime);
    expect(presentRuntime(reloaded.rimProviderRuntime, chat.id)).toEqual(runtime);
  });

  it("keeps one runtime for the frozen and restored RimChatId", async () => {
    const harness = await openStore(kind);
    const context = kernelContext();
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const runtime = runtimeFor(chat);
    const saved = await harness.store.saveRimProviderRuntime(USER_ID, seeded.revision, runtime);
    const frozen = await apply(
      harness.store,
      saved,
      defaultEvent("RIM.PRESS_SUGGESTION_FORBID"),
      context,
    );

    expect(frozen.snapshot.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(frozen.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(frozen.snapshot.extended.savedFrozenRimChat?.id).toBe(chat.id);
    expect(frozen.rimProviderRuntime).toEqual(runtime);
    expect(
      presentRuntime(frozen.rimProviderRuntime, frozen.snapshot.extended.rimChat?.id ?? null),
    ).toEqual(runtime);
    expect(
      presentRuntime(
        frozen.rimProviderRuntime,
        frozen.snapshot.extended.savedFrozenRimChat?.id ?? null,
      ),
    ).toEqual(runtime);

    const restored = await apply(
      harness.store,
      frozen,
      defaultEvent("CREATE_BAN.PRESS_BACK"),
      context,
    );
    expect(restored.snapshot.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(presentRuntime(restored.rimProviderRuntime, chat.id)).toEqual(runtime);
    expect(harness.sessionChatJson(USER_ID)).not.toContain(CONV_ID);
  });

  it("does not apply an old runtime to a new chat for the same contact", async () => {
    const harness = await openStore(kind);
    const context = kernelContext();
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const saved = await harness.store.saveRimProviderRuntime(
      USER_ID,
      seeded.revision,
      runtimeFor(chat),
    );
    const lobby = await apply(harness.store, saved, defaultEvent("RIM.PRESS_BACK"), context);
    expect(lobby.snapshot.extended.rimChat).toBeNull();
    expect(presentRuntime(lobby.rimProviderRuntime, null)).toBeNull();

    const started = await apply(
      harness.store,
      lobby,
      defaultEvent("RIM.PRESS_START_CHAT"),
      context,
    );
    const selecting = await apply(
      harness.store,
      started,
      defaultEvent("RIM.PRESS_SELECT_CONTACT"),
      context,
    );
    const selected = await apply(
      harness.store,
      selecting,
      defaultEvent("RIM.SELECT_CONTACT"),
      context,
    );
    const nextChatId = selected.snapshot.extended.rimChat?.id ?? null;
    expect(nextChatId).not.toBe(chat.id);
    expect(selected.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_A);
    expect(presentRuntime(selected.rimProviderRuntime, nextChatId)).toBeNull();
    expect(presentRuntime(selected.rimProviderRuntime, chat.id)?.rimChatId).toBe(chat.id);
  });

  it("does not apply an old runtime when the contact changes inside a new chat id", async () => {
    const harness = await openStore(kind);
    const context = kernelContext();
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const saved = await harness.store.saveRimProviderRuntime(
      USER_ID,
      seeded.revision,
      runtimeFor(chat),
    );
    const selecting = await apply(
      harness.store,
      saved,
      defaultEvent("RIM.PRESS_SELECT_CONTACT"),
      context,
    );
    const changed = await apply(
      harness.store,
      selecting,
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }),
      context,
    );
    const nextChatId = changed.snapshot.extended.rimChat?.id ?? null;
    expect(nextChatId).not.toBe(chat.id);
    expect(changed.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_B);
    expect(presentRuntime(changed.rimProviderRuntime, nextChatId)).toBeNull();
    expect(parseRimProviderRuntime(changed.rimProviderRuntime).status).toBe("PRESENT");
  });

  it("keeps the record after ordinary back, Ask RIM back, successful Ban, and full close, without applying it", async () => {
    const harness = await openStore(kind);
    const context = kernelContext();
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const saved = await harness.store.saveRimProviderRuntime(
      USER_ID,
      seeded.revision,
      runtimeFor(chat),
    );
    const ordinaryBack = await apply(harness.store, saved, defaultEvent("RIM.PRESS_BACK"), context);
    expect(ordinaryBack.snapshot.controlState).toBe("RIM.LOBBY");
    expect(ordinaryBack.snapshot.extended.rimChat).toBeNull();
    expect(presentRuntime(ordinaryBack.rimProviderRuntime, null)).toBeNull();
    expect(parseRimProviderRuntime(ordinaryBack.rimProviderRuntime).status).toBe("PRESENT");

    const item = statusItem({
      role: "RECEIVER",
      status: "BANTASTIC",
      ownerId: USER_ID,
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    const askChat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(CONTACT_A),
      askRimOrigin: {
        sourceStatusItemId: item.id,
        banId: BAN_ID,
        status: "BANTASTIC",
        sourceRole: "RECEIVER",
      },
    });
    const askWorld = withEntities(chatSnapshot(askChat), {
      bans: {
        [BAN_ID]: makeBan({
          senderId: CONTACT_A,
          receiverId: USER_ID,
          status: "BANTASTIC",
          acceptance: "ACCEPTED",
        }),
      },
      notificationItems: { [item.id]: item },
    });
    const askSeed = await harness.install(USER_ID, {
      ...askWorld,
      extended: { ...askWorld.extended, activeNotificationItemId: item.id },
    });
    const askSaved = await harness.store.saveRimProviderRuntime(
      USER_ID,
      askSeed.revision,
      runtimeFor(askChat),
    );
    const askBack = await apply(harness.store, askSaved, defaultEvent("RIM.PRESS_BACK"), context);
    expect(askBack.snapshot.extended.rimChat).toBeNull();
    expect(presentRuntime(askBack.rimProviderRuntime, CHAT_ID)).toEqual(runtimeFor(askChat));
    expect(presentRuntime(askBack.rimProviderRuntime, null)).toBeNull();

    const confirmChat = readyChat();
    const confirmBase = withOperation(
      withControlState(chatSnapshot(confirmChat), "CREATE_BAN.CONFIRM.RIM"),
      pendingOp({ originatingState: "CREATE_BAN.CONFIRM.RIM" }),
    );
    const confirmWorld: ProductSnapshot = {
      ...confirmBase,
      extended: {
        ...confirmBase.extended,
        createBanDraft: validCreateDraft("RIM"),
        savedFrozenRimChat: confirmChat,
      },
    };
    const confirmSeed = await harness.install(USER_ID, confirmWorld);
    const confirmSaved = await harness.store.saveRimProviderRuntime(
      USER_ID,
      confirmSeed.revision,
      runtimeFor(confirmChat),
    );
    const banned = await apply(
      harness.store,
      confirmSaved,
      defaultEvent("CREATE_BAN.SEND_CONFIRMED"),
      context,
    );
    expect(banned.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(banned.snapshot.extended.rimChat).toBeNull();
    expect(banned.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(presentRuntime(banned.rimProviderRuntime, null)).toBeNull();
    expect(parseRimProviderRuntime(banned.rimProviderRuntime).status).toBe("PRESENT");

    const closeSeed = await harness.install(USER_ID, chatSnapshot(readyChat()));
    const closeSaved = await harness.store.saveRimProviderRuntime(
      USER_ID,
      closeSeed.revision,
      runtimeFor(readyChat()),
    );
    const closed = await apply(harness.store, closeSaved, defaultEvent("APP.FULL_CLOSE"), context);
    expect(closed.snapshot.runtime.session).toBe("CLOSED");
    expect(closed.snapshot.extended.rimChat).toBeNull();
    expect(presentRuntime(closed.rimProviderRuntime, null)).toBeNull();
    expect(parseRimProviderRuntime(closed.rimProviderRuntime).status).toBe("PRESENT");
  });

  it("preserves not-submitted, acceptance-unknown, and known responseId attempt states", async () => {
    const harness = await openStore(kind);
    const chat = readyChat();
    const seeded = await harness.install(USER_ID, chatSnapshot(chat));
    const notSubmitted: RimProviderAttempt = {
      requestId: AI_REQUEST_ID,
      attemptId: attemptId("attempt-1"),
      submissionState: "not-submitted",
      clientRequestId: null,
    };
    const unknown: RimProviderAttempt = {
      requestId: AI_REQUEST_ID,
      attemptId: attemptId("attempt-1"),
      submissionState: "acceptance-unknown",
      clientRequestId: "client-turn-1",
    };
    const known: RimProviderAttempt = {
      requestId: AI_REQUEST_ID,
      attemptId: attemptId("attempt-1"),
      submissionState: "response-id-known",
      responseId: RESPONSE_ID as ProviderResponseId,
      clientRequestId: "client-turn-1",
    };
    const retrieved: RimProviderAttempt = {
      requestId: AI_REQUEST_ID,
      attemptId: attemptId("attempt-1"),
      submissionState: "completed-retrieved",
      responseId: known.responseId,
      providerStatus: "completed",
      clientRequestId: "client-turn-1",
    };
    const observed: RimProviderAttempt = {
      requestId: AI_REQUEST_ID,
      attemptId: attemptId("attempt-1"),
      submissionState: "returned-body-observed",
      clientRequestId: "client-turn-1",
    };

    let revision = seeded.revision;
    for (const attempt of [notSubmitted, unknown, observed, known, retrieved]) {
      const saved = await harness.store.saveRimProviderRuntime(
        USER_ID,
        revision,
        runtimeFor(chat, storedInitialization(), attempt),
      );
      revision = saved.revision;
      const reloaded = await harness.store.loadProductSnapshot(USER_ID);
      expect(presentRuntime(reloaded.rimProviderRuntime, chat.id)?.attempt).toEqual(attempt);
      expect(JSON.stringify(reloaded.rimProviderRuntime)).not.toContain("retryable");
      expect(JSON.stringify(reloaded.snapshot)).not.toContain(RESPONSE_ID);
    }

    const unknownParsed = parseRimProviderRuntime(
      runtimeFor(chat, storedInitialization(), unknown),
    );
    expect(unknownParsed.status).toBe("PRESENT");
    if (unknownParsed.status === "PRESENT") {
      expect(unknownParsed.runtime.attempt).toEqual(unknown);
      expect(unknownParsed.runtime.attempt).not.toHaveProperty("responseId");
    }
  });
});

describe("RimProviderRuntime applicability", () => {
  it("rejects item ids, a conversation id before it is known, and contact-only matching", () => {
    const chat = readyChat();
    const runtime = runtimeFor(chat);
    expect(
      parseRimProviderRuntime({
        ...runtime,
        conversationItemId: "msg_abc",
      }).status,
    ).toBe("INVALID");
    expect(
      parseRimProviderRuntime({
        ...runtime,
        initialization: {
          submissionState: "acceptance-unknown",
          attemptId: "init-1",
          conversationId: CONV_ID,
          clientRequestId: null,
        },
      }).status,
    ).toBe("INVALID");
    const otherChatId = "chat-other" as RimChatId;
    expect(applicableRimProviderRuntime(parseRimProviderRuntime(runtime), otherChatId)).toBeNull();
    expect(applicableRimProviderRuntime(parseRimProviderRuntime(runtime), chat.id)).toEqual(
      runtime,
    );
    expect(applicableRimProviderRuntime({ status: "ABSENT" }, chat.id)).toBeNull();
  });
});

describe("DC-02 continuity runtime", () => {
  function dc01Record(initialization: RimProviderInitialization, attempt: unknown = null) {
    const chat = readyChat();
    return {
      rimChatId: chat.id,
      selectedContactId: CONTACT_A,
      contextRequestId: chat.relationshipContext?.requestId ?? REQUEST_ID,
      initialization,
      attempt,
    };
  }

  function attempt(submission: RimProviderAttempt["submissionState"]): RimProviderAttempt {
    if (submission === "response-id-known") {
      return {
        requestId: AI_REQUEST_ID,
        attemptId: attemptId("attempt-1"),
        submissionState: submission,
        responseId: RESPONSE_ID as ProviderResponseId,
        clientRequestId: null,
      };
    }
    if (submission === "completed-retrieved") {
      return {
        requestId: AI_REQUEST_ID,
        attemptId: attemptId("attempt-1"),
        submissionState: submission,
        responseId: RESPONSE_ID as ProviderResponseId,
        providerStatus: "completed",
        clientRequestId: null,
      };
    }
    return {
      requestId: AI_REQUEST_ID,
      attemptId: attemptId("attempt-1"),
      submissionState: submission,
      clientRequestId: null,
    };
  }

  it("keeps the frozen Product counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
  });

  it.each(["not-submitted", "acceptance-unknown", "stored"] as const)(
    "parses DC-01 initialization %s without continuity fields as provider-conversation",
    (submissionState) => {
      const initialization: RimProviderInitialization =
        submissionState === "stored"
          ? storedInitialization()
          : {
              submissionState,
              attemptId: attemptId("init-1"),
              clientRequestId: null,
            };
      const parsed = parseRimProviderRuntime(dc01Record(initialization));
      expect(parsed.status).toBe("PRESENT");
      if (parsed.status !== "PRESENT") {
        return;
      }
      expect(parsed.runtime.continuityMode).toBe("provider-conversation");
      expect(parsed.runtime.retiredAttemptId).toBeNull();
      expect(parsed.runtime.initialization).toEqual(initialization);
      if (
        submissionState === "stored" &&
        parsed.runtime.initialization.submissionState === "stored"
      ) {
        expect(parsed.runtime.initialization.conversationId).toBe(CONV_ID);
      }
    },
  );

  it.each([
    "not-submitted",
    "acceptance-unknown",
    "returned-body-observed",
    "response-id-known",
    "completed-retrieved",
  ] as const)("parses DC-01 USER attempt %s without continuity fields", (submissionState) => {
    const userAttempt = attempt(submissionState);
    const parsed = parseRimProviderRuntime(dc01Record(storedInitialization(), userAttempt));
    expect(parsed.status).toBe("PRESENT");
    if (parsed.status !== "PRESENT") {
      return;
    }
    expect(parsed.runtime.continuityMode).toBe("provider-conversation");
    expect(parsed.runtime.retiredAttemptId).toBeNull();
    expect(parsed.runtime.attempt).toEqual(userAttempt);
  });

  it("rejects a returned-body-observed attempt that also carries a responseId", () => {
    const chat = readyChat();
    expect(
      parseRimProviderRuntime({
        ...runtimeFor(chat),
        attempt: {
          requestId: AI_REQUEST_ID,
          attemptId: "attempt-1",
          submissionState: "returned-body-observed",
          responseId: RESPONSE_ID,
          clientRequestId: null,
        },
      }).status,
    ).toBe("INVALID");
    const historical = parseRimProviderRuntime({
      ...runtimeFor(chat),
      attempt: {
        requestId: AI_REQUEST_ID,
        attemptId: "attempt-1",
        submissionState: "acceptance-unknown",
        clientRequestId: null,
      },
    });
    expect(historical.status).toBe("PRESENT");
    if (historical.status === "PRESENT") {
      expect(historical.runtime.attempt?.submissionState).toBe("acceptance-unknown");
    }
  });

  it("rejects an unknown continuity mode and a blank retired attempt id", () => {
    const chat = readyChat();
    const runtime = runtimeFor(chat);
    expect(parseRimProviderRuntime({ ...runtime, continuityMode: "c2" }).status).toBe("INVALID");
    expect(parseRimProviderRuntime({ ...runtime, retiredAttemptId: "" }).status).toBe("INVALID");
  });

  it.each(["sql", "memory"] as const)(
    "round-trips both continuity modes and a retired attempt id (%s)",
    async (kind) => {
      const harness = await openStore(kind);
      const chat = readyChat();
      const seeded = await harness.install(USER_ID, chatSnapshot(chat));
      const legacy = dc01Record(storedInitialization());
      const legacySaved = await harness.store.saveRimProviderRuntime(
        USER_ID,
        seeded.revision,
        legacy,
      );
      const legacyParsed = parseRimProviderRuntime(legacySaved.rimProviderRuntime);
      expect(legacyParsed.status).toBe("PRESENT");
      if (legacyParsed.status !== "PRESENT") {
        return;
      }
      expect(legacyParsed.runtime.continuityMode).toBe("provider-conversation");
      expect(legacyParsed.runtime.retiredAttemptId).toBeNull();
      expect(legacySaved.rimProviderRuntime).not.toHaveProperty("continuityMode");
      expect(legacyParsed.runtime.initialization).toMatchObject({
        submissionState: "stored",
        conversationId: CONV_ID,
      });

      const modes: readonly RimContinuityMode[] = [
        "provider-conversation",
        "local-canonical-history",
      ];
      let revision = legacySaved.revision;
      for (const continuityMode of modes) {
        const retiredAttemptId =
          continuityMode === "local-canonical-history" ? attemptId("attempt-retired") : null;
        const runtime: RimProviderRuntime = {
          ...runtimeFor(chat),
          continuityMode,
          retiredAttemptId,
        };
        const saved = await harness.store.saveRimProviderRuntime(USER_ID, revision, runtime);
        revision = saved.revision;
        const reloaded = await harness.store.loadProductSnapshot(USER_ID);
        expect(presentRuntime(reloaded.rimProviderRuntime, chat.id)).toEqual(runtime);
        if (continuityMode === "local-canonical-history") {
          expect(
            presentRuntime(reloaded.rimProviderRuntime, chat.id)?.initialization,
          ).toMatchObject({ submissionState: "stored", conversationId: CONV_ID });
        }
      }
    },
  );
});
