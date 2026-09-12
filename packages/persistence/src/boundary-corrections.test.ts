import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptySnapshot, reduce, type NotificationItem } from "@98plus/product-model";
import {
  BAN_ID,
  CONTACT_A,
  OTHER_USER,
  SHARE_ATTEMPT_ID,
  USER_ID,
  branded,
  checkItem,
  defaultEvent,
  incomingItem,
  kernelContext,
  makeBan,
  makeTimer,
  pendingOp,
  shareOp,
  statusItem,
  timerItem,
  validCreateDraft,
  withControlState,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { asInstant } from "../../product-model/src/kernel/snapshot.ts";
import type { BanId, NotificationItemId, OperationId } from "../../product-model/src/ids.ts";
import { decodeNotificationItem, type NotificationItemRecord } from "./codec.ts";
import { PersistenceError } from "./errors.ts";
import { InMemoryProductStore } from "./in-memory-store.ts";
import {
  IDENTITY_MIGRATION_AUTHORITY,
  MIGRATION_CHAIN,
  allMigrationSql,
  identitySchemaSql,
  productPersistenceSql,
} from "./migrations.ts";
import { MemorySqlClient } from "./memory-sql.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { SQL } from "./sql.ts";
import { DURABLE_COLLECTION_SYNC } from "./sync-policy.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import type { ProductStore } from "./types.ts";
import * as persistencePublic from "./index.ts";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STALE_ITEM_ID = branded<NotificationItemId>("stale-incoming-1");
const STALE_OP_ID = branded<OperationId>("stale-op-1");
const OTHER_BAN_ID = branded<BanId>("ban-other-1");

function applied(snapshot: ReturnType<typeof emptySnapshot>, event: Parameters<typeof reduce>[1]) {
  return reduce(snapshot, event, kernelContext());
}

function durationWorld() {
  return withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
    bans: { [BAN_ID]: makeBan() },
    domainTimers: { "timer-1": makeTimer({ startedAt: asInstant(0) }) },
  });
}

async function registeredKit(mode: "memory" | "postgres" = "memory"): Promise<{
  kit: PersistenceTestKit;
  store: ProductStore;
  memory: InMemoryProductStore | null;
  sql: MemorySqlClient | null;
}> {
  const kit = mode === "memory" ? PersistenceTestKit.inMemory() : PersistenceTestKit.postgres();
  kit.establishIdentity(USER_ID, "tg-user-1");
  kit.establishIdentity(OTHER_USER, "tg-user-2");
  kit.establishIdentity(CONTACT_A, "tg-contact-a");
  return {
    kit,
    store: kit.store,
    memory: kit.memoryStore,
    sql: kit.sqlClient,
  };
}

function expectInvariant(error: unknown, field: string): void {
  expect(error).toBeInstanceOf(PersistenceError);
  expect(error).toMatchObject({ code: "INVARIANT" });
  expect((error as PersistenceError).message).toContain("Refusing to invent missing product fact");
  expect((error as PersistenceError).message).toContain(field);
}

