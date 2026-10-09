import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import { emptySnapshot, type TransitionResult, type UserId } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import type { PersistenceSqlClient } from "./types.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

function explodeAfterOwnershipInsert(inner: PersistenceSqlClient): PersistenceSqlClient {
  const wrap = (client: PersistenceSqlClient): PersistenceSqlClient => ({
    query: async <T>(sql: string, params: readonly unknown[]) => {
      const result = await client.query<T>(sql, params);
      if (sql.includes("INSERT INTO rim_provider_ownership")) {
        throw new Error("injected after ownership insert");
      }
      return result;
    },
    transaction: (fn) => client.transaction(async (tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

describe.skipIf(!databaseUrl)("disposable PostgreSQL RIM provider ownership", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    assertSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    await db.sql.query(`CREATE SCHEMA ${schema}`, []);
    await db.sql.query(`SET search_path TO ${schema}`, []);
    const report = await db.migrate();
    expect(report.applied).toHaveLength(12);
    expect(report.applied[10]).toBe("packages/persistence/schema/011_rim_provider_ownership.sql");
    expect(report.applied[11]).toBe("packages/persistence/schema/012_telegram_ban_message.sql");
  }, 30_000);

  afterAll(async () => {
    if (!db) {
      return;
    }
    assertSchemaName(schema);
    await db.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await db.close();
  }, 30_000);

  async function seed(): Promise<{
    userId: UserId;
    revision: number;
    store: PostgresProductStore;
  }> {
    const identity = new PostgresIdentityStore(db.sql);
    const user = await identity.resolveByTelegramUserId(asTelegramUserId(`own-${randomUUID()}`));
    const saved = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
      user.userId,
      emptySnapshot(),
    );
    return {
      userId: user.userId,
      revision: saved.revision,
      store: new PostgresProductStore(db.sql),
    };
  }

  function claim(userId: UserId, attemptId: string, expectedRevision: number) {
    return {
      currentUserId: userId,
      expectedRevision,
      operationKind: "initialization" as const,
      attemptId,
      requestId: "request-1",
      leaseSeconds: 30,
      runtime: { marker: "acceptance-unknown", attemptId },
    };
  }

  it("applies migration 011 and rejects duplicate keys and illegal release columns", async () => {
    const { userId } = await seed();
    const constraints = await db.sql.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'rim_provider_ownership'::regclass
       ORDER BY conname`,
      [],
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "rim_provider_ownership_attempt_id_chk",
      "rim_provider_ownership_operation_kind_chk",
      "rim_provider_ownership_pkey",
      "rim_provider_ownership_release_pair_chk",
      "rim_provider_ownership_release_reason_chk",
      "rim_provider_ownership_request_id_chk",
      "rim_provider_ownership_user_fk",
    ]);
    const token = randomUUID();
    await db.sql.query(
      `INSERT INTO rim_provider_ownership (
         user_id, operation_kind, attempt_id, request_id, owner_token, leased_until
       ) VALUES ($1, 'user-attempt', 'attempt-unique', 'request-1', $2::uuid, clock_timestamp() + INTERVAL '30 seconds')`,
      [userId, token],
    );
    await expect(
      db.sql.query(
        `INSERT INTO rim_provider_ownership (
           user_id, operation_kind, attempt_id, request_id, owner_token, leased_until
         ) VALUES ($1, 'user-attempt', 'attempt-unique', 'request-1', $2::uuid, clock_timestamp() + INTERVAL '30 seconds')`,
        [userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.sql.query(
        `INSERT INTO rim_provider_ownership (
           user_id, operation_kind, attempt_id, owner_token, leased_until, release_reason
         ) VALUES ($1, 'initialization', 'attempt-bad-reason', $2::uuid, clock_timestamp(), 'nope')`,
        [userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.sql.query(
        `INSERT INTO rim_provider_ownership (
           user_id, operation_kind, attempt_id, owner_token, leased_until, release_reason
         ) VALUES ($1, 'initialization', 'attempt-half-release', $2::uuid, clock_timestamp(), 'completed')`,
        [userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.sql.query(
        `INSERT INTO rim_provider_ownership (
           user_id, operation_kind, attempt_id, owner_token, leased_until
         ) VALUES ($1, 'sideways', 'attempt-kind', $2::uuid, clock_timestamp())`,
        [userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("lets one connection acquire and shows the same row to another connection", async () => {
    const { userId, revision, store } = await seed();
    const raced = await Promise.allSettled([
      store.acquireRimProviderOwnership(claim(userId, "attempt-race", revision)),
      new PostgresProductStore(db.sql).acquireRimProviderOwnership(
        claim(userId, "attempt-race", revision),
      ),
    ]);
    const won = raced.find((result) => result.status === "fulfilled");
    const lost = raced.find((result) => result.status === "rejected");
    expect(won?.status).toBe("fulfilled");
    expect(lost?.status).toBe("rejected");
    if (lost?.status === "rejected") {
      expect((lost.reason as PersistenceError).code).toBe("REVISION_CONFLICT");
    }
    if (won?.status !== "fulfilled" || won.value.status !== "ACQUIRED") {
      throw new Error("expected one acquire");
    }
    assertSchemaName(schema);
    const other = openPostgresPersistence({
      connectionString: databaseUrl ?? "",
      max: 1,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    try {
      const seen = await new PostgresProductStore(other.sql).lookupRimProviderOwnership({
        currentUserId: userId,
        operationKind: "initialization",
        attemptId: "attempt-race",
      });
      expect(seen?.ownerToken).toBe(won.value.ownership.ownerToken);
      expect(seen?.phase).toBe("held");
      const loaded = await other.sql.query<{ revision: string | number }>(
        "SELECT revision FROM product_user_sessions WHERE user_id = $1",
        [userId],
      );
      expect(Number(loaded.rows[0]?.revision)).toBe(won.value.loaded.revision);
    } finally {
      await other.close();
    }
  });

  it("rolls back ownership when the claim transaction fails", async () => {
    const { userId, revision } = await seed();
    const exploding = new PostgresProductStore(explodeAfterOwnershipInsert(db.sql));
    await expect(
      exploding.acquireRimProviderOwnership(claim(userId, "attempt-rollback", revision)),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const rows = await db.sql.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM rim_provider_ownership
       WHERE user_id = $1 AND attempt_id = 'attempt-rollback'`,
      [userId],
    );
    expect(rows.rows).toEqual([]);
    const session = await db.sql.query<{
      revision: string | number;
      rim_provider_runtime: unknown;
    }>("SELECT revision, rim_provider_runtime FROM product_user_sessions WHERE user_id = $1", [
      userId,
    ]);
    expect(Number(session.rows[0]?.revision)).toBe(revision);
    expect(session.rows[0]?.rim_provider_runtime).toBeNull();
  });

  it("renews and releases only the holding token, and expiry does not replace it", async () => {
    const { userId, revision, store } = await seed();
    const acquired = await store.acquireRimProviderOwnership(
      claim(userId, "attempt-lease", revision),
    );
    expect(acquired.status).toBe("ACQUIRED");
    if (acquired.status !== "ACQUIRED") {
      return;
    }
    const renewed = await store.renewRimProviderOwnership({
      currentUserId: userId,
      operationKind: "initialization",
      attemptId: "attempt-lease",
      ownerToken: acquired.ownership.ownerToken,
      leaseSeconds: 40,
    });
    expect(renewed.status).toBe("RENEWED");
    const mismatched = await store.renewRimProviderOwnership({
      currentUserId: userId,
      operationKind: "initialization",
      attemptId: "attempt-lease",
      ownerToken: randomUUID(),
      leaseSeconds: 40,
    });
    expect(mismatched).toMatchObject({
      status: "REJECTED",
      reason: "TOKEN_MISMATCH",
    });
    const afterHeartbeat = await store.loadProductSnapshot(userId);
    expect(afterHeartbeat.revision).toBe(acquired.loaded.revision);

    await db.sql.query(
      `UPDATE rim_provider_ownership
       SET leased_until = clock_timestamp() - INTERVAL '1 second'
       WHERE user_id = $1 AND operation_kind = 'initialization' AND attempt_id = 'attempt-lease'`,
      [userId],
    );
    const expired = await store.renewRimProviderOwnership({
      currentUserId: userId,
      operationKind: "initialization",
      attemptId: "attempt-lease",
      ownerToken: acquired.ownership.ownerToken,
      leaseSeconds: 40,
    });
    expect(expired).toMatchObject({ status: "REJECTED", reason: "EXPIRED" });
    if (expired.status === "REJECTED") {
      expect(expired.ownership?.ownerToken).toBe(acquired.ownership.ownerToken);
      expect(expired.ownership?.phase).toBe("renewal-lapsed");
    }
    const kept = await store.acquireRimProviderOwnership({
      ...claim(userId, "attempt-lease", acquired.loaded.revision),
    });
    expect(kept.status).toBe("ALREADY_PRESENT");
    if (kept.status === "ALREADY_PRESENT") {
      expect(kept.ownership.ownerToken).toBe(acquired.ownership.ownerToken);
      expect(kept.loaded.revision).toBe(acquired.loaded.revision);
    }
    const wrongRelease = await store.releaseRimProviderOwnership({
      currentUserId: userId,
      operationKind: "initialization",
      attemptId: "attempt-lease",
      ownerToken: randomUUID(),
      releaseReason: "completed",
    });
    expect(wrongRelease).toMatchObject({ status: "REJECTED", reason: "TOKEN_MISMATCH" });
    const released = await store.releaseRimProviderOwnership({
      currentUserId: userId,
      operationKind: "initialization",
      attemptId: "attempt-lease",
      ownerToken: acquired.ownership.ownerToken,
      releaseReason: "completed",
    });
    expect(released.status).toBe("RELEASED");
    if (released.status === "RELEASED") {
      expect(released.ownership.phase).toBe("released");
      expect(released.ownership.ownerToken).toBe(acquired.ownership.ownerToken);
    }
    const loaded = await store.loadProductSnapshot(userId);
    expect(loaded.revision).toBe(acquired.loaded.revision);
  });

  it("keeps the ownership row when the Product session is written", async () => {
    const { userId, revision, store } = await seed();
    const acquired = await store.acquireRimProviderOwnership(
      claim(userId, "attempt-keep", revision),
    );
    if (acquired.status !== "ACQUIRED") {
      throw new Error("expected acquire");
    }
    const written = await store.persistTransition({
      currentUserId: userId,
      expectedRevision: acquired.loaded.revision,
      result: { outcome: "APPLIED", snapshot: acquired.loaded.snapshot } as TransitionResult,
    });
    expect(written.revision).toBe(acquired.loaded.revision + 1);
    const kept = await store.lookupRimProviderOwnership({
      currentUserId: userId,
      operationKind: "initialization",
      attemptId: "attempt-keep",
    });
    expect(kept?.ownerToken).toBe(acquired.ownership.ownerToken);
    expect(kept?.phase).toBe("held");
  });

  it("locks the product session before the ownership row and fences through that order", async () => {
    const { userId, revision, store } = await seed();
    const acquired = await store.acquireRimProviderOwnership(
      claim(userId, "attempt-lock", revision),
    );
    if (acquired.status !== "ACQUIRED") {
      throw new Error("expected acquire");
    }
    let releaseRaw: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      releaseRaw = resolve;
    });
    const raw = db.sql.transaction(async (tx) => {
      await tx.query(
        `SELECT attempt_id FROM rim_provider_ownership
         WHERE user_id = $1 AND operation_kind = 'initialization' AND attempt_id = 'attempt-lock'
         FOR UPDATE`,
        [userId],
      );
      await holding;
    });
    try {
      await waitForLocks(db, (rows) =>
        rows.some(
          (row) => row.granted && String(row.relation).includes("rim_provider_ownership"),
        ),
      );
      let entered = false;
      const coordinated = store.withRimProviderOwnershipCoordination(
        { currentUserId: userId, operationKind: "initialization", attemptId: "attempt-lock" },
        async (context) => {
          entered = true;
          expect(context.revision).toBe(acquired.loaded.revision);
          const marked = await context.invalidate("superseded");
          expect(marked.status).toBe("INVALIDATED");
          return marked;
        },
      );
      await waitForLocks(db, (rows) =>
        rows.some(
          (row) =>
            !row.granted &&
            rows.some(
              (held) =>
                held.pid === row.pid &&
                held.granted &&
                String(held.relation).includes("product_user_sessions"),
            ),
        ),
      );
      expect(entered).toBe(false);
      releaseRaw();
      await raw;
      const marked = await coordinated;
      expect(entered).toBe(true);
      expect(marked.status).toBe("INVALIDATED");
      const loaded = await store.loadProductSnapshot(userId);
      expect(loaded.revision).toBe(acquired.loaded.revision);
      const fenced = await store.lookupRimProviderOwnership({
        currentUserId: userId,
        operationKind: "initialization",
        attemptId: "attempt-lock",
      });
      expect(fenced?.releaseReason).toBe("superseded");
      expect(fenced?.ownerToken).toBe(acquired.ownership.ownerToken);
    } finally {
      releaseRaw();
      await raw.catch(() => undefined);
    }
  }, 20_000);
});

type LockView = { pid: number; granted: boolean; relation: string; locktype: string };

async function waitForLocks(
  db: PostgresPersistence,
  ready: (rows: readonly LockView[]) => boolean,
): Promise<readonly LockView[]> {
  const started = Date.now();
  let latest: readonly LockView[] = [];
  while (Date.now() - started < 5_000) {
    const result = await db.sql.query<LockView>(
      `SELECT l.pid,
              l.granted,
              l.locktype,
              COALESCE(c.relname, '') AS relation
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       LEFT JOIN pg_class c ON c.oid = l.relation
       WHERE a.datname = current_database()
         AND a.pid <> pg_backend_pid()`,
      [],
    );
    latest = result.rows;
    if (ready(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for locks: ${JSON.stringify(latest)}`);
}
