import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTelegramUserId, PostgresIdentityStore } from "@98plus/identity";
import {
  asInstant,
  CANONICAL_EVENT_COUNT,
  CANONICAL_EVENT_DEFINITIONS,
  counterAllocator,
  emptySnapshot,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  reduce,
  type CanonicalEvent,
  type ExecutionProbability,
  type Failure,
  type ProductSnapshot,
  type UserId,
} from "@98plus/product-model";
import {
  eventOf,
  makeBan,
  statusItem,
  withControlState,
  CONTEXT_DATA,
} from "../../product-model/src/kernel.fixtures.ts";
import { baselineFromLoadedSnapshot } from "./hybrid-persist.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { projectRimHistory } from "./rim-history.ts";
import { SQL } from "./sql.ts";
import {
  assertConnectedTestDatabase,
  assertMvp17TestSchemaName,
  assertSafeMvp17TestDatabaseUrl,
} from "./test-database-guard.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import type { LoadedSnapshot } from "./types.ts";

const rawDatabaseUrl = process.env.MVP17_TEST_DATABASE_URL;
if (rawDatabaseUrl !== undefined && rawDatabaseUrl.trim().length > 0) {
  assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
}

type HistoryMessage = {
  message_key: string;
  ordinal: number;
  kind: string;
  payload: { text?: string; message?: string; proposals?: readonly { proposalId: string }[] };
  source_ai_request_id: string | null;
  source_context_request_id: string | null;
};

type HistoryChat = {
  rim_chat_id: string;
  termination_reason: string | null;
  resulting_ban_id: string | null;
  openai_conversation_id: string | null;
  terminated: boolean;
};

