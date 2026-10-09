import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTelegramUserId, PostgresIdentityStore } from "@98plus/identity";
import {
  openPostgresPersistence,
  PostgresProductStore,
  type PostgresPersistence,
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
  type ProductSnapshot,
  type RimChat,
  type RimChatId,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  makeChat,
  pendingAi,
  readyContext,
  withChat,
  withControlState,
} from "../../../product-model/src/kernel.fixtures.ts";
import { executeProductEvent } from "../execute.ts";
import { authContext, eventOf } from "../test-harness.ts";
import { reconcileRimInitialization } from "./initialize-rim-conversation.ts";
import { insertPostgresOwnership } from "./ownership-test-seed.ts";
import { recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import { parseRimProviderRuntime } from "./rim-provider-runtime.ts";
import type {
  ProviderConversationId,
  ProviderResponseId,
  RimProviderAttemptId,
  RimProviderRuntime,
} from "./rim-provider-runtime.ts";
import type { RimAiRequest } from "./rim-ai-port.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

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

class ConnectivityLossStore extends PostgresProductStore {
  failRenew = true;
  renewAttempts = 0;

  override async renewRimProviderOwnership(
    input: Parameters<PostgresProductStore["renewRimProviderOwnership"]>[0],
  ): Promise<Awaited<ReturnType<PostgresProductStore["renewRimProviderOwnership"]>>> {
    this.renewAttempts += 1;
    if (this.failRenew) {
      throw new Error("database connectivity lost");
    }
    return super.renewRimProviderOwnership(input);
  }
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ownership recovery does not change the Product engine", () => {
  it("keeps 30 states, 60 events, and 360 matrix rows", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });
});

