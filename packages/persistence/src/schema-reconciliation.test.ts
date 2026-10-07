import { describe, expect, it } from "vitest";
import { UPSERT_IDENTITY_USER_SQL } from "@98plus/identity";
import {
  CANONICAL_EVENT_COUNT,
  emptySnapshot,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import {
  BAN_ID,
  makeBan,
  OTHER_USER,
  shareOp,
  USER_ID,
  withControlState,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { MemorySqlClient } from "./memory-sql.ts";
import {
  allMigrationSql,
  MIGRATION_CHAIN,
  productPersistenceSql,
  rimProviderRuntimeSql,
  shareOperationTokenUniqueSql,
} from "./migrations.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { SQL } from "./sql.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const CANONICAL_MIGRATIONS = [
  "packages/identity/schema/001_identity_users.sql",
  "packages/persistence/schema/002_product_persistence.sql",
  "packages/persistence/schema/003_telegram_persistent_reentry.sql",
  "packages/persistence/schema/004_telegram_persistent_reentry_bootstrap_claim.sql",
  "packages/persistence/schema/005_telegram_persistent_reentry_bootstrap_claim_token.sql",
  "packages/persistence/schema/006_telegram_persistent_reentry_cta_opportunity.sql",
  "packages/persistence/schema/007_ban_source_proposal.sql",
  "packages/persistence/schema/008_rim_provider_runtime.sql",
  "packages/persistence/schema/009_share_operation_token_unique.sql",
] as const;

function migrationSql(): string {
  return allMigrationSql().join("\n");
}

function createTableBody(ddl: string, table: string): string {
  const match = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  return match?.[1] ?? "";
}

function conflictTargets(sql: string): { table: string; columns: readonly string[] }[] {
  return [...sql.matchAll(/INSERT INTO ([a-z_]+)[\s\S]*?ON CONFLICT \(([^)]+)\)/g)].map(
    (match) => ({
      table: match[1] ?? "",
      columns: (match[2] ?? "").split(",").map((column) => column.trim()),
    }),
  );
}

function constraintCovers(ddl: string, table: string, columns: readonly string[]): boolean {
  const body = createTableBody(ddl, table);
  if (columns.length === 1) {
    const column = columns[0] ?? "";
    const inline = new RegExp(`\\b${column}\\b[^,\\n]*\\b(?:PRIMARY KEY|UNIQUE)\\b`);
    const tableUnique = new RegExp(`\\bUNIQUE \\(${column}\\)`);
    const uniqueIndex = new RegExp(
      `CREATE UNIQUE INDEX IF NOT EXISTS [a-z0-9_]+\\s+ON ${table} \\(${column}\\)`,
    );
    return inline.test(body) || tableUnique.test(body) || uniqueIndex.test(ddl);
  }
  const list = columns.join(", ");
  return (
    new RegExp(`\\bPRIMARY KEY \\(${list}\\)`).test(body) ||
    new RegExp(`\\bUNIQUE \\(${list}\\)`).test(body)
  );
}

describe("MVP17 canonical Postgres schema", () => {
  it("keeps the Product Engine freeze at 30 / 60 / 360", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });

  it("lists every canonical migration once, in apply order", () => {
    expect(MIGRATION_CHAIN.map((entry) => entry.file)).toEqual([...CANONICAL_MIGRATIONS]);
    expect(allMigrationSql()).toHaveLength(CANONICAL_MIGRATIONS.length);
    expect(MIGRATION_CHAIN[0]?.authority).toBe("identity");
    expect(MIGRATION_CHAIN.slice(1).every((entry) => entry.authority === "persistence")).toBe(true);
    const ddl = migrationSql();
    expect(ddl.indexOf("CREATE TABLE IF NOT EXISTS identity_users")).toBeLessThan(
      ddl.indexOf("REFERENCES identity_users (user_id)"),
    );
    expect(ddl.indexOf("CREATE TABLE IF NOT EXISTS bans")).toBeLessThan(
      ddl.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS share_operations_token_key"),
    );
  });

  it("keeps every CREATE and ALTER idempotent and constraint names unique", () => {
    for (const sql of allMigrationSql()) {
      expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
      expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
      expect(sql).not.toMatch(/CREATE UNIQUE INDEX (?!IF NOT EXISTS)/);
      expect(sql).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
    }
    const names = [
      ...migrationSql().matchAll(/\bCONSTRAINT ([a-z0-9_]+)/g),
      ...migrationSql().matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z0-9_]+)/g),
    ].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every ON CONFLICT target a primary key or unique constraint", () => {
    const statements = [UPSERT_IDENTITY_USER_SQL, ...Object.values(SQL)];
    const targets = statements.flatMap((statement) => conflictTargets(statement));
    expect(targets.map((target) => `${target.table}(${target.columns.join(",")})`).sort()).toEqual([
      "bans(ban_id)",
      "check_pairs(pair_id)",
      "domain_timers(timer_id)",
      "identity_users(telegram_user_id)",
      "identity_users(user_id)",
      "notification_items(item_id)",
      "pending_operations(operation_id)",
      "product_user_sessions(user_id)",
      "share_operations(attempt_id)",
    ]);
    const ddl = migrationSql();
    for (const target of targets) {
      expect(constraintCovers(ddl, target.table, target.columns)).toBe(true);
    }
  });

  it("enforces one share_operations row per token and looks that token up directly", () => {
    expect(shareOperationTokenUniqueSql()).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS share_operations_token_key",
    );
    expect(shareOperationTokenUniqueSql()).toContain("ON share_operations (token)");
    expect(SQL.selectShareByToken).not.toContain("ORDER BY");
    expect(SQL.selectShareByToken).not.toContain("LIMIT");
    expect(SQL.selectShareByTokenForUpdate).toContain("WHERE token = $1");
    expect(SQL.selectShareByTokenForUpdate).toContain("FOR UPDATE");
    expect(SQL.selectShareByTokenForUpdate).not.toContain("LIMIT");
    expect(productPersistenceSql()).toContain(
      "CONSTRAINT share_operations_status_chk CHECK (status IN ('ACTIVE', 'CONFIRMED', 'CANCELLED'))",
    );
    expect(migrationSql()).not.toContain("INVALIDATED");
  });

  it("rejects a second ShareOperation with the same token", async () => {
    const kit = PersistenceTestKit.postgres();
    kit.establishIdentity(USER_ID, "tg-1");
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      shareOperations: {
        "share-1": shareOp(),
        "share-2": shareOp({
          attemptId: "share-2" as never,
          token: "share-token" as never,
        }),
      },
    });
    await expect(kit.installFixtureSnapshot(USER_ID, world)).rejects.toMatchObject({
      code: "INVARIANT",
    });
  });

  it("stores Ban creation time once and projects it to relationship sources", async () => {
    const client = new MemorySqlClient();
    const kit = PersistenceTestKit.postgres(client);
    kit.establishIdentity(USER_ID, "tg-1");
    kit.establishIdentity(OTHER_USER, "tg-2");
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [BAN_ID]: makeBan() },
    });
    await kit.installFixtureSnapshot(USER_ID, world);
    const first = await kit.store.listRelationshipContextSources(USER_ID, OTHER_USER);
    expect(first).toHaveLength(1);
    const createdAtMs = first[0]?.createdAtMs ?? null;
    if (createdAtMs === null) {
      throw new Error("expected Ban createdAtMs");
    }
    expect(Number.isFinite(createdAtMs)).toBe(true);

    const revised = withEntities(world, {
      bans: { [BAN_ID]: makeBan({ banText: "later text" }) },
    });
    await kit.installFixtureSnapshot(USER_ID, revised);
    const second = await kit.store.listRelationshipContextSources(USER_ID, OTHER_USER);
    expect(second[0]?.createdAtMs).toBe(createdAtMs);
    expect(second[0]?.banText).toBe("later text");

    const restarted = new MemorySqlClient();
    restarted.tables.restore(client.tables.snapshot());
    const restored = await new PostgresProductStore(restarted).listRelationshipContextSources(
      USER_ID,
      OTHER_USER,
    );
    expect(restored[0]?.createdAtMs).toBe(createdAtMs);
    expect(productPersistenceSql()).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(SQL.upsertBan).not.toContain("created_at");
    expect(SQL.selectRelationshipContextSources).toContain("b.created_at");
  });

  it("keeps RIM provider runtime as session JSON and the current lookup indexes", () => {
    expect(rimProviderRuntimeSql()).toContain(
      "ADD COLUMN IF NOT EXISTS rim_provider_runtime JSONB",
    );
    expect(SQL.upsertSession).toContain("rim_provider_runtime");
    expect(SQL.updateRimProviderRuntime).toContain("rim_provider_runtime = $3::jsonb");
    expect(SQL.updateRimProviderRuntime).toContain("AND revision = $2");
    const ddl = migrationSql();
    for (const index of [
      "bans_sender_created_seq_idx",
      "bans_receiver_created_seq_idx",
      "bans_pair_created_seq_idx",
      "notification_items_owner_fifo_idx",
      "notification_items_ban_idx",
      "pending_operations_owner_idx",
      "share_operations_owner_idx",
      "share_operations_token_key",
      "domain_timers_one_per_ban UNIQUE (ban_id)",
      "check_pairs_one_per_ban UNIQUE (ban_id)",
      "telegram_user_id TEXT NOT NULL UNIQUE",
    ]) {
      expect(ddl).toContain(index);
    }
    expect(SQL.selectTimersForBans).toContain("ANY($1::text[])");
    expect(SQL.selectPairsForBans).toContain("ANY($1::text[])");
    expect(SQL.deleteItemsNotIn).toContain("ANY($2::text[])");
    expect(SQL.deleteOpsNotIn).toContain("ANY($2::text[])");
    expect(SQL.deleteSharesNotIn).toContain("ANY($2::text[])");
    expect(ddl).not.toMatch(/worker_lease|timer_queue|cron_job/i);
  });
});