describe("Defect A — snapshot to database synchronization", () => {
  it("A1. a durable fact removed from the authoritative snapshot does not reappear after persist + reload", async () => {
    const { kit, store, memory } = await registeredKit();
    if (!memory) {
      throw new Error("expected in-memory harness");
    }
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const result = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(result.outcome).toBe("APPLIED");
    memory.inspect().installRawItem(incomingItem({ id: STALE_ITEM_ID }));
    memory.inspect().upsertOperation(USER_ID, pendingOp({ operationId: STALE_OP_ID }));
    expect(memory.inspect().snapshot().items.has(STALE_ITEM_ID)).toBe(true);
    expect(result.snapshot.extended.entities.notificationItems[STALE_ITEM_ID]).toBeUndefined();
    expect(result.snapshot.runtime.pendingOperations[STALE_OP_ID]).toBeUndefined();
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.notificationItems[STALE_ITEM_ID]).toBeUndefined();
    expect(loaded.snapshot.runtime.pendingOperations[STALE_OP_ID]).toBeUndefined();
    expect(Object.values(loaded.snapshot.extended.entities.checkPairs)).toHaveLength(1);
  });

  it("A1. postgres SQL path also deletes owner-absent items and operations atomically with the transition", async () => {
    const { kit, store, sql } = await registeredKit("postgres");
    if (!sql) {
      throw new Error("expected memory SQL client");
    }
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const result = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(result.outcome).toBe("APPLIED");
    sql.tables.installRawItem(incomingItem({ id: STALE_ITEM_ID }));
    sql.tables.upsertOperation(USER_ID, pendingOp({ operationId: STALE_OP_ID }));
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.notificationItems[STALE_ITEM_ID]).toBeUndefined();
    expect(loaded.snapshot.runtime.pendingOperations[STALE_OP_ID]).toBeUndefined();
    expect(SQL.deleteItemsNotIn).toContain("DELETE FROM notification_items");
    expect(SQL.deleteSharesNotIn).toContain("DELETE FROM share_operations");
    expect(SQL.deleteOpsNotIn).toContain("DELETE FROM pending_operations");
  });

  it("A2. historical facts absent from a user-scoped snapshot are retained, not deleted", async () => {
    const { kit, store } = await registeredKit();
    const otherWorld = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: {
        [OTHER_BAN_ID]: makeBan({
          id: OTHER_BAN_ID,
          senderId: OTHER_USER,
          receiverId: CONTACT_A,
        }),
      },
    });
    await kit.installFixtureSnapshot(USER_ID, durationWorld());
    await kit.installFixtureSnapshot(OTHER_USER, otherWorld);
    const seeded = await store.loadProductSnapshot(USER_ID);
    expect(seeded.snapshot.extended.entities.bans[OTHER_BAN_ID]).toBeUndefined();
    const result = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.entities.bans[OTHER_BAN_ID]).toBeUndefined();
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const otherLoaded = await store.loadProductSnapshot(OTHER_USER);
    expect(otherLoaded.snapshot.extended.entities.bans[OTHER_BAN_ID]).toEqual(
      otherWorld.extended.entities.bans[OTHER_BAN_ID],
    );
    const userLoaded = await store.loadProductSnapshot(USER_ID);
    expect(userLoaded.snapshot.extended.entities.bans[BAN_ID]).toBeDefined();
    expect(userLoaded.snapshot.extended.entities.domainTimers["timer-1"]).toBeDefined();
    expect(DURABLE_COLLECTION_SYNC.bans).toBe("UPSERT_RETAIN_HISTORICAL");
    expect(DURABLE_COLLECTION_SYNC.domainTimers).toBe("UPSERT_RETAIN_HISTORICAL");
    expect(DURABLE_COLLECTION_SYNC.checkPairs).toBe("UPSERT_RETAIN_HISTORICAL");
  });

  it("A2. cancelled ShareOperations remain because the kernel retains them in the snapshot", async () => {
    const { kit, store } = await registeredKit();
    let world = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    world = {
      ...world,
      extended: { ...world.extended, createBanDraft: validCreateDraft("TEMPLATE") },
    };
    world = withEntities(world, { shareOperations: { [SHARE_ATTEMPT_ID]: shareOp() } });
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const cancelled = applied(seeded.snapshot, defaultEvent("CREATE_BAN.SHARE_CANCELLED"));
    expect(cancelled.outcome).toBe("APPLIED");
    expect(cancelled.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CANCELLED",
    );
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result: cancelled,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CANCELLED",
    );
    expect(DURABLE_COLLECTION_SYNC.shareOperations).toBe("UPSERT_RESULT_AND_DELETE_OWNER_ABSENT");
  });

  it("A3. owner-absent deletion rolls back with the rest of the transition", async () => {
    const { kit, store, memory } = await registeredKit();
    if (!memory) {
      throw new Error("expected in-memory harness");
    }
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const result = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(result.outcome).toBe("APPLIED");
    memory.inspect().installRawItem(incomingItem({ id: STALE_ITEM_ID }));
    memory.inspect().upsertOperation(USER_ID, pendingOp({ operationId: STALE_OP_ID }));
    memory.failNextWriteAfterBans();
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: seeded.revision,
        result,
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(seeded.revision);
    expect(loaded.snapshot.extended.entities.notificationItems[STALE_ITEM_ID]).toBeDefined();
    expect(loaded.snapshot.runtime.pendingOperations[STALE_OP_ID]).toBeDefined();
    expect(Object.keys(loaded.snapshot.extended.entities.checkPairs)).toEqual([]);
  });
});