describe.skipIf(!databaseUrl)("durable ownership recovery on disposable PostgreSQL", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let admin: PostgresPersistence;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    assertSchemaName(schema);
    admin = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_dc02_admin`,
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
  }, 30_000);

  async function openStore(name: string): Promise<{
    db: PostgresPersistence;
    store: PostgresProductStore;
    close(): Promise<void>;
  }> {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    const db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_dc02_${name}`,
    });
    return {
      db,
      store: new PostgresProductStore(db.sql),
      async close() {
        await db.close();
      },
    };
  }

  async function actor(label: string): Promise<{ userId: UserId; telegram: string }> {
    const telegram = `${label}-${randomUUID()}`;
    const user = await new PostgresIdentityStore(admin.sql).resolveByTelegramUserId(
      asTelegramUserId(telegram),
    );
    return { userId: user.userId, telegram };
  }

  async function seed(userId: UserId, snapshot: ProductSnapshot, runtime: RimProviderRuntime) {
    const saved = await PersistenceTestKit.postgres(admin.sql).installFixtureSnapshot(
      userId,
      snapshot,
    );
    return new PostgresProductStore(admin.sql).saveRimProviderRuntime(
      userId,
      saved.revision,
      runtime,
    );
  }

  function deps(store: PostgresProductStore, salt: number) {
    return {
      store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(salt),
    };
  }

  function readyChat(contactId: UserId, text = "сообщение"): RimChat {
    const id = branded<RimChatId>(`own-${randomUUID()}`);
    const contextId = branded<ContextRequestId>(`own-ctx-${randomUUID()}`);
    return makeChat({
      id,
      selectedContactId: contactId,
      relationshipContext: readyContext(contactId, contextId),
      messages: [{ kind: "USER", text }],
    });
  }

  function pendingChat(contactId: UserId, text: string): RimChat {
    const chat = readyChat(contactId, text);
    const contextRequestId = chat.relationshipContext?.requestId;
    if (!contextRequestId) {
      throw new Error("pending chat is missing context");
    }
    const requestId = branded<AiRequestId>(`ai-${randomUUID()}`);
    return makeChat({
      ...chat,
      aiOperation: pendingAi({
        userMessage: text,
        rimChatId: chat.id,
        requestId,
        contextRequestId,
      }),
    });
  }

  function initRuntime(chat: RimChat, state: "not-submitted" | "acceptance-unknown"): RimProviderRuntime {
    if (!chat.selectedContactId || !chat.relationshipContext) {
      throw new Error("chat is incomplete");
    }
    return {
      rimChatId: chat.id,
      selectedContactId: chat.selectedContactId,
      contextRequestId: chat.relationshipContext.requestId,
      initialization: {
        submissionState: state,
        attemptId: attempt("init-1"),
        clientRequestId: "client-init",
      },
      attempt: null,
      continuityMode: "provider-conversation",
      retiredAttemptId: null,
    };
  }

  function userRuntime(
    chat: RimChat,
    submissionState: "not-submitted" | "acceptance-unknown" | "response-id-known",
    responseId?: ProviderResponseId,
  ): RimProviderRuntime {
    if (!chat.selectedContactId || !chat.relationshipContext) {
      throw new Error("chat is incomplete");
    }
    if (chat.aiOperation.status !== "PENDING") {
      throw new Error("pending request required");
    }
    const attemptBase = {
      requestId: chat.aiOperation.requestId,
      attemptId: attempt("attempt-1"),
      clientRequestId: "client-1",
    };
    return {
      rimChatId: chat.id,
      selectedContactId: chat.selectedContactId,
      contextRequestId: chat.relationshipContext.requestId,
      initialization: {
        submissionState: "stored",
        attemptId: attempt("init-stored"),
        conversationId: conversation("conv-stored"),
        clientRequestId: "client-init",
      },
      attempt:
        submissionState === "response-id-known"
          ? {
              ...attemptBase,
              submissionState,
              responseId: responseId ?? response("resp-known"),
            }
          : { ...attemptBase, submissionState },
      continuityMode: "provider-conversation",
      retiredAttemptId: null,
    };
  }

  async function waitForOpenOwnership(userId: UserId) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await admin.sql.query(
        `SELECT 1 FROM rim_provider_ownership WHERE user_id = $1 AND released_at IS NULL`,
        [userId],
      );
      if (rows.rows.length > 0) {
        return;
      }
      await admin.sql.query("SELECT pg_sleep(0.02)", []);
    }
    throw new Error("ownership row did not appear");
  }

  async function expire(userId: UserId, operationKind: "initialization" | "user-attempt") {
    await admin.sql.query(
      `UPDATE rim_provider_ownership
       SET leased_until = clock_timestamp() - INTERVAL '1 second'
       WHERE user_id = $1 AND operation_kind = $2 AND released_at IS NULL`,
      [userId, operationKind],
    );
  }

  function rimTexts(snapshot: ProductSnapshot): string[] {
    return (snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
      message.kind === "RIM" ? [message.text] : [],
    );
  }

  function userTexts(snapshot: ProductSnapshot): string[] {
    return (snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
      message.kind === "USER" ? [message.text] : [],
    );
  }

  it("does not dispatch E-64 when initialization ownership is absent", async () => {
    const user = await actor("absent-user");
    const contact = await actor("absent-contact");
    const chat = readyChat(contact.userId);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "acceptance-unknown"),
    );
    const replica = await openStore("absent");
    try {
      let calls = 0;
      const ended = await reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(replica.store, 11),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            calls += 1;
            return { conversationId: conversation("conv-should-not") };
          },
        },
      });
      expect(ended).toBeNull();
      expect(calls).toBe(0);
      const loaded = await replica.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("RIM.CHAT");
      expect(loaded.snapshot.extended.rimChat?.id).toBe(chat.id);
    } finally {
      await replica.close();
    }
  });

  it("dispatches Class C E-64 after owner-terminated initialization and does not create a conversation", async () => {
    const user = await actor("class-c-init");
    const contact = await actor("class-c-contact");
    const chat = readyChat(contact.userId);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "acceptance-unknown"),
    );
    await insertPostgresOwnership(admin.sql, {
      userId: user.userId,
      operationKind: "initialization",
      attemptId: "init-1",
      requestId: null,
      phase: "owner-terminated",
    });
    const replica = await openStore("class-c-init");
    try {
      let calls = 0;
      const ended = await reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(replica.store, 21),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            calls += 1;
            return { conversationId: conversation("conv-should-not") };
          },
        },
      });
      expect(ended?.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
      expect(calls).toBe(0);
      const loaded = await replica.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(loaded.snapshot.extended.rimChat).toBeNull();
    } finally {
      await replica.close();
    }
  });

  it("installs one Class C local USER successor and does not resubmit the retired conversation", async () => {
    const user = await actor("class-c-user");
    const contact = await actor("class-c-user-contact");
    const chat = pendingChat(contact.userId, "класс c");
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      userRuntime(chat, "acceptance-unknown"),
    );
    await insertPostgresOwnership(admin.sql, {
      userId: user.userId,
      operationKind: "user-attempt",
      attemptId: "attempt-1",
      requestId: chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : null,
      phase: "owner-terminated",
    });
    const replica = await openStore("class-c-user");
    try {
      const seen: RimAiRequest[] = [];
      const ended = await recoverPendingRimAi({
        context: authContext(user.userId, user.telegram),
        deps: deps(replica.store, 31),
        rimAi: {
          async respond(request) {
            seen.push(request);
            return { kind: "MESSAGE", text: "локально" };
          },
        },
        retrieval: null,
      });
      expect(ended?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.continuityMode).toBe("local-canonical-history");
      expect(seen[0] && "conversationId" in seen[0]).toBe(false);
      const loaded = await replica.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot)).toEqual(["локально"]);
      expect(userTexts(loaded.snapshot)).toEqual(["класс c"]);
      const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT") {
        expect(runtime.runtime.retiredAttemptId).toBe(attempt("attempt-1"));
        expect(runtime.runtime.attempt?.attemptId).not.toBe(attempt("attempt-1"));
        expect(runtime.runtime.attempt?.requestId).toBe(
          chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : undefined,
        );
      }
    } finally {
      await replica.close();
    }
  });

  it("lets two replicas race one lapsed initialization and dispatch E-64 once", async () => {
    const user = await actor("race-recover");
    const contact = await actor("race-recover-contact");
    const chat = readyChat(contact.userId);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "acceptance-unknown"),
    );
    await insertPostgresOwnership(admin.sql, {
      userId: user.userId,
      operationKind: "initialization",
      attemptId: "init-1",
      requestId: null,
      phase: "lapsed",
    });
    const left = await openStore("race-left");
    const right = await openStore("race-right");
    try {
      let calls = 0;
      const initializationPort = {
        async initialize() {
          calls += 1;
          return { conversationId: conversation("conv-should-not") };
        },
      };
      const [a, b] = await Promise.all([
        reconcileRimInitialization({
          context: authContext(user.userId, user.telegram),
          deps: deps(left.store, 41),
          rimAi: { async respond() { throw new Error("unused"); } },
          conversation: initializationPort,
        }),
        reconcileRimInitialization({
          context: authContext(user.userId, user.telegram),
          deps: deps(right.store, 42),
          rimAi: { async respond() { throw new Error("unused"); } },
          conversation: initializationPort,
        }),
      ]);
      expect([a?.event.name, b?.event.name].filter((name) => name === "RIM.INITIALIZATION_UNRECOVERABLE")).toHaveLength(1);
      expect(calls).toBe(0);
      const loaded = await left.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.extended.rimChat).toBeNull();
    } finally {
      await left.close();
      await right.close();
    }
  });

  it("recovers a crash before provider submission only after the lease lapses", async () => {
    const user = await actor("crash-before");
    const contact = await actor("crash-before-contact");
    const chat = readyChat(contact.userId);
    const loaded = await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("crash-owner");
    const peer = await openStore("crash-peer");
    try {
      const claimed = initRuntime(chat, "acceptance-unknown");
      const acquired = await owner.store.acquireRimProviderOwnership({
        currentUserId: user.userId,
        expectedRevision: loaded.revision,
        runtime: claimed,
        operationKind: "initialization",
        attemptId: "init-1",
        requestId: null,
        leaseSeconds: 30,
      });
      expect(acquired.status).toBe("ACQUIRED");
      let calls = 0;
      const initializationPort = {
        async initialize() {
          calls += 1;
          return { conversationId: conversation("conv-should-not") };
        },
      };
      const held = await reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(peer.store, 51),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: initializationPort,
      });
      expect(held).toBeNull();
      expect(calls).toBe(0);
      await expire(user.userId, "initialization");
      const ended = await reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(peer.store, 52),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: initializationPort,
      });
      expect(ended?.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
      expect(calls).toBe(0);
    } finally {
      await owner.close();
      await peer.close();
    }
  });

  it("keeps a conversation id that commits before Class U recovery", async () => {
    const user = await actor("before-recovery");
    const contact = await actor("before-recovery-contact");
    const chat = readyChat(contact.userId);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("before-owner");
    const peer = await openStore("before-peer");
    const gate = deferred();
    let calls = 0;
    try {
      const running = reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(owner.store, 61),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            calls += 1;
            await gate.promise;
            return { conversationId: conversation("conv-in-time") };
          },
        },
      });
      await waitForOpenOwnership(user.userId);
      await expire(user.userId, "initialization");
      gate.resolve();
      expect(await running).toBeNull();
      const peerResult = await reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(peer.store, 62),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            calls += 1;
            return { conversationId: conversation("conv-second") };
          },
        },
      });
      expect(peerResult).toBeNull();
      expect(calls).toBe(1);
      const loaded = await peer.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.extended.rimChat?.id).toBe(chat.id);
      const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT" && runtime.runtime.initialization.submissionState === "stored") {
        expect(runtime.runtime.initialization.conversationId).toBe(conversation("conv-in-time"));
      } else {
        throw new Error("expected the conversation id that won the recovery race");
      }
    } finally {
      gate.resolve();
      await owner.close();
      await peer.close();
    }
  });

  it("rejects renewal after expiry and still lets recovery win the race", async () => {
    const user = await actor("heartbeat-race");
    const contact = await actor("heartbeat-race-contact");
    const chat = readyChat(contact.userId);
    const loaded = await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("hb-owner");
    const peer = await openStore("hb-peer");
    try {
      const acquired = await owner.store.acquireRimProviderOwnership({
        currentUserId: user.userId,
        expectedRevision: loaded.revision,
        runtime: initRuntime(chat, "acceptance-unknown"),
        operationKind: "initialization",
        attemptId: "init-1",
        requestId: null,
        leaseSeconds: 30,
      });
      if (acquired.status !== "ACQUIRED") {
        throw new Error("expected the crash owner");
      }
      await expire(user.userId, "initialization");
      const [renewed, ended] = await Promise.all([
        owner.store.renewRimProviderOwnership({
          currentUserId: user.userId,
          operationKind: "initialization",
          attemptId: "init-1",
          ownerToken: acquired.ownership.ownerToken,
          leaseSeconds: 30,
        }),
        reconcileRimInitialization({
          context: authContext(user.userId, user.telegram),
          deps: deps(peer.store, 71),
          rimAi: { async respond() { throw new Error("unused"); } },
          conversation: {
            async initialize() {
              throw new Error("recovery must not initialize");
            },
          },
        }),
      ]);
      expect(renewed.status).toBe("REJECTED");
      if (renewed.status === "REJECTED") {
        expect(renewed.reason).toBe("EXPIRED");
      }
      expect(ended?.event.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
    } finally {
      await owner.close();
      await peer.close();
    }
  });

  it("renews the lease during a slow provider call without a Product revision bump", async () => {
    const user = await actor("heartbeat");
    const contact = await actor("heartbeat-contact");
    const chat = readyChat(contact.userId);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("hb-slow");
    const gate = deferred();
    try {
      const before = await owner.store.loadProductSnapshot(user.userId);
      const running = reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(owner.store, 81),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            await gate.promise;
            return { conversationId: conversation("conv-slow") };
          },
        },
      });
      await waitForOpenOwnership(user.userId);
      const first = await admin.sql.query<{ leased_until: Date }>(
        `SELECT leased_until FROM rim_provider_ownership
         WHERE user_id = $1 AND operation_kind = 'initialization'`,
        [user.userId],
      );
      await admin.sql.query("SELECT pg_sleep(11)", []);
      const second = await admin.sql.query<{ leased_until: Date }>(
        `SELECT leased_until FROM rim_provider_ownership
         WHERE user_id = $1 AND operation_kind = 'initialization'`,
        [user.userId],
      );
      const during = await owner.store.loadProductSnapshot(user.userId);
      expect(during.revision).toBe(before.revision + 1);
      expect(new Date(second.rows[0]?.leased_until ?? 0).getTime()).toBeGreaterThan(
        new Date(first.rows[0]?.leased_until ?? 0).getTime(),
      );
      gate.resolve();
      expect(await running).toBeNull();
      const after = await owner.store.loadProductSnapshot(user.userId);
      expect(after.revision).toBe(during.revision + 1);
      const runtime = parseRimProviderRuntime(after.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT" && runtime.runtime.initialization.submissionState === "stored") {
        expect(runtime.runtime.initialization.conversationId).toBe(conversation("conv-slow"));
      }
    } finally {
      gate.resolve();
      await owner.close();
    }
  }, 25_000);

  it("keeps exclusive ownership when heartbeat renewal loses database connectivity", async () => {
    const user = await actor("heartbeat-down");
    const contact = await actor("heartbeat-down-contact");
    const chat = readyChat(contact.userId);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("hb-down-owner");
    const peer = await openStore("hb-down-peer");
    const flaky = new ConnectivityLossStore(owner.db.sql);
    const gate = deferred();
    let initializes = 0;
    try {
      const running = reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(flaky, 82),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            initializes += 1;
            await gate.promise;
            return { conversationId: conversation("conv-after-outage") };
          },
        },
      });
      await waitForOpenOwnership(user.userId);
      const before = await admin.sql.query<{ leased_until: Date; owner_token: string }>(
        `SELECT leased_until, owner_token::text AS owner_token
         FROM rim_provider_ownership WHERE user_id = $1`,
        [user.userId],
      );
      await admin.sql.query("SELECT pg_sleep(11)", []);
      expect(flaky.renewAttempts).toBeGreaterThan(0);
      const during = await admin.sql.query<{
        leased_until: Date;
        owner_token: string;
        release_reason: string | null;
      }>(
        `SELECT leased_until, owner_token::text AS owner_token, release_reason
         FROM rim_provider_ownership WHERE user_id = $1`,
        [user.userId],
      );
      expect(during.rows[0]?.owner_token).toBe(before.rows[0]?.owner_token);
      expect(new Date(during.rows[0]?.leased_until ?? 0).getTime()).toBe(
        new Date(before.rows[0]?.leased_until ?? 0).getTime(),
      );
      expect(during.rows[0]?.release_reason).toBeNull();
      const peerResult = await reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(peer.store, 83),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            throw new Error("peer must not initialize during a connectivity loss");
          },
        },
      });
      expect(peerResult).toBeNull();
      expect(initializes).toBe(1);
      flaky.failRenew = false;
      gate.resolve();
      expect(await running).toBeNull();
      const after = await owner.store.loadProductSnapshot(user.userId);
      const runtime = parseRimProviderRuntime(after.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT" && runtime.runtime.initialization.submissionState === "stored") {
        expect(runtime.runtime.initialization.conversationId).toBe(conversation("conv-after-outage"));
      }
      const released = await admin.sql.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM rim_provider_ownership WHERE user_id = $1`,
        [user.userId],
      );
      expect(released.rows[0]?.release_reason).toBe("completed");
    } finally {
      gate.resolve();
      await owner.close();
      await peer.close();
    }
  }, 25_000);

  it("discards a late initialization after E-50 and does not revive the chat", async () => {
    const user = await actor("e50-user");
    const contact = await actor("e50-contact");
    const chat = readyChat(contact.userId, "назад");
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("e50-owner");
    const peer = await openStore("e50-peer");
    const gate = deferred();
    try {
      const running = reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(owner.store, 91),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            await gate.promise;
            return { conversationId: conversation("conv-late-back") };
          },
        },
      });
      await waitForOpenOwnership(user.userId);
      const closed = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.PRESS_BACK"),
        },
        deps(peer.store, 92),
      );
      expect(closed.event.name).toBe("RIM.PRESS_BACK");
      expect(closed.persisted).toBe(true);
      gate.resolve();
      expect(await running).toBeNull();
      const loaded = await peer.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.extended.rimChat).toBeNull();
      expect(loaded.snapshot.controlState).not.toBe("RIM.CHAT");
      const ownership = await admin.sql.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM rim_provider_ownership WHERE user_id = $1`,
        [user.userId],
      );
      expect(ownership.rows[0]?.release_reason).toBe("chat-abandoned");
    } finally {
      gate.resolve();
      await owner.close();
      await peer.close();
    }
  });

  it("discards a late initialization after an E-49 contact change", async () => {
    const user = await actor("e49-user");
    const contact = await actor("e49-contact");
    const other = await actor("e49-other");
    const chat = readyChat(contact.userId, "контакт");
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      initRuntime(chat, "not-submitted"),
    );
    const owner = await openStore("e49-owner");
    const peer = await openStore("e49-peer");
    const gate = deferred();
    let running: Promise<unknown> | undefined;
    try {
      running = reconcileRimInitialization({
        context: authContext(user.userId, user.telegram),
        deps: deps(owner.store, 101),
        rimAi: { async respond() { throw new Error("unused"); } },
        conversation: {
          async initialize() {
            await gate.promise;
            return { conversationId: conversation("conv-old-contact") };
          },
        },
      });
      await waitForOpenOwnership(user.userId);
      const selector = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.PRESS_SELECT_CONTACT"),
        },
        deps(peer.store, 102),
      );
      expect(selector.persisted).toBe(true);
      expect(selector.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      const selected = await executeProductEvent(
        {
          context: authContext(user.userId, user.telegram),
          event: eventOf("RIM.SELECT_CONTACT", { contactId: other.userId }),
        },
        deps(peer.store, 103),
      );
      expect(selected.persisted).toBe(true);
      expect(selected.snapshot.extended.rimChat?.id).not.toBe(chat.id);
      gate.resolve();
      expect(await running).toBeNull();
      const loaded = await peer.store.loadProductSnapshot(user.userId);
      expect(loaded.snapshot.extended.rimChat?.id).not.toBe(chat.id);
      const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
      if (runtime.status === "PRESENT" && runtime.runtime.initialization.submissionState === "stored") {
        expect(runtime.runtime.initialization.conversationId).not.toBe(conversation("conv-old-contact"));
      }
    } finally {
      gate.resolve();
      await running?.catch(() => undefined);
      await owner.close();
      await peer.close();
    }
  });

  it("retrieves one known response id and commits one Product result", async () => {
    const user = await actor("known-response");
    const contact = await actor("known-response-contact");
    const chat = pendingChat(contact.userId, "известный");
    const responseId = response(`resp-${randomUUID()}`);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      userRuntime(chat, "response-id-known", responseId),
    );
    const left = await openStore("known-a");
    const right = await openStore("known-b");
    try {
      let retrieves = 0;
      const retrieval = {
        async retrieve(id: ProviderResponseId) {
          retrieves += 1;
          return {
            responseId: id,
            providerStatus: "completed" as const,
            output: { kind: "MESSAGE" as const, text: "извлечено" },
          };
        },
      };
      let responds = 0;
      const rimAi = {
        async respond() {
          responds += 1;
          return { kind: "MESSAGE" as const, text: "нельзя" };
        },
      };
      const [a, b] = await Promise.all([
        recoverPendingRimAi({
          context: authContext(user.userId, user.telegram),
          deps: deps(left.store, 111),
          rimAi,
          retrieval,
        }),
        recoverPendingRimAi({
          context: authContext(user.userId, user.telegram),
          deps: deps(right.store, 112),
          rimAi,
          retrieval,
        }),
      ]);
      expect([a, b].filter((item) => item?.status === "APPLIED")).toHaveLength(1);
      expect(responds).toBe(0);
      const loaded = await left.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot)).toEqual(["извлечено"]);
      expect(userTexts(loaded.snapshot)).toEqual(["известный"]);
      expect(retrieves).toBeGreaterThan(0);
    } finally {
      await left.close();
      await right.close();
    }
  });

  it("retries a retrieved terminal failure once through E-54 without a second conversation", async () => {
    const user = await actor("e54-user");
    const contact = await actor("e54-contact");
    const chat = pendingChat(contact.userId, "повтор");
    const responseId = response(`resp-${randomUUID()}`);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      userRuntime(chat, "response-id-known", responseId),
    );
    const store = await openStore("e54");
    try {
      const context = authContext(user.userId, user.telegram);
      const failed = await recoverPendingRimAi({
        context,
        deps: deps(store.store, 121),
        rimAi: { async respond() { throw new Error("unused"); } },
        retrieval: {
          async retrieve(id) {
            return { responseId: id, providerStatus: "failed", output: null };
          },
        },
      });
      expect(failed?.event.name).toBe("RIM.AI_REQUEST_FAILED");
      const requestId = chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : null;
      if (!requestId) {
        throw new Error("missing request");
      }
      const retried = await executeProductEvent(
        { context, event: eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: requestId }) },
        deps(store.store, 122),
      );
      expect(retried.event.name).toBe("RIM.PRESS_RETRY_AI");
      expect(retried.persisted).toBe(true);
      const seen: RimAiRequest[] = [];
      const followed = await recoverPendingRimAi({
        context,
        deps: deps(store.store, 123),
        rimAi: {
          async respond(request) {
            seen.push(request);
            return { kind: "MESSAGE", text: "после e54" };
          },
        },
        retrieval: null,
      });
      expect(followed?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.continuityMode).toBe("local-canonical-history");
      expect(seen[0] && "conversationId" in seen[0]).toBe(false);
      const loaded = await store.store.loadProductSnapshot(user.userId);
      expect(rimTexts(loaded.snapshot)).toEqual(["после e54"]);
      expect(userTexts(loaded.snapshot)).toEqual(["повтор"]);
    } finally {
      await store.close();
    }
  });
});
