/**
 * Pass 12D-1C — isolated PostgreSQL concurrency scenarios PG-01..PG-17.
 * Requires MVP17_TEST_DATABASE_URL pointing at a disposable loopback database.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import {
  emptySnapshot,
  reduce,
  type Ban,
  type BanId,
  type CheckPair,
  type CheckPairId,
  type DomainTimerId,
  type Effect,
  type NotificationItemId,
  type OperationId,
  type ProductSnapshot,
  type ShareOperation,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  eventOf,
  kernelContext,
  makeBan,
  makeTimer,
  pendingOp,
  shareOp,
  statusItem,
  withControlState,
  withEntities,
  withOperation,
} from "../../product-model/src/kernel.fixtures.ts";
import { asInstant, counterAllocator } from "../../product-model/src/kernel/snapshot.ts";
import type { DurationMinutes } from "@98plus/product-model";
import {
  assertNoHeldLockExpansion,
  baselineFromLoadedSnapshot,
  buildLockPlan,
  deriveEntityWriteSet,
  sharedWriteContextForTransition,
} from "./hybrid-persist.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { SQL } from "./sql.ts";
import {
  assertConnectedTestDatabase,
  assertMvp17TestSchemaName,
  assertSafeMvp17TestDatabaseUrl,
} from "./test-database-guard.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const rawDatabaseUrl = process.env.MVP17_TEST_DATABASE_URL;
if (rawDatabaseUrl !== undefined && rawDatabaseUrl.trim().length > 0) {
  assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function appliedResult(snapshot: ProductSnapshot, effects: readonly Effect[]): TransitionResult {
  return {
    outcome: "APPLIED",
    result: "TRANSITION",
    controlState: snapshot.controlState,
    snapshot,
    effects,
    declaredEffects: [],
    traces: [],
    composition: "GLOBAL_THEN_LOCAL",
    error: null,
  };
}

describe.skipIf(!rawDatabaseUrl)("12D-1C PostgreSQL concurrency (PG-01..PG-17)", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;

  beforeAll(async () => {
    const safe = assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
    assertMvp17TestSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: safe.connectionString,
      max: 8,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_12d1c -c deadlock_timeout=200`,
    });
    await assertConnectedTestDatabase((sql, params) => db.sql.query(sql, params ?? []), safe);
    await db.sql.query(`CREATE SCHEMA ${schema}`, []);
    await db.sql.query(`SET search_path TO ${schema}`, []);
    await db.applyMigrations();
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    assertMvp17TestSchemaName(schema);
    await db.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await db.close();
  });

  async function identity(label: string): Promise<UserId> {
    const store = new PostgresIdentityStore(db.sql);
    const user = await store.resolveByTelegramUserId(asTelegramUserId(`${label}-${randomUUID()}`));
    return user.userId;
  }

  async function seed(userId: UserId, snapshot: ProductSnapshot) {
    return PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(userId, snapshot);
  }

  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const result = await db.sql.query<{ waiting: number }>(
        `SELECT COUNT(*)::int AS waiting
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = 'mvp17_12d1c'
           AND wait_event_type = 'Lock'
           AND pid <> pg_backend_pid()`,
        [],
      );
      if (Number(result.rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function contend<T>(
    lockSql: string,
    lockParams: readonly unknown[],
    waiters: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const held = deferred();
    const release = deferred();
    const holder = db.sql.transaction(async (tx) => {
      await tx.query(lockSql, lockParams);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const pending = run();
    try {
      await waitForLockWaiters(waiters);
    } finally {
      release.resolve();
    }
    try {
      return await pending;
    } finally {
      await holder;
    }
  }

  it("PG-01 cross-owner NotificationItem survival under overlapping writes", async () => {
    const senderId = await identity("pg01-sender");
    const receiverId = await identity("pg01-receiver");
    const banId = branded<BanId>(`ban-pg01-${randomUUID()}`);
    const senderItem = statusItem({
      id: branded<NotificationItemId>(`item-s-${randomUUID()}`),
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "BANTASTIC",
    });
    const receiverItem = statusItem({
      id: branded<NotificationItemId>(`item-r-${randomUUID()}`),
      ownerId: receiverId,
      banId,
      role: "RECEIVER",
      status: "BANTASTIC",
    });
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "BANTASTIC",
      acceptance: "ACCEPTED",
    });
    const senderSeed = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [senderItem.id]: senderItem },
      }),
    );
    const receiverSeed = await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [receiverItem.id]: receiverItem },
      }),
    );
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const nextBan: Ban = { ...ban, status: "OVERBOARD" };
    const senderNext = withEntities(senderSeed.snapshot, {
      bans: { [banId]: nextBan },
      notificationItems: { [senderItem.id]: senderItem },
    });
    const receiverClose = reduce(receiverSeed.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: receiverId,
    });
    expect(receiverClose.outcome).toBe("APPLIED");
    const settled = await contend(SQL.selectBanForUpdate, [banId], 1, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: senderId,
          expectedRevision: senderSeed.revision,
          result: appliedResult(senderNext, [{ type: "UPSERT_BAN", ban: nextBan }]),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(senderSeed.snapshot, senderSeed.revision),
        }),
        storeB.persistTransition({
          currentUserId: receiverId,
          expectedRevision: receiverSeed.revision,
          result: receiverClose,
          baseline: baselineFromLoadedSnapshot(receiverSeed.snapshot, receiverSeed.revision),
        }),
      ]),
    );
    expect(settled.some((s) => s.status === "fulfilled")).toBe(true);
    const senderAfter = await storeA.loadProductSnapshot(senderId);
    const receiverAfter = await storeB.loadProductSnapshot(receiverId);
    expect(senderAfter.snapshot.extended.entities.notificationItems[senderItem.id]).toMatchObject({
      id: senderItem.id,
      ownerId: senderId,
      kind: "STATUS",
    });
    expect(
      receiverAfter.snapshot.extended.entities.notificationItems[receiverItem.id],
    ).toMatchObject({ id: receiverItem.id, ownerId: receiverId, kind: "STATUS" });
    const itemRows = await db.sql.query<{ item_id: string; owner_id: string }>(
      "SELECT item_id, owner_id FROM notification_items WHERE ban_id = $1",
      [banId],
    );
    expect(itemRows.rows).toHaveLength(2);
  }, 30_000);

  it("PG-02 concurrent E-20/E-23 terminal status serialization", async () => {
    const senderId = await identity("pg02-sender");
    const receiverId = await identity("pg02-receiver");
    const banId = branded<BanId>(`ban-pg02-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "ACCEPTED",
    });
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: ban },
    });
    const seeded = await seed(senderId, world);
    await seed(receiverId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const overboard: Ban = { ...ban, status: "OVERBOARD" };
    const bantastic: Ban = { ...ban, status: "BANTASTIC" };
    const settled = await contend(SQL.selectBanForUpdate, [banId], 1, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: appliedResult(withEntities(seeded.snapshot, { bans: { [banId]: overboard } }), [
            { type: "UPSERT_BAN", ban: overboard },
          ]),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
        storeB.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: appliedResult(withEntities(seeded.snapshot, { bans: { [banId]: bantastic } }), [
            { type: "UPSERT_BAN", ban: bantastic },
          ]),
          appliedRule: { eventId: "E-23", branch: "bantastic" },
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
      ]),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
    const durable = await db.sql.query<{ status: string | null }>(
      "SELECT status FROM bans WHERE ban_id = $1",
      [banId],
    );
    expect(["OVERBOARD", "BANTASTIC"]).toContain(durable.rows[0]?.status);
    const sessions = await db.sql.query<{ revision: string | number }>(
      "SELECT revision FROM product_user_sessions WHERE user_id = $1",
      [senderId],
    );
    expect(Number(sessions.rows[0]?.revision)).toBe(seeded.revision + 1);
  }, 30_000);

  it("PG-03 two owners same Ban — lock serializes; no lost updates", async () => {
    const senderId = await identity("pg03-sender");
    const receiverId = await identity("pg03-receiver");
    const banId = branded<BanId>(`ban-pg03-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: ban },
    });
    const senderSeed = await seed(senderId, world);
    const receiverSeed = await seed(receiverId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const accepted: Ban = { ...ban, acceptance: "ACCEPTED" };
    const overboard: Ban = { ...ban, status: "OVERBOARD", acceptance: "ACCEPTED" };
    const settled = await contend(SQL.selectBanForUpdate, [banId], 1, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: receiverId,
          expectedRevision: receiverSeed.revision,
          result: appliedResult(
            withEntities(receiverSeed.snapshot, { bans: { [banId]: accepted } }),
            [{ type: "UPSERT_BAN", ban: accepted }],
          ),
          appliedRule: { eventId: "E-30", branch: "accept" },
          baseline: baselineFromLoadedSnapshot(receiverSeed.snapshot, receiverSeed.revision),
        }),
        storeB.persistTransition({
          currentUserId: senderId,
          expectedRevision: senderSeed.revision,
          result: appliedResult(
            withEntities(senderSeed.snapshot, { bans: { [banId]: overboard } }),
            [{ type: "UPSERT_BAN", ban: overboard }],
          ),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(senderSeed.snapshot, senderSeed.revision),
        }),
      ]),
    );
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const durable = await db.sql.query<{ acceptance: string }>(
      "SELECT acceptance FROM bans WHERE ban_id = $1",
      [banId],
    );
    expect(durable.rows[0]?.acceptance).toBe("ACCEPTED");
  }, 30_000);

  it("PG-04 CheckPair answer nullification rejected under concurrent stale writes", async () => {
    const receiverId = await identity("pg04-receiver");
    const senderId = await identity("pg04-sender");
    const pairId = branded<CheckPairId>(`pair-pg04-${randomUUID()}`);
    const banId = branded<BanId>(`ban-pg04-${randomUUID()}`);
    const pair: CheckPair = {
      id: pairId,
      banId,
      receiverItemId: branded<NotificationItemId>(`${pairId}-r`),
      senderItemId: branded<NotificationItemId>(`${pairId}-s`),
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    const ban = makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" });
    const world = withEntities(withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER"), {
      bans: { [banId]: ban },
      checkPairs: { [pairId]: pair },
    });
    await seed(receiverId, world);
    await seed(senderId, world);
    const store = new PostgresProductStore(db.sql);
    const answered: CheckPair = { ...pair, receiverAnswer: "FULFILLED" };
    await store.withCheckPairLock(pairId, banId, receiverId, async (ctx) => {
      const loaded = await ctx.loadProductSnapshot(receiverId);
      await ctx.persistTransition({
        currentUserId: receiverId,
        expectedRevision: loaded.revision,
        result: appliedResult(withEntities(loaded.snapshot, { checkPairs: { [pairId]: answered } }), [
          { type: "UPSERT_CHECK_PAIR", pair: answered },
        ]),
        baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
      });
    });
    await expect(
      store.withCheckPairLock(pairId, banId, receiverId, async (ctx) => {
        const loaded = await ctx.loadProductSnapshot(receiverId);
        const staleClear: CheckPair = {
          ...pair,
          receiverAnswer: null,
          senderAnswer: "FULFILLED",
        };
        return ctx.persistTransition({
          currentUserId: receiverId,
          expectedRevision: loaded.revision,
          result: appliedResult(
            withEntities(loaded.snapshot, { checkPairs: { [pairId]: staleClear } }),
            [{ type: "UPSERT_CHECK_PAIR", pair: staleClear }],
          ),
          baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
        });
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const durable = await db.sql.query<{
      receiver_answer: string | null;
      sender_answer: string | null;
      resulting_status: string | null;
    }>(
      "SELECT receiver_answer, sender_answer, resulting_status FROM check_pairs WHERE pair_id = $1",
      [pairId],
    );
    expect(durable.rows[0]?.receiver_answer).toBe("FULFILLED");
    expect(durable.rows[0]?.sender_answer).toBeNull();
    expect(durable.rows[0]?.resulting_status).toBeNull();
  }, 30_000);

  it("PG-05 Timer expiry race — RUNNING→EXPIRED and checkPairCreated stick", async () => {
    const senderId = await identity("pg05-sender");
    const receiverId = await identity("pg05-receiver");
    const banId = branded<BanId>(`ban-pg05-${randomUUID()}`);
    const timerId = branded<DomainTimerId>(`timer-pg05-${randomUUID()}`);
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" }) },
      domainTimers: {
        [timerId]: makeTimer({
          id: timerId,
          banId,
          startedAt: asInstant(0),
          state: "RUNNING",
          checkPairCreated: false,
        }),
      },
    });
    const seeded = await seed(senderId, world);
    await seed(receiverId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const first = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: senderId,
      allocateId: counterAllocator(501),
    });
    const second = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: senderId,
      allocateId: counterAllocator(502),
    });
    expect(first.outcome).toBe("APPLIED");
    expect(second.outcome).toBe("APPLIED");
    const settled = await contend(SQL.selectSessionForUpdate, [senderId], 2, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: first,
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
        storeB.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: second,
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
      ]),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const timer = await db.sql.query<{ state: string; check_pair_created: boolean }>(
      "SELECT state, check_pair_created FROM domain_timers WHERE timer_id = $1",
      [timerId],
    );
    expect(timer.rows[0]?.state).toBe("EXPIRED");
    expect(timer.rows[0]?.check_pair_created).toBe(true);
  }, 30_000);

  it("PG-06 share claim vs ordinary Ban transition — no deadlock", async () => {
    const senderId = await identity("pg06-sender");
    const receiverId = await identity("pg06-receiver");
    const banId = branded<BanId>(`ban-pg06-${randomUUID()}`);
    const attemptId = branded<ShareOperation["attemptId"]>(`attempt-${randomUUID()}`);
    const token = `token-pg06-${randomUUID()}` as unknown as ShareOperation["token"];
    await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({
            id: banId,
            senderId,
            receiverId: null,
            acceptance: "PENDING",
            status: null,
          }),
        },
        shareOperations: {
          [attemptId]: shareOp({
            attemptId,
            token,
            createdBanId: banId,
            draft: {
              origin: "TEMPLATE",
              selectedContactId: null,
              banText: "pg06",
              durationMinutes: 21 as DurationMinutes,
              proposalId: null,
            },
          }),
        },
      }),
    );
    await seed(receiverId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const store = new PostgresProductStore(db.sql);
    const senderLoaded = await store.loadProductSnapshot(senderId);
    const closed = reduce(senderLoaded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: senderId,
    });
    expect(closed.outcome).toBe("APPLIED");
    const settled = await Promise.allSettled([
      store.claimTemplateShare({
        receiverId,
        token: String(token),
        reduceClaim: (context) =>
          reduce(
            withEntities(context.receiver.snapshot, {
              shareOperations: { [context.share.attemptId]: context.share },
            }),
            eventOf("TELEGRAM_SHARE_LINK.RESOLVED", {
              targetBanId: banId,
              receiverId,
              incomingBanItemId: branded<NotificationItemId>(`incoming-${randomUUID()}`),
              shareAttemptId: attemptId,
              shareOwnerId: senderId,
            }),
            { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(601) },
          ),
        observeSender: () => null,
      }),
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: senderLoaded.revision,
        result: closed,
        baseline: baselineFromLoadedSnapshot(senderLoaded.snapshot, senderLoaded.revision),
      }),
    ]);
    expect(
      settled.some(
        (s) => s.status === "rejected" && (s.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(false);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("PG-07 duplicate claim — exactly one receiver binding", async () => {
    const senderId = await identity("pg07-sender");
    const firstId = await identity("pg07-a");
    const secondId = await identity("pg07-b");
    const banId = branded<BanId>(`ban-pg07-${randomUUID()}`);
    const attemptId = branded<ShareOperation["attemptId"]>(`attempt-${randomUUID()}`);
    const token = `token-pg07-${randomUUID()}` as unknown as ShareOperation["token"];
    await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({ id: banId, senderId, receiverId: null, acceptance: "PENDING" }),
        },
        shareOperations: {
          [attemptId]: shareOp({
            attemptId,
            token,
            createdBanId: banId,
            draft: {
              origin: "TEMPLATE",
              selectedContactId: null,
              banText: "pg07",
              durationMinutes: 21 as DurationMinutes,
              proposalId: null,
            },
          }),
        },
      }),
    );
    await seed(firstId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    await seed(secondId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const claim = (store: PostgresProductStore, receiverId: UserId) =>
      store.claimTemplateShare({
        receiverId,
        token: String(token),
        reduceClaim: (context) =>
          reduce(
            withEntities(context.receiver.snapshot, {
              shareOperations: { [context.share.attemptId]: context.share },
            }),
            eventOf("TELEGRAM_SHARE_LINK.RESOLVED", {
              targetBanId: banId,
              receiverId,
              incomingBanItemId: branded<NotificationItemId>(`incoming-${randomUUID()}`),
              shareAttemptId: attemptId,
              shareOwnerId: senderId,
            }),
            { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(701) },
          ),
        observeSender: () => null,
      });
    const settled = await contend(SQL.selectShareByTokenForUpdate, [token], 2, () =>
      Promise.allSettled([claim(storeA, firstId), claim(storeB, secondId)]),
    );
    const results = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
    expect(results.filter((r) => r?.status === "CLAIMED")).toHaveLength(1);
    expect(results.filter((r) => r?.status === "CONFLICT")).toHaveLength(1);
    expect((await db.sql.query("SELECT ban_id FROM bans WHERE ban_id = $1", [banId])).rows).toHaveLength(
      1,
    );
  }, 30_000);

  it("PG-08 withCheckPairLock vs ordinary write — no deadlock", async () => {
    const receiverId = await identity("pg08-receiver");
    const senderId = await identity("pg08-sender");
    const pairId = branded<CheckPairId>(`pair-pg08-${randomUUID()}`);
    const banId = branded<BanId>(`ban-pg08-${randomUUID()}`);
    const pair: CheckPair = {
      id: pairId,
      banId,
      receiverItemId: branded<NotificationItemId>(`${pairId}-r`),
      senderItemId: branded<NotificationItemId>(`${pairId}-s`),
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    const ban = makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" });
    const world = withEntities(withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER"), {
      bans: { [banId]: ban },
      checkPairs: { [pairId]: pair },
    });
    const seeded = await seed(receiverId, world);
    await seed(senderId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const answered: CheckPair = { ...pair, receiverAnswer: "FULFILLED" };
    const answerResult = appliedResult(
      withEntities(seeded.snapshot, { checkPairs: { [pairId]: answered } }),
      [{ type: "UPSERT_CHECK_PAIR", pair: answered }],
    );
    const closed = reduce(seeded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: receiverId,
    });
    expect(closed.outcome).toBe("APPLIED");
    const settled = await contend(SQL.selectSessionForUpdate, [receiverId], 2, () =>
      Promise.allSettled([
        storeA.withCheckPairLock(pairId, banId, receiverId, (ctx) =>
          ctx.persistTransition({
            currentUserId: receiverId,
            expectedRevision: seeded.revision,
            result: answerResult,
            baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
          }),
        ),
        storeB.persistTransition({
          currentUserId: receiverId,
          expectedRevision: seeded.revision,
          result: closed,
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
      ]),
    );
    expect(
      settled.some(
        (s) => s.status === "rejected" && (s.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(false);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
  }, 30_000);

  it("PG-09 multi-Ban lock order ascending under reversed concurrent requests", async () => {
    const userId = await identity("pg09-user");
    const banLow = branded<BanId>(`ban-a-${randomUUID()}`);
    const banHigh = branded<BanId>(`ban-z-${randomUUID()}`);
    expect(banLow.localeCompare(banHigh)).toBeLessThan(0);
    const lowBan = makeBan({ id: banLow, senderId: userId, receiverId: null });
    const highBan = makeBan({ id: banHigh, senderId: userId, receiverId: null });
    await seed(
      userId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banLow]: lowBan, [banHigh]: highBan },
      }),
    );
    const planReversed = buildLockPlan({
      sessionUserIds: [userId],
      writeSet: deriveEntityWriteSet([
        { type: "UPSERT_BAN", ban: highBan },
        { type: "UPSERT_BAN", ban: lowBan },
      ]),
    });
    const ascending = [banLow, banHigh].sort((a, b) => a.localeCompare(b));
    expect(planReversed.banIds).toEqual(ascending);
    const orderA: string[] = [];
    const orderB: string[] = [];
    const settled = await Promise.allSettled([
      db.sql.transaction(async (tx) => {
        for (const id of ascending) {
          orderA.push(id);
          await tx.query(SQL.selectBanForUpdate, [id]);
        }
      }),
      db.sql.transaction(async (tx) => {
        for (const id of [...[banHigh, banLow]].sort((a, b) => a.localeCompare(b))) {
          orderB.push(id);
          await tx.query(SQL.selectBanForUpdate, [id]);
        }
      }),
    ]);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(orderA).toEqual(ascending);
    expect(orderB).toEqual(ascending);
    const lowFirst = deferred();
    const highFirst = deferred();
    const opposite = await Promise.allSettled([
      db.sql.transaction(async (tx) => {
        await tx.query(SQL.selectBanForUpdate, [banLow]);
        lowFirst.resolve();
        await highFirst.promise;
        await tx.query(SQL.selectBanForUpdate, [banHigh]);
      }),
      db.sql.transaction(async (tx) => {
        await tx.query(SQL.selectBanForUpdate, [banHigh]);
        highFirst.resolve();
        await lowFirst.promise;
        await tx.query(SQL.selectBanForUpdate, [banLow]);
      }),
    ]);
    expect(
      opposite.some(
        (s) =>
          s.status === "rejected" &&
          ((s.reason as { code?: string }).code === "40P01" ||
            (s.reason as { code?: string }).code === "55P03"),
      ),
    ).toBe(true);
  }, 30_000);

  it("PG-10 P2-LOCK-EXPAND — nested writeOn rejects Ban lock expansion", async () => {
    const userId = await identity("pg10-user");
    const banHeld = branded<BanId>(`ban-z-${randomUUID()}`);
    const banExtra = branded<BanId>(`ban-a-${randomUUID()}`);
    expect(banExtra.localeCompare(banHeld)).toBeLessThan(0);
    const heldBan = makeBan({ id: banHeld, senderId: userId, receiverId: null });
    const extraBan = makeBan({ id: banExtra, senderId: userId, receiverId: null });
    const seeded = await seed(
      userId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banHeld]: heldBan, [banExtra]: extraBan },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    expect(() =>
      assertNoHeldLockExpansion(
        {
          sessionUserIds: new Set([userId]),
          banIds: new Set([banHeld]),
          timerIds: new Set(),
          checkPairIds: new Set(),
        },
        buildLockPlan({
          sessionUserIds: [userId],
          writeSet: deriveEntityWriteSet([
            { type: "UPSERT_BAN", ban: heldBan },
            { type: "UPSERT_BAN", ban: extraBan },
          ]),
        }),
      ),
    ).toThrow(/expands held Ban locks/);

    const pairId = branded<CheckPairId>(`pair-pg10-${randomUUID()}`);
    const pair: CheckPair = {
      id: pairId,
      banId: banHeld,
      receiverItemId: branded<NotificationItemId>(`${pairId}-r`),
      senderItemId: branded<NotificationItemId>(`${pairId}-s`),
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    await seed(
      userId,
      withEntities(seeded.snapshot, {
        bans: { [banHeld]: heldBan, [banExtra]: extraBan },
        checkPairs: { [pairId]: pair },
      }),
    );
    await expect(
      store.withCheckPairLock(pairId, banHeld, userId, async (ctx) => {
        const loaded = await ctx.loadProductSnapshot(userId);
        const nextHeld: Ban = { ...heldBan, status: "OVERBOARD" };
        const nextExtra: Ban = { ...extraBan, status: "BANTASTIC" };
        return ctx.persistTransition({
          currentUserId: userId,
          expectedRevision: loaded.revision,
          result: appliedResult(
            withEntities(loaded.snapshot, {
              bans: { [banHeld]: nextHeld, [banExtra]: nextExtra },
            }),
            [
              { type: "UPSERT_BAN", ban: nextHeld },
              { type: "UPSERT_BAN", ban: nextExtra },
            ],
          ),
          baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
          appliedRule: { eventId: "E-20", branch: "overboard" },
        });
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  }, 30_000);

  it("PG-11 Session CAS failure prevents shared Ban commit", async () => {
    const senderId = await identity("pg11-sender");
    const receiverId = await identity("pg11-receiver");
    const banId = branded<BanId>(`ban-pg11-${randomUUID()}`);
    const ban = makeBan({ id: banId, senderId, receiverId, banText: "cas" });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban, status: "OVERBOARD" };
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision + 99,
        result: appliedResult(withEntities(seeded.snapshot, { bans: { [banId]: next } }), [
          { type: "UPSERT_BAN", ban: next },
        ]),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const durable = await db.sql.query<{ status: string | null; ban_text: string }>(
      "SELECT status, ban_text FROM bans WHERE ban_id = $1",
      [banId],
    );
    expect(durable.rows[0]?.status).toBeNull();
    expect(durable.rows[0]?.ban_text).toBe("cas");
    expect((await store.loadProductSnapshot(senderId)).revision).toBe(seeded.revision);
  }, 30_000);

  it("PG-12 rollback after shared write — failNextWriteAfterBans", async () => {
    const senderId = await identity("pg12-sender");
    const receiverId = await identity("pg12-receiver");
    const banId = branded<BanId>(`ban-pg12-${randomUUID()}`);
    const opId = branded<OperationId>(`op-pg12-${randomUUID()}`);
    const ban = makeBan({ id: banId, senderId, receiverId, banText: "before" });
    const world = withOperation(
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
      pendingOp({ operationId: opId }),
    );
    const seeded = await seed(senderId, world);
    const store = new PostgresProductStore(db.sql);
    store.failNextWriteAfterBans();
    const next: Ban = { ...ban, banText: "after", status: "OVERBOARD" };
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: appliedResult(withEntities(seeded.snapshot, { bans: { [banId]: next } }), [
          { type: "UPSERT_BAN", ban: next },
        ]),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const durable = await db.sql.query<{ status: string | null; ban_text: string }>(
      "SELECT status, ban_text FROM bans WHERE ban_id = $1",
      [banId],
    );
    expect(durable.rows[0]?.ban_text).toBe("before");
    expect(durable.rows[0]?.status).toBeNull();
    const session = await store.loadProductSnapshot(senderId);
    expect(session.revision).toBe(seeded.revision);
    expect(session.snapshot.runtime.pendingOperations[opId]).toBeTruthy();
  }, 30_000);

  it("PG-13 CLEAR_OPERATION deletes target only", async () => {
    const userId = await identity("pg13-user");
    const opClear = branded<OperationId>(`op-clear-${randomUUID()}`);
    const opKeep = branded<OperationId>(`op-keep-${randomUUID()}`);
    let world = withControlState(emptySnapshot(), "RIM.LOBBY");
    world = withOperation(world, pendingOp({ operationId: opClear }));
    world = withOperation(world, pendingOp({ operationId: opKeep }));
    const seeded = await seed(userId, world);
    const store = new PostgresProductStore(db.sql);
    const cleared = {
      ...seeded.snapshot,
      runtime: {
        ...seeded.snapshot.runtime,
        pendingOperations: {
          [opKeep]: seeded.snapshot.runtime.pendingOperations[opKeep]!,
        },
      },
    };
    await store.persistTransition({
      currentUserId: userId,
      expectedRevision: seeded.revision,
      result: appliedResult(cleared, [
        { type: "CLEAR_OPERATION", operationId: opClear },
        { type: "MARK_OPERATION_RESULT_APPLIED", operationId: opKeep },
      ]),
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    const ops = await db.sql.query<{ operation_id: string }>(
      "SELECT operation_id FROM pending_operations WHERE owner_id = $1 ORDER BY operation_id",
      [userId],
    );
    expect(ops.rows.map((r) => r.operation_id)).toEqual([opKeep]);
  }, 30_000);

  it("PG-14 FK lock interactions — opposite order deadlocks; canonical order does not", async () => {
    const senderId = await identity("pg14-sender");
    const receiverId = await identity("pg14-receiver");
    const banId = branded<BanId>(`ban-pg14-${randomUUID()}`);
    const timerId = branded<DomainTimerId>(`timer-pg14-${randomUUID()}`);
    const pairId = branded<CheckPairId>(`pair-pg14-${randomUUID()}`);
    const itemId = branded<NotificationItemId>(`item-pg14-${randomUUID()}`);
    const ban = makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" });
    const timer = makeTimer({ id: timerId, banId, startedAt: asInstant(0) });
    const pair: CheckPair = {
      id: pairId,
      banId,
      receiverItemId: itemId,
      senderItemId: branded<NotificationItemId>(`${itemId}-s`),
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    const item = statusItem({ id: itemId, ownerId: senderId, banId, status: "BANTASTIC" });
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: ban },
      domainTimers: { [timerId]: timer },
      checkPairs: { [pairId]: pair },
      notificationItems: { [itemId]: item },
    });
    await seed(senderId, world);
    await seed(receiverId, world);
    const sessionHeld = deferred();
    const pairHeld = deferred();
    const opposite = await Promise.allSettled([
      db.sql.transaction(async (tx) => {
        await tx.query(SQL.selectBanForUpdate, [banId]);
        sessionHeld.resolve();
        await pairHeld.promise;
        await tx.query(SQL.selectPairForUpdate, [pairId]);
      }),
      db.sql.transaction(async (tx) => {
        await sessionHeld.promise;
        await tx.query(SQL.selectPairForUpdate, [pairId]);
        pairHeld.resolve();
        await tx.query(SQL.selectBanForUpdate, [banId]);
      }),
    ]);
    expect(
      opposite.some(
        (s) => s.status === "rejected" && (s.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(true);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const loaded = await storeA.loadProductSnapshot(senderId);
    const nextBan: Ban = { ...ban, status: "OVERBOARD" };
    const closed = reduce(loaded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: senderId,
    });
    expect(closed.outcome).toBe("APPLIED");
    const ordered = await contend(SQL.selectBanForUpdate, [banId], 1, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: senderId,
          expectedRevision: loaded.revision,
          result: appliedResult(withEntities(loaded.snapshot, { bans: { [banId]: nextBan } }), [
            { type: "UPSERT_BAN", ban: nextBan },
          ]),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
        }),
        storeB.persistTransition({
          currentUserId: senderId,
          expectedRevision: loaded.revision,
          result: closed,
          baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
        }),
      ]),
    );
    expect(
      ordered.some(
        (s) => s.status === "rejected" && (s.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(false);
    expect(ordered.filter((s) => s.status === "fulfilled")).toHaveLength(1);
  }, 30_000);

  it("PG-15 E-08/E-10 create-only — existing Ban unchanged", async () => {
    const userId = await identity("pg15-user");
    const banId = branded<BanId>(`ban-pg15-${randomUUID()}`);
    const durable = makeBan({
      id: banId,
      senderId: userId,
      receiverId: null,
      status: null,
      acceptance: "PENDING",
      banText: "durable",
    });
    const seeded = await seed(
      userId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: durable } }),
    );
    const store = new PostgresProductStore(db.sql);
    const mutated: Ban = {
      ...durable,
      status: "OVERBOARD",
      acceptance: "ACCEPTED",
      banText: "hijack",
    };
    await store.persistTransition({
      currentUserId: userId,
      expectedRevision: seeded.revision,
      result: appliedResult(withEntities(seeded.snapshot, { bans: { [banId]: mutated } }), [
        { type: "UPSERT_BAN", ban: mutated },
      ]),
      appliedRule: { eventId: "E-10", branch: "create" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    const row = await db.sql.query<{
      status: string | null;
      acceptance: string;
      ban_text: string;
    }>("SELECT status, acceptance, ban_text FROM bans WHERE ban_id = $1", [banId]);
    expect(row.rows[0]).toEqual({ status: null, acceptance: "PENDING", ban_text: "durable" });
  }, 30_000);

  it("PG-16 missing baseline fail-closed — no shared mutations", async () => {
    const userId = await identity("pg16-user");
    const banId = branded<BanId>(`ban-pg16-${randomUUID()}`);
    const durable = makeBan({
      id: banId,
      senderId: userId,
      receiverId: null,
      banText: "baseline",
    });
    const seeded = await seed(
      userId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: durable } }),
    );
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...durable, status: "OVERBOARD" };
    await expect(
      store.persistTransition({
        currentUserId: userId,
        expectedRevision: seeded.revision,
        result: appliedResult(withEntities(seeded.snapshot, { bans: { [banId]: next } }), [
          { type: "UPSERT_BAN", ban: next },
        ]),
        appliedRule: { eventId: "E-20", branch: "overboard" },
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const row = await db.sql.query<{ status: string | null }>(
      "SELECT status FROM bans WHERE ban_id = $1",
      [banId],
    );
    expect(row.rows[0]?.status).toBeNull();
    expect((await store.loadProductSnapshot(userId)).revision).toBe(seeded.revision);
  }, 30_000);

  it("PG-17 write-set accepts future materializer Item IDs (no materializer impl)", async () => {
    const futureId = branded<NotificationItemId>(`item-mat-${randomUUID()}`);
    expect(deriveEntityWriteSet([], { materializerWrittenItemIds: [futureId] }).itemIds).toEqual([
      futureId,
    ]);
    const userId = await identity("pg17-user");
    const seeded = await seed(userId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const store = new PostgresProductStore(db.sql);
    const closed = reduce(seeded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: userId,
    });
    expect(closed.outcome).toBe("APPLIED");
    const ctx = sharedWriteContextForTransition({
      currentUserId: userId,
      expectedRevision: seeded.revision,
      result: closed,
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect(ctx.materializerWrittenItemIds).toEqual([]);
    await store.persistTransition({
      currentUserId: userId,
      expectedRevision: seeded.revision,
      result: closed,
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect(ctx.writeSet.itemIds).toEqual([]);
  }, 30_000);
});
