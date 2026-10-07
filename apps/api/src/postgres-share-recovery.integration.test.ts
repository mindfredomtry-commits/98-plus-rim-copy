import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeShareLinkResolved } from "@98plus/application";
import { randomIdAllocator } from "@98plus/application";
import { asTelegramUserId } from "@98plus/identity";
import { SQL, openPostgresPersistence, type PostgresPersistence } from "@98plus/persistence";
import { PersistenceTestKit } from "../../../packages/persistence/src/test-kit.ts";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  counterAllocator,
  emptySnapshot,
  type BanId,
  type DurationMinutes,
  type NotificationItemId,
  type ShareLinkId,
  type OperationId,
  type ProductSnapshot,
  type ShareAttemptId,
  type ShareOperation,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  eventOf,
  pendingOp,
  shareOp,
  validCreateDraft,
  withControlState,
  withEntities,
  withOperation,
} from "../../../packages/product-model/src/kernel.fixtures.ts";
import { authContext } from "../../../packages/application/src/test-harness.ts";
import { createShareReturnLatch } from "../../miniapp/src/test-ui/telegram-share-return.ts";
import {
  resolvePendingExternalEntryIfOnline,
  resolveTelegramShareExternalEntry,
} from "./external-entry.ts";
import {
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  executorDeps,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import { telegramShareOutcomeToEventName } from "./telegram-share.ts";
import { completeTelegramShare } from "./template-share.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

type Actor = Readonly<{ userId: UserId; telegram: string }>;

type Process = Readonly<{
  db: PostgresPersistence;
  runtime: CreateBanContactRuntime;
  kill(): Promise<void>;
}>;

type ShareRow = Readonly<{
  attempt_id: string;
  owner_id: string;
  token: string;
  status: string;
  created_ban_id: string | null;
}>;

type BanRow = Readonly<{
  ban_id: string;
  sender_id: string;
  receiver_id: string | null;
  ban_text: string;
  acceptance: string;
  bound_via_telegram_share_link: boolean;
}>;

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

function tokenOf(value: string): ShareOperation["token"] {
  return value as unknown as ShareOperation["token"];
}

describe("Share restart identity is not process-local", () => {
  it("keeps the frozen Product engine", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });

  it("treats counterAllocator as a test helper that repeats after a fresh process", () => {
    const first = counterAllocator(1);
    const restarted = counterAllocator(1);
    expect(first("share-token")).toBe("share-token-1");
    expect(first("ban")).toBe("ban-2");
    expect(restarted("share-token")).toBe("share-token-1");
    expect(restarted("ban")).toBe("ban-2");
  });

  it("allocates production Share ids with randomUUID so a fresh runtime does not repeat them", () => {
    const first = createCreateBanContactRuntime({ allocateId: randomIdAllocator() });
    const restarted = createCreateBanContactRuntime({ allocateId: randomIdAllocator() });
    const kinds = ["ban", "share", "share-token", "notification", "operation"] as const;
    const seen = new Set<string>();
    for (const runtime of [first, restarted]) {
      for (const kind of kinds) {
        for (let index = 0; index < 8; index += 1) {
          const id = runtime.allocateId(kind);
          expect(seen.has(id)).toBe(false);
          expect(id.startsWith(`${kind}-`)).toBe(true);
          expect(id).not.toBe(`${kind}-1`);
          seen.add(id);
        }
      }
    }
    expect(first.allocateId).not.toBe(restarted.allocateId);
  });

  it("loses the share-return latch and the confirmed Telegram callback with the process", () => {
    const latch = createShareReturnLatch();
    latch.arm("attempt-1");
    expect(latch.observe("deactivated").dispatch).toBe(false);
    expect(latch.observe("activated")).toEqual({ shareAttemptId: "attempt-1", dispatch: true });
    const restarted = createShareReturnLatch();
    expect(restarted.observe("activated")).toEqual({ shareAttemptId: null, dispatch: false });
    expect(telegramShareOutcomeToEventName("CONFIRMED")).toBeNull();
    expect(telegramShareOutcomeToEventName("CANCELLED")).toBe("CREATE_BAN.SHARE_CANCELLED");
  });
});

