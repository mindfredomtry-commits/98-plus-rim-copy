import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import {
  openPostgresPersistence,
  type PostgresPersistence,
  type RuntimeAttemptAuthority,
} from "@98plus/persistence";
import { PostgresProductStore } from "@98plus/persistence";
import { PersistenceTestKit } from "../../../persistence/src/test-kit.ts";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  asInstant,
  counterAllocator,
  emptySnapshot,
  reduce,
  type AiRequestId,
  type BanId,
  type ContextRequestId,
  type DurationMinutes,
  type ExecutionProbability,
  type NotificationItemId,
  type ProductSnapshot,
  type ProposalId,
  type RimChat,
  type RimChatId,
  type UserId,
} from "@98plus/product-model";
import {
  CONTEXT_DATA,
  applicationProposal,
  branded,
  defaultEvent,
  OP_ID,
  eventOf,
  makeBan,
  makeChat,
  pendingAi,
  pendingOp,
  proposalsMessage,
  readyContext,
  statusItem,
  withChat,
  withControlState,
  withEntities,
  withOperation,
} from "../../../product-model/src/kernel.fixtures.ts";
import { executeProductEvent, type ProductExecutorDependencies } from "../execute.ts";
import { commitProductEventIfAttemptCurrent } from "../execute.ts";
import { authContext } from "../test-harness.ts";
import { continueRimEffects } from "./continue-rim.ts";
import { continuePendingRimAi, recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import type { RimAiRequest } from "./rim-ai-port.ts";
import type { RimInitializationObservation } from "./initialize-rim-conversation.ts";
import type { RimConversationInitializationRequest } from "./rim-conversation-port.ts";
import {
  parseRimProviderRuntime,
  type ProviderConversationId,
  type ProviderResponseId,
  type RimProviderAttempt,
  type RimProviderAttemptId,
  type RimProviderInitialization,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;
const ASSISTANT = "слышу";

type Actor = Readonly<{ userId: UserId; telegram: string }>;

type Process = Readonly<{
  db: PostgresPersistence;
  store: PostgresProductStore;
  kit: PersistenceTestKit;
  deps: ProductExecutorDependencies;
  kill(): Promise<void>;
}>;

type Probe = Readonly<{
  initializes: RimConversationInitializationRequest[];
  responds: RimAiRequest[];
  retrieves: ProviderResponseId[];
  log: RimInitializationObservation[];
  rimAi: Parameters<typeof recoverPendingRimAi>[0]["rimAi"];
  conversation: NonNullable<Parameters<typeof recoverPendingRimAi>[0]["conversation"]>;
  retrieval: NonNullable<Parameters<typeof recoverPendingRimAi>[0]["retrieval"]>;
}>;

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

function attempt(value: string): RimProviderAttemptId {
  return value as RimProviderAttemptId;
}

function conversation(value: string): ProviderConversationId {
  return value as ProviderConversationId;
}

function response(value: string): ProviderResponseId {
  return value as ProviderResponseId;
}

function present(value: unknown): RimProviderRuntime {
  const parsed = parseRimProviderRuntime(value);
  if (parsed.status !== "PRESENT") {
    throw new Error(`runtime ${parsed.status}`);
  }
  return parsed.runtime;
}

function userTexts(chat: RimChat | null | undefined): string[] {
  return (chat?.messages ?? []).flatMap((message) =>
    message.kind === "USER" ? [message.text] : [],
  );
}

function rimTexts(chat: RimChat | null | undefined): string[] {
  return (chat?.messages ?? []).flatMap((message) =>
    message.kind === "RIM" ? [message.text] : [],
  );
}

function probe(retrieve?: Probe["retrieval"]["retrieve"]): Probe {
  const initializes: RimConversationInitializationRequest[] = [];
  const responds: RimAiRequest[] = [];
  const retrieves: ProviderResponseId[] = [];
  const log: RimInitializationObservation[] = [];
  return {
    initializes,
    responds,
    retrieves,
    log,
    rimAi: {
      async respond(request) {
        responds.push(request);
        return { kind: "MESSAGE", text: ASSISTANT };
      },
    },
    conversation: {
      async initialize(request) {
        initializes.push(request);
        return { conversationId: conversation(`conv-new-${initializes.length}`) };
      },
    },
    retrieval: {
      async retrieve(responseId) {
        if (retrieve) {
          return retrieve(responseId);
        }
        retrieves.push(responseId);
        return {
          responseId,
          providerStatus: "completed",
          output: { kind: "MESSAGE", text: ASSISTANT },
        };
      },
    },
  };
}

function storedInit(conv: string): RimProviderInitialization {
  return {
    submissionState: "stored",
    attemptId: attempt("init-1"),
    conversationId: conversation(conv),
    clientRequestId: "client-init",
  };
}

function runtimeFor(
  chat: RimChat,
  initialization: RimProviderInitialization,
  providerAttempt: RimProviderAttempt | null,
  continuityMode: RimProviderRuntime["continuityMode"] = "provider-conversation",
  retiredAttemptId: RimProviderAttemptId | null = null,
  retryIntent?: RimProviderRuntime["retryIntent"],
): RimProviderRuntime {
  if (!chat.selectedContactId || !chat.relationshipContext) {
    throw new Error("chat is missing contact or context");
  }
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    contextRequestId: chat.relationshipContext.requestId,
    initialization,
    attempt: providerAttempt,
    continuityMode,
    retiredAttemptId,
    ...(retryIntent ? { retryIntent } : {}),
  };
}

function providerAttempt(
  chat: RimChat,
  submission: "not-submitted" | "acceptance-unknown",
  attemptId = "attempt-1",
): RimProviderAttempt {
  if (chat.aiOperation.status !== "PENDING") {
    throw new Error("pending request required");
  }
  return {
    requestId: chat.aiOperation.requestId,
    attemptId: attempt(attemptId),
    submissionState: submission,
    clientRequestId: "client-1",
  };
}

describe.skipIf(!databaseUrl)("real PostgreSQL RIM restart recovery", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let admin: PostgresPersistence;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    assertSchemaName(schema);
    admin = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    await admin.sql.query(`CREATE SCHEMA ${schema}`, []);
    await admin.sql.query(`SET search_path TO ${schema}`, []);
    await admin.applyMigrations();
  }, 30_000);

  afterAll(async () => {
    if (!admin) {
      return;
    }
    assertSchemaName(schema);
    await admin.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await admin.close();
  });

  async function actor(prefix: string): Promise<Actor> {
    const telegram = `${prefix}-${randomUUID()}`;
    const store = new PostgresIdentityStore(admin.sql);
    const user = await store.resolveByTelegramUserId(asTelegramUserId(telegram));
    return { userId: user.userId, telegram };
  }

  async function startProcess(): Promise<Process> {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    const db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_pass4`,
    });
    const store = new PostgresProductStore(db.sql);
    const kit = PersistenceTestKit.postgres(db.sql);
    const deps: ProductExecutorDependencies = {
      store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(1),
    };
    return {
      db,
      store,
      kit,
      deps,
      async kill() {
        await db.close();
      },
    };
  }

  async function seed(
    process: Process,
    actor: Actor,
    snapshot: ProductSnapshot,
    runtime?: RimProviderRuntime,
  ): Promise<void> {
    const saved = await process.kit.installFixtureSnapshot(actor.userId, snapshot);
    if (runtime) {
      await process.store.saveRimProviderRuntime(actor.userId, saved.revision, runtime);
    }
  }

  function recover(process: Process, actor: Actor, tools: Probe) {
    return recoverPendingRimAi({
      context: authContext(actor.userId, actor.telegram),
      deps: process.deps,
      rimAi: tools.rimAi,
      conversation: tools.conversation,
      initializationLog: tools.log,
      retrieval: tools.retrieval,
    });
  }

  it("keeps the frozen Product counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });

  it("reloads one active RIM chat through a new process without a new conversation", async () => {
    const user = await actor("chat-user");
    const contact = await actor("chat-contact");
    const chatId = branded<RimChatId>(`chat-${randomUUID()}`);
    const contextId = branded<ContextRequestId>(`ctx-${randomUUID()}`);
    const proposals = proposalsMessage([
      applicationProposal(branded<ProposalId>("p1"), "no phones", 0.2 as ExecutionProbability),
      applicationProposal(branded<ProposalId>("p2"), "no meetings", 0.4 as ExecutionProbability),
      applicationProposal(branded<ProposalId>("p3"), "no mail", 0.8 as ExecutionProbability),
    ]);
    const chat = makeChat({
      id: chatId,
      selectedContactId: contact.userId,
      relationshipContext: readyContext(contact.userId, contextId),
      messages: [{ kind: "USER", text: "привет" }, proposals],
      inputDraft: "draft-1",
      aiOperation: { status: "IDLE" },
    });
    const runtime = runtimeFor(chat, storedInit("conv-kept"), null);
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    const firstDb = first.db;
    await first.kill();
    await expect(firstDb.sql.query("SELECT 1", [])).rejects.toThrow();

    const second = await startProcess();
    expect(second.db).not.toBe(firstDb);
    try {
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.extended.rimChat).toEqual(chat);
      expect(loaded.snapshot.extended.savedFrozenRimChat).toBeNull();
      expect(present(loaded.rimProviderRuntime)).toEqual(runtime);
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(0);
      expect(tools.responds).toHaveLength(0);
      const again = await startProcess();
      try {
        const reread = await again.store.loadProductSnapshot(user.userId);
        expect(reread.snapshot.extended.rimChat).toEqual(chat);
        expect(present(reread.rimProviderRuntime).initialization).toEqual(runtime.initialization);
        const repeat = probe();
        expect(await recover(again, user, repeat)).toBeNull();
        expect(repeat.initializes).toHaveLength(0);
      } finally {
        await again.kill();
      }
    } finally {
      await second.kill();
    }
  });

  it("resumes not-submitted initialization once and leaves a stored conversation idempotent", async () => {
    const user = await actor("init-user");
    const contact = await actor("init-contact");
    const chat = makeChat({
      id: branded<RimChatId>(`init-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`init-ctx-${randomUUID()}`),
      ),
    });
    const runtime = runtimeFor(
      chat,
      {
        submissionState: "not-submitted",
        attemptId: attempt("init-open"),
        clientRequestId: "client-init",
      },
      null,
    );
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();

    const second = await startProcess();
    try {
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(1);
      expect(tools.log).toEqual(["initialization-claimed", "initialization-stored"]);
      const stored = present(
        (await second.store.loadProductSnapshot(user.userId)).rimProviderRuntime,
      );
      expect(stored.initialization.submissionState).toBe("stored");
      if (stored.initialization.submissionState === "stored") {
        expect(stored.initialization.conversationId).toBe(conversation("conv-new-1"));
        expect(stored.initialization.attemptId).toBe(attempt("init-open"));
      }
      expect(await second.store.loadProductSnapshot(user.userId)).toMatchObject({
        snapshot: { extended: { rimChat: chat } },
      });
    } finally {
      await second.kill();
    }

    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(0);
      expect(tools.log).toEqual([]);
    } finally {
      await third.kill();
    }
  });

  it("dispatches E-64 for acceptance-unknown initialization after the flight map is gone", async () => {
    const user = await actor("e64-user");
    const contact = await actor("e64-contact");
    const chat = makeChat({
      id: branded<RimChatId>(`e64-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`e64-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "USER", text: "до инициализации" }],
    });
    const runtime = runtimeFor(
      chat,
      {
        submissionState: "acceptance-unknown",
        attemptId: attempt("init-unknown"),
        clientRequestId: "client-init",
      },
      null,
    );
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();

    const second = await startProcess();
    try {
      const before = present(
        (await second.store.loadProductSnapshot(user.userId)).rimProviderRuntime,
      );
      expect(before.initialization.submissionState).toBe("acceptance-unknown");
      const tools = probe();
      const ended = await recover(second, user, tools);
      expect(ended?.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
      expect(tools.initializes).toHaveLength(0);
      expect(tools.responds).toHaveLength(0);
      expect(tools.log).toEqual(["initialization-acceptance-unknown", "e64-dispatched"]);
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(loaded.snapshot.extended.rimChat).toBeNull();
      expect(present(loaded.rimProviderRuntime).initialization.submissionState).toBe(
        "acceptance-unknown",
      );
    } finally {
      await second.kill();
    }

    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(0);
      expect(tools.log).toEqual([]);
      const loaded = await third.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(loaded.snapshot.extended.rimChat).toBeNull();
    } finally {
      await third.kill();
    }
  });

  it("does not mint a USER attempt during recovery when none was stored", async () => {
    const user = await actor("missing-user");
    const contact = await actor("missing-contact");
    const pending = pendingChat(user, contact, "один");
    const runtime = runtimeFor(pending, storedInit("conv-stored-missing"), null);
    const first = await startProcess();
    await seed(
      first,
      user,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), pending),
      runtime,
    );
    await first.kill();

    const second = await startProcess();
    try {
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      expect(tools.initializes).toHaveLength(0);
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["один"]);
      expect(present(loaded.rimProviderRuntime).attempt).toBeNull();
      const live = probe();
      const settled = await continuePendingRimAi({
        context: authContext(user.userId, user.telegram),
        deps: second.deps,
        rimAi: live.rimAi,
        conversation: live.conversation,
        retrieval: live.retrieval,
        origin: null,
      });
      expect(settled?.status).toBe("APPLIED");
      expect(live.initializes).toHaveLength(0);
      expect(live.responds).toHaveLength(1);
      expect(live.responds[0]?.continuityMode).toBe("provider-conversation");
      const after = await second.store.loadProductSnapshot(user.userId);
      expect(userTexts(after.snapshot.extended.rimChat)).toEqual(["один"]);
      expect(rimTexts(after.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
    } finally {
      await second.kill();
    }
  });

  it("submits a not-submitted provider attempt once from a fresh process", async () => {
    const user = await actor("pre-user");
    const contact = await actor("pre-contact");
    const chat = pendingChat(user, contact, "до отправки");
    const runtime = runtimeFor(
      chat,
      storedInit("conv-pre"),
      providerAttempt(chat, "not-submitted"),
    );
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();

    const second = await startProcess();
    try {
      const tools = probe();
      const settled = await recover(second, user, tools);
      expect(settled?.status).toBe("APPLIED");
      expect(tools.initializes).toHaveLength(0);
      expect(tools.responds).toHaveLength(1);
      expect(tools.responds[0]?.continuityMode).toBe("provider-conversation");
      if (tools.responds[0]?.continuityMode === "provider-conversation") {
        expect(tools.responds[0].conversationId).toBe(conversation("conv-pre"));
        expect(tools.responds[0].userMessage).toBe("до отправки");
      }
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["до отправки"]);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
    } finally {
      await second.kill();
    }

    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      const loaded = await third.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
    } finally {
      await third.kill();
    }
  });

  it("switches an abandoned provider attempt to local history and fences the old attempt", async () => {
    const user = await actor("amb-user");
    const contact = await actor("amb-contact");
    const chat = pendingChat(user, contact, "неясно");
    const oldAttempt = "attempt-old";
    const runtime = runtimeFor(
      chat,
      storedInit("conv-abandoned"),
      providerAttempt(chat, "acceptance-unknown", oldAttempt),
    );
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    const revisionBefore = (await first.store.loadProductSnapshot(user.userId)).revision;
    await first.kill();

    const second = await startProcess();
    try {
      const tools = probe();
      const settled = await recover(second, user, tools);
      expect(settled?.status).toBe("APPLIED");
      expect(tools.responds).toHaveLength(1);
      expect(tools.responds[0]?.continuityMode).toBe("local-canonical-history");
      expect(JSON.stringify(tools.responds[0])).not.toContain("conv-abandoned");
      const loaded = await second.store.loadProductSnapshot(user.userId);
      const next = present(loaded.rimProviderRuntime);
      expect(next.continuityMode).toBe("local-canonical-history");
      expect(next.retiredAttemptId).toBe(attempt(oldAttempt));
      expect(next.attempt?.attemptId).not.toBe(attempt(oldAttempt));
      expect(next.attempt?.requestId).toBe(
        chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : "",
      );
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["неясно"]);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
      expect(loaded.revision).toBeGreaterThan(revisionBefore);
      const late = await commitProductEventIfAttemptCurrent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.AI_RESULT_RECEIVED", {
            rimChatId: chat.id,
            requestId:
              chat.aiOperation.status === "PENDING"
                ? chat.aiOperation.requestId
                : branded<AiRequestId>("missing"),
            result: { kind: "MESSAGE", text: "опоздал" },
          }),
          authority: authority(runtime, oldAttempt, "provider-conversation"),
        },
        second.deps,
      );
      expect(late).toBeNull();
      const draft = reduce(
        loaded.snapshot,
        eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "late-draft" }),
        {
          now: asInstant(2_000_000),
          currentUserId: user.userId,
          allocateId: second.deps.allocateId,
        },
      );
      expect(draft.outcome).toBe("APPLIED");
      const owned = await second.store.commitOwnedTransition({
        currentUserId: user.userId,
        expectedRevision: loaded.revision,
        result: draft,
        requireAttempt: authority(runtime, oldAttempt, "provider-conversation"),
      });
      expect(owned.status).toBe("ATTEMPT_SUPERSEDED");
      const fenced = await second.store.loadProductSnapshot(user.userId);
      expect(fenced.revision).toBe(loaded.revision);
      expect(fenced.snapshot.extended.rimChat?.inputDraft).not.toBe("late-draft");
      expect(rimTexts(fenced.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
      expect(present(fenced.rimProviderRuntime).attempt?.attemptId).toBe(next.attempt?.attemptId);
    } finally {
      await second.kill();
    }

    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      const loaded = await third.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["неясно"]);
    } finally {
      await third.kill();
    }
  });

  it("retrieves a returned body by its response id and ignores a stale revision", async () => {
    const user = await actor("body-user");
    const contact = await actor("body-contact");
    const chat = pendingChat(user, contact, "есть ответ");
    const responseId = response("resp-body-1");
    const runtime = runtimeFor(chat, storedInit("conv-body"), {
      requestId: requestOf(chat),
      attemptId: attempt("attempt-body"),
      submissionState: "returned-body-observed",
      responseId,
      clientRequestId: "client-1",
    });
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();

    const raced = await startProcess();
    try {
      let bumped = false;
      const tools = probe(async (id) => {
        if (!bumped) {
          bumped = true;
          const current = await raced.store.loadProductSnapshot(user.userId);
          await raced.store.saveRimProviderRuntime(
            user.userId,
            current.revision,
            current.rimProviderRuntime,
          );
        }
        return {
          responseId: id,
          providerStatus: "completed" as const,
          output: { kind: "MESSAGE" as const, text: ASSISTANT },
        };
      });
      expect(await recover(raced, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      const stalled = await raced.store.loadProductSnapshot(user.userId);
      expect(rimTexts(stalled.snapshot.extended.rimChat)).toEqual([]);
      expect(present(stalled.rimProviderRuntime).attempt?.submissionState).toBe(
        "returned-body-observed",
      );
    } finally {
      await raced.kill();
    }

    const second = await startProcess();
    try {
      const tools = probe();
      const settled = await recover(second, user, tools);
      expect(settled?.status).toBe("APPLIED");
      expect(tools.responds).toHaveLength(0);
      expect(tools.retrieves).toEqual([responseId]);
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["есть ответ"]);
      expect(present(loaded.rimProviderRuntime).attempt?.submissionState).toBe(
        "completed-retrieved",
      );
    } finally {
      await second.kill();
    }

    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.retrieves).toHaveLength(0);
      expect(tools.responds).toHaveLength(0);
      const loaded = await third.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
    } finally {
      await third.kill();
    }
  });

  it("retrieves a known response id that has not yet observed a body", async () => {
    const user = await actor("known-user");
    const contact = await actor("known-contact");
    const chat = pendingChat(user, contact, "ид известен");
    const responseId = response("resp-known-1");
    const runtime = runtimeFor(chat, storedInit("conv-known"), {
      requestId: requestOf(chat),
      attemptId: attempt("attempt-known"),
      submissionState: "response-id-known",
      responseId,
      clientRequestId: "client-1",
    });
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();
    const second = await startProcess();
    try {
      const tools = probe();
      expect((await recover(second, user, tools))?.status).toBe("APPLIED");
      expect(tools.retrieves).toEqual([responseId]);
      expect(tools.responds).toHaveLength(0);
      expect(
        rimTexts((await second.store.loadProductSnapshot(user.userId)).snapshot.extended.rimChat),
      ).toEqual([ASSISTANT]);
    } finally {
      await second.kill();
    }
    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.retrieves).toHaveLength(0);
    } finally {
      await third.kill();
    }
  });

  it("stops on a returned body with no response id and does not retry it", async () => {
    const user = await actor("dead-user");
    const contact = await actor("dead-contact");
    const chat = pendingChat(user, contact, "без идентификатора");
    const runtime = runtimeFor(chat, storedInit("conv-dead"), {
      requestId: requestOf(chat),
      attemptId: attempt("attempt-dead"),
      submissionState: "returned-body-observed",
      clientRequestId: "client-1",
    });
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    const before = await first.store.loadProductSnapshot(user.userId);
    await first.kill();

    const second = await startProcess();
    try {
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      expect(tools.retrieves).toHaveLength(0);
      expect(tools.initializes).toHaveLength(0);
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(loaded.revision).toBe(before.revision);
      expect(loaded.snapshot.extended.rimChat).toEqual(chat);
      expect(present(loaded.rimProviderRuntime)).toEqual(runtime);
      const retry = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: requestOf(chat) }),
        },
        second.deps,
      );
      expect(retry.status).not.toBe("APPLIED");
      const after = await second.store.loadProductSnapshot(user.userId);
      expect(after.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
      expect(present(after.rimProviderRuntime).continuityMode).toBe("provider-conversation");
      expect(present(after.rimProviderRuntime).attempt?.submissionState).toBe(
        "returned-body-observed",
      );
    } finally {
      await second.kill();
    }
  });

  it("continues local canonical history without returning to the provider conversation", async () => {
    const user = await actor("local-user");
    const contact = await actor("local-contact");
    const chat = pendingChat(user, contact, "локально");
    const runtime = runtimeFor(
      chat,
      storedInit("conv-retired"),
      providerAttempt(chat, "not-submitted", "attempt-local"),
      "local-canonical-history",
      attempt("attempt-retired"),
    );
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();
    const second = await startProcess();
    try {
      const tools = probe();
      expect((await recover(second, user, tools))?.status).toBe("APPLIED");
      expect(tools.responds).toHaveLength(1);
      expect(tools.responds[0]?.continuityMode).toBe("local-canonical-history");
      expect(JSON.stringify(tools.responds[0])).not.toContain("conv-retired");
      const loaded = await second.store.loadProductSnapshot(user.userId);
      const next = present(loaded.rimProviderRuntime);
      expect(next.continuityMode).toBe("local-canonical-history");
      expect(next.retiredAttemptId).toBe(attempt("attempt-retired"));
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["локально"]);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
    } finally {
      await second.kill();
    }
    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
    } finally {
      await third.kill();
    }
  });

  it("leaves an unresolved local acceptance-unknown attempt unsubmitted", async () => {
    const user = await actor("local-unknown-user");
    const contact = await actor("local-unknown-contact");
    const chat = pendingChat(user, contact, "локальная неопределенность");
    const runtime = runtimeFor(
      chat,
      storedInit("conv-local-unknown"),
      providerAttempt(chat, "acceptance-unknown", "attempt-local-unknown"),
      "local-canonical-history",
      attempt("attempt-retired-local"),
    );
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();
    const second = await startProcess();
    try {
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(present(loaded.rimProviderRuntime)).toEqual(runtime);
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["локальная неопределенность"]);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([]);
    } finally {
      await second.kill();
    }
  });

  it("installs one local replacement from a durable retry intent", async () => {
    const user = await actor("retry-user");
    const contact = await actor("retry-contact");
    const chat = pendingChat(user, contact, "повтор");
    const oldAttempt = "attempt-terminal";
    const base = runtimeFor(chat, storedInit("conv-retry"), {
      requestId: requestOf(chat),
      attemptId: attempt(oldAttempt),
      submissionState: "returned-body-observed",
      clientRequestId: "client-1",
    });
    const runtime: RimProviderRuntime = {
      ...base,
      retryIntent: {
        rimChatId: chat.id,
        contextRequestId:
          chat.relationshipContext?.requestId ?? branded<ContextRequestId>("missing"),
        requestId: requestOf(chat),
        attemptId: attempt(oldAttempt),
      },
    };
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();
    const second = await startProcess();
    try {
      const durable = present(
        (await second.store.loadProductSnapshot(user.userId)).rimProviderRuntime,
      );
      expect(durable.retryIntent?.attemptId).toBe(attempt(oldAttempt));
      const tools = probe();
      expect((await recover(second, user, tools))?.status).toBe("APPLIED");
      expect(tools.responds).toHaveLength(1);
      expect(tools.responds[0]?.continuityMode).toBe("local-canonical-history");
      const loaded = await second.store.loadProductSnapshot(user.userId);
      const next = present(loaded.rimProviderRuntime);
      expect(next.retryIntent).toBeUndefined();
      expect(next.continuityMode).toBe("local-canonical-history");
      expect(next.retiredAttemptId).toBe(attempt(oldAttempt));
      expect(next.attempt?.attemptId).not.toBe(attempt(oldAttempt));
      expect(next.attempt?.requestId).toBe(requestOf(chat));
      expect(userTexts(loaded.snapshot.extended.rimChat)).toEqual(["повтор"]);
      expect(rimTexts(loaded.snapshot.extended.rimChat)).toEqual([ASSISTANT]);
      const owned = await second.store.commitOwnedTransition({
        currentUserId: user.userId,
        expectedRevision: loaded.revision,
        result: reduce(
          loaded.snapshot,
          eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "stale-retry" }),
          {
            now: asInstant(2_000_000),
            currentUserId: user.userId,
            allocateId: second.deps.allocateId,
          },
        ),
        requireAttempt: authority(runtime, oldAttempt, "provider-conversation"),
      });
      expect(owned.status).toBe("ATTEMPT_SUPERSEDED");
      expect(
        (await second.store.loadProductSnapshot(user.userId)).snapshot.extended.rimChat?.inputDraft,
      ).not.toBe("stale-retry");
    } finally {
      await second.kill();
    }
    const third = await startProcess();
    try {
      const tools = probe();
      expect(await recover(third, user, tools)).toBeNull();
      expect(tools.responds).toHaveLength(0);
      expect(
        rimTexts((await third.store.loadProductSnapshot(user.userId)).snapshot.extended.rimChat),
      ).toEqual([ASSISTANT]);
    } finally {
      await third.kill();
    }
  });

  it("restores the same frozen RIM chat from Create Ban after restart", async () => {
    const user = await actor("frozen-user");
    const contact = await actor("frozen-contact");
    const chatId = branded<RimChatId>(`frozen-${randomUUID()}`);
    const proposalId = branded<ProposalId>(`proposal-${randomUUID()}`);
    const frozen = makeChat({
      id: chatId,
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`frozen-ctx-${randomUUID()}`),
      ),
      messages: [
        { kind: "USER", text: "предложение" },
        proposalsMessage([
          applicationProposal(proposalId, "exact ban text", 0.25 as ExecutionProbability),
          applicationProposal(
            branded<ProposalId>(`${proposalId}-2`),
            "no meetings",
            0.5 as ExecutionProbability,
          ),
          applicationProposal(
            branded<ProposalId>(`${proposalId}-3`),
            "no mail",
            0.75 as ExecutionProbability,
          ),
        ]),
      ],
      inputDraft: "frozen-draft",
    });
    const live = makeChat({
      ...frozen,
      inputDraft: "changed-live",
    });
    const snapshot: ProductSnapshot = {
      ...withChat(withControlState(emptySnapshot(), "CREATE_BAN.WHAT.RIM"), live),
      extended: {
        ...withChat(withControlState(emptySnapshot(), "CREATE_BAN.WHAT.RIM"), live).extended,
        savedFrozenRimChat: frozen,
        createBanDraft: {
          origin: "RIM",
          selectedContactId: contact.userId,
          banText: "exact ban text",
          durationMinutes: null,
          proposalId,
        },
      },
    };
    const runtime = runtimeFor(frozen, storedInit("conv-frozen"), null);
    const first = await startProcess();
    await seed(first, user, snapshot, runtime);
    await first.kill();
    const second = await startProcess();
    try {
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("CREATE_BAN.WHAT.RIM");
      expect(loaded.snapshot.extended.createBanDraft).toEqual(snapshot.extended.createBanDraft);
      expect(loaded.snapshot.extended.savedFrozenRimChat).toEqual(frozen);
      expect(loaded.snapshot.extended.rimChat).toEqual(live);
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(0);
      const back = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: defaultEvent("CREATE_BAN.PRESS_BACK"),
        },
        second.deps,
      );
      expect(back.status).toBe("APPLIED");
      expect(back.snapshot.controlState).toBe("RIM.CHAT");
      expect(back.snapshot.extended.rimChat).toEqual(frozen);
      expect(back.snapshot.extended.savedFrozenRimChat).toBeNull();
      expect(back.snapshot.extended.createBanDraft).toBeNull();
      const restored = await second.store.loadProductSnapshot(user.userId);
      expect(restored.snapshot.extended.rimChat?.id).toBe(chatId);
      expect(present(restored.rimProviderRuntime).initialization).toEqual(runtime.initialization);
      const after = probe();
      expect(await recover(second, user, after)).toBeNull();
      expect(after.initializes).toHaveLength(0);
    } finally {
      await second.kill();
    }
  });

  it("terminates the frozen RIM chat when Create Ban send is confirmed", async () => {
    const user = await actor("send-user");
    const contact = await actor("send-contact");
    const chat = makeChat({
      id: branded<RimChatId>(`send-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`send-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "USER", text: "отправка" }],
    });
    const proposalId = branded<ProposalId>(`send-proposal-${randomUUID()}`);
    const createdBanId = branded<BanId>(`created-${randomUUID()}`);
    const draft = {
      origin: "RIM" as const,
      selectedContactId: contact.userId,
      banText: "exact ban text",
      durationMinutes: 5 as DurationMinutes,
      proposalId,
    };
    const snapshot = withOperation(
      {
        ...withChat(withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.RIM"), chat),
        extended: {
          ...withChat(withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.RIM"), chat).extended,
          savedFrozenRimChat: chat,
          createBanDraft: draft,
        },
      },
      pendingOp({
        originatingState: "CREATE_BAN.CONFIRM.RIM",
        sendDraft: draft,
      }),
    );
    const first = await startProcess();
    await seed(first, user, snapshot, runtimeFor(chat, storedInit("conv-send"), null));
    await first.kill();
    const second = await startProcess();
    try {
      const confirmed = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("CREATE_BAN.SEND_CONFIRMED", {
            operationId: OP_ID,
            createdBanId,
          }),
        },
        second.deps,
      );
      expect(confirmed.status).toBe("APPLIED");
      expect(confirmed.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
      expect(confirmed.snapshot.extended.rimChat).toBeNull();
      expect(confirmed.snapshot.extended.savedFrozenRimChat).toBeNull();
      expect(confirmed.snapshot.extended.entities.bans[createdBanId]?.sourceProposalId).toBe(
        proposalId,
      );
      expect(confirmed.snapshot.extended.entities.bans[createdBanId]?.banText).toBe(
        "exact ban text",
      );
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(0);
      expect(tools.responds).toHaveLength(0);
    } finally {
      await second.kill();
    }
  });

  it("keeps ask-RIM origin and continues the same conversation", async () => {
    const user = await actor("ask-user");
    const contact = await actor("ask-contact");
    const banId = branded<BanId>(`ask-ban-${randomUUID()}`);
    const itemId = branded<NotificationItemId>(`ask-item-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId: contact.userId,
      receiverId: user.userId,
      status: "BANTASTIC",
      acceptance: "ACCEPTED",
    });
    const item = statusItem({
      id: itemId,
      ownerId: user.userId,
      banId,
      role: "RECEIVER",
      status: "BANTASTIC",
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    const origin = {
      sourceStatusItemId: itemId,
      banId,
      status: "BANTASTIC" as const,
      sourceRole: "RECEIVER" as const,
    };
    const chat = makeChat({
      id: branded<RimChatId>(`ask-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`ask-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "RIM", text: "что хочешь спросить?" }],
      inputDraft: "что случилось",
      askRimOrigin: origin,
    });
    const snapshot = withEntities(withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), {
      bans: { [ban.id]: ban },
      notificationItems: { [item.id]: item },
    });
    const seeded = {
      ...snapshot,
      extended: { ...snapshot.extended, activeNotificationItemId: item.id },
    };
    const runtime = runtimeFor(chat, storedInit("conv-ask"), null);
    const first = await startProcess();
    await seed(first, user, seeded, runtime);
    await first.kill();
    const second = await startProcess();
    try {
      const loaded = await second.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.extended.rimChat).toEqual(chat);
      const idle = probe();
      expect(await recover(second, user, idle)).toBeNull();
      expect(idle.initializes).toHaveLength(0);
      const sent = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: defaultEvent("RIM.PRESS_SEND"),
        },
        second.deps,
      );
      expect(sent.status).toBe("APPLIED");
      const tools = probe();
      const settled = await continueRimEffects(sent, {
        context: authContext(user.userId, user.telegram),
        deps: second.deps,
        rimAi: tools.rimAi,
        conversation: tools.conversation,
        retrieval: tools.retrieval,
        contextFailures: { remainingFailures: 0 },
        loadSources: async () => [],
      });
      expect(settled.status).toBe("APPLIED");
      expect(tools.initializes).toHaveLength(0);
      expect(tools.responds).toHaveLength(1);
      expect(tools.responds[0]?.continuityMode).toBe("provider-conversation");
      if (tools.responds[0]?.continuityMode === "provider-conversation") {
        expect(tools.responds[0].conversationId).toBe(conversation("conv-ask"));
        expect(tools.responds[0].conversationalOrigin).toEqual(origin);
      }
      const after = await second.store.loadProductSnapshot(user.userId);
      expect(after.snapshot.extended.rimChat?.id).toBe(chat.id);
      expect(after.snapshot.extended.rimChat?.askRimOrigin).toEqual(origin);
      expect(after.snapshot.extended.rimChat?.selectedContactId).toBe(contact.userId);
      expect(rimTexts(after.snapshot.extended.rimChat)).toEqual([
        "что хочешь спросить?",
        ASSISTANT,
      ]);
      expect(userTexts(after.snapshot.extended.rimChat)).toEqual(["что случилось"]);
    } finally {
      await second.kill();
    }
  });

  it("creates a new chat and conversation when the contact changes after restart", async () => {
    const user = await actor("switch-user");
    const contact = await actor("switch-contact");
    const other = await actor("switch-other");
    const chat = makeChat({
      id: branded<RimChatId>(`switch-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`switch-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "USER", text: "старый контакт" }],
      inputDraft: "old-draft",
    });
    const runtime = runtimeFor(chat, storedInit("conv-old-contact"), null);
    const first = await startProcess();
    await seed(first, user, withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat), runtime);
    await first.kill();
    const second = await startProcess();
    try {
      expect(
        (await second.store.loadProductSnapshot(user.userId)).snapshot.extended.rimChat,
      ).toEqual(chat);
      const opened = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: defaultEvent("RIM.PRESS_SELECT_CONTACT"),
        },
        second.deps,
      );
      expect(opened.snapshot.extended.rimChat?.id).toBe(chat.id);
      const selected = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.SELECT_CONTACT", { contactId: other.userId }),
        },
        second.deps,
      );
      expect(selected.status).toBe("APPLIED");
      const born = selected.snapshot.extended.rimChat;
      expect(born?.id).not.toBe(chat.id);
      expect(born?.selectedContactId).toBe(other.userId);
      expect(born?.messages).toEqual([]);
      expect(born?.relationshipContext?.status).toBe("loading");
      const stale = present(
        (await second.store.loadProductSnapshot(user.userId)).rimProviderRuntime,
      );
      expect(stale.rimChatId).toBe(chat.id);
      expect(stale.initialization).toEqual(runtime.initialization);
      const context = born?.relationshipContext;
      if (!born || !context) {
        throw new Error("new chat missing");
      }
      const ready = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.CONTEXT_READY", {
            rimChatId: born.id,
            selectedContactId: other.userId,
            relationshipContext: CONTEXT_DATA,
            requestId: context.requestId,
          }),
        },
        second.deps,
      );
      expect(ready.status).toBe("APPLIED");
      const tools = probe();
      expect(await recover(second, user, tools)).toBeNull();
      expect(tools.initializes).toHaveLength(1);
      expect(tools.initializes[0]?.rimChatId).toBe(born.id);
      const next = present(
        (await second.store.loadProductSnapshot(user.userId)).rimProviderRuntime,
      );
      expect(next.rimChatId).toBe(born.id);
      expect(next.selectedContactId).toBe(other.userId);
      if (next.initialization.submissionState === "stored") {
        expect(next.initialization.conversationId).toBe(conversation("conv-new-1"));
        expect(next.initialization.conversationId).not.toBe(conversation("conv-old-contact"));
      }
      const repeat = probe();
      expect(await recover(second, user, repeat)).toBeNull();
      expect(repeat.initializes).toHaveLength(0);
    } finally {
      await second.kill();
    }
  });

  function pendingChat(_user: Actor, contact: Actor, text: string): RimChat {
    const chatId = branded<RimChatId>(`pending-${randomUUID()}`);
    const contextId = branded<ContextRequestId>(`pending-ctx-${randomUUID()}`);
    const requestId = branded<AiRequestId>(`ai-${randomUUID()}`);
    return makeChat({
      id: chatId,
      selectedContactId: contact.userId,
      relationshipContext: readyContext(contact.userId, contextId),
      messages: [{ kind: "USER", text }],
      aiOperation: pendingAi({
        userMessage: text,
        rimChatId: chatId,
        requestId,
        contextRequestId: contextId,
      }),
    });
  }
});

function requestOf(chat: RimChat): AiRequestId {
  if (chat.aiOperation.status !== "PENDING" && chat.aiOperation.status !== "FAILED") {
    throw new Error("request id missing");
  }
  return chat.aiOperation.requestId;
}

function authority(
  runtime: RimProviderRuntime,
  attemptId: string,
  continuityMode: RuntimeAttemptAuthority["continuityMode"],
): RuntimeAttemptAuthority {
  return {
    rimChatId: runtime.rimChatId,
    selectedContactId: runtime.selectedContactId,
    contextRequestId: runtime.contextRequestId,
    requestId: runtime.attempt?.requestId ?? "",
    attemptId,
    continuityMode,
  };
}
