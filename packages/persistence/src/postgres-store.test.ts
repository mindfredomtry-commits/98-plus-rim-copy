import { describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import { emptySnapshot, reduce } from "@98plus/product-model";
import {
  BAN_ID,
  USER_ID,
  OTHER_USER,
  defaultEvent,
  kernelContext,
  makeBan,
  makeTimer,
  withControlState,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { asInstant, counterAllocator } from "../../product-model/src/kernel/snapshot.ts";
import { MemorySqlClient } from "./memory-sql.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { SQL } from "./sql.ts";
import { PersistenceTestKit } from "./test-kit.ts";

describe("PostgresProductStore SQL boundary", () => {
  it("round-trips a kernel APPLIED transition through SQL statements and rolls back on failure", async () => {
    const client = new MemorySqlClient();
    const kit = PersistenceTestKit.postgres(client);
    const store = kit.store;
    kit.establishIdentity(USER_ID, "tg-1");
    kit.establishIdentity(OTHER_USER, "tg-2");
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [BAN_ID]: makeBan() },
      domainTimers: { "timer-1": makeTimer({ startedAt: asInstant(0) }) },
    });
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const result = reduce(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"), kernelContext());
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(Object.values(loaded.snapshot.extended.entities.checkPairs)).toHaveLength(1);
    expect(saved.revision).toBe(loaded.revision);
    expect(SQL.upsertBan).toContain("ON CONFLICT (ban_id)");
    expect(SQL.upsertTimer).toContain("ON CONFLICT (timer_id)");
    expect(SQL.selectSessionForUpdate).toContain("FOR UPDATE");

    const before = loaded;
    client.failNextQuery();
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: before.revision,
        result,
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const after = await store.loadProductSnapshot(USER_ID);
    expect(after.revision).toBe(before.revision);
    expect(Object.values(after.snapshot.extended.entities.checkPairs)).toHaveLength(1);
  });

  it("does not expose an arbitrary snapshot-seed mutation on the production class", () => {
    const store = new PostgresProductStore(new MemorySqlClient());
    expect("seedSnapshot" in store).toBe(false);
    expect("installFixture" in store).toBe(false);
    expect("registerIdentityUser" in store).toBe(false);
    expect(typeof (store as { seedSnapshot?: unknown }).seedSnapshot).toBe("undefined");
    expect(typeof (store as { registerIdentityUser?: unknown }).registerIdentityUser).toBe(
      "undefined",
    );
  });

  it("consumes Stage 3 identity_users rows on the same SQL client and keeps FKs", async () => {
    const client = new MemorySqlClient();
    const identity = new PostgresIdentityStore(client);
    const store = new PostgresProductStore(client);
    const user = await identity.resolveByTelegramUserId(asTelegramUserId("tg-1"));
    expect(client.tables.hasUser(user.userId)).toBe(true);
    expect("registerIdentityUser" in store).toBe(false);
    const loaded = await store.loadProductSnapshot(user.userId);
    const opened = reduce(loaded.snapshot, defaultEvent("APP.NORMAL_OPEN"), {
      now: asInstant(1_000_000),
      currentUserId: user.userId,
      allocateId: counterAllocator(),
    });
    expect(opened.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: user.userId,
      expectedRevision: loaded.revision,
      result: opened,
    });
    expect(saved.snapshot.controlState).toBe("RIM.LOBBY");
  });
});