describe.skipIf(!databaseUrl)("real PostgreSQL Share restart recovery", () => {
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
      options: `-c search_path=${schema} -c application_name=mvp17_pass5_admin`,
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

  async function startProcess(): Promise<Process> {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    const db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_pass5`,
    });
    const runtime = createCreateBanContactRuntime({
      sql: db.sql,
      clock: { nowMs: () => 2_000_000 },
      allocateId: randomIdAllocator(),
      telegramSharePrepare: "mock",
    });
    return {
      db,
      runtime,
      async kill() {
        await db.close();
      },
    };
  }

  async function actor(process: Process, label: string): Promise<Actor> {
    const telegram = `${label}-${randomUUID()}`;
    const user = await process.runtime.identityStore.resolveByTelegramUserId(
      asTelegramUserId(telegram),
    );
    return { userId: user.userId, telegram };
  }

  async function seed(process: Process, userId: UserId, snapshot: ProductSnapshot) {
    return PersistenceTestKit.postgres(process.db.sql).installFixtureSnapshot(userId, snapshot);
  }

  function templateSender(): ProductSnapshot {
    return withControlState(
      {
        ...emptySnapshot(),
        extended: { ...emptySnapshot().extended, createBanDraft: validCreateDraft("TEMPLATE") },
      },
      "CREATE_BAN.CONFIRM.TEMPLATE",
    );
  }

  function lobby(): ProductSnapshot {
    return withControlState(emptySnapshot(), "RIM.LOBBY");
  }

  async function shareByOwner(process: Process, ownerId: UserId): Promise<ShareRow> {
    const result = await process.db.sql.query<ShareRow>(SQL.selectSharesForUser, [ownerId]);
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) {
      throw new Error(`expected one share for ${ownerId}, found ${result.rows.length}`);
    }
    return row;
  }

  async function banById(process: Process, banId: string): Promise<BanRow> {
    const result = await process.db.sql.query<BanRow>(SQL.selectBanById, [banId]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`missing ban ${banId}`);
    }
    return row;
  }

  async function incomingCount(process: Process, banId: string): Promise<number> {
    const result = await process.db.sql.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM notification_items WHERE ban_id = $1 AND kind = 'INCOMING_BAN'",
      [banId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function rowCount(
    process: Process,
    table: "bans" | "share_operations" | "pending_operations",
    column: string,
    value: string,
  ): Promise<number> {
    const result = await process.db.sql.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`,
      [value],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function openShare(process: Process, sender: Actor) {
    const opened = await executeAuthenticatedEvent(
      process.runtime,
      authContext(sender.userId, sender.telegram),
      { name: "CREATE_BAN.PRESS_FORBID", payload: {} },
    );
    expect(opened.status).toBe("APPLIED");
    expect(opened.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    const share = await shareByOwner(process, sender.userId);
    expect(share.status).toBe("ACTIVE");
    expect(share.created_ban_id).toBeTruthy();
    return { opened, share, ban: await banById(process, share.created_ban_id!) };
  }

  async function claim(
    process: Process,
    receiver: Actor,
    token: string,
  ): Promise<Awaited<ReturnType<typeof resolveTelegramShareExternalEntry>>> {
    return resolveTelegramShareExternalEntry(
      process.runtime,
      authContext(receiver.userId, receiver.telegram),
      `share_${token}`,
    );
  }

  async function crashOpenTransaction(
    statements: readonly { text: string; params: readonly unknown[] }[],
  ): Promise<void> {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    const client = new Client({ connectionString: databaseUrl });
    client.on("error", () => undefined);
    await client.connect();
    try {
      assertSchemaName(schema);
      await client.query(`SET search_path TO ${schema}`);
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement.text, [...statement.params]);
      }
      const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = pidResult.rows[0]?.pid;
      if (pid === undefined) {
        throw new Error("missing backend pid");
      }
      const dying = new Promise<void>((resolve, reject) => {
        client.query("SELECT pg_sleep(30)", (error) => {
          if (error) {
            resolve();
            return;
          }
          reject(new Error("open transaction survived connection death"));
        });
      });
      await admin.sql.query("SELECT pg_terminate_backend($1::int)", [pid]);
      await dying;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  it("reloads an ACTIVE share after process death and claims it once from the next process", async () => {
    const first = await startProcess();
    const sender = await actor(first, "sender");
    const receiver = await actor(first, "receiver");
    await seed(first, sender.userId, templateSender());
    await seed(first, receiver.userId, lobby());
    const created = await openShare(first, sender);
    const senderBefore = await first.runtime.productStore.loadProductSnapshot(sender.userId);
    expect(created.ban.receiver_id).toBeNull();
    expect(created.ban.bound_via_telegram_share_link).toBe(false);
    expect(created.ban.acceptance).toBe("PENDING");
    expect(senderBefore.snapshot.extended.createBanDraft?.banText).toBe("no phones");
    expect(senderBefore.snapshot.runtime.pendingOperations).toEqual({});
    expect(await rowCount(first, "bans", "sender_id", sender.userId)).toBe(1);
    expect(await rowCount(first, "share_operations", "owner_id", sender.userId)).toBe(1);
    await first.kill();

    const second = await startProcess();
    const senderAfter = await second.runtime.productStore.loadProductSnapshot(sender.userId);
    const share = await shareByOwner(second, sender.userId);
    const ban = await banById(second, share.created_ban_id!);
    expect(share).toEqual(created.share);
    expect(ban).toEqual(created.ban);
    expect(senderAfter.revision).toBe(senderBefore.revision);
    expect(senderAfter.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(senderAfter.snapshot.extended.createBanDraft).toEqual(
      senderBefore.snapshot.extended.createBanDraft,
    );
    expect(senderAfter.snapshot.extended.entities.shareOperations[share.attempt_id]).toMatchObject({
      status: "ACTIVE",
      createdBanId: share.created_ban_id,
      token: tokenOf(share.token),
    });
    expect(await rowCount(second, "bans", "sender_id", sender.userId)).toBe(1);
    expect(await rowCount(second, "share_operations", "owner_id", sender.userId)).toBe(1);

    const claimed = await claim(second, receiver, share.token);
    expect(claimed.orchestration.outcome).toBe("RESOLVED");
    expect(claimed.orchestration.bindStatus).toBe("BOUND");
    const bound = await banById(second, share.created_ban_id!);
    const confirmed = await shareByOwner(second, sender.userId);
    const senderObserved = await second.runtime.productStore.loadProductSnapshot(sender.userId);
    const recipient = await second.runtime.productStore.loadProductSnapshot(receiver.userId);
    expect(bound.receiver_id).toBe(receiver.userId);
    expect(bound.bound_via_telegram_share_link).toBe(true);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.created_ban_id).toBe(share.created_ban_id);
    expect(confirmed.token).toBe(share.token);
    expect(await incomingCount(second, share.created_ban_id!)).toBe(1);
    expect(recipient.snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(senderObserved.revision).toBe(senderBefore.revision);
    expect(senderObserved.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(
      senderObserved.snapshot.extended.entities.shareOperations[share.attempt_id]?.status,
    ).toBe("CONFIRMED");
    await second.kill();

    const third = await startProcess();
    const durable = await shareByOwner(third, sender.userId);
    const durableBan = await banById(third, share.created_ban_id!);
    const senderFinal = await third.runtime.productStore.loadProductSnapshot(sender.userId);
    expect(durable).toEqual(confirmed);
    expect(durableBan.receiver_id).toBe(receiver.userId);
    expect(senderFinal.revision).toBe(senderBefore.revision);
    expect(await incomingCount(third, share.created_ban_id!)).toBe(1);
    expect(await rowCount(third, "bans", "sender_id", sender.userId)).toBe(1);
    await third.kill();
  });

  it("keeps an unclaimed ACTIVE share unchanged across three process deaths and stores no share TTL", async () => {
    const columns = await admin.sql.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'share_operations'
       ORDER BY ordinal_position`,
      [],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "attempt_id",
      "owner_id",
      "draft",
      "token",
      "status",
      "created_ban_id",
    ]);

    const origin = await startProcess();
    const sender = await actor(origin, "unclaimed");
    await seed(origin, sender.userId, templateSender());
    const created = await openShare(origin, sender);
    await origin.kill();

    let previous = created.share;
    for (let restart = 0; restart < 3; restart += 1) {
      const next = await startProcess();
      const share = await shareByOwner(next, sender.userId);
      const ban = await banById(next, share.created_ban_id!);
      const loaded = await next.runtime.productStore.loadProductSnapshot(sender.userId);
      expect(share).toEqual(previous);
      expect(ban.receiver_id).toBeNull();
      expect(loaded.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
      expect(Object.keys(loaded.snapshot.runtime.pendingOperations)).toEqual([]);
      expect(await rowCount(next, "share_operations", "token", share.token)).toBe(1);
      expect(await incomingCount(next, share.created_ban_id!)).toBe(0);
      previous = share;
      await next.kill();
    }
  });

  it("rolls back a bind that dies before commit and recovers a claim that already committed", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "crash-sender");
    const receiver = await actor(origin, "crash-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    const targetBanId = created.share.created_ban_id;
    if (targetBanId === null) {
      throw new Error("active share is missing its Ban");
    }
    const opened = await executeAuthenticatedEvent(
      origin.runtime,
      authContext(receiver.userId, receiver.telegram),
      eventOf("TELEGRAM_SHARE_LINK.OPENED", {
        shareLinkId: branded<ShareLinkId>(created.share.attempt_id),
        shareTargetBanId: branded<BanId>(targetBanId),
        currentTelegramUserId: receiver.userId,
      }),
    );
    expect(opened.status).toBe("APPLIED");
    const pending = await origin.runtime.productStore.loadProductSnapshot(receiver.userId);
    expect(pending.snapshot.extended.pendingExternalEntry?.shareTargetBanId).toBe(
      created.share.created_ban_id,
    );
    expect((await banById(origin, created.share.created_ban_id!)).receiver_id).toBeNull();
    await origin.kill();

    const recovered = await startProcess();
    const resumed = await claim(recovered, receiver, created.share.token);
    expect(resumed.orchestration.outcome).toBe("RESOLVED");
    expect(resumed.orchestration.bindStatus).toBe("BOUND");
    expect((await shareByOwner(recovered, sender.userId)).status).toBe("CONFIRMED");
    expect(await incomingCount(recovered, created.share.created_ban_id!)).toBe(1);
    await recovered.kill();

    const uncommitted = await startProcess();
    const otherSender = await actor(uncommitted, "open-tx-sender");
    const otherReceiver = await actor(uncommitted, "open-tx-receiver");
    await seed(uncommitted, otherSender.userId, templateSender());
    await seed(uncommitted, otherReceiver.userId, lobby());
    const held = await openShare(uncommitted, otherSender);
    await crashOpenTransaction([
      {
        text: SQL.bindBanReceiverIfUnbound,
        params: [held.share.created_ban_id, otherReceiver.userId],
      },
      {
        text: "UPDATE share_operations SET status = 'CONFIRMED' WHERE attempt_id = $1",
        params: [held.share.attempt_id],
      },
    ]);
    await uncommitted.kill();

    const afterCrash = await startProcess();
    const share = await shareByOwner(afterCrash, otherSender.userId);
    const ban = await banById(afterCrash, held.share.created_ban_id!);
    expect(share.status).toBe("ACTIVE");
    expect(share.token).toBe(held.share.token);
    expect(ban.receiver_id).toBeNull();
    expect(await incomingCount(afterCrash, held.share.created_ban_id!)).toBe(0);
    const claimed = await claim(afterCrash, otherReceiver, share.token);
    expect(claimed.orchestration.bindStatus).toBe("BOUND");
    await afterCrash.kill();

    const diedAfterCommit = await startProcess();
    expect((await shareByOwner(diedAfterCommit, sender.userId)).status).toBe("CONFIRMED");
    const again = await claim(diedAfterCommit, receiver, created.share.token);
    expect(again.orchestration.bindStatus).toBe("ALREADY_BOUND");
    expect(await incomingCount(diedAfterCommit, created.share.created_ban_id!)).toBe(1);
    expect(await rowCount(diedAfterCommit, "bans", "ban_id", created.share.created_ban_id!)).toBe(
      1,
    );
    await diedAfterCommit.kill();
  }, 20_000);

  it("shows the sender the confirmed share without a sender write, then accepts one return", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "observe-sender");
    const receiver = await actor(origin, "observe-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    const before = await origin.runtime.productStore.loadProductSnapshot(sender.userId);
    await origin.kill();

    const claimedBy = await startProcess();
    const claimed = await claim(claimedBy, receiver, created.share.token);
    expect(claimed.orchestration.outcome).toBe("RESOLVED");
    await claimedBy.kill();

    const senderReturns = await startProcess();
    const observed = await senderReturns.runtime.productStore.loadProductSnapshot(sender.userId);
    expect(observed.revision).toBe(before.revision);
    expect(observed.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(observed.snapshot.extended.successfulBanId).toBe(
      before.snapshot.extended.successfulBanId,
    );
    expect(
      observed.snapshot.extended.entities.shareOperations[created.share.attempt_id],
    ).toMatchObject({ status: "CONFIRMED", createdBanId: created.share.created_ban_id });
    const returned = await executeAuthenticatedEvent(
      senderReturns.runtime,
      authContext(sender.userId, sender.telegram),
      eventOf("CREATE_BAN.SHARE_RETURNED", {
        shareAttemptId: branded<ShareAttemptId>(created.share.attempt_id),
      }),
    );
    expect(returned.status).toBe("APPLIED");
    expect(returned.controlState).toBe("CREATE_BAN.SUCCESS");
    const again = await executeAuthenticatedEvent(
      senderReturns.runtime,
      authContext(sender.userId, sender.telegram),
      eventOf("CREATE_BAN.SHARE_RETURNED", {
        shareAttemptId: branded<ShareAttemptId>(created.share.attempt_id),
      }),
    );
    expect(again.status).toBe("NOT_APPLIED");
    expect(again.persisted).toBe(false);
    const after = await senderReturns.runtime.productStore.loadProductSnapshot(sender.userId);
    expect(after.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(after.revision).toBe(returned.revision);
    expect((await shareByOwner(senderReturns, sender.userId)).status).toBe("CONFIRMED");
    expect(await rowCount(senderReturns, "bans", "sender_id", sender.userId)).toBe(1);
    expect(await incomingCount(senderReturns, created.share.created_ban_id!)).toBe(1);
    await senderReturns.kill();
  });

  it("keeps the original receiver authoritative when the link is opened again after restart", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "dup-sender");
    const receiver = await actor(origin, "dup-receiver");
    const stranger = await actor(origin, "dup-stranger");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    await seed(origin, stranger.userId, lobby());
    const created = await openShare(origin, sender);
    const claimed = await claim(origin, receiver, created.share.token);
    expect(claimed.orchestration.bindStatus).toBe("BOUND");
    const recipientBefore = await origin.runtime.productStore.loadProductSnapshot(receiver.userId);
    await origin.kill();

    const restarted = await startProcess();
    const same = await claim(restarted, receiver, created.share.token);
    expect(same.orchestration.outcome).toBe("RESOLVED");
    expect(same.orchestration.bindStatus).toBe("ALREADY_BOUND");
    const recipientAfter = await restarted.runtime.productStore.loadProductSnapshot(
      receiver.userId,
    );
    expect(await incomingCount(restarted, created.share.created_ban_id!)).toBe(1);
    expect((await banById(restarted, created.share.created_ban_id!)).receiver_id).toBe(
      receiver.userId,
    );
    expect((await shareByOwner(restarted, sender.userId)).status).toBe("CONFIRMED");
    const senderAfterSame = await restarted.runtime.productStore.loadProductSnapshot(sender.userId);
    expect(senderAfterSame.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");

    const other = await claim(restarted, stranger, created.share.token);
    expect(other.orchestration.outcome).toBe("REJECTED");
    expect(other.orchestration.bindStatus).toBe("CONFLICT");
    expect((await banById(restarted, created.share.created_ban_id!)).receiver_id).toBe(
      receiver.userId,
    );
    expect(await incomingCount(restarted, created.share.created_ban_id!)).toBe(1);
    const strangerLoaded = await restarted.runtime.productStore.loadProductSnapshot(
      stranger.userId,
    );
    expect(Object.keys(strangerLoaded.snapshot.extended.entities.notificationItems)).toEqual([]);
    expect(recipientAfter.revision).toBe(recipientBefore.revision + 2);
    await restarted.kill();
  });

  it("does not make a bound receiver bindable again after restart", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "bind-sender");
    const receiver = await actor(origin, "bind-receiver");
    const stranger = await actor(origin, "bind-stranger");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    await seed(origin, stranger.userId, lobby());
    const created = await openShare(origin, sender);
    expect((await claim(origin, receiver, created.share.token)).orchestration.bindStatus).toBe(
      "BOUND",
    );
    await origin.kill();

    const restarted = await startProcess();
    const same = await restarted.runtime.productStore.claimTemplateShare({
      receiverId: receiver.userId,
      token: created.share.token,
      reduceClaim: () => {
        throw new Error("same receiver must not reduce");
      },
    });
    expect(same.status).toBe("ALREADY_BOUND");
    const conflict = await restarted.runtime.productStore.claimTemplateShare({
      receiverId: stranger.userId,
      token: created.share.token,
      reduceClaim: () => {
        throw new Error("different receiver must not reduce");
      },
    });
    expect(conflict.status).toBe("CONFLICT");
    const rebound = await restarted.db.sql.query(SQL.bindBanReceiverIfUnbound, [
      created.share.created_ban_id,
      stranger.userId,
    ]);
    expect(rebound.rows).toEqual([]);
    expect((await banById(restarted, created.share.created_ban_id!)).receiver_id).toBe(
      receiver.userId,
    );
    await restarted.kill();
  });

  it("keeps CONFIRMED from returning to ACTIVE", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "confirm-sender");
    const receiver = await actor(origin, "confirm-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    await claim(origin, receiver, created.share.token);
    await origin.kill();

    const restarted = await startProcess();
    const share = await shareByOwner(restarted, sender.userId);
    expect(share.status).toBe("CONFIRMED");
    const secondConfirm = await restarted.db.sql.query(SQL.confirmShareIfActive, [
      share.attempt_id,
      share.created_ban_id,
      sender.userId,
    ]);
    expect(secondConfirm.rows).toEqual([]);
    expect((await shareByOwner(restarted, sender.userId)).status).toBe("CONFIRMED");
    const repeat = await claim(restarted, receiver, share.token);
    expect(repeat.orchestration.bindStatus).toBe("ALREADY_BOUND");
    expect(await rowCount(restarted, "bans", "ban_id", share.created_ban_id!)).toBe(1);
    expect(await rowCount(restarted, "share_operations", "token", share.token)).toBe(1);
    await restarted.kill();
  });

  it("cancels only a share that has no Ban, and a created Ban ignores SHARE_CANCELLED", async () => {
    const origin = await startProcess();
    const legacySender = await actor(origin, "legacy-sender");
    const receiver = await actor(origin, "legacy-receiver");
    const attemptId = branded<ShareAttemptId>(`share-${randomUUID()}`);
    const token = `token-${randomUUID()}`;
    await seed(origin, receiver.userId, lobby());
    await seed(
      origin,
      legacySender.userId,
      withEntities(withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING"), {
        shareOperations: {
          [attemptId]: shareOp({
            attemptId,
            token: tokenOf(token),
            createdBanId: null,
            draft: validCreateDraft("TEMPLATE"),
          }),
        },
      }),
    );
    const cancelled = await executeAuthenticatedEvent(
      origin.runtime,
      authContext(legacySender.userId, legacySender.telegram),
      eventOf("CREATE_BAN.SHARE_CANCELLED", { shareAttemptId: attemptId }),
    );
    expect(cancelled.status).toBe("APPLIED");
    expect(cancelled.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE");
    await origin.kill();

    const restarted = await startProcess();
    const share = await shareByOwner(restarted, legacySender.userId);
    expect(share.status).toBe("CANCELLED");
    expect(share.token).toBe(token);
    expect(share.created_ban_id).toBeNull();
    const rejected = await claim(restarted, receiver, token);
    expect(rejected.orchestration.outcome).toBe("REJECTED");
    expect(await rowCount(restarted, "bans", "sender_id", legacySender.userId)).toBe(0);
    const duplicate = await completeTelegramShare(
      restarted.runtime,
      authContext(legacySender.userId, legacySender.telegram),
      { shareAttemptId: attemptId, outcome: "CANCELLED" },
    );
    expect(duplicate?.status).toBe("NOT_APPLIED");
    expect((await shareByOwner(restarted, legacySender.userId)).status).toBe("CANCELLED");
    const confirmedCallback = await completeTelegramShare(
      restarted.runtime,
      authContext(legacySender.userId, legacySender.telegram),
      { shareAttemptId: attemptId, outcome: "CONFIRMED" },
    );
    expect(confirmedCallback).toBeNull();
    expect((await shareByOwner(restarted, legacySender.userId)).status).toBe("CANCELLED");
    await restarted.kill();

    const live = await startProcess();
    const sender = await actor(live, "live-cancel-sender");
    const liveReceiver = await actor(live, "live-cancel-receiver");
    await seed(live, sender.userId, templateSender());
    await seed(live, liveReceiver.userId, lobby());
    const created = await openShare(live, sender);
    const ignored = await completeTelegramShare(
      live.runtime,
      authContext(sender.userId, sender.telegram),
      { shareAttemptId: created.share.attempt_id, outcome: "CANCELLED" },
    );
    expect(ignored?.status).toBe("APPLIED");
    expect(ignored?.result).toBe("IGNORE_NOT_ALLOWED");
    expect(ignored?.persisted).toBe(true);
    expect(ignored?.effects).toEqual([]);
    expect(ignored?.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect((await shareByOwner(live, sender.userId)).status).toBe("ACTIVE");
    expect((await banById(live, created.share.created_ban_id!)).receiver_id).toBeNull();
    await live.kill();

    const stillClaimable = await startProcess();
    const claimed = await claim(stillClaimable, liveReceiver, created.share.token);
    expect(claimed.orchestration.bindStatus).toBe("BOUND");
    expect((await shareByOwner(stillClaimable, sender.userId)).status).toBe("CONFIRMED");
    await stillClaimable.kill();
  });

  it("keeps a committed share-link resolution and drops an uncommitted one", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "link-sender");
    const receiver = await actor(origin, "link-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    const itemId = origin.runtime.allocateId("notification") as NotificationItemId;
    const resolved = await executeShareLinkResolved(
      {
        context: authContext(receiver.userId, receiver.telegram),
        event: {
          name: "TELEGRAM_SHARE_LINK.RESOLVED",
          payload: {
            targetBanId: created.share.created_ban_id as BanId,
            receiverId: receiver.userId,
            incomingBanItemId: itemId,
          },
        },
        targetBanId: created.share.created_ban_id as BanId,
        receiverId: receiver.userId,
      },
      executorDeps(origin.runtime),
    );
    expect(resolved.status).toBe("APPLIED");
    expect(resolved.bindStatus).toBe("BOUND");
    expect(resolved.persisted).toBe(true);
    await origin.kill();

    const restarted = await startProcess();
    expect((await banById(restarted, created.share.created_ban_id!)).receiver_id).toBe(
      receiver.userId,
    );
    expect(await incomingCount(restarted, created.share.created_ban_id!)).toBe(1);
    expect((await shareByOwner(restarted, sender.userId)).status).toBe("ACTIVE");
    const retry = await executeShareLinkResolved(
      {
        context: authContext(receiver.userId, receiver.telegram),
        event: {
          name: "TELEGRAM_SHARE_LINK.RESOLVED",
          payload: {
            targetBanId: created.share.created_ban_id as BanId,
            receiverId: receiver.userId,
            incomingBanItemId: itemId,
          },
        },
        targetBanId: created.share.created_ban_id as BanId,
        receiverId: receiver.userId,
      },
      executorDeps(restarted.runtime),
    );
    expect(retry.bindStatus).toBe("ALREADY_BOUND");
    expect(await incomingCount(restarted, created.share.created_ban_id!)).toBe(1);
    expect((await banById(restarted, created.share.created_ban_id!)).receiver_id).toBe(
      receiver.userId,
    );
    await restarted.kill();

    const dying = await startProcess();
    const unboundSender = await actor(dying, "unbound-sender");
    const unboundReceiver = await actor(dying, "unbound-receiver");
    await seed(dying, unboundSender.userId, templateSender());
    const unbound = await openShare(dying, unboundSender);
    await crashOpenTransaction([
      {
        text: SQL.bindBanReceiverIfUnbound,
        params: [unbound.share.created_ban_id, unboundReceiver.userId],
      },
    ]);
    await dying.kill();

    const converged = await startProcess();
    expect((await banById(converged, unbound.share.created_ban_id!)).receiver_id).toBeNull();
    const follow = await claim(converged, unboundReceiver, unbound.share.token);
    expect(follow.orchestration.bindStatus).toBe("BOUND");
    expect((await shareByOwner(converged, unboundSender.userId)).status).toBe("CONFIRMED");
    await converged.kill();
  }, 20_000);

  it("reloads Create Ban pending work and does not apply it again", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "pending-sender");
    const operationId = branded<OperationId>(`op-${randomUUID()}`);
    const draft = {
      origin: "CONTACT" as const,
      selectedContactId: null,
      banText: "no phones",
      durationMinutes: 3 as DurationMinutes,
      proposalId: null,
    };
    await seed(
      origin,
      sender.userId,
      withOperation(
        withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT"),
        pendingOp({
          operationId,
          resultApplied: false,
          supersededByExternalEntry: false,
          sendDraft: draft,
        }),
      ),
    );
    await origin.kill();

    const restarted = await startProcess();
    const loaded = await restarted.runtime.productStore.loadProductSnapshot(sender.userId);
    expect(loaded.snapshot.runtime.pendingOperations[operationId]).toMatchObject({
      kind: "CREATE_BAN_SEND",
      resultApplied: false,
      supersededByExternalEntry: false,
      sendDraft: draft,
    });
    expect(await rowCount(restarted, "bans", "sender_id", sender.userId)).toBe(0);
    await restarted.kill();

    const claimer = await startProcess();
    const shareSender = await actor(claimer, "pending-share-sender");
    const receiver = await actor(claimer, "pending-share-receiver");
    const receiverOperationId = branded<OperationId>(`op-${randomUUID()}`);
    await seed(claimer, shareSender.userId, templateSender());
    await seed(
      claimer,
      receiver.userId,
      withOperation(
        lobby(),
        pendingOp({
          operationId: receiverOperationId,
          resultApplied: false,
          supersededByExternalEntry: false,
          sendDraft: draft,
        }),
      ),
    );
    const created = await openShare(claimer, shareSender);
    expect(
      (await claimer.runtime.productStore.loadProductSnapshot(shareSender.userId)).snapshot.runtime
        .pendingOperations,
    ).toEqual({});
    const claimed = await claim(claimer, receiver, created.share.token);
    expect(claimed.orchestration.bindStatus).toBe("BOUND");
    await claimer.kill();

    const after = await startProcess();
    const receiverLoaded = await after.runtime.productStore.loadProductSnapshot(receiver.userId);
    expect(receiverLoaded.snapshot.runtime.pendingOperations[receiverOperationId]).toMatchObject({
      resultApplied: false,
      supersededByExternalEntry: true,
    });
    expect(await rowCount(after, "bans", "sender_id", shareSender.userId)).toBe(1);
    expect(await incomingCount(after, created.share.created_ban_id!)).toBe(1);
    expect(await rowCount(after, "share_operations", "owner_id", shareSender.userId)).toBe(1);
    await after.kill();
  });

  it("absorbs a stale cancel after a later process has confirmed the share", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "stale-sender");
    const receiver = await actor(origin, "stale-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    await origin.kill();

    const advanced = await startProcess();
    expect((await claim(advanced, receiver, created.share.token)).orchestration.bindStatus).toBe(
      "BOUND",
    );
    const recipientRevision = (
      await advanced.runtime.productStore.loadProductSnapshot(receiver.userId)
    ).revision;
    await advanced.kill();

    const stale = await startProcess();
    const callback = await completeTelegramShare(
      stale.runtime,
      authContext(sender.userId, sender.telegram),
      { shareAttemptId: created.share.attempt_id, outcome: "CANCELLED" },
    );
    expect(callback?.status).toBe("APPLIED");
    expect(callback?.result).toBe("IGNORE_NOT_ALLOWED");
    expect(callback?.persisted).toBe(true);
    expect(callback?.effects).toEqual([]);
    expect(callback?.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect((await shareByOwner(stale, sender.userId)).status).toBe("CONFIRMED");
    expect((await banById(stale, created.share.created_ban_id!)).receiver_id).toBe(receiver.userId);
    expect(await incomingCount(stale, created.share.created_ban_id!)).toBe(1);
    expect((await stale.runtime.productStore.loadProductSnapshot(receiver.userId)).revision).toBe(
      recipientRevision,
    );
    expect((await stale.runtime.productStore.loadProductSnapshot(sender.userId)).revision).toBe(
      created.opened.revision + 1,
    );
    await stale.kill();
  });

  it("reloads each durable share state without allocating another row", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "repeat-sender");
    const receiver = await actor(origin, "repeat-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    await origin.kill();

    const states: ShareRow[] = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const next = await startProcess();
      states.push(await shareByOwner(next, sender.userId));
      await next.kill();
    }
    expect(states[0]).toEqual(states[1]);
    expect(states[0]?.status).toBe("ACTIVE");

    const claimer = await startProcess();
    await claim(claimer, receiver, created.share.token);
    await claimer.kill();
    for (let restart = 0; restart < 2; restart += 1) {
      const next = await startProcess();
      const share = await shareByOwner(next, sender.userId);
      const loaded = await next.runtime.productStore.loadProductSnapshot(receiver.userId);
      expect(share.status).toBe("CONFIRMED");
      expect(share.token).toBe(created.share.token);
      expect(await incomingCount(next, created.share.created_ban_id!)).toBe(1);
      expect(loaded.snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(await rowCount(next, "bans", "ban_id", created.share.created_ban_id!)).toBe(1);
      await next.kill();
    }
  });

  it("preserves token identity across restart and rejects a duplicate token", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "token-sender");
    await seed(origin, sender.userId, templateSender());
    const created = await openShare(origin, sender);
    const storedToken = created.share.token;
    await origin.kill();

    const restarted = await startProcess();
    const found = await restarted.db.sql.query<ShareRow>(SQL.selectShareByToken, [storedToken]);
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.attempt_id).toBe(created.share.attempt_id);
    const freshTokens = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      freshTokens.add(restarted.runtime.allocateId("share-token"));
    }
    expect(freshTokens.has(storedToken)).toBe(false);
    const duplicate = restarted.db.sql.query(SQL.upsertShare, [
      `share-${randomUUID()}`,
      sender.userId,
      JSON.stringify(validCreateDraft("TEMPLATE")),
      storedToken,
      "ACTIVE",
      null,
    ]);
    await expect(duplicate).rejects.toMatchObject({ code: "23505" });
    expect(await rowCount(restarted, "share_operations", "token", storedToken)).toBe(1);
    await restarted.kill();
  });

  it("follows the current pending-entry retry without a second Incoming Ban", async () => {
    const origin = await startProcess();
    const sender = await actor(origin, "entry-sender");
    const receiver = await actor(origin, "entry-receiver");
    await seed(origin, sender.userId, templateSender());
    await seed(origin, receiver.userId, lobby());
    const created = await openShare(origin, sender);
    const claimed = await claim(origin, receiver, created.share.token);
    expect(claimed.orchestration.bindStatus).toBe("BOUND");
    const before = await origin.runtime.productStore.loadProductSnapshot(receiver.userId);
    const itemIds = Object.keys(before.snapshot.extended.entities.notificationItems);
    await origin.kill();

    const restarted = await startProcess();
    const follow = await resolvePendingExternalEntryIfOnline(
      restarted.runtime,
      authContext(receiver.userId, receiver.telegram),
    );
    const after = await restarted.runtime.productStore.loadProductSnapshot(receiver.userId);
    expect(await incomingCount(restarted, created.share.created_ban_id!)).toBe(1);
    expect(Object.keys(after.snapshot.extended.entities.notificationItems)).toEqual(itemIds);
    expect((await banById(restarted, created.share.created_ban_id!)).receiver_id).toBe(
      receiver.userId,
    );
    expect(before.snapshot.extended.pendingExternalEntry?.shareTargetBanId).toBe(
      created.share.created_ban_id,
    );
    expect(follow?.orchestration.outcome).toBe("RESOLVED");
    expect(follow?.orchestration.bindStatus).toBe("ALREADY_BOUND");
    expect(after.revision).toBe(before.revision + 1);
    await restarted.kill();
  });
});
