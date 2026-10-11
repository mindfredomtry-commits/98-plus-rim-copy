/**
 * Pass 12D-2 — PostgreSQL Status materialization scenarios PG-S01..PG-S15.
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
  type Effect,
  type NotificationItemId,
  type OperationId,
  type ProductSnapshot,
  type StatusNotificationItem,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  eventOf,
  kernelContext,
  makeBan,
  statusItem,
  withControlState,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { baselineFromLoadedSnapshot } from "./hybrid-persist.ts";
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

function applied(
  snapshot: ProductSnapshot,
  effects: readonly Effect[],
): TransitionResult {
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

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!rawDatabaseUrl)("12D-2 PostgreSQL Status materialization (PG-S01..PG-S15)", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;

  beforeAll(async () => {
    const safe = assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
    assertMvp17TestSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: safe.connectionString,
      max: 8,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_12d2 -c deadlock_timeout=200`,
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

  async function statusRows(banId: BanId) {
    return db.sql.query<{
      item_id: string;
      owner_id: string;
      role: string;
      status: string;
      lifecycle_status: string;
    }>(
      `SELECT item_id, owner_id, role, status, lifecycle_status
       FROM notification_items WHERE ban_id = $1 AND kind = 'STATUS'
       ORDER BY role, item_id`,
      [banId],
    );
  }

  function overboardEffects(
    ban: Ban,
    recvId: string,
    sendId: string,
  ): Effect[] {
    return [
      { type: "UPSERT_BAN", ban },
      {
        type: "UPSERT_NOTIFICATION_ITEM",
        item: statusItem({
          id: branded(recvId),
          ownerId: ban.receiverId!,
          banId: ban.id,
          role: "RECEIVER",
          status: "OVERBOARD",
        }),
      },
      {
        type: "UPSERT_NOTIFICATION_ITEM",
        item: statusItem({
          id: branded(sendId),
          ownerId: ban.senderId,
          banId: ban.id,
          role: "SENDER",
          status: "OVERBOARD",
        }),
      },
    ];
  }

  it("PG-S01 both Status absent → pair created", async () => {
    const senderId = await identity("s01-s");
    const receiverId = await identity("s01-r");
    const banId = branded<BanId>(`ban-s01-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    await seed(receiverId, withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }));
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban, status: "OVERBOARD" };
    await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(withEntities(seeded.snapshot, { bans: { [banId]: next } }), overboardEffects(next, `kr-${randomUUID()}`, `ks-${randomUUID()}`)),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((r) => r.role))).toEqual(new Set(["RECEIVER", "SENDER"]));
  }, 30_000);

  it("PG-S02 one Status missing → counterpart created", async () => {
    const senderId = await identity("s02-s");
    const receiverId = await identity("s02-r");
    const banId = branded<BanId>(`ban-s02-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const senderItem = statusItem({
      id: branded(`s02-send-${randomUUID()}`),
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
    }) as StatusNotificationItem;
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [senderItem.id]: senderItem },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    const store = new PostgresProductStore(db.sql);
    await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(
        withEntities(seeded.snapshot, {
          bans: { [banId]: ban },
          notificationItems: { [senderItem.id]: senderItem },
        }),
        overboardEffects(ban, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
      ),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.role === "SENDER")?.item_id).toBe(senderItem.id);
  }, 30_000);

  it("PG-S03 both Status present → reused", async () => {
    const senderId = await identity("s03-s");
    const receiverId = await identity("s03-r");
    const banId = branded<BanId>(`ban-s03-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const senderItem = statusItem({
      id: branded(`s03-s-${randomUUID()}`),
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
    });
    const receiverItem = statusItem({
      id: branded(`s03-r-${randomUUID()}`),
      ownerId: receiverId,
      banId,
      role: "RECEIVER",
      status: "OVERBOARD",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [senderItem.id]: senderItem },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [receiverItem.id]: receiverItem },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(
        seeded.snapshot,
        overboardEffects(ban, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
      ),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((r) => r.item_id))).toEqual(
      new Set([senderItem.id, receiverItem.id]),
    );
  }, 30_000);

  it("PG-S04 two owners concurrently materialize → one logical pair", async () => {
    const senderId = await identity("s04-s");
    const receiverId = await identity("s04-r");
    const banId = branded<BanId>(`ban-s04-${randomUUID()}`);
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
    const next: Ban = { ...ban, status: "OVERBOARD" };
    const held = deferred();
    const release = deferred();
    const holder = db.sql.transaction(async (tx) => {
      await tx.query(SQL.selectBanForUpdate, [banId]);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const pending = Promise.allSettled([
      storeA.persistTransition({
        currentUserId: senderId,
        expectedRevision: senderSeed.revision,
        result: applied(
          withEntities(senderSeed.snapshot, { bans: { [banId]: next } }),
          overboardEffects(next, `a-r-${randomUUID()}`, `a-s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(senderSeed.snapshot, senderSeed.revision),
      }),
      storeB.persistTransition({
        currentUserId: receiverId,
        expectedRevision: receiverSeed.revision,
        result: applied(
          withEntities(receiverSeed.snapshot, { bans: { [banId]: next } }),
          overboardEffects(next, `b-r-${randomUUID()}`, `b-s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(receiverSeed.snapshot, receiverSeed.revision),
      }),
    ]);
    release.resolve();
    const settled = await pending;
    await holder;
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((r) => `${r.role}:${r.status}`)).size).toBe(2);
  }, 30_000);

  it("PG-S05 repeated E-20 → no duplicate pair", async () => {
    const senderId = await identity("s05-s");
    const receiverId = await identity("s05-r");
    const banId = branded<BanId>(`ban-s05-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    let seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    await seed(receiverId, withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }));
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban, status: "OVERBOARD" };
    seeded = await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(
        withEntities(seeded.snapshot, { bans: { [banId]: next } }),
        overboardEffects(next, `r1-${randomUUID()}`, `s1-${randomUUID()}`),
      ),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(
        seeded.snapshot,
        overboardEffects(next, `r2-${randomUUID()}`, `s2-${randomUUID()}`),
      ),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect((await statusRows(banId)).rows).toHaveLength(2);
  }, 30_000);

  it("PG-S06 PROCESSED lifecycle survives concurrent persistence", async () => {
    const senderId = await identity("s06-s");
    const receiverId = await identity("s06-r");
    const banId = branded<BanId>(`ban-s06-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const processed = statusItem({
      id: branded(`s06-proc-${randomUUID()}`),
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
      lifecycle: { status: "PROCESSED" },
    });
    const receiverItem = statusItem({
      id: branded(`s06-r-${randomUUID()}`),
      ownerId: receiverId,
      banId,
      role: "RECEIVER",
      status: "OVERBOARD",
    });
    const senderSeed = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [processed.id]: processed },
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
    await Promise.all([
      storeA.persistTransition({
        currentUserId: senderId,
        expectedRevision: senderSeed.revision,
        result: applied(
          senderSeed.snapshot,
          overboardEffects(ban, `a-r-${randomUUID()}`, `a-s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(senderSeed.snapshot, senderSeed.revision),
      }),
      storeB.persistTransition({
        currentUserId: receiverId,
        expectedRevision: receiverSeed.revision,
        result: applied(
          receiverSeed.snapshot,
          overboardEffects(ban, `b-r-${randomUUID()}`, `b-s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(receiverSeed.snapshot, receiverSeed.revision),
      }),
    ]);
    const rows = await statusRows(banId);
    const senderRow = rows.rows.find((r) => r.role === "SENDER");
    expect(senderRow?.item_id).toBe(processed.id);
    expect(senderRow?.lifecycle_status).toBe("PROCESSED");
  }, 30_000);

  it("PG-S07 Kernel X → durable Y; Session pointers durable", async () => {
    const senderId = await identity("s07-s");
    const receiverId = await identity("s07-r");
    const banId = branded<BanId>(`ban-s07-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const durableRecv = branded<NotificationItemId>(`dur-r-${randomUUID()}`);
    const durableSend = branded<NotificationItemId>(`dur-s-${randomUUID()}`);
    const receiverItem = statusItem({
      id: durableRecv,
      ownerId: receiverId,
      banId,
      role: "RECEIVER",
      status: "OVERBOARD",
    });
    const senderItem = statusItem({
      id: durableSend,
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
    });
    const kernelRecv = `k-r-${randomUUID()}`;
    let snap = withEntities(withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"), {
      bans: { [banId]: ban },
      notificationItems: { [senderItem.id]: senderItem },
    });
    snap = {
      ...snap,
      extended: {
        ...snap.extended,
        activeNotificationItemId: branded(kernelRecv),
        priorities: { statusItemId: branded(kernelRecv), timerItemId: null },
      },
    };
    const seeded = await seed(senderId, snap);
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [receiverItem.id]: receiverItem },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    const saved = await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(seeded.snapshot, overboardEffects(ban, kernelRecv, `k-s-${randomUUID()}`)),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect(saved.snapshot.extended.activeNotificationItemId).toBe(durableRecv);
    expect(saved.snapshot.extended.priorities.statusItemId).toBe(durableRecv);
    const rows = await statusRows(banId);
    expect(new Set(rows.rows.map((r) => r.item_id))).toEqual(new Set([durableRecv, durableSend]));
  }, 30_000);

  it("PG-S08 PendingOperation references durable Y", async () => {
    const senderId = await identity("s08-s");
    const receiverId = await identity("s08-r");
    const banId = branded<BanId>(`ban-s08-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const durableRecv = branded<NotificationItemId>(`dur8-r-${randomUUID()}`);
    const durableSend = branded<NotificationItemId>(`dur8-s-${randomUUID()}`);
    const kernelRecv = `k8-r-${randomUUID()}`;
    const opId = branded<OperationId>(`op-s08-${randomUUID()}`);
    let snap = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: ban },
      notificationItems: {
        [String(durableSend)]: statusItem({
          id: durableSend,
          ownerId: senderId,
          banId,
          role: "SENDER",
          status: "OVERBOARD",
        }),
      },
    });
    snap = {
      ...snap,
      runtime: {
        ...snap.runtime,
        pendingOperations: {
          [String(opId)]: {
            operationId: opId,
            kind: "CHECK_ANSWER",
            originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
            originatingItemId: branded(kernelRecv),
            resultApplied: false,
            supersededByExternalEntry: false,
            sendDraft: null,
          },
        },
      },
    };
    const seeded = await seed(senderId, snap);
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: {
          [durableRecv]: statusItem({
            id: durableRecv,
            ownerId: receiverId,
            banId,
            role: "RECEIVER",
            status: "OVERBOARD",
          }),
        },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    const saved = await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(seeded.snapshot, [
        ...overboardEffects(ban, kernelRecv, `k8-s-${randomUUID()}`),
        {
          type: "MARK_OPERATION_RESULT_APPLIED",
          operationId: opId,
        } as Effect,
      ]),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect(saved.snapshot.runtime.pendingOperations[String(opId)]?.originatingItemId).toBe(
      durableRecv,
    );
  }, 30_000);

  it("PG-S09 failure during second Item write → full rollback", async () => {
    const senderId = await identity("s09-s");
    const receiverId = await identity("s09-r");
    const banId = branded<BanId>(`ban-s09-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
      banText: "rollback",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    await seed(receiverId, withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }));
    const store = new PostgresProductStore(db.sql);
    store.failNextWriteAfterBans();
    const next: Ban = { ...ban, status: "OVERBOARD" };
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(
          withEntities(seeded.snapshot, { bans: { [banId]: next } }),
          overboardEffects(next, `r-${randomUUID()}`, `s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    expect((await statusRows(banId)).rows).toHaveLength(0);
    const durable = await db.sql.query<{ status: string | null }>(
      "SELECT status FROM bans WHERE ban_id = $1",
      [banId],
    );
    expect(durable.rows[0]?.status).toBeNull();
    expect((await store.loadProductSnapshot(senderId)).revision).toBe(seeded.revision);
  }, 30_000);

  it("PG-S10 duplicate logical Status → fail closed without mutation", async () => {
    const senderId = await identity("s10-s");
    const receiverId = await identity("s10-r");
    const banId = branded<BanId>(`ban-s10-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    await seed(receiverId, withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }));
    // Insert duplicate RECEIVER Status rows bypassing materializer
    for (const id of [`dup-a-${randomUUID()}`, `dup-b-${randomUUID()}`]) {
      await db.sql.query(SQL.upsertItem, [
        id,
        receiverId,
        banId,
        "STATUS",
        1,
        "UNPROCESSED",
        "WAITING",
        "RECEIVER",
        null,
        null,
        "OVERBOARD",
      ]);
    }
    const store = new PostgresProductStore(db.sql);
    const before = await statusRows(banId);
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(seeded.snapshot, overboardEffects(ban, `r-${randomUUID()}`, `s-${randomUUID()}`)),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const after = await statusRows(banId);
    expect(after.rows.map((r) => r.item_id).sort()).toEqual(
      before.rows.map((r) => r.item_id).sort(),
    );
    expect((await store.loadProductSnapshot(senderId)).revision).toBe(seeded.revision);
  }, 30_000);

  it("PG-S11 cross-owner Session persistence does not wipe counterpart", async () => {
    const senderId = await identity("s11-s");
    const receiverId = await identity("s11-r");
    const banId = branded<BanId>(`ban-s11-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const senderItem = statusItem({
      id: branded(`s11-s-${randomUUID()}`),
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
    });
    const receiverItem = statusItem({
      id: branded(`s11-r-${randomUUID()}`),
      ownerId: receiverId,
      banId,
      role: "RECEIVER",
      status: "OVERBOARD",
    });
    const senderSeed = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [senderItem.id]: senderItem },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [receiverItem.id]: receiverItem },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    const closed = reduce(senderSeed.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: senderId,
    });
    expect(closed.outcome).toBe("APPLIED");
    await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: senderSeed.revision,
      result: closed,
      baseline: baselineFromLoadedSnapshot(senderSeed.snapshot, senderSeed.revision),
    });
    const rows = await statusRows(banId);
    expect(rows.rows.map((r) => r.item_id).sort()).toEqual(
      [senderItem.id, receiverItem.id].sort(),
    );
  }, 30_000);

  it("PG-S12 Status materialization vs CheckPair answer — no deadlock", async () => {
    const senderId = await identity("s12-s");
    const receiverId = await identity("s12-r");
    const banId = branded<BanId>(`ban-s12-${randomUUID()}`);
    const pairId = branded<CheckPairId>(`pair-s12-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "ACCEPTED",
    });
    const pair: CheckPair = {
      id: pairId,
      banId,
      receiverItemId: branded(`${pairId}-r`),
      senderItemId: branded(`${pairId}-s`),
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    const world = withEntities(withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER"), {
      bans: { [banId]: ban },
      checkPairs: { [pairId]: pair },
    });
    const receiverSeed = await seed(receiverId, world);
    const senderSeed = await seed(senderId, world);
    const storeA = new PostgresProductStore(db.sql);
    const storeB = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban, status: "OVERBOARD" };
    const answered: CheckPair = { ...pair, receiverAnswer: "FULFILLED" };
    const settled = await Promise.allSettled([
      storeA.persistTransition({
        currentUserId: senderId,
        expectedRevision: senderSeed.revision,
        result: applied(
          withEntities(senderSeed.snapshot, { bans: { [banId]: next } }),
          overboardEffects(next, `r-${randomUUID()}`, `s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(senderSeed.snapshot, senderSeed.revision),
      }),
      storeB.withCheckPairLock(pairId, banId, receiverId, (ctx) =>
        ctx.persistTransition({
          currentUserId: receiverId,
          expectedRevision: receiverSeed.revision,
          result: applied(
            withEntities(receiverSeed.snapshot, { checkPairs: { [pairId]: answered } }),
            [{ type: "UPSERT_CHECK_PAIR", pair: answered }],
          ),
          baseline: baselineFromLoadedSnapshot(receiverSeed.snapshot, receiverSeed.revision),
        }),
      ),
    ]);
    expect(
      settled.some(
        (s) => s.status === "rejected" && (s.reason as { code?: string }).code === "40P01",
      ),
    ).toBe(false);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("PG-S13 CAS failure prevents materializer writes", async () => {
    const senderId = await identity("s13-s");
    const receiverId = await identity("s13-r");
    const banId = branded<BanId>(`ban-s13-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    await seed(receiverId, withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }));
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban, status: "OVERBOARD" };
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision + 50,
        result: applied(
          withEntities(seeded.snapshot, { bans: { [banId]: next } }),
          overboardEffects(next, `r-${randomUUID()}`, `s-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await statusRows(banId)).rows).toHaveLength(0);
  }, 30_000);

  it("PG-S14 Priority never promotes PROCESSED Status", async () => {
    const senderId = await identity("s14-s");
    const receiverId = await identity("s14-r");
    const banId = branded<BanId>(`ban-s14-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const processedId = branded<NotificationItemId>(`proc-${randomUUID()}`);
    const processed = statusItem({
      id: processedId,
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
      lifecycle: { status: "PROCESSED" },
    });
    const receiverItem = statusItem({
      id: branded(`s14-r-${randomUUID()}`),
      ownerId: receiverId,
      banId,
      role: "RECEIVER",
      status: "OVERBOARD",
    });
    let snap = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [banId]: ban },
      notificationItems: { [processed.id]: processed },
    });
    snap = {
      ...snap,
      extended: {
        ...snap.extended,
        priorities: { statusItemId: processedId, timerItemId: null },
      },
    };
    const seeded = await seed(senderId, snap);
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [receiverItem.id]: receiverItem },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    const saved = await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(seeded.snapshot, overboardEffects(ban, `r-${randomUUID()}`, `s-${randomUUID()}`)),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect(saved.snapshot.extended.priorities.statusItemId).toBeNull();
    const rows = await statusRows(banId);
    expect(rows.rows.find((r) => r.item_id === processedId)?.lifecycle_status).toBe("PROCESSED");
  }, 30_000);

  it("PG-S15 materializer write-set contains both authorized created/updated IDs", async () => {
    const senderId = await identity("s15-s");
    const receiverId = await identity("s15-r");
    const banId = branded<BanId>(`ban-s15-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const senderItem = statusItem({
      id: branded(`s15-s-${randomUUID()}`),
      ownerId: senderId,
      banId,
      role: "SENDER",
      status: "OVERBOARD",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [senderItem.id]: senderItem },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    const store = new PostgresProductStore(db.sql);
    // Only Ban + sender Status in effects — materializer must still create receiver
    await store.persistTransition({
      currentUserId: senderId,
      expectedRevision: seeded.revision,
      result: applied(seeded.snapshot, [
        { type: "UPSERT_BAN", ban },
        { type: "UPSERT_NOTIFICATION_ITEM", item: senderItem },
      ]),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.role === "SENDER")?.item_id).toBe(senderItem.id);
    expect(rows.rows.find((r) => r.role === "RECEIVER")).toBeTruthy();
  }, 30_000);
});