describe("Defect B — no silent product-fact invention on load", () => {
  const baseRecord: NotificationItemRecord = {
    item_id: "item-1",
    owner_id: USER_ID,
    ban_id: BAN_ID,
    kind: "CHECK",
    fifo_sequence: 1,
    lifecycle_status: "UNPROCESSED",
    lifecycle_display: "ACTIVE",
    role: "RECEIVER",
    check_pair_id: "pair-1",
    domain_timer_id: null,
    status: null,
  };

  it("B1. malformed CHECK row with missing required role is rejected", () => {
    try {
      decodeNotificationItem({ ...baseRecord, role: null });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.role");
    }
  });

  it("B2. malformed STATUS row with missing required role is rejected", () => {
    try {
      decodeNotificationItem({
        ...baseRecord,
        kind: "STATUS",
        role: null,
        status: "BANTASTIC",
        check_pair_id: null,
      });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.role");
    }
  });

  it("B3. malformed STATUS row with missing required status is rejected", () => {
    try {
      decodeNotificationItem({
        ...baseRecord,
        kind: "STATUS",
        role: "SENDER",
        status: null,
        check_pair_id: null,
      });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.status");
    }
  });

  it("B4. malformed UNPROCESSED item with missing required display is rejected", () => {
    try {
      decodeNotificationItem({
        ...baseRecord,
        kind: "INCOMING_BAN",
        role: null,
        check_pair_id: null,
        lifecycle_display: null,
      });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.lifecycle_display");
    }
  });

  it("B5. other required codec facts are rejected rather than repaired", () => {
    try {
      decodeNotificationItem({
        ...baseRecord,
        kind: "TIMER",
        role: null,
        check_pair_id: null,
        domain_timer_id: null,
      });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.domain_timer_id");
    }
    try {
      decodeNotificationItem({ ...baseRecord, kind: "UNKNOWN" });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.kind");
    }
    try {
      decodeNotificationItem({ ...baseRecord, fifo_sequence: Number.NaN });
      expect.unreachable();
    } catch (error) {
      expectInvariant(error, "notification_items.fifo_sequence");
    }
  });

  it("B1-B5. load rejects planted malformed rows instead of substituting product defaults", async () => {
    const cases: ReadonlyArray<{ item: NotificationItem; field: string }> = [
      {
        item: { ...checkItem("RECEIVER"), role: undefined } as unknown as NotificationItem,
        field: "role",
      },
      {
        item: { ...statusItem(), role: undefined } as unknown as NotificationItem,
        field: "role",
      },
      {
        item: { ...statusItem(), status: undefined } as unknown as NotificationItem,
        field: "status",
      },
      {
        item: {
          ...incomingItem(),
          lifecycle: { status: "UNPROCESSED" },
        } as unknown as NotificationItem,
        field: "lifecycle_display",
      },
      {
        item: { ...timerItem(), domainTimerId: undefined } as unknown as NotificationItem,
        field: "domain_timer_id",
      },
    ];
    for (const testCase of cases) {
      const { kit, store, memory } = await registeredKit();
      if (!memory) {
        throw new Error("expected in-memory harness");
      }
      await kit.installFixtureSnapshot(USER_ID, durationWorld());
      memory.inspect().installRawItem(testCase.item);
      await expect(store.loadProductSnapshot(USER_ID)).rejects.toMatchObject({
        code: "INVARIANT",
      });
    }
  });

  it("B5. missing session bootstrap and share draft are rejected on load", async () => {
    const { kit, store, memory } = await registeredKit();
    if (!memory) {
      throw new Error("expected in-memory harness");
    }
    await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const session = memory.inspect().lockSession(USER_ID);
    if (!session) {
      throw new Error("expected session");
    }
    memory.inspect().writeSession({ ...session, bootstrap: undefined as never });
    await expect(store.loadProductSnapshot(USER_ID)).rejects.toMatchObject({ code: "INVARIANT" });

    const shareKit = await registeredKit();
    const shareMemory = shareKit.memory;
    if (!shareMemory) {
      throw new Error("expected in-memory harness");
    }
    await shareKit.kit.installFixtureSnapshot(USER_ID, durationWorld());
    shareMemory.inspect().upsertShare(USER_ID, { ...shareOp(), draft: null as never });
    await expect(shareKit.store.loadProductSnapshot(USER_ID)).rejects.toMatchObject({
      code: "INVARIANT",
    });
  });
});