describe.skipIf(!rawDatabaseUrl)("disposable PostgreSQL RIM history", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;
  let nextAllocation = 1_000;

  function freshAllocator(): ReturnType<typeof counterAllocator> {
    const start = nextAllocation;
    nextAllocation += 1_000;
    return counterAllocator(start);
  }

  beforeAll(async () => {
    const safe = assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
    assertMvp17TestSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: safe.connectionString,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    await assertConnectedTestDatabase((sql, params) => db.sql.query(sql, params ?? []), safe);
    await db.sql.query(`CREATE SCHEMA ${schema}`, []);
    await db.sql.query(`SET search_path TO ${schema}`, []);
    const report = await db.migrate();
    expect(report.applied).toHaveLength(12);
    expect(report.applied[9]).toBe("packages/persistence/schema/010_rim_history.sql");
    expect(report.applied[10]).toBe("packages/persistence/schema/011_rim_provider_ownership.sql");
    expect(report.applied[11]).toBe("packages/persistence/schema/012_telegram_ban_message.sql");
  }, 30_000);

  afterAll(async () => {
    if (!db) {
      return;
    }
    assertMvp17TestSchemaName(schema);
    await db.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await db.close();
  });

  async function identity(label: string): Promise<UserId> {
    const store = new PostgresIdentityStore(db.sql);
    const user = await store.resolveByTelegramUserId(asTelegramUserId(`${label}-${randomUUID()}`));
    return user.userId;
  }

  async function messages(rimChatId: string): Promise<HistoryMessage[]> {
    const result = await db.sql.query<HistoryMessage>(
      `SELECT message_key, ordinal, kind, payload, source_ai_request_id, source_context_request_id
       FROM rim_messages WHERE rim_chat_id = $1 ORDER BY ordinal`,
      [rimChatId],
    );
    return [...result.rows];
  }

  async function chats(ownerUserId: UserId): Promise<HistoryChat[]> {
    const result = await db.sql.query<HistoryChat>(
      `SELECT rim_chat_id, termination_reason, resulting_ban_id, openai_conversation_id,
              terminated_at IS NOT NULL AS terminated
       FROM rim_chats WHERE owner_user_id = $1 ORDER BY created_at, rim_chat_id`,
      [ownerUserId],
    );
    return [...result.rows];
  }

  function committer(allocateId: ReturnType<typeof counterAllocator>) {
    const store = new PostgresProductStore(db.sql);
    return {
      store,
      async apply(userId: UserId, loaded: LoadedSnapshot, event: CanonicalEvent) {
        const transition = reduce(loaded.snapshot, event, {
          now: asInstant(1_700_000_000_000),
          currentUserId: userId,
          allocateId,
        });
        if (transition.outcome !== "APPLIED") {
          throw new Error(`${event.name} was ${transition.outcome}`);
        }
        const definition = CANONICAL_EVENT_DEFINITIONS.find((item) => item.name === event.name);
        const trace = [...transition.traces]
          .reverse()
          .find((item) => item.eventId === definition?.id);
        if (!definition || !trace) {
          throw new Error(`${event.name} has no applied trace`);
        }
        return store.persistTransition({
          currentUserId: userId,
          expectedRevision: loaded.revision,
          result: transition,
          appliedRule: { eventId: definition.id, branch: trace.branch },
          baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
        });
      },
    };
  }

  async function openChat(owner: UserId, contact: UserId) {
    const kit = PersistenceTestKit.postgres(db.sql);
    const { apply, store } = committer(freshAllocator());
    let loaded = await kit.installFixtureSnapshot(
      owner,
      withControlState(emptySnapshot(), "RIM.LOBBY"),
    );
    loaded = await apply(owner, loaded, eventOf("RIM.PRESS_START_CHAT", {}));
    loaded = await apply(owner, loaded, eventOf("RIM.PRESS_SELECT_CONTACT", {}));
    loaded = await apply(owner, loaded, eventOf("RIM.SELECT_CONTACT", { contactId: contact }));
    const chat = loaded.snapshot.extended.rimChat;
    if (!chat?.relationshipContext) {
      throw new Error("selected contact did not create a RimChat");
    }
    return { store, apply, loaded, chat };
  }

  it("keeps the Product Engine freeze at 30 / 60 / 360", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });

  it("applies migration 010 from the canonical chain", async () => {
    const versions = await db.sql.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at, version",
      [],
    );
    expect(versions.rows.map((row) => row.version)).toHaveLength(12);
    const tables = await db.sql.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name IN ('rim_chats', 'rim_messages')
       ORDER BY table_name`,
      [],
    );
    expect(tables.rows.map((row) => row.name)).toEqual(["rim_chats", "rim_messages"]);
  });

  it("archives one chat, the prompt, a USER message, and one MESSAGE reply", async () => {
    const owner = await identity("owner");
    const contact = await identity("contact");
    const { apply, loaded: opened, chat } = await openChat(owner, contact);
    const ready = await apply(
      owner,
      opened,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "hello" }),
    );
    const sent = await apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("send did not open a pending AI request");
    }
    const beforeReply = sent.snapshot;
    const answered = await apply(
      owner,
      sent,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: chat.id,
        requestId: pending.requestId,
        result: { kind: "MESSAGE", text: "a reply" },
      }),
    );
    const rows = await messages(chat.id);
    expect(rows.map((row) => row.kind)).toEqual(["RIM", "USER", "RIM"]);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(rows[0]?.source_context_request_id).toBe(chat.relationshipContext?.requestId);
    expect(rows[1]?.source_ai_request_id).toBe(pending.requestId);
    expect(rows[2]?.message_key).toBe(`${chat.id}:${pending.requestId}:reply`);
    expect(rows[2]?.payload.text).toBe("a reply");
    expect(JSON.stringify(rows)).not.toContain("aggregates");
    const archived = await chats(owner);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.terminated).toBe(false);
    await db.sql.transaction(async (tx) => {
      await projectRimHistory(tx, {
        ownerUserId: owner,
        previousLive: beforeReply.extended.rimChat,
        previousFrozen: beforeReply.extended.savedFrozenRimChat,
        nextLive: answered.snapshot.extended.rimChat,
        nextFrozen: answered.snapshot.extended.savedFrozenRimChat,
        bans: answered.snapshot.extended.entities.bans,
        createdBanIds: new Set<string>(),
        appliedRule: { eventId: "E-58", branch: "current-request" },
      });
    });
    expect(await messages(chat.id)).toHaveLength(3);
  });

  it("archives BAN_PROPOSALS once and does not duplicate a retry or a failure", async () => {
    const owner = await identity("proposal-owner");
    const contact = await identity("proposal-contact");
    const { apply, store, loaded: opened, chat } = await openChat(owner, contact);
    const ready = await apply(
      owner,
      opened,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "suggest" }),
    );
    const sent = await apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("send did not open a pending AI request");
    }
    const proposed = await apply(
      owner,
      sent,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: chat.id,
        requestId: pending.requestId,
        result: {
          kind: "BAN_PROPOSALS",
          message: "three bans",
          proposals: [
            { banText: "no phones", executionProbability: 0.2 as ExecutionProbability },
            { banText: "no meetings", executionProbability: 0.5 as ExecutionProbability },
            { banText: "no mail", executionProbability: 0.9 as ExecutionProbability },
          ],
        },
      }),
    );
    const proposalRows = await messages(chat.id);
    const proposals = proposalRows.at(-1);
    expect(proposals?.kind).toBe("BAN_PROPOSALS");
    expect(proposals?.payload.proposals).toHaveLength(3);
    expect(proposals?.message_key).toBe(`${chat.id}:${pending.requestId}:reply`);
    const failedSend = await apply(
      owner,
      await apply(owner, proposed, eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "again" })),
      eventOf("RIM.PRESS_SEND", {}),
    );
    const second = failedSend.snapshot.extended.rimChat?.aiOperation;
    if (second?.status !== "PENDING") {
      throw new Error("second send did not open a pending AI request");
    }
    const failed = await apply(
      owner,
      failedSend,
      eventOf("RIM.AI_REQUEST_FAILED", {
        rimChatId: chat.id,
        requestId: second.requestId,
        failure: {} as Failure,
      }),
    );
    const retried = await apply(
      owner,
      failed,
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: second.requestId }),
    );
    const afterRetry = await messages(chat.id);
    expect(afterRetry.filter((row) => row.kind === "USER")).toHaveLength(2);
    expect(afterRetry.filter((row) => row.message_key.endsWith(":reply"))).toHaveLength(1);
    expect(retried.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    const stale = reduce(
      retried.snapshot,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: chat.id,
        requestId: pending.requestId,
        result: { kind: "MESSAGE", text: "stale" },
      }),
      {
        now: asInstant(1_700_000_000_000),
        currentUserId: owner,
        allocateId: counterAllocator(),
      },
    );
    expect(stale.outcome).toBe("APPLIED");
    expect(stale.result).toBe("IGNORE_NOT_ALLOWED");
    const staleTrace = stale.traces.find((item) => item.eventId === "E-58");
    if (!staleTrace) {
      throw new Error("stale E-58 trace missing");
    }
    await store.persistTransition({
      currentUserId: owner,
      expectedRevision: retried.revision,
      result: stale,
      appliedRule: { eventId: "E-58", branch: staleTrace.branch },
      baseline: baselineFromLoadedSnapshot(retried.snapshot, retried.revision),
    });
    expect(await messages(chat.id)).toHaveLength(afterRetry.length);
    expect((await messages(chat.id)).some((row) => row.payload.text === "stale")).toBe(false);
  });

  it("keeps one chat for the same contact and archives the previous chat on a switch", async () => {
    const owner = await identity("switch-owner");
    const first = await identity("switch-a");
    const second = await identity("switch-b");
    const { apply, loaded, chat } = await openChat(owner, first);
    const selecting = await apply(owner, loaded, eventOf("RIM.PRESS_SELECT_CONTACT", {}));
    const same = await apply(owner, selecting, eventOf("RIM.SELECT_CONTACT", { contactId: first }));
    expect(same.snapshot.extended.rimChat?.id).toBe(chat.id);
    expect(await chats(owner)).toHaveLength(1);
    const again = await apply(owner, same, eventOf("RIM.PRESS_SELECT_CONTACT", {}));
    const changed = await apply(owner, again, eventOf("RIM.SELECT_CONTACT", { contactId: second }));
    const archived = await chats(owner);
    expect(archived).toHaveLength(2);
    expect(archived.find((row) => row.rim_chat_id === chat.id)?.termination_reason).toBe(
      "contact_changed",
    );
    expect(changed.snapshot.extended.rimChat?.id).not.toBe(chat.id);
    expect(await messages(chat.id)).toHaveLength(0);
  });

  it("does not duplicate messages on Create Ban back and links the Ban on success", async () => {
    const owner = await identity("ban-owner");
    const contact = await identity("ban-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "ban" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("send did not open a pending AI request");
    }
    const proposed = await opened.apply(
      owner,
      sent,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: opened.chat.id,
        requestId: pending.requestId,
        result: {
          kind: "BAN_PROPOSALS",
          message: "three bans",
          proposals: [
            { banText: "no phones", executionProbability: 0.2 as ExecutionProbability },
            { banText: "no meetings", executionProbability: 0.5 as ExecutionProbability },
            { banText: "no mail", executionProbability: 0.9 as ExecutionProbability },
          ],
        },
      }),
    );
    const proposalId = proposed.snapshot.extended.rimChat?.messages.find(
      (message) => message.kind === "BAN_PROPOSALS",
    )?.proposals[0]?.proposalId;
    if (!proposalId) {
      throw new Error("proposal was not minted");
    }
    const before = (await messages(opened.chat.id)).length;
    const frozen = await opened.apply(
      owner,
      proposed,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", { rimChatId: opened.chat.id, proposalId }),
    );
    expect((await chats(owner))[0]?.terminated).toBe(false);
    const timed = await opened.apply(
      owner,
      frozen,
      eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 5 }),
    );
    const restored = await opened.apply(owner, timed, eventOf("CREATE_BAN.PRESS_BACK", {}));
    expect(await messages(opened.chat.id)).toHaveLength(before);
    expect((await chats(owner))[0]?.terminated).toBe(false);
    expect(restored.snapshot.extended.rimChat?.id).toBe(opened.chat.id);
    const forbid = await opened.apply(
      owner,
      await opened.apply(
        owner,
        await opened.apply(
          owner,
          restored,
          eventOf("RIM.PRESS_SUGGESTION_FORBID", { rimChatId: opened.chat.id, proposalId }),
        ),
        eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 5 }),
      ),
      eventOf("CREATE_BAN.PRESS_NEXT", {}),
    );
    const started = await opened.apply(owner, forbid, eventOf("CREATE_BAN.PRESS_FORBID", {}));
    const operation = Object.values(started.snapshot.runtime.pendingOperations)[0];
    if (!operation) {
      throw new Error("Create Ban did not start a send");
    }
    const succeeded = await opened.apply(
      owner,
      started,
      eventOf("CREATE_BAN.SEND_CONFIRMED", {
        operationId: operation.operationId,
        createdBanId: `ban-${randomUUID()}` as never,
      }),
    );
    const archived = await chats(owner);
    expect(archived[0]?.termination_reason).toBe("create_ban_success");
    expect(archived[0]?.resulting_ban_id).toBe(succeeded.snapshot.extended.successfulBanId);
    expect(await messages(opened.chat.id)).toHaveLength(before);
    expect(succeeded.snapshot.extended.rimChat).toBeNull();
    const closing = started.snapshot.extended.rimChat;
    const realBanId = succeeded.snapshot.extended.successfulBanId;
    const realBan = realBanId ? succeeded.snapshot.extended.entities.bans[realBanId] : undefined;
    if (!closing || !realBanId || !realBan) {
      throw new Error("Create Ban did not close the archived chat");
    }
    await db.sql.transaction(async (tx) => {
      await projectRimHistory(tx, {
        ownerUserId: owner,
        previousLive: closing,
        previousFrozen: started.snapshot.extended.savedFrozenRimChat,
        nextLive: null,
        nextFrozen: null,
        bans: succeeded.snapshot.extended.entities.bans,
        createdBanIds: new Set([realBanId]),
        appliedRule: { eventId: "E-10", branch: "confirm-rim" },
      });
    });
    expect((await chats(owner))[0]?.resulting_ban_id).toBe(realBanId);
    const otherId = `ban-${randomUUID()}`;
    await expect(
      db.sql.transaction(async (tx) => {
        await projectRimHistory(tx, {
          ownerUserId: owner,
          previousLive: closing,
          previousFrozen: started.snapshot.extended.savedFrozenRimChat,
          nextLive: null,
          nextFrozen: null,
          bans: { [otherId]: { ...realBan, id: otherId as never, sourceProposalId: null } },
          createdBanIds: new Set([otherId]),
          appliedRule: { eventId: "E-10", branch: "confirm-rim" },
        });
      }),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM chat archive termination conflict",
    });
    expect((await chats(owner))[0]?.resulting_ban_id).toBe(realBanId);
    expect(await messages(opened.chat.id)).toHaveLength(before);
  });

  it("retains history on full close and does not invent a reply when initialization fails", async () => {
    const owner = await identity("close-owner");
    const contact = await identity("close-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "stay" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const closed = await opened.apply(owner, sent, eventOf("APP.FULL_CLOSE", {}));
    expect(closed.snapshot.extended.rimChat).toBeNull();
    const archived = await chats(owner);
    expect(archived[0]?.termination_reason).toBe("full_close");
    expect((await messages(opened.chat.id)).map((row) => row.kind)).toEqual(["RIM", "USER"]);

    const failedOwner = await identity("init-owner");
    const failedContact = await identity("init-contact");
    const fresh = await openChat(failedOwner, failedContact);
    const cleared = await fresh.apply(
      failedOwner,
      fresh.loaded,
      eventOf("RIM.INITIALIZATION_UNRECOVERABLE", {
        rimChatId: fresh.chat.id,
        selectedContactId: failedContact,
        contextRequestId: fresh.chat.relationshipContext!.requestId,
      }),
    );
    expect(cleared.snapshot.extended.rimChat).toBeNull();
    expect((await chats(failedOwner))[0]?.termination_reason).toBe("initialization_unrecoverable");
    expect(await messages(fresh.chat.id)).toHaveLength(0);
  });

  it("keeps the accepted USER message across a new store and archives the later reply once", async () => {
    const owner = await identity("restart-owner");
    const contact = await identity("restart-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "persist" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("send did not open a pending AI request");
    }
    const restarted = new PostgresProductStore(db.sql);
    const loaded = await restarted.loadProductSnapshot(owner);
    const transition = reduce(
      loaded.snapshot,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: opened.chat.id,
        requestId: pending.requestId,
        result: { kind: "MESSAGE", text: "after restart" },
      }),
      {
        now: asInstant(1_700_000_000_000),
        currentUserId: owner,
        allocateId: counterAllocator(),
      },
    );
    expect(transition.outcome).toBe("APPLIED");
    const trace = transition.traces.find((item) => item.eventId === "E-58");
    if (!trace) {
      throw new Error("E-58 trace missing");
    }
    await restarted.persistTransition({
      currentUserId: owner,
      expectedRevision: loaded.revision,
      result: transition,
      appliedRule: { eventId: "E-58", branch: trace.branch },
      baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
    });
    const rows = await messages(opened.chat.id);
    expect(rows.map((row) => row.payload.text ?? row.payload.message)).toEqual([
      rows[0]?.payload.text,
      "persist",
      "after restart",
    ]);
    expect(rows.filter((row) => row.message_key.endsWith(":reply"))).toHaveLength(1);
  });

  it("rolls back history with the Product transaction and rejects a conflicting payload", async () => {
    const owner = await identity("rollback-owner");
    const contact = await identity("rollback-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "rollback" }),
    );
    opened.store.failNextWriteAfterBans();
    await expect(opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}))).rejects.toMatchObject(
      {
        code: "TRANSACTION_FAILED",
      },
    );
    const rolled = await opened.store.loadProductSnapshot(owner);
    expect(rolled.revision).toBe(drafted.revision);
    expect(await messages(opened.chat.id)).toHaveLength(1);

    const transition = reduce(drafted.snapshot, eventOf("RIM.PRESS_SEND", {}), {
      now: asInstant(1_700_000_000_000),
      currentUserId: owner,
      allocateId: counterAllocator(50),
    });
    const operation = transition.snapshot.extended.rimChat?.aiOperation;
    if (transition.outcome !== "APPLIED" || operation?.status !== "PENDING") {
      throw new Error("conflict setup did not apply the send");
    }
    await db.sql.query(SQL.insertRimMessage, [
      `${opened.chat.id}:${operation.requestId}:user`,
      opened.chat.id,
      9,
      "USER",
      JSON.stringify({ text: "different" }),
      operation.requestId,
      null,
    ]);
    const trace = transition.traces.find((item) => item.eventId === "E-52");
    if (!trace) {
      throw new Error("E-52 trace missing");
    }
    await expect(
      opened.store.persistTransition({
        currentUserId: owner,
        expectedRevision: drafted.revision,
        result: transition,
        appliedRule: { eventId: "E-52", branch: trace.branch },
        baseline: baselineFromLoadedSnapshot(drafted.snapshot, drafted.revision),
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const kept = await opened.store.loadProductSnapshot(owner);
    expect(kept.revision).toBe(drafted.revision);
    const rows = await messages(opened.chat.id);
    expect(rows.some((row) => row.payload.text === "different")).toBe(true);
    expect(rows.some((row) => row.payload.text === "rollback")).toBe(false);
  });

  it("stores the OpenAI conversation id in the same runtime transaction", async () => {
    const owner = await identity("openai-owner");
    const contact = await identity("openai-contact");
    const opened = await openChat(owner, contact);
    const stored = await opened.store.saveRimProviderRuntime(owner, opened.loaded.revision, {
      rimChatId: opened.chat.id,
      selectedContactId: contact,
      contextRequestId: opened.chat.relationshipContext?.requestId,
      initialization: {
        submissionState: "stored",
        attemptId: "init-1",
        conversationId: "conv-1",
        clientRequestId: null,
      },
      attempt: null,
      continuityMode: "provider-conversation",
      retiredAttemptId: null,
    });
    expect((await chats(owner))[0]?.openai_conversation_id).toBe("conv-1");
    await expect(
      opened.store.saveRimProviderRuntime(owner, stored.revision, {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        contextRequestId: opened.chat.relationshipContext?.requestId,
        initialization: {
          submissionState: "stored",
          attemptId: "init-2",
          conversationId: "conv-2",
          clientRequestId: null,
        },
        attempt: null,
        continuityMode: "provider-conversation",
        retiredAttemptId: null,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const loaded = await opened.store.loadProductSnapshot(owner);
    expect(loaded.revision).toBe(stored.revision);
    expect((await chats(owner))[0]?.openai_conversation_id).toBe("conv-1");
  });

  it("lets one revision win and archives only that commit", async () => {
    const owner = await identity("race-owner");
    const contact = await identity("race-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "race" }),
    );
    const send = reduce(drafted.snapshot, eventOf("RIM.PRESS_SEND", {}), {
      now: asInstant(1_700_000_000_000),
      currentUserId: owner,
      allocateId: counterAllocator(80),
    });
    const other = reduce(
      drafted.snapshot,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "other" }),
      {
        now: asInstant(1_700_000_000_000),
        currentUserId: owner,
        allocateId: counterAllocator(90),
      },
    );
    expect(send.outcome).toBe("APPLIED");
    expect(other.outcome).toBe("APPLIED");
    const sendTrace = send.traces.find((item) => item.eventId === "E-52");
    const otherTrace = other.traces.find((item) => item.eventId === "E-51");
    if (!sendTrace || !otherTrace) {
      throw new Error("race traces missing");
    }
    const second = new PostgresProductStore(db.sql);
    const raced = await Promise.allSettled([
      opened.store.persistTransition({
        currentUserId: owner,
        expectedRevision: drafted.revision,
        result: send,
        appliedRule: { eventId: "E-52", branch: sendTrace.branch },
        baseline: baselineFromLoadedSnapshot(drafted.snapshot, drafted.revision),
      }),
      second.persistTransition({
        currentUserId: owner,
        expectedRevision: drafted.revision,
        result: other,
        appliedRule: { eventId: "E-51", branch: otherTrace.branch },
        baseline: baselineFromLoadedSnapshot(drafted.snapshot, drafted.revision),
      }),
    ]);
    expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1);
    const loaded = await opened.store.loadProductSnapshot(owner);
    const rows = await messages(opened.chat.id);
    const userRows = rows.filter((row) => row.kind === "USER");
    expect(userRows).toHaveLength(
      loaded.snapshot.extended.rimChat?.messages.some((message) => message.kind === "USER") ? 1 : 0,
    );
  });

  it("replaces an empty chat from Ask RIM and keeps the previous chat row", async () => {
    const owner = await identity("ask-owner");
    const contact = await identity("ask-contact");
    const opened = await openChat(owner, contact);
    const banId = `ban-${randomUUID()}`;
    const item = statusItem({
      id: `item-${randomUUID()}` as never,
      ownerId: owner,
      banId: banId as never,
      role: "RECEIVER",
      status: "BANTASTIC",
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    const positioned: ProductSnapshot = {
      ...opened.loaded.snapshot,
      controlState: "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER",
      extended: {
        ...opened.loaded.snapshot.extended,
        activeNotificationItemId: item.id,
        entities: {
          ...opened.loaded.snapshot.extended.entities,
          bans: {
            [banId]: makeBan({
              id: banId as never,
              senderId: contact,
              receiverId: owner,
              status: "BANTASTIC",
              acceptance: "ACCEPTED",
            }),
          },
          notificationItems: { [item.id]: item },
        },
      },
    };
    // Seed Status context via fixture install (create authority); do not invent Ban via E-47.
    const moved = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      positioned,
    );
    const asked = await opened.apply(owner, moved, eventOf("NOTIFICATIONS.PRESS_ASK_RIM", {}));
    const archived = await chats(owner);
    expect(archived).toHaveLength(2);
    expect(archived.find((row) => row.rim_chat_id === opened.chat.id)?.termination_reason).toBe(
      "ask_rim_replaced",
    );
    expect(asked.snapshot.extended.rimChat?.id).not.toBe(opened.chat.id);
    expect(await messages(opened.chat.id)).toHaveLength(0);
  });

  function withRimChat(
    snapshot: ProductSnapshot,
    patch: Partial<NonNullable<ProductSnapshot["extended"]["rimChat"]>>,
  ): ProductSnapshot {
    const chat = snapshot.extended.rimChat;
    if (!chat) {
      throw new Error("missing RimChat");
    }
    return {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        rimChat: { ...chat, ...patch },
      },
    };
  }

  it("appends a normal event-keyed message into an empty archive", async () => {
    const owner = await identity("empty-owner");
    const contact = await identity("empty-contact");
    const opened = await openChat(owner, contact);
    expect(await messages(opened.chat.id)).toHaveLength(0);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const rows = await messages(opened.chat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_key).toBe(
      `${opened.chat.id}:${opened.chat.relationshipContext?.requestId}:prompt`,
    );
    expect(rows[0]?.message_key.includes(":accepted:")).toBe(false);
    expect(rows[0]?.kind).toBe("RIM");
    expect(rows[0]?.ordinal).toBe(1);
    expect(ready.snapshot.extended.rimChat?.messages).toHaveLength(1);
  });

  it("recovers an empty archive with accepted-prefix keys and one new event key", async () => {
    const owner = await identity("recover-owner");
    const contact = await identity("recover-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const prompt = ready.snapshot.extended.rimChat?.messages[0];
    if (!prompt || prompt.kind !== "RIM") {
      throw new Error("prompt was not accepted");
    }
    await db.sql.query("DELETE FROM rim_messages WHERE rim_chat_id = $1", [opened.chat.id]);
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "recovered" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("recovered send did not open a pending AI request");
    }
    const rows = await messages(opened.chat.id);
    expect(rows.map((row) => row.message_key)).toEqual([
      `${opened.chat.id}:accepted:1`,
      `${opened.chat.id}:${pending.requestId}:user`,
    ]);
    expect(rows[0]?.kind).toBe("RIM");
    expect(rows[0]?.payload.text).toBe(prompt.text);
    expect(rows[0]?.source_context_request_id).toBe(`accepted:${opened.chat.id}:1`);
    expect(rows[1]?.payload.text).toBe("recovered");
    expect(rows.filter((row) => row.payload.text === prompt.text)).toHaveLength(1);
  });

  it("appends only the missing tail after a verified archive prefix", async () => {
    const owner = await identity("partial-owner");
    const contact = await identity("partial-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const chat = ready.snapshot.extended.rimChat;
    const prompt = chat?.messages[0];
    if (!chat || !prompt) {
      throw new Error("prompt was not accepted");
    }
    const promptKey = (await messages(chat.id))[0]?.message_key;
    const seeded = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      withRimChat(ready.snapshot, {
        messages: [prompt, { kind: "USER", text: "already" }],
        inputDraft: "tail",
      }),
    );
    const sent = await opened.apply(owner, seeded, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("partial recovery did not open a pending AI request");
    }
    const rows = await messages(chat.id);
    expect(rows.map((row) => row.message_key)).toEqual([
      promptKey,
      `${chat.id}:accepted:2`,
      `${chat.id}:${pending.requestId}:user`,
    ]);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.payload.text)).toEqual([
      prompt.kind === "RIM" ? prompt.text : "",
      "already",
      "tail",
    ]);
    expect(rows.filter((row) => row.message_key?.includes(":accepted:"))).toHaveLength(1);
  });

  it("rejects a partial archive that does not match the accepted payload", async () => {
    const owner = await identity("mismatch-owner");
    const contact = await identity("mismatch-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const prompt = ready.snapshot.extended.rimChat?.messages[0];
    if (!prompt || prompt.kind !== "RIM") {
      throw new Error("prompt was not accepted");
    }
    const before = await messages(opened.chat.id);
    const seeded = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      withRimChat(ready.snapshot, {
        messages: [{ ...prompt, text: "mutated prompt" }],
        inputDraft: "nope",
      }),
    );
    await expect(opened.apply(owner, seeded, eventOf("RIM.PRESS_SEND", {}))).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history archive prefix does not match",
    });
    expect(await messages(opened.chat.id)).toEqual(before);
    const kept = await opened.store.loadProductSnapshot(owner);
    expect(kept.revision).toBe(seeded.revision);
  });

  it("rejects a snapshot whose order does not match the archive", async () => {
    const owner = await identity("reorder-owner");
    const contact = await identity("reorder-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "ordered" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    const chat = sent.snapshot.extended.rimChat;
    const prompt = chat?.messages[0];
    const user = chat?.messages[1];
    if (!chat || !prompt || !user || pending?.status !== "PENDING") {
      throw new Error("ordered chat was not ready to reverse");
    }
    const before = await messages(chat.id);
    const seeded = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      withRimChat(sent.snapshot, { messages: [user, prompt] }),
    );
    await expect(
      opened.apply(
        owner,
        seeded,
        eventOf("RIM.AI_RESULT_RECEIVED", {
          rimChatId: chat.id,
          requestId: pending.requestId,
          result: { kind: "MESSAGE", text: "should not archive" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history archive prefix does not match",
    });
    expect(await messages(chat.id)).toEqual(before);
  });

  it("keeps two legitimate messages with the same text at different ordinals", async () => {
    const owner = await identity("duplicate-owner");
    const contact = await identity("duplicate-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const prompt = ready.snapshot.extended.rimChat?.messages[0];
    if (!prompt) {
      throw new Error("prompt was not accepted");
    }
    const seeded = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      withRimChat(ready.snapshot, {
        messages: [prompt, { kind: "USER", text: "same" }],
        inputDraft: "same",
      }),
    );
    const sent = await opened.apply(owner, seeded, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("duplicate send did not open a pending AI request");
    }
    const rows = await messages(opened.chat.id);
    const users = rows.filter((row) => row.kind === "USER");
    expect(users.map((row) => row.payload.text)).toEqual(["same", "same"]);
    expect(users.map((row) => row.ordinal)).toEqual([2, 3]);
    expect(new Set(users.map((row) => row.message_key)).size).toBe(2);
  });

  it("rejects a seeded prefix mutation after an event-keyed message", async () => {
    const owner = await identity("mutate-owner");
    const contact = await identity("mutate-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "hello" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    const chat = sent.snapshot.extended.rimChat;
    if (!chat || pending?.status !== "PENDING") {
      throw new Error("event-keyed user message was not archived");
    }
    await db.sql.query("DELETE FROM rim_messages WHERE rim_chat_id = $1 AND ordinal = 1", [
      chat.id,
    ]);
    await db.sql.query(
      "UPDATE rim_messages SET ordinal = 1 WHERE rim_chat_id = $1 AND ordinal = 2",
      [chat.id],
    );
    const eventKeyed = await messages(chat.id);
    expect(eventKeyed).toHaveLength(1);
    expect(eventKeyed[0]?.message_key).toBe(`${chat.id}:${pending.requestId}:user`);
    const seeded = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      sent.snapshot,
    );
    await expect(
      opened.apply(
        owner,
        seeded,
        eventOf("RIM.AI_RESULT_RECEIVED", {
          rimChatId: chat.id,
          requestId: pending.requestId,
          result: { kind: "MESSAGE", text: "should not archive" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history archive prefix does not match",
    });
    const rows = await messages(chat.id);
    expect(rows.map((row) => row.message_key)).toEqual(eventKeyed.map((row) => row.message_key));
    expect(rows.some((row) => row.message_key.includes(":accepted:"))).toBe(false);
  });

  it("rejects an archive that contains more messages than the snapshot", async () => {
    const owner = await identity("longer-owner");
    const contact = await identity("longer-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "kept" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const pending = sent.snapshot.extended.rimChat?.aiOperation;
    if (pending?.status !== "PENDING") {
      throw new Error("longer archive setup did not send");
    }
    await opened.apply(
      owner,
      sent,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: opened.chat.id,
        requestId: pending.requestId,
        result: { kind: "MESSAGE", text: "kept reply" },
      }),
    );
    const before = await messages(opened.chat.id);
    expect(before).toHaveLength(3);
    const seeded = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      owner,
      withRimChat(ready.snapshot, { inputDraft: "extra" }),
    );
    await expect(opened.apply(owner, seeded, eventOf("RIM.PRESS_SEND", {}))).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history has more messages than the accepted chat",
    });
    expect(await messages(opened.chat.id)).toEqual(before);
  });

  it("rejects a later user message and a later reply on a terminated chat", async () => {
    const owner = await identity("closed-owner");
    const contact = await identity("closed-contact");
    const opened = await openChat(owner, contact);
    const ready = await opened.apply(
      owner,
      opened.loaded,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: opened.chat.id,
        selectedContactId: contact,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.chat.relationshipContext!.requestId,
      }),
    );
    const drafted = await opened.apply(
      owner,
      ready,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "closing" }),
    );
    const sent = await opened.apply(owner, drafted, eventOf("RIM.PRESS_SEND", {}));
    const live = sent.snapshot.extended.rimChat;
    const pending = live?.aiOperation;
    if (!live || pending?.status !== "PENDING") {
      throw new Error("chat was not pending before close");
    }
    const closed = await opened.apply(owner, sent, eventOf("APP.FULL_CLOSE", {}));
    const before = await messages(live.id);
    await expect(
      PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(owner, sent.snapshot),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history cannot write a terminated chat",
    });
    expect((await chats(owner))[0]?.termination_reason).toBe("full_close");
    const nextUser = {
      ...live,
      messages: [...live.messages, { kind: "USER" as const, text: "later" }],
      aiOperation: {
        ...pending,
        snapshot: { ...pending.snapshot, userMessage: "later" },
      },
    };
    await expect(
      db.sql.transaction(async (tx) => {
        await projectRimHistory(tx, {
          ownerUserId: owner,
          previousLive: live,
          previousFrozen: null,
          nextLive: nextUser,
          nextFrozen: null,
          bans: {},
          createdBanIds: new Set<string>(),
          appliedRule: { eventId: "E-52", branch: "default" },
        });
      }),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history cannot write a terminated chat",
    });
    const nextReply = {
      ...live,
      messages: [...live.messages, { kind: "RIM" as const, text: "later reply" }],
    };
    await expect(
      db.sql.transaction(async (tx) => {
        await projectRimHistory(tx, {
          ownerUserId: owner,
          previousLive: live,
          previousFrozen: null,
          nextLive: nextReply,
          nextFrozen: null,
          bans: {},
          createdBanIds: new Set<string>(),
          appliedRule: { eventId: "E-58", branch: "current-request" },
        });
      }),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM history cannot write a terminated chat",
    });
    await db.sql.transaction(async (tx) => {
      await projectRimHistory(tx, {
        ownerUserId: owner,
        previousLive: live,
        previousFrozen: null,
        nextLive: closed.snapshot.extended.rimChat,
        nextFrozen: null,
        bans: {},
        createdBanIds: new Set<string>(),
        appliedRule: { eventId: "E-32", branch: "default" },
      });
    });
    await expect(
      db.sql.transaction(async (tx) => {
        await projectRimHistory(tx, {
          ownerUserId: owner,
          previousLive: live,
          previousFrozen: null,
          nextLive: null,
          nextFrozen: null,
          bans: {},
          createdBanIds: new Set<string>(),
          appliedRule: { eventId: "E-50", branch: "default" },
        });
      }),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "RIM chat archive termination conflict",
    });
    expect(await messages(live.id)).toEqual(before);
    expect((await chats(owner))[0]?.termination_reason).toBe("full_close");
  });
});
