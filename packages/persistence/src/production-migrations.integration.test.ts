import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asTelegramUserId, PostgresIdentityStore } from "@98plus/identity";
import { emptySnapshot } from "@98plus/product-model";
import { canonicalMigrationScripts, rimHistorySql } from "./migrations.ts";
import { declaredMigrationObjects, type DeclaredMigrationObject } from "./production-migrations.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

function open(schema?: string, max = 2): PostgresPersistence {
  if (!databaseUrl) {
    throw new Error("MVP17_TEST_DATABASE_URL is required");
  }
  return openPostgresPersistence({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: 5_000,
    ...(schema === undefined
      ? {}
      : (() => {
          assertSchemaName(schema);
          return { options: `-c search_path=${schema}` };
        })()),
  });
}

async function createSchema(schema: string): Promise<void> {
  assertSchemaName(schema);
  const admin = open();
  try {
    await admin.sql.query(`CREATE SCHEMA ${schema}`, []);
  } finally {
    await admin.close();
  }
}

async function dropSchema(schema: string): Promise<void> {
  assertSchemaName(schema);
  const admin = open();
  try {
    await admin.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
  } finally {
    await admin.close();
  }
}

async function objectPresent(
  db: PostgresPersistence,
  object: DeclaredMigrationObject,
): Promise<boolean> {
  if (object.kind === "column") {
    const result = await db.sql.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
       ) AS present`,
      [object.table, object.name],
    );
    return result.rows[0]?.present === true;
  }
  if (object.kind === "constraint") {
    const result = await db.sql.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = $1 AND connamespace = current_schema()::regnamespace
       ) AS present`,
      [object.name],
    );
    return result.rows[0]?.present === true;
  }
  const result = await db.sql.query<{ present: string | null }>(
    "SELECT to_regclass($1) AS present",
    [object.name],
  );
  return result.rows[0]?.present != null;
}

