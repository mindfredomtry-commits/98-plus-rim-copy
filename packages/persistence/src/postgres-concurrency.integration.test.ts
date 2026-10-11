import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import {
  emptySnapshot,
  reduce,
  type BanId,
  type CheckPair,
  type CheckPairId,
  type NotificationItemId,
  type DomainTimerId,
  type OperationId,
  type ProductSnapshot,
  type ShareOperation,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  checkItem,
  eventOf,
  kernelContext,
  makeBan,
  makeChat,
  makeTimer,
  pendingOp,
  shareOp,
  validCreateDraft,
  withControlState,
  withEntities,
  withOperation,
} from "../../product-model/src/kernel.fixtures.ts";
import { asInstant, counterAllocator } from "../../product-model/src/kernel/snapshot.ts";
import type { DurationMinutes } from "@98plus/product-model";
import { PostgresProductStore } from "./postgres-store.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { SQL } from "./sql.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import type { RuntimeAttemptAuthority } from "./runtime-attempt-authority.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function appliedShape(snapshot: ProductSnapshot): TransitionResult {
  return { outcome: "APPLIED", snapshot } as TransitionResult;
}

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

describe.skipIf(!databaseUrl)("real PostgreSQL concurrency invariants", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    assertSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_pass3`,
    });
    await db.sql.query(`CREATE SCHEMA ${schema}`, []);
    await db.sql.query(`SET search_path TO ${schema}`, []);
    await db.applyMigrations();
    const isolation = await db.sql.query<{ isolation: string }>(
      "SELECT current_setting('transaction_isolation') AS isolation",
      [],
    );
    expect(isolation.rows[0]?.isolation).toBe("read committed");
  }, 30_000);

  afterAll(async () => {
    if (!db) {
      return;
    }
    assertSchemaName(schema);
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
    const deadline = Date.now() + 5_000;
    for (;;) {
      const result = await db.sql.query<{ waiting: number }>(
        `SELECT COUNT(*)::int AS waiting
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = 'mvp17_pass3'
           AND wait_event_type = 'Lock'
           AND pid <> pg_backend_pid()`,
        [],
      );
      const waiting = Number(result.rows[0]?.waiting ?? 0);
      if (waiting >= count) {
        return;
      }
      if (Date.now() > deadline) {
        const detail = await db.sql.query(
          `SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
           FROM pg_stat_activity
           WHERE datname = current_database()`,
          [],
        );
        throw new Error(
          `expected ${count} overlapping lock waiters, saw ${waiting}: ${JSON.stringify(detail.rows)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
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

  function expectPoolIdle(): void {
    const stats = db.stats();
    expect(stats.waiting).toBe(0);
    expect(stats.idle).toBe(stats.total);
    expect(stats.total).toBeGreaterThan(0);
  }

  async function expectNoIdleTransaction(): Promise<void> {
    const stuck = await db.sql.query<{ stuck: number }>(
      `SELECT COUNT(*)::int AS stuck
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = 'mvp17_pass3'
         AND state = 'idle in transaction'`,
      [],
    );
    expect(Number(stuck.rows[0]?.stuck ?? 0)).toBe(0);
    expectPoolIdle();
  }

  it("commits one same-revision write and lets the loser continue from the new revision", async () => {
    const senderId = await identity("revision-sender");
    const receiverId = await identity("revision-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const timerId = branded<DomainTimerId>(`timer-${randomUUID()}`);
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: makeBan({ id: banId, senderId, receiverId }) },
      domainTimers: { [timerId]: makeTimer({ id: timerId, banId, startedAt: asInstant(0) }) },
    });
    const seeded = await seed(senderId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const expired = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: senderId,
      allocateId: counterAllocator(1),
    });
    const closed = reduce(seeded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: senderId,
    });
    expect(expired.outcome).toBe("APPLIED");
    expect(closed.outcome).toBe("APPLIED");
    const loserPairIds = Object.keys(expired.snapshot.extended.entities.checkPairs);
    const settled = await contend(SQL.selectSessionForUpdate, [senderId], 2, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: expired,
        }),
        storeB.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: closed,
        }),
      ]),
    );
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toMatchObject({
      code: "REVISION_CONFLICT",
    });
    const loaded = await storeA.loadProductSnapshot(senderId);
    expect(loaded.revision).toBe(seeded.revision + 1);
    const winner = fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value.snapshot : null;
    expect(loaded.snapshot.controlState).toBe(winner?.controlState);
    expect(loaded.snapshot.extended.entities.checkPairs).toEqual(
      winner?.extended.entities.checkPairs,
    );
    if (loaded.snapshot.controlState !== "RIM.LOBBY") {
      for (const pairId of loserPairIds) {
        expect(loaded.snapshot.extended.entities.checkPairs[pairId as CheckPairId]).toBeUndefined();
      }
    }
    const follow = reduce(
      loaded.snapshot,
      eventOf("APP.NORMAL_OPEN", { serverState: {} as never }),
      {
        ...kernelContext(),
        currentUserId: senderId,
      },
    );
    const continued =
      follow.outcome === "APPLIED"
        ? follow
        : reduce(loaded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
            ...kernelContext(),
            currentUserId: senderId,
          });
    expect(continued.outcome).toBe("APPLIED");
    const saved = await storeA.persistTransition({
      currentUserId: senderId,
      expectedRevision: loaded.revision,
      result: continued,
    });
    expect(saved.revision).toBe(loaded.revision + 1);
    await expectNoIdleTransaction();
  });

  it("rolls a snapshot write back to the pre-transaction rows", async () => {
    const senderId = await identity("atomic-sender");
    const receiverId = await identity("atomic-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({ id: banId, senderId, receiverId, banText: "before" }),
        },
      }),
    );
    const itemId = `item-${randomUUID()}`;
    const originalBan = seeded.snapshot.extended.entities.bans[banId]!;
    const changed = withEntities(seeded.snapshot, {
      bans: {
        ...seeded.snapshot.extended.entities.bans,
        [banId]: { ...originalBan, banText: "after" },
      },
      notificationItems: {
        ...seeded.snapshot.extended.entities.notificationItems,
        [itemId]: checkItem("RECEIVER", {
          id: branded<NotificationItemId>(itemId),
          ownerId: senderId,
          banId,
          checkPairId: branded<CheckPairId>(`missing-${randomUUID()}`),
        }),
      },
    });
    const store = new PostgresProductStore(db.sql);
    store.failNextWriteAfterBans();
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: appliedShape(changed),
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const loaded = await store.loadProductSnapshot(senderId);
    expect(loaded.revision).toBe(seeded.revision);
    expect(loaded.snapshot.extended.entities.bans[banId]?.banText).toBe("before");
    expect(loaded.snapshot.extended.entities.notificationItems[itemId]).toBeUndefined();
    const counts = await db.sql.query<{
      sessions: number;
      bans: number;
      timers: number;
      pairs: number;
      items: number;
      operations: number;
      shares: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM product_user_sessions WHERE user_id = $1) AS sessions,
         (SELECT COUNT(*)::int FROM bans WHERE ban_id = $2) AS bans,
         (SELECT COUNT(*)::int FROM domain_timers WHERE ban_id = $2) AS timers,
         (SELECT COUNT(*)::int FROM check_pairs WHERE ban_id = $2) AS pairs,
         (SELECT COUNT(*)::int FROM notification_items WHERE ban_id = $2) AS items,
         (SELECT COUNT(*)::int FROM pending_operations WHERE owner_id = $1) AS operations,
         (SELECT COUNT(*)::int FROM share_operations WHERE owner_id = $1) AS shares`,
      [senderId, banId],
    );
    expect(counts.rows[0]).toEqual({
      sessions: 1,
      bans: 1,
      timers: 0,
      pairs: 0,
      items: 0,
      operations: 0,
      shares: 0,
    });
    await expectNoIdleTransaction();
  });

  it("lets exactly one recipient claim an active share token", async () => {
    const senderId = await identity("share-sender");
    const firstId = await identity("share-first");
    const secondId = await identity("share-second");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const attemptId = branded<ShareOperation["attemptId"]>(`attempt-${randomUUID()}`);
    const token = `token-${randomUUID()}` as unknown as ShareOperation["token"];
    const calls = { reduce: 0, observe: 0 };
    await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({
            id: banId,
            senderId,
            receiverId: null,
            banText: "share ban",
            durationMinutes: 21 as DurationMinutes,
            acceptance: "PENDING",
            status: null,
            boundViaTelegramShareLink: false,
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
              banText: "share ban",
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
    const claimFor = (receiverId: UserId, incomingId: string) =>
      storeA.claimTemplateShare({
        receiverId,
        token: String(token),
        reduceClaim: (context) => {
          calls.reduce += 1;
          return reduce(
            withEntities(context.receiver.snapshot, {
              shareOperations: { [context.share.attemptId]: context.share },
            }),
            eventOf("TELEGRAM_SHARE_LINK.RESOLVED", {
              targetBanId: banId,
              receiverId,
              incomingBanItemId: branded<NotificationItemId>(incomingId),
              shareAttemptId: attemptId,
              shareOwnerId: senderId,
            }),
            { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(3) },
          );
        },
        observeSender: () => {
          calls.observe += 1;
          return null;
        },
      });
    const settled = await contend(SQL.selectShareByTokenForUpdate, [token], 2, () =>
      Promise.allSettled([
        claimFor(firstId, `incoming-${randomUUID()}`),
        storeB.claimTemplateShare({
          receiverId: secondId,
          token: String(token),
          reduceClaim: (context) => {
            calls.reduce += 1;
            return reduce(
              withEntities(context.receiver.snapshot, {
                shareOperations: { [context.share.attemptId]: context.share },
              }),
              eventOf("TELEGRAM_SHARE_LINK.RESOLVED", {
                targetBanId: banId,
                receiverId: secondId,
                incomingBanItemId: branded<NotificationItemId>(`incoming-${randomUUID()}`),
                shareAttemptId: attemptId,
                shareOwnerId: senderId,
              }),
              { ...kernelContext(), currentUserId: secondId, allocateId: counterAllocator(4) },
            );
          },
          observeSender: () => {
            calls.observe += 1;
            return null;
          },
        }),
      ]),
    );
    expect(settled.every((item) => item.status === "fulfilled")).toBe(true);
    const results = settled.map((item) => (item.status === "fulfilled" ? item.value : null));
    const claimed = results.filter((item) => item?.status === "CLAIMED");
    const lost = results.filter((item) => item?.status === "CONFLICT");
    expect(claimed).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(calls.reduce).toBe(1);
    expect(calls.observe).toBe(1);
    const winnerId = claimed[0]?.status === "CLAIMED" ? claimed[0].loadedSnapshot : null;
    const ban = await storeA.getBanById(banId);
    expect(ban?.receiverId).not.toBeNull();
    const receiverId = ban?.receiverId;
    const winner = await storeA.loadProductSnapshot(receiverId!);
    const loserId = receiverId === firstId ? secondId : firstId;
    const loser = await storeA.loadProductSnapshot(loserId);
    expect(winner.snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(
      Object.values(winner.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "INCOMING_BAN",
      ),
    ).toHaveLength(1);
    expect(loser.snapshot.controlState).toBe("RIM.LOBBY");
    expect(Object.keys(loser.snapshot.extended.entities.notificationItems)).toEqual([]);
    expect(winnerId).toBeTruthy();
    const sender = await storeA.loadProductSnapshot(senderId);
    expect(sender.snapshot.extended.entities.shareOperations[attemptId]).toMatchObject({
      status: "CONFIRMED",
      createdBanId: banId,
    });
    const shares = await db.sql.query<{
      attempt_id: string;
      status: string;
      created_ban_id: string;
    }>("SELECT attempt_id, status, created_ban_id FROM share_operations WHERE token = $1", [token]);
    expect(shares.rows).toEqual([
      { attempt_id: attemptId, status: "CONFIRMED", created_ban_id: banId },
    ]);
    const incoming = await db.sql.query(
      "SELECT item_id FROM notification_items WHERE ban_id = $1 AND kind = 'INCOMING_BAN'",
      [banId],
    );
    expect(incoming.rows).toHaveLength(1);
    calls.reduce = 0;
    calls.observe = 0;
    const repeat = await storeA.claimTemplateShare({
      receiverId: receiverId!,
      token: String(token),
      reduceClaim: () => {
        calls.reduce += 1;
        throw new Error("duplicate claim must not reduce");
      },
      observeSender: () => {
        calls.observe += 1;
        throw new Error("duplicate claim must not observe the sender");
      },
    });
    expect(repeat.status).toBe("ALREADY_BOUND");
    expect(calls.reduce).toBe(0);
    expect(calls.observe).toBe(0);
    await expectNoIdleTransaction();
  });

  it("binds one receiver and rejects a different concurrent receiver", async () => {
    const senderId = await identity("bind-sender");
    const firstId = await identity("bind-first");
    const secondId = await identity("bind-second");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({
            id: banId,
            senderId,
            receiverId: null,
            acceptance: "PENDING",
          }),
        },
      }),
    );
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const settled = await contend(
      "SELECT ban_id FROM bans WHERE ban_id = $1 FOR UPDATE",
      [banId],
      2,
      () =>
        Promise.allSettled([
          storeA.bindBanReceiver(banId, firstId),
          storeB.bindBanReceiver(banId, secondId),
        ]),
    );
    expect(settled.every((item) => item.status === "fulfilled")).toBe(true);
    const statuses = settled.map((item) => (item.status === "fulfilled" ? item.value.status : ""));
    expect(statuses.sort()).toEqual(["BOUND", "CONFLICT"]);
    const ban = await storeA.getBanById(banId);
    expect([firstId, secondId]).toContain(ban?.receiverId);
    const again = await storeA.bindBanReceiver(banId, ban!.receiverId!);
    expect(again.status).toBe("ALREADY_BOUND");
    const other = ban?.receiverId === firstId ? secondId : firstId;
    const conflict = await storeA.bindBanReceiver(banId, other);
    expect(conflict.status).toBe("CONFLICT");
    expect((await storeA.getBanById(banId))?.receiverId).toBe(ban?.receiverId);
    await expectNoIdleTransaction();
  });

  it("keeps one confirmed CheckPair answer when the same participant races", async () => {
    const receiverId = await identity("check-same");
    const senderId = await identity("check-same-sender");
    const { pairId, receiverWorld, senderWorld } = checkWorld(receiverId, senderId);
    const seeded = await seed(receiverId, receiverWorld);
    await seed(senderId, senderWorld);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const fulfilled = reduce(
      seeded.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${pairId}-receiver`),
        answer: "FULFILLED",
        checkPairId: pairId,
      }),
      { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(11) },
    );
    const declined = reduce(
      seeded.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${pairId}-receiver`),
        answer: "NOT_FULFILLED",
        checkPairId: pairId,
      }),
      { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(12) },
    );
    expect(fulfilled.outcome).toBe("APPLIED");
    expect(declined.outcome).toBe("APPLIED");
    const same = await contend(SQL.selectSessionForUpdate, [receiverId], 2, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: receiverId,
          expectedRevision: seeded.revision,
          result: fulfilled,
        }),
        storeB.persistTransition({
          currentUserId: receiverId,
          expectedRevision: seeded.revision,
          result: fulfilled,
        }),
      ]),
    );
    expect(same.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(same.filter((item) => item.status === "rejected")[0]).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const current = await storeA.loadProductSnapshot(receiverId);
    await expect(
      storeB.persistTransition({
        currentUserId: receiverId,
        expectedRevision: current.revision,
        result: declined,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const loaded = await storeA.loadProductSnapshot(receiverId);
    const pair = loaded.snapshot.extended.entities.checkPairs[pairId];
    expect(pair?.receiverAnswer).toBe("FULFILLED");
    expect(pair?.senderAnswer).toBeNull();
    expect(pair?.resultingStatus).toBeNull();
    const sender = await storeA.loadProductSnapshot(senderId);
    expect(sender.snapshot.extended.entities.checkPairs[pairId]).toEqual(pair);
    await expectNoIdleTransaction();
  });

  it("serializes sender and receiver answers into one derived Status", async () => {
    const receiverId = await identity("check-both-receiver");
    const senderId = await identity("check-both-sender");
    const { pairId, banId, receiverWorld, senderWorld } = checkWorld(receiverId, senderId);
    await seed(receiverId, receiverWorld);
    await seed(senderId, senderWorld);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const names = await contend(SQL.selectPairForUpdate, [pairId], 2, () =>
      Promise.all([
        storeA.withCheckPairLock(pairId, banId, receiverId, async (ctx) => {
          const loaded = await ctx.loadProductSnapshot(receiverId);
          const pair = ctx.pair ?? loaded.snapshot.extended.entities.checkPairs[pairId]!;
          const event =
            pair.senderAnswer === null
              ? eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
                  checkItemId: branded<NotificationItemId>(`${pairId}-receiver`),
                  answer: "FULFILLED",
                  checkPairId: pairId,
                })
              : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
                  checkItemId: branded<NotificationItemId>(`${pairId}-receiver`),
                  answer: "FULFILLED",
                  checkPairId: pairId,
                  resultingStatus: pair.senderAnswer === "FULFILLED" ? "BANTASTIC" : "BANFLICT",
                });
          const result = reduce(loaded.snapshot, event, {
            ...kernelContext(),
            currentUserId: receiverId,
            allocateId: counterAllocator(21),
          });
          expect(result.outcome).toBe("APPLIED");
          await ctx.persistTransition({
            currentUserId: receiverId,
            expectedRevision: loaded.revision,
            result,
          });
          return event.name;
        }),
        storeB.withCheckPairLock(pairId, banId, senderId, async (ctx) => {
          const loaded = await ctx.loadProductSnapshot(senderId);
          const pair = ctx.pair ?? loaded.snapshot.extended.entities.checkPairs[pairId]!;
          const event =
            pair.receiverAnswer === null
              ? eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
                  checkItemId: branded<NotificationItemId>(`${pairId}-sender`),
                  answer: "NOT_FULFILLED",
                  checkPairId: pairId,
                })
              : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
                  checkItemId: branded<NotificationItemId>(`${pairId}-sender`),
                  answer: "NOT_FULFILLED",
                  checkPairId: pairId,
                  resultingStatus:
                    pair.receiverAnswer === "NOT_FULFILLED" ? "FAIR_ENOUGH" : "BANFLICT",
                });
          const result = reduce(loaded.snapshot, event, {
            ...kernelContext(),
            currentUserId: senderId,
            allocateId: counterAllocator(22),
          });
          expect(result.outcome).toBe("APPLIED");
          await ctx.persistTransition({
            currentUserId: senderId,
            expectedRevision: loaded.revision,
            result,
          });
          return event.name;
        }),
      ]),
    );
    expect(new Set(names)).toEqual(
      new Set([
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
      ]),
    );
    const receiver = await storeA.loadProductSnapshot(receiverId);
    const sender = await storeB.loadProductSnapshot(senderId);
    const pair = receiver.snapshot.extended.entities.checkPairs[pairId];
    expect(pair).toMatchObject({
      receiverAnswer: "FULFILLED",
      senderAnswer: "NOT_FULFILLED",
      resultingStatus: "BANFLICT",
    });
    expect(sender.snapshot.extended.entities.checkPairs[pairId]).toEqual(pair);
    const rows = await db.sql.query("SELECT pair_id FROM check_pairs WHERE pair_id = $1", [pairId]);
    expect(rows.rows).toHaveLength(1);
    await expectNoIdleTransaction();
  });

  it("rejects a second FIRST after the other participant already answered", async () => {
    const receiverId = await identity("check-boundary-receiver");
    const senderId = await identity("check-boundary-sender");
    const { pairId, banId, receiverWorld, senderWorld } = checkWorld(receiverId, senderId);
    const receiverSeed = await seed(receiverId, receiverWorld);
    const senderSeed = await seed(senderId, senderWorld);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const receiverFirst = reduce(
      receiverSeed.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${pairId}-receiver`),
        answer: "FULFILLED",
        checkPairId: pairId,
      }),
      { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(31) },
    );
    const senderFirst = reduce(
      senderSeed.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${pairId}-sender`),
        answer: "FULFILLED",
        checkPairId: pairId,
      }),
      { ...kernelContext(), currentUserId: senderId, allocateId: counterAllocator(32) },
    );
    expect(receiverFirst.outcome).toBe("APPLIED");
    expect(senderFirst.outcome).toBe("APPLIED");
    const settled = await contend(SQL.selectPairForUpdate, [pairId], 2, () =>
      Promise.allSettled([
        storeA.withCheckPairLock(pairId, banId, receiverId, (ctx) =>
          ctx.persistTransition({
            currentUserId: receiverId,
            expectedRevision: receiverSeed.revision,
            result: receiverFirst,
          }),
        ),
        storeB.withCheckPairLock(pairId, banId, senderId, (ctx) =>
          ctx.persistTransition({
            currentUserId: senderId,
            expectedRevision: senderSeed.revision,
            result: senderFirst,
          }),
        ),
      ]),
    );
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toMatchObject({
      code: "CHECK_PAIR_CONFLICT",
    });
    const loaded = await storeA.loadProductSnapshot(receiverId);
    const pair = loaded.snapshot.extended.entities.checkPairs[pairId];
    const answers = [pair?.receiverAnswer, pair?.senderAnswer].filter((value) => value !== null);
    expect(answers).toHaveLength(1);
    expect(pair?.resultingStatus).toBeNull();
    expect(
      Object.values(loaded.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS",
      ),
    ).toHaveLength(0);
    const sender = await storeA.loadProductSnapshot(senderId);
    expect(sender.snapshot.extended.entities.checkPairs[pairId]).toEqual(pair);
    await expectNoIdleTransaction();
  });

  it("fences bootstrap delivery to one claim token", async () => {
    const userId = await identity("bootstrap");
    await seed(userId, {
      ...withControlState(emptySnapshot(), "RIM.LOBBY"),
      extended: {
        ...withControlState(emptySnapshot(), "RIM.LOBBY").extended,
        telegramPersistentReentryEstablished: true,
      },
    });
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const settled = await contend(SQL.selectSessionForUpdate, [userId], 2, () =>
      Promise.all([
        storeA.claimTelegramPersistentReentryBootstrapDelivery(userId, 1_000, 60_000),
        storeB.claimTelegramPersistentReentryBootstrapDelivery(userId, 1_000, 60_000),
      ]),
    );
    const claimed = settled.filter((item) => item.status === "CLAIMED");
    const busy = settled.filter((item) => item.status === "ALREADY_CLAIMED");
    expect(claimed).toHaveLength(1);
    expect(busy).toHaveLength(1);
    const token = claimed[0]?.status === "CLAIMED" ? claimed[0].claimToken : "";
    expect(token.length).toBeGreaterThan(0);
    const wrongMark = await storeA.markTelegramPersistentReentryBootstrapSent(
      userId,
      "other-token",
    );
    expect(wrongMark.status).toBe("STALE_CLAIM");
    const wrongRelease = await storeA.releaseTelegramPersistentReentryBootstrapClaim(
      userId,
      "other-token",
    );
    expect(wrongRelease.status).toBe("STALE_CLAIM");
    const marked = await storeA.markTelegramPersistentReentryBootstrapSent(userId, token);
    expect(marked.status).toBe("MARKED");
    const markedAgain = await storeA.markTelegramPersistentReentryBootstrapSent(userId, token);
    expect(markedAgain.status).toBe("ALREADY_MARKED");
    const late = await storeA.claimTelegramPersistentReentryBootstrapDelivery(
      userId,
      2_000,
      60_000,
    );
    expect(late.status).toBe("ALREADY_SENT");

    const reclaimUser = await identity("bootstrap-reclaim");
    await seed(reclaimUser, {
      ...withControlState(emptySnapshot(), "RIM.LOBBY"),
      extended: {
        ...withControlState(emptySnapshot(), "RIM.LOBBY").extended,
        telegramPersistentReentryEstablished: true,
      },
    });
    const first = await storeA.claimTelegramPersistentReentryBootstrapDelivery(
      reclaimUser,
      5_000,
      10,
    );
    expect(first.status).toBe("CLAIMED");
    const oldToken = first.status === "CLAIMED" ? first.claimToken : "";
    const second = await storeA.claimTelegramPersistentReentryBootstrapDelivery(
      reclaimUser,
      5_020,
      10,
    );
    expect(second.status).toBe("CLAIMED");
    const newToken = second.status === "CLAIMED" ? second.claimToken : "";
    expect(newToken).not.toBe(oldToken);
    expect(
      (await storeA.markTelegramPersistentReentryBootstrapSent(reclaimUser, oldToken)).status,
    ).toBe("STALE_CLAIM");
    expect(
      (await storeA.releaseTelegramPersistentReentryBootstrapClaim(reclaimUser, oldToken)).status,
    ).toBe("STALE_CLAIM");
    expect(
      (await storeA.markTelegramPersistentReentryBootstrapSent(reclaimUser, newToken)).status,
    ).toBe("MARKED");
    await expectNoIdleTransaction();
  });

  it("lets only the current RIM attempt commit its snapshot", async () => {
    const userId = await identity("rim-commit");
    const seeded = await seed(userId, {
      ...withControlState(emptySnapshot(), "RIM.LOBBY"),
      extended: {
        ...withControlState(emptySnapshot(), "RIM.LOBBY").extended,
        rimChat: makeChat({ inputDraft: "original" }),
      },
    });
    const store = new PostgresProductStore(db.sql);
    const other = new PostgresProductStore(db.sql);
    const saved = await store.saveRimProviderRuntime(userId, seeded.revision, runtime("attempt-1"));
    const authority = attemptAuthority("attempt-1");
    const committed = reduce(saved.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: userId,
    });
    const closed = reduce(saved.snapshot, eventOf("RIM.PRESS_START_CHAT", {}), {
      ...kernelContext(),
      currentUserId: userId,
    });
    expect(committed.outcome).toBe("APPLIED");
    expect(closed.outcome).toBe("APPLIED");
    const raced = await contend(SQL.selectSessionForUpdate, [userId], 2, () =>
      Promise.allSettled([
        store.commitOwnedTransition({
          currentUserId: userId,
          expectedRevision: saved.revision,
          result: committed,
          requireAttempt: authority,
        }),
        other.persistTransition({
          currentUserId: userId,
          expectedRevision: saved.revision,
          result: closed,
        }),
      ]),
    );
    const successes = raced.filter((item) => item.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const loaded = await store.loadProductSnapshot(userId);
    expect(loaded.revision).toBe(saved.revision + 1);
    expect(loaded.rimProviderRuntime).toEqual(runtime("attempt-1"));
    const commitWon = raced[0]?.status === "fulfilled";
    expect(loaded.snapshot.controlState).toBe(
      commitWon ? committed.snapshot.controlState : closed.snapshot.controlState,
    );

    const owned = await store.saveRimProviderRuntime(userId, loaded.revision, runtime("attempt-2"));
    const stale = await store.commitOwnedTransition({
      currentUserId: userId,
      expectedRevision: owned.revision,
      result: committed,
      requireAttempt: authority,
    });
    expect(stale.status).toBe("ATTEMPT_SUPERSEDED");
    const afterStale = await store.loadProductSnapshot(userId);
    expect(afterStale.revision).toBe(owned.revision);
    expect(afterStale.snapshot.controlState).toBe(loaded.snapshot.controlState);
    expect(afterStale.snapshot.extended.rimChat).toEqual(loaded.snapshot.extended.rimChat);
    expect(afterStale.rimProviderRuntime).toEqual(runtime("attempt-2"));

    const retired = await store.saveRimProviderRuntime(
      userId,
      afterStale.revision,
      runtime("attempt-2", "attempt-2"),
    );
    const retry = await store.commitOwnedTransition({
      currentUserId: userId,
      expectedRevision: retired.revision,
      result: committed,
      requireAttempt: attemptAuthority("attempt-2"),
    });
    expect(retry.status).toBe("ATTEMPT_SUPERSEDED");
    const afterRetry = await store.loadProductSnapshot(userId);
    expect(afterRetry.revision).toBe(retired.revision);
    expect(afterRetry.snapshot).toEqual(retired.snapshot);
    expect(afterRetry.rimProviderRuntime).toEqual(runtime("attempt-2", "attempt-2"));
    await expectNoIdleTransaction();
  });

  it("keeps the newest rim provider runtime when two saves share a revision", async () => {
    const userId = await identity("rim-runtime");
    const seeded = await seed(userId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const newer = { ...runtime("attempt-new"), nonce: "new" };
    const older = { ...runtime("attempt-old"), nonce: "old" };
    const settled = await contend(SQL.selectSessionForUpdate, [userId], 2, () =>
      Promise.allSettled([
        storeA.saveRimProviderRuntime(userId, seeded.revision, newer),
        storeB.saveRimProviderRuntime(userId, seeded.revision, older),
      ]),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")[0]).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const loaded = await storeA.loadProductSnapshot(userId);
    expect(loaded.revision).toBe(seeded.revision + 1);
    expect([newer, older]).toContainEqual(loaded.rimProviderRuntime);
    const winner = settled.find((item) => item.status === "fulfilled");
    const winnerRuntime = winner?.status === "fulfilled" ? winner.value.rimProviderRuntime : null;
    expect(loaded.rimProviderRuntime).toEqual(winnerRuntime);
    await expectNoIdleTransaction();
  });

  it("expires one elapsed timer when two requests race", async () => {
    const senderId = await identity("timer-sender");
    const receiverId = await identity("timer-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const timerId = branded<DomainTimerId>(`timer-${randomUUID()}`);
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" }) },
      domainTimers: { [timerId]: makeTimer({ id: timerId, banId, startedAt: asInstant(0) }) },
    });
    const seeded = await seed(senderId, world);
    await seed(receiverId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const first = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: senderId,
      allocateId: counterAllocator(41),
    });
    const second = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: senderId,
      allocateId: counterAllocator(42),
    });
    expect(first.outcome).toBe("APPLIED");
    expect(second.outcome).toBe("APPLIED");
    const settled = await contend(SQL.selectSessionForUpdate, [senderId], 2, () =>
      Promise.allSettled([
        storeA.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: first,
        }),
        storeB.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: second,
        }),
      ]),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")[0]).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const pairs = await db.sql.query<{ pair_id: string }>(
      "SELECT pair_id FROM check_pairs WHERE ban_id = $1",
      [banId],
    );
    expect(pairs.rows).toHaveLength(1);
    const items = await db.sql.query<{ item_id: string }>(
      "SELECT item_id FROM notification_items WHERE ban_id = $1 AND kind = 'CHECK'",
      [banId],
    );
    expect(new Set(items.rows.map((row) => row.item_id)).size).toBe(items.rows.length);
    const timer = await db.sql.query<{ state: string; check_pair_created: boolean }>(
      "SELECT state, check_pair_created FROM domain_timers WHERE timer_id = $1",
      [timerId],
    );
    expect(timer.rows[0]).toEqual({ state: "EXPIRED", check_pair_created: true });
    const sender = await storeA.loadProductSnapshot(senderId);
    const receiver = await storeA.loadProductSnapshot(receiverId);
    const pairId = pairs.rows[0]?.pair_id ?? "";
    expect(sender.snapshot.extended.entities.checkPairs[pairId as CheckPairId]).toEqual(
      receiver.snapshot.extended.entities.checkPairs[pairId as CheckPairId],
    );
    expect(sender.revision).toBe(seeded.revision + 1);
    await expectNoIdleTransaction();
  });

  it("treats a second create-ban confirmation as non-applied", async () => {
    const userId = await identity("duplicate-create");
    const receiverId = await identity("duplicate-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const operationId = branded<OperationId>(`op-${randomUUID()}`);
    let world = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    world = {
      ...world,
      extended: {
        ...world.extended,
        createBanDraft: { ...validCreateDraft("CONTACT"), selectedContactId: receiverId },
      },
    };
    world = withOperation(world, pendingOp({ operationId }));
    const seeded = await seed(userId, world);
    const store = new PostgresProductStore(db.sql);
    const result = reduce(
      seeded.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId, createdBanId: banId }),
      { ...kernelContext(), currentUserId: userId, allocateId: counterAllocator(51) },
    );
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: userId,
      expectedRevision: seeded.revision,
      result,
    });
    const replay = reduce(
      saved.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId, createdBanId: banId }),
      { ...kernelContext(), currentUserId: userId, allocateId: counterAllocator(52) },
    );
    expect(replay.outcome).not.toBe("APPLIED");
    const bans = await db.sql.query("SELECT ban_id FROM bans WHERE sender_id = $1", [userId]);
    expect(bans.rows).toHaveLength(1);
    await expect(
      store.persistTransition({
        currentUserId: userId,
        expectedRevision: seeded.revision,
        result,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      (await db.sql.query("SELECT ban_id FROM bans WHERE sender_id = $1", [userId])).rows,
    ).toHaveLength(1);
    await expectNoIdleTransaction();
  });

  it("deadlocks opposite session and pair order, and the store order completes", async () => {
    const receiverId = await identity("deadlock-receiver");
    const senderId = await identity("deadlock-sender");
    const { pairId, banId, receiverWorld, senderWorld } = checkWorld(receiverId, senderId);
    const seeded = await seed(receiverId, receiverWorld);
    await seed(senderId, senderWorld);
    const sessionHeld = deferred();
    const pairHeld = deferred();
    const first = db.sql.transaction(async (tx) => {
      await tx.query(SQL.selectSessionForUpdate, [receiverId]);
      sessionHeld.resolve();
      await pairHeld.promise;
      await tx.query(SQL.selectPairForUpdate, [pairId]);
    });
    const second = db.sql.transaction(async (tx) => {
      await sessionHeld.promise;
      await tx.query(SQL.selectPairForUpdate, [pairId]);
      pairHeld.resolve();
      await tx.query(SQL.selectSessionForUpdate, [receiverId]);
    });
    const opposite = await Promise.allSettled([first, second]);
    expect(opposite.some((item) => item.status === "rejected")).toBe(true);
    expect(
      opposite.some(
        (item) => item.status === "rejected" && (item.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(true);

    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const answer = reduce(
      seeded.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${pairId}-receiver`),
        answer: "FULFILLED",
        checkPairId: pairId,
      }),
      { ...kernelContext(), currentUserId: receiverId, allocateId: counterAllocator(61) },
    );
    expect(answer.outcome).toBe("APPLIED");
    const closed = reduce(seeded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: receiverId,
    });
    expect(closed.outcome).toBe("APPLIED");
    const ordered = await contend(SQL.selectSessionForUpdate, [receiverId], 2, () =>
      Promise.allSettled([
        storeA.withCheckPairLock(pairId, banId, receiverId, (ctx) =>
          ctx.persistTransition({
            currentUserId: receiverId,
            expectedRevision: seeded.revision,
            result: answer,
          }),
        ),
        storeB.persistTransition({
          currentUserId: receiverId,
          expectedRevision: seeded.revision,
          result: closed,
        }),
      ]),
    );
    expect(
      ordered.some(
        (item) => item.status === "rejected" && (item.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(false);
    expect(ordered.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(ordered.filter((item) => item.status === "rejected")[0]).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    await db.sql.query("SELECT 1", []);
    await expectNoIdleTransaction();
  });
});