describe("Defect C — single identity migration authority", () => {
  it("C1. only identity owns the identity_users migration", () => {
    expect(existsSync(join(PACKAGES, "identity/schema/001_identity_users.sql"))).toBe(true);
    expect(existsSync(join(PACKAGES, "persistence/schema/001_identity_users.sql"))).toBe(false);
    expect(readdirSync(join(PACKAGES, "persistence/schema"))).toEqual([
      "002_product_persistence.sql",
    ]);
    expect(IDENTITY_MIGRATION_AUTHORITY).toBe("packages/identity/schema/001_identity_users.sql");
    expect(MIGRATION_CHAIN.filter((entry) => entry.authority === "identity")).toHaveLength(1);
  });

  it("C2. Stage 4 applies the identity migration before product persistence", () => {
    expect(MIGRATION_CHAIN.map((entry) => [entry.authority, entry.file])).toEqual([
      ["identity", "packages/identity/schema/001_identity_users.sql"],
      ["persistence", "packages/persistence/schema/002_product_persistence.sql"],
    ]);
    const sql = allMigrationSql();
    expect(sql).toHaveLength(2);
    expect(sql[0]).toBe(identitySchemaSql());
    expect(sql[1]).toBe(productPersistenceSql());
  });

  it("C3. product persistence still creates FKs to identity_users", () => {
    expect(productPersistenceSql()).toContain("REFERENCES identity_users (user_id)");
    expect(identitySchemaSql()).toContain("CREATE TABLE IF NOT EXISTS identity_users");
  });
});

describe("Defect D — seedSnapshot is not a production mutation API", () => {
  it("A. ProductStore has no seedSnapshot method", () => {
    const store: ProductStore = new InMemoryProductStore();
    expect("seedSnapshot" in store).toBe(false);
    expect(typeof (store as { seedSnapshot?: unknown }).seedSnapshot).toBe("undefined");
    expect("commitFixture" in store).toBe(false);
    expect("installFixture" in store).toBe(false);
    expect("installFixtureSnapshot" in store).toBe(false);
    expect("registerIdentityUser" in store).toBe(false);
    expect("ensureIdentityUser" in store).toBe(false);
  });

  it("B. production PostgresProductStore cannot seed an arbitrary snapshot", () => {
    const store = new PostgresProductStore(new MemorySqlClient());
    expect("seedSnapshot" in store).toBe(false);
    expect("installFixture" in store).toBe(false);
    expect("installFixtureSnapshot" in store).toBe(false);
    expect("commitFixture" in store).toBe(false);
    expect(typeof (store as { persistTransition: unknown }).persistTransition).toBe("function");
    expect("registerIdentityUser" in store).toBe(false);
  });

  it("C. production InMemoryProductStore cannot seed an arbitrary snapshot", () => {
    const store = new InMemoryProductStore();
    expect("seedSnapshot" in store).toBe(false);
    expect("installFixture" in store).toBe(false);
    expect("installFixtureSnapshot" in store).toBe(false);
    expect("commitFixture" in store).toBe(false);
    expect("registerIdentityUser" in store).toBe(false);
  });

  it("D. PersistenceTestKit is not exported by the @98plus/persistence production entry point", () => {
    expect("PersistenceTestKit" in persistencePublic).toBe(false);
    expect("installFixtureSnapshot" in persistencePublic).toBe(false);
    expect("seedSnapshot" in persistencePublic).toBe(false);
    expect("registerIdentityUser" in persistencePublic).toBe(false);
    expect(
      (persistencePublic as { PersistenceTestKit?: unknown }).PersistenceTestKit,
    ).toBeUndefined();
  });

  it("E. tests can still install fixture snapshots through internal ./test-kit.ts", async () => {
    const { kit, store } = await registeredKit();
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.bans[BAN_ID]).toEqual(
      durationWorld().extended.entities.bans[BAN_ID],
    );
    expect(loaded.revision).toBe(seeded.revision);
  });

  it("F. normal runtime mutation remains APPLIED persistTransition with revision validation", async () => {
    const { kit, store } = await registeredKit();
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const first = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(first.outcome).toBe("APPLIED");
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result: first,
    });
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: seeded.revision,
        result: first,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
});
