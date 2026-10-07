import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import {
  emptySnapshot,
  type Ban,
  type BanId,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import {
  incomingItem,
  makeBan,
  makeChat,
  shareOp,
  withChat,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { SQL } from "./sql.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

function applied(snapshot: TransitionResult["snapshot"]): TransitionResult {
  return { outcome: "APPLIED", snapshot } as TransitionResult;
}

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

describe.skipIf(!databaseUrl)("real PostgreSQL persistence client", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    assertSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2_000,
      options: `-c search_path=${schema}`,
    });
    await db.sql.query(`CREATE SCHEMA ${schema}`, []);
    await db.sql.query(`SET search_path TO ${schema}`, []);
    await db.applyMigrations();
    const current = await db.sql.query<{ current: string }>(
      "SELECT current_schema() AS current",
      [],
    );
    if (current.rows[0]?.current !== schema) {
      throw new Error(
        `migrations ran in ${current.rows[0]?.current ?? "unknown"}, expected ${schema}`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (!db) {
      return;
    }
    assertSchemaName(schema);
    await db.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await db.close();
  });

  async function identity(telegramUserId: string): Promise<UserId> {
    const store = new PostgresIdentityStore(db.sql);
    const user = await store.resolveByTelegramUserId(asTelegramUserId(telegramUserId));
    return user.userId;
  }

  function expectReleased(): void {
    const stats = db.stats();
    expect(stats.waiting).toBe(0);
    expect(stats.idle).toBe(stats.total);
    expect(stats.total).toBeGreaterThan(0);
  }

  it("resolves and upserts an identity without creating a second user", async () => {
    const store = new PostgresIdentityStore(db.sql);
    const telegramUserId = asTelegramUserId(`tg-${randomUUID()}`);
    const before = await db.sql.query(SQL.selectIdentityByTelegramUserId, [telegramUserId]);
    expect(before.rows).toHaveLength(0);
    const first = await store.resolveByTelegramUserId(telegramUserId);
    const second = await store.resolveByTelegramUserId(telegramUserId);
    expect(second.userId).toBe(first.userId);
    const after = await db.sql.query<{ user_id: string }>(SQL.selectIdentityByTelegramUserId, [
      telegramUserId,
    ]);
    expect(after.rows).toEqual([{ user_id: first.userId, telegram_user_id: telegramUserId }]);
  });

  it("writes and loads a product snapshot", async () => {
    const senderId = await identity(`sender-${randomUUID()}`);
    const receiverId = await identity(`receiver-${randomUUID()}`);
    const ban = makeBan({
      id: `ban-${randomUUID()}` as BanId,
      senderId,
      receiverId,
    });
    const chat = makeChat({ inputDraft: "round trip" });
    const kit = PersistenceTestKit.postgres(db.sql);
    const saved = await kit.installFixtureSnapshot(
      senderId,
      withChat(withEntities(emptySnapshot(), { bans: { [ban.id]: ban } }), chat),
    );
    const loaded = await kit.store.loadProductSnapshot(senderId);
    expect(loaded.revision).toBe(saved.revision);
    expect(loaded.snapshot.extended.entities.bans[ban.id]).toMatchObject({
      banText: ban.banText,
      senderId,
      receiverId,
    });
    expect(loaded.snapshot.extended.rimChat).toEqual(chat);
    expect(typeof loaded.revision).toBe("number");
  });

  it("commits a transaction", async () => {
    const userId = `commit-${randomUUID()}`;
    const value = await db.sql.transaction(async (tx) => {
      await tx.query(SQL.insertIdentity, [userId, `tg-${userId}`]);
      return "committed";
    });
    expect(value).toBe("committed");
    const found = await db.sql.query(SQL.selectIdentity, [userId]);
    expect(found.rows).toHaveLength(1);
  });

  it("rolls back a transaction when the callback throws", async () => {
    const userId = `rollback-${randomUUID()}`;
    await expect(
      db.sql.transaction(async (tx) => {
        await tx.query(SQL.insertIdentity, [userId, `tg-${userId}`]);
        throw new Error("fail the transaction");
      }),
    ).rejects.toThrow("fail the transaction");
    const found = await db.sql.query(SQL.selectIdentity, [userId]);
    expect(found.rows).toHaveLength(0);
  });

  it("rejects a stale session revision", async () => {
    const senderId = await identity(`revision-${randomUUID()}`);
    const store = new PostgresProductStore(db.sql);
    const kit = PersistenceTestKit.postgres(db.sql);
    const saved = await kit.installFixtureSnapshot(senderId, emptySnapshot());
    await expect(
      store.persistTransition({
        currentUserId: senderId,
        expectedRevision: saved.revision + 4,
        result: applied(saved.snapshot),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const loaded = await store.loadProductSnapshot(senderId);
    expect(loaded.revision).toBe(saved.revision);
  });

  it("rejects a duplicate share token", async () => {
    const ownerId = await identity(`share-${randomUUID()}`);
    const token = `token-${randomUUID()}`;
    const kit = PersistenceTestKit.postgres(db.sql);
    await kit.installFixtureSnapshot(
      ownerId,
      withEntities(emptySnapshot(), {
        shareOperations: {
          "attempt-1": shareOp({ attemptId: "attempt-1" as never, token: token as never }),
        },
      }),
    );
    await expect(
      db.sql.query(
        `INSERT INTO share_operations (attempt_id, owner_id, draft, token, status)
         VALUES ($1, $2, $3::jsonb, $4, 'ACTIVE')`,
        [`attempt-${randomUUID()}`, ownerId, JSON.stringify({ origin: "TEMPLATE" }), token],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const stored = await db.sql.query(SQL.selectShareByToken, [token]);
    expect(stored.rows).toHaveLength(1);
  });

  it("locks a share token with SELECT FOR UPDATE inside a transaction", async () => {
    const ownerId = await identity(`lock-${randomUUID()}`);
    const token = `lock-token-${randomUUID()}`;
    const kit = PersistenceTestKit.postgres(db.sql);
    await kit.installFixtureSnapshot(
      ownerId,
      withEntities(emptySnapshot(), {
        shareOperations: {
          "attempt-lock": shareOp({
            attemptId: "attempt-lock" as never,
            token: token as never,
          }),
        },
      }),
    );
    const locked = await db.sql.transaction(async (tx) =>
      tx.query<{ token: string }>(SQL.selectShareByTokenForUpdate, [token]),
    );
    expect(locked.rows[0]?.token).toBe(token);
  });

  it("keeps Ban created_at across an update and reload", async () => {
    const senderId = await identity(`created-${randomUUID()}`);
    const receiverId = await identity(`created-receiver-${randomUUID()}`);
    const ban = makeBan({
      id: `created-${randomUUID()}` as BanId,
      senderId,
      receiverId,
      banText: "original",
    });
    const store = new PostgresProductStore(db.sql);
    const kit = PersistenceTestKit.postgres(db.sql);
    await kit.installFixtureSnapshot(
      senderId,
      withEntities(emptySnapshot(), { bans: { [ban.id]: ban } }),
    );
    const before = await store.listRelationshipContextSources(senderId, receiverId);
    const createdAtMs = before[0]?.createdAtMs;
    expect(typeof createdAtMs).toBe("number");
    const sequence = await db.sql.query<{ created_seq: number }>(
      "SELECT created_seq FROM bans WHERE ban_id = $1",
      [ban.id],
    );
    expect(typeof sequence.rows[0]?.created_seq).toBe("number");
    const updated: Ban = { ...ban, banText: "updated" };
    await kit.installFixtureSnapshot(
      senderId,
      withEntities(emptySnapshot(), { bans: { [ban.id]: updated } }),
    );
    const after = await store.listRelationshipContextSources(senderId, receiverId);
    expect(after[0]?.banText).toBe("updated");
    expect(after[0]?.createdAtMs).toBe(createdAtMs);
  });

  it("round-trips JSONB RimChat and rim provider runtime", async () => {
    const senderId = await identity(`json-${randomUUID()}`);
    const chat = makeChat({ inputDraft: "jsonb" });
    const runtime = { provider: "fake", nonce: 7 };
    const store = new PostgresProductStore(db.sql);
    const kit = PersistenceTestKit.postgres(db.sql);
    const saved = await kit.installFixtureSnapshot(senderId, withChat(emptySnapshot(), chat));
    const withRuntime = await store.saveRimProviderRuntime(senderId, saved.revision, runtime);
    expect(withRuntime.snapshot.extended.rimChat).toEqual(chat);
    expect(withRuntime.rimProviderRuntime).toEqual(runtime);
    const loaded = await store.loadProductSnapshot(senderId);
    expect(loaded.snapshot.extended.rimChat).toEqual(chat);
    expect(loaded.rimProviderRuntime).toEqual(runtime);
  });

  it("replaces an owner's rows with an empty text array", async () => {
    const senderId = await identity(`empty-${randomUUID()}`);
    const receiverId = await identity(`empty-receiver-${randomUUID()}`);
    const ban = makeBan({
      id: `empty-${randomUUID()}` as BanId,
      senderId,
      receiverId,
    });
    const item = incomingItem({
      id: `item-${randomUUID()}` as never,
      ownerId: senderId,
      banId: ban.id,
    });
    const kit = PersistenceTestKit.postgres(db.sql);
    await kit.installFixtureSnapshot(
      senderId,
      withEntities(emptySnapshot(), {
        bans: { [ban.id]: ban },
        notificationItems: { [item.id]: item },
      }),
    );
    const cleared = await kit.installFixtureSnapshot(
      senderId,
      withEntities(emptySnapshot(), { bans: { [ban.id]: ban }, notificationItems: {} }),
    );
    expect(Object.keys(cleared.snapshot.extended.entities.notificationItems)).toHaveLength(0);
    const stored = await db.sql.query<{ item_id: string }>(
      "SELECT item_id FROM notification_items WHERE owner_id = $1",
      [senderId],
    );
    expect(stored.rows).toHaveLength(0);
  });

  it("rejects a second check pair for the same Ban", async () => {
    const senderId = await identity(`pair-${randomUUID()}`);
    const receiverId = await identity(`pair-receiver-${randomUUID()}`);
    const ban = makeBan({
      id: `pair-${randomUUID()}` as BanId,
      senderId,
      receiverId,
    });
    const kit = PersistenceTestKit.postgres(db.sql);
    await kit.installFixtureSnapshot(
      senderId,
      withEntities(emptySnapshot(), { bans: { [ban.id]: ban } }),
    );
    await db.sql.query(
      `INSERT INTO check_pairs (pair_id, ban_id, receiver_item_id, sender_item_id)
       VALUES ($1, $2, $3, $4)`,
      ["pair-a", ban.id, "item-r", "item-s"],
    );
    await expect(
      db.sql.query(
        `INSERT INTO check_pairs (pair_id, ban_id, receiver_item_id, sender_item_id)
         VALUES ($1, $2, $3, $4)`,
        ["pair-b", ban.id, "item-r2", "item-s2"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("conditionally binds a receiver and leaves a bound Ban unchanged", async () => {
    const senderId = await identity(`bind-${randomUUID()}`);
    const receiverId = await identity(`bind-receiver-${randomUUID()}`);
    const otherId = await identity(`bind-other-${randomUUID()}`);
    const ban = makeBan({
      id: `bind-${randomUUID()}` as BanId,
      senderId,
      receiverId: null,
    });
    const store = new PostgresProductStore(db.sql);
    const kit = PersistenceTestKit.postgres(db.sql);
    await kit.installFixtureSnapshot(
      senderId,
      withEntities(emptySnapshot(), { bans: { [ban.id]: ban } }),
    );
    const bound = await store.bindBanReceiver(ban.id, receiverId);
    expect(bound.status).toBe("BOUND");
    const again = await store.bindBanReceiver(ban.id, receiverId);
    expect(again.status).toBe("ALREADY_BOUND");
    const conflict = await store.bindBanReceiver(ban.id, otherId);
    expect(conflict.status).toBe("CONFLICT");
    if (conflict.status === "CONFLICT") {
      expect(conflict.ban.receiverId).toBe(receiverId);
    }
  });

  it("returns the connection after transaction success", async () => {
    const value = await db.sql.transaction(async (tx) => {
      const result = await tx.query<{ n: number }>("SELECT 1 AS n", []);
      return result.rows[0]?.n;
    });
    expect(value).toBe(1);
    expectReleased();
    await db.sql.query("SELECT 1", []);
    expectReleased();
  });

  it("returns the connection after transaction failure", async () => {
    await expect(
      db.sql.transaction(async (tx) => {
        await tx.query("SELECT 1", []);
        throw new Error("release after failure");
      }),
    ).rejects.toThrow("release after failure");
    expectReleased();
    await db.sql.query("SELECT 1", []);
    expectReleased();
  });

  it("fails loudly on invalid SQL and does not keep the rolled-back statement", async () => {
    await expect(db.sql.query("NOT VALID SQL", [])).rejects.toThrow(/syntax error/i);
    const secret = new URL(databaseUrl ?? "postgres://localhost/none").password;
    await expect(
      db.sql.transaction(async (tx) => {
        await tx.query("CREATE TABLE migration_probe (id int)", []);
        await tx.query("NOT VALID SQL", []);
      }),
    ).rejects.toThrow(/syntax error/i);
    const left = await db.sql.query<{ name: string | null }>(
      "SELECT to_regclass('migration_probe') AS name",
      [],
    );
    expect(left.rows[0]?.name).toBeNull();
    if (secret) {
      await db.sql.query("NOT VALID SQL", []).catch((error: unknown) => {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : "";
        expect(message).not.toContain(secret);
        expect(message).not.toContain(databaseUrl);
      });
    }
    const tables = await db.sql.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()",
      [],
    );
    const names = tables.rows.map((row) => row.tablename);
    expect(names).toEqual(
      expect.arrayContaining([
        "identity_users",
        "product_user_sessions",
        "bans",
        "domain_timers",
        "check_pairs",
        "notification_items",
        "pending_operations",
        "share_operations",
      ]),
    );
    const index = await db.sql.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'share_operations_token_key'",
      [],
    );
    expect(index.rows).toHaveLength(1);
    await db.applyMigrations();
  });
});