function runtime(attemptId: string, retryAttemptId?: string) {
  return {
    rimChatId: "chat-1",
    selectedContactId: "contact-1",
    contextRequestId: "ctx-1",
    continuityMode: "provider-conversation" as const,
    attempt: { requestId: "req-1", attemptId },
    ...(retryAttemptId === undefined ? {} : { retryIntent: { attemptId: retryAttemptId } }),
    nonce: attemptId,
  };
}

function attemptAuthority(attemptId: string): RuntimeAttemptAuthority {
  return {
    rimChatId: "chat-1",
    selectedContactId: "contact-1",
    contextRequestId: "ctx-1",
    requestId: "req-1",
    attemptId,
    continuityMode: "provider-conversation",
  };
}

function checkWorld(receiverId: UserId, senderId: UserId) {
  const pairId = branded<CheckPairId>(`pair-${randomUUID()}`);
  const banId = branded<BanId>(`ban-${randomUUID()}`);
  const receiverItem = `${pairId}-receiver`;
  const senderItem = `${pairId}-sender`;
  const pair: CheckPair = {
    id: pairId,
    banId,
    receiverItemId: branded<NotificationItemId>(receiverItem),
    senderItemId: branded<NotificationItemId>(senderItem),
    receiverAnswer: null,
    senderAnswer: null,
    resultingStatus: null,
  };
  const receiver = checkItem("RECEIVER", {
    id: branded<NotificationItemId>(receiverItem),
    ownerId: receiverId,
    banId,
    checkPairId: pairId,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const sender = checkItem("SENDER", {
    id: branded<NotificationItemId>(senderItem),
    ownerId: senderId,
    banId,
    checkPairId: pairId,
  });
  let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER");
  snapshot = withEntities(snapshot, {
    bans: {
      [banId]: makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" }),
    },
    checkPairs: { [pairId]: pair },
    notificationItems: { [receiver.id]: receiver, [sender.id]: sender },
  });
  snapshot = {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: receiver.id },
  };
  const receiverWorld = withOperation(
    snapshot,
    pendingOp({
      operationId: branded<OperationId>(`op-${pairId}-receiver`),
      kind: "CHECK_ANSWER",
      originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
      originatingItemId: receiver.id,
    }),
  );
  const activeSender = {
    ...sender,
    lifecycle: { status: "UNPROCESSED" as const, display: "ACTIVE" as const },
  };
  let senderSnapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.SENDER");
  senderSnapshot = withEntities(senderSnapshot, {
    bans: snapshot.extended.entities.bans,
    checkPairs: { [pairId]: pair },
    notificationItems: { [receiver.id]: receiver, [activeSender.id]: activeSender },
  });
  senderSnapshot = {
    ...senderSnapshot,
    extended: { ...senderSnapshot.extended, activeNotificationItemId: activeSender.id },
  };
  const senderWorld = withOperation(
    senderSnapshot,
    pendingOp({
      operationId: branded<OperationId>(`op-${pairId}-sender`),
      kind: "CHECK_ANSWER",
      originatingState: "NOTIFICATIONS.CHECK.SENDER",
      originatingItemId: activeSender.id,
    }),
  );
  return { pairId, banId, receiverWorld, senderWorld };
}