describe.skipIf(!databaseUrl)("production migration runner", () => {
  const schemas: string[] = [];

  afterAll(async () => {
    for (const schema of schemas) {
      await dropSchema(schema);
    }
  });

  async function schema(): Promise<string> {
    const name = `mvp17_${randomUUID().replaceAll("-", "")}`;
    schemas.push(name);
    await createSchema(name);
    return name;
  }

  it("applies 001–010 once on an empty schema and leaves stores usable", async () => {
    const name = await schema();
    const db = open(name);
    try {
      const first = await db.migrate();
      const scripts = canonicalMigrationScripts();
      expect(first.newlyApplied).toEqual(scripts.map((script) => script.id));
      expect(first.applied).toEqual(first.newlyApplied);
      for (const script of scripts) {
        for (const object of declaredMigrationObjects(script.sql)) {
          expect(await objectPresent(db, object)).toBe(true);
        }
      }
      const history = await db.sql.query<{ version: string; applied_at: Date }>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at ASC, version ASC",
        [],
      );
      expect(history.rows.map((row) => row.version)).toEqual(first.applied);
      expect(history.rows.every((row) => row.applied_at instanceof Date)).toBe(true);

      const second = await db.migrate();
      expect(second.newlyApplied).toEqual([]);
      expect(second.applied).toEqual(first.applied);
      const again = await db.sql.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
        [],
      );
      expect(again.rows).toHaveLength(10);

      const identity = new PostgresIdentityStore(db.sql);
      const user = await identity.resolveByTelegramUserId(asTelegramUserId("4242"));
      const saved = await PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(
        user.userId,
        emptySnapshot(),
      );
      const other = open(name);
      try {
        const againUser = await new PostgresIdentityStore(other.sql).resolveByTelegramUserId(
          asTelegramUserId("4242"),
        );
        expect(againUser.userId).toBe(user.userId);
        const loaded = await new PostgresProductStore(other.sql).loadProductSnapshot(user.userId);
        expect(loaded.revision).toBe(saved.revision);
        expect(loaded.snapshot.controlState).toBe(saved.snapshot.controlState);
      } finally {
        await other.close();
      }
    } finally {
      await db.close();
    }
  }, 30_000);

  it("continues a recorded 001–004 prefix with 005–010", async () => {
    const name = await schema();
    const db = open(name);
    try {
      const scripts = canonicalMigrationScripts();
      const partial = await db.migrate({ migrations: scripts.slice(0, 4) });
      expect(partial.newlyApplied).toHaveLength(4);
      const rest = await db.migrate();
      expect(rest.newlyApplied).toEqual(scripts.slice(4).map((script) => script.id));
      expect(rest.applied).toHaveLength(10);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("rolls back a failed migration and resumes the same version", async () => {
    const name = await schema();
    const db = open(name);
    try {
      const first = canonicalMigrationScripts()[0];
      if (!first) {
        throw new Error("missing migration 001");
      }
      const failedId = "packages/persistence/schema/failed_probe.sql";
      await expect(
        db.migrate({
          migrations: [
            first,
            {
              id: failedId,
              sql: "CREATE TABLE migration_rollback_probe (id int); SELECT * FROM migration_missing;",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
      const history = await db.sql.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
        [],
      );
      expect(history.rows.map((row) => row.version)).toEqual([first.id]);
      const probe = await db.sql.query<{ present: string | null }>(
        "SELECT to_regclass('migration_rollback_probe') AS present",
        [],
      );
      expect(probe.rows[0]?.present ?? null).toBeNull();
      const resumed = await db.migrate({
        migrations: [
          first,
          { id: failedId, sql: "CREATE TABLE migration_rollback_probe (id int)" },
        ],
      });
      expect(resumed.newlyApplied).toEqual([failedId]);
      const created = await db.sql.query<{ present: string | null }>(
        "SELECT to_regclass('migration_rollback_probe') AS present",
        [],
      );
      expect(created.rows[0]?.present ?? null).not.toBeNull();
    } finally {
      await db.close();
    }
  }, 30_000);

  it("lets one of two runners apply a non-idempotent migration", async () => {
    const name = await schema();
    const left = open(name);
    const right = open(name);
    try {
      const script = {
        id: "packages/persistence/schema/once_probe.sql",
        sql: "CREATE TABLE mig_once (id int primary key); INSERT INTO mig_once VALUES (1);",
      };
      await Promise.all([
        left.migrate({ migrations: [script] }),
        right.migrate({ migrations: [script] }),
      ]);
      const rows = await left.sql.query<{ id: number }>("SELECT id FROM mig_once", []);
      expect(rows.rows).toEqual([{ id: 1 }]);
      const history = await left.sql.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
        [],
      );
      expect(history.rows.map((row) => row.version)).toEqual([script.id]);
    } finally {
      await left.close();
      await right.close();
    }
  }, 30_000);

  it("refuses an unknown history version, a gap, and a schema/history mismatch", async () => {
    const name = await schema();
    const db = open(name);
    try {
      await db.migrate();
      await db.sql.query(
        "INSERT INTO schema_migrations (version) VALUES ('packages/persistence/schema/999_future.sql')",
        [],
      );
      await expect(db.migrate()).rejects.toMatchObject({ code: "MIGRATION_HISTORY" });
    } finally {
      await db.close();
    }

    const gapped = await schema();
    const gapDb = open(gapped);
    try {
      const scripts = canonicalMigrationScripts();
      const fourth = scripts[3];
      if (!fourth) {
        throw new Error("missing migration 004");
      }
      await gapDb.migrate({ migrations: scripts.slice(0, 2) });
      await gapDb.sql.query("INSERT INTO schema_migrations (version) VALUES ($1)", [fourth.id]);
      await expect(gapDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_HISTORY" });
      const later = await gapDb.sql.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'product_user_sessions'
             AND column_name = 'telegram_persistent_reentry_eligible'
         ) AS present`,
        [],
      );
      expect(later.rows[0]?.present).toBe(false);
    } finally {
      await gapDb.close();
    }

    const missing = await schema();
    const missingDb = open(missing);
    try {
      const scripts = canonicalMigrationScripts();
      const second = scripts[1];
      if (!second) {
        throw new Error("missing migration 002");
      }
      await missingDb.migrate({ migrations: scripts.slice(0, 1) });
      await missingDb.sql.query("INSERT INTO schema_migrations (version) VALUES ($1)", [second.id]);
      await expect(missingDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_SCHEMA" });
    } finally {
      await missingDb.close();
    }

    const ahead = await schema();
    const aheadDb = open(ahead);
    try {
      await aheadDb.sql.query("CREATE TABLE identity_users (user_id text primary key)", []);
      await expect(aheadDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_SCHEMA" });
      const history = await aheadDb.sql.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
        [],
      );
      expect(history.rows).toEqual([]);
    } finally {
      await aheadDb.close();
    }
  }, 30_000);

  it("keeps migration 010 fail-closed for old code, new code, and a partial schema", async () => {
    const scripts = canonicalMigrationScripts();
    const oldScripts = scripts.slice(0, 9);

    const recorded = await schema();
    const recordedDb = open(recorded);
    try {
      await recordedDb.migrate();
      await expect(recordedDb.migrate({ migrations: oldScripts })).rejects.toThrow(
        /unknown version/,
      );
    } finally {
      await recordedDb.close();
    }

    const current = await schema();
    const currentDb = open(current);
    try {
      const first = await currentDb.migrate();
      expect(first.applied).toHaveLength(10);
      const second = await currentDb.migrate();
      expect(second.newlyApplied).toEqual([]);
      expect(second.applied).toHaveLength(10);
    } finally {
      await currentDb.close();
    }

    const unrecorded = await schema();
    const unrecordedDb = open(unrecorded);
    try {
      await unrecordedDb.migrate({ migrations: oldScripts });
      for (const statement of rimHistorySql()
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)) {
        await unrecordedDb.sql.query(statement, []);
      }
      const again = await unrecordedDb.migrate({ migrations: oldScripts });
      expect(again.newlyApplied).toEqual([]);
      const history = await unrecordedDb.sql.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
        [],
      );
      expect(history.rows).toHaveLength(9);
      await expect(unrecordedDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_SCHEMA" });
    } finally {
      await unrecordedDb.close();
    }

    const partial = await schema();
    const partialDb = open(partial);
    try {
      await partialDb.migrate({ migrations: oldScripts });
      await partialDb.sql.query("CREATE TABLE rim_chats (rim_chat_id TEXT PRIMARY KEY)", []);
      await expect(partialDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_SCHEMA" });
      const history = await partialDb.sql.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
        [],
      );
      expect(history.rows).toHaveLength(9);
      const messages = await partialDb.sql.query<{ present: string | null }>(
        "SELECT to_regclass('rim_messages') AS present",
        [],
      );
      expect(messages.rows[0]?.present).toBeNull();
    } finally {
      await partialDb.close();
    }
  }, 30_000);

  it("does not treat the test replay harness as recorded history", async () => {
    const name = await schema();
    const db = open(name);
    try {
      await db.applyMigrations();
      await expect(db.migrate()).rejects.toMatchObject({ code: "MIGRATION_SCHEMA" });
    } finally {
      await db.close();
    }
  }, 30_000);
});
