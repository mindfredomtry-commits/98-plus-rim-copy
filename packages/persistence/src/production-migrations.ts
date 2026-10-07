import type { CanonicalMigrationScript } from "./migrations.ts";

const ADVISORY_LOCK_KEY_1 = 17017;
const ADVISORY_LOCK_KEY_2 = 1;

export type MigrationScript = CanonicalMigrationScript;

export type ProductionMigrationReport = Readonly<{
  applied: readonly string[];
  newlyApplied: readonly string[];
}>;

export type ProductionMigrationErrorCode =
  "MIGRATION_HISTORY" | "MIGRATION_SCHEMA" | "MIGRATION_FAILED";

export class ProductionMigrationError extends Error {
  readonly code: ProductionMigrationErrorCode;

  constructor(code: ProductionMigrationErrorCode, message: string) {
    super(message);
    this.name = "ProductionMigrationError";
    this.code = code;
  }
}

export type DeclaredMigrationObject =
  | Readonly<{ kind: "table"; name: string }>
  | Readonly<{ kind: "index"; name: string }>
  | Readonly<{ kind: "constraint"; name: string }>
  | Readonly<{ kind: "column"; table: string; name: string }>;

export type MigrationQueryClient = {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly T[] }>;
};

function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined || value.length === 0) {
    throw new ProductionMigrationError("MIGRATION_FAILED", "migration SQL could not be parsed");
  }
  return value;
}

/** Objects named by the canonical migration text. Used to detect history/schema mismatch. */
export function declaredMigrationObjects(sql: string): readonly DeclaredMigrationObject[] {
  const objects: DeclaredMigrationObject[] = [];
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)) {
    objects.push({ kind: "table", name: group(match, 1) });
  }
  for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)) {
    objects.push({ kind: "index", name: group(match, 1) });
  }
  for (const match of sql.matchAll(/CONSTRAINT ([a-z_][a-z0-9_]*)/g)) {
    objects.push({ kind: "constraint", name: group(match, 1) });
  }
  for (const alter of sql.matchAll(/ALTER TABLE ([a-z_][a-z0-9_]*)([\s\S]*?);/g)) {
    const table = group(alter, 1);
    const body = alter[2] ?? "";
    for (const column of body.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)) {
      objects.push({ kind: "column", table, name: group(column, 1) });
    }
  }
  return objects;
}

function objectLabel(object: DeclaredMigrationObject): string {
  if (object.kind === "column") {
    return `column ${object.table}.${object.name}`;
  }
  return `${object.kind} ${object.name}`;
}

async function objectExists(
  client: MigrationQueryClient,
  object: DeclaredMigrationObject,
): Promise<boolean> {
  if (object.kind === "column") {
    const result = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1
           AND column_name = $2
       ) AS present`,
      [object.table, object.name],
    );
    return result.rows[0]?.present === true;
  }
  if (object.kind === "constraint") {
    const result = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = $1
           AND connamespace = current_schema()::regnamespace
       ) AS present`,
      [object.name],
    );
    return result.rows[0]?.present === true;
  }
  const result = await client.query<{ present: string | null }>(
    "SELECT to_regclass($1) AS present",
    [object.name],
  );
  return result.rows[0]?.present != null;
}

function assertUniqueIds(migrations: readonly MigrationScript[]): readonly string[] {
  const ids = migrations.map((migration) => migration.id);
  if (ids.some((id) => id.trim().length === 0) || new Set(ids).size !== ids.length) {
    throw new ProductionMigrationError(
      "MIGRATION_HISTORY",
      "canonical migration ids must be unique and non-empty",
    );
  }
  return ids;
}

function assertCanonicalPrefix(applied: readonly string[], ids: readonly string[]): void {
  const index = new Map(ids.map((id, position) => [id, position]));
  const positions: number[] = [];
  for (const version of applied) {
    const position = index.get(version);
    if (position === undefined) {
      throw new ProductionMigrationError(
        "MIGRATION_HISTORY",
        `migration history contains an unknown version: ${version}`,
      );
    }
    positions.push(position);
  }
  const ordered = [...positions].sort((left, right) => left - right);
  for (let position = 0; position < ordered.length; position += 1) {
    if (ordered[position] !== position) {
      throw new ProductionMigrationError(
        "MIGRATION_HISTORY",
        "migration history is not a prefix of the canonical chain",
      );
    }
  }
}

async function assertObjects(
  client: MigrationQueryClient,
  migrations: readonly MigrationScript[],
  applied: ReadonlySet<string>,
): Promise<void> {
  for (const migration of migrations) {
    const recorded = applied.has(migration.id);
    for (const object of declaredMigrationObjects(migration.sql)) {
      const exists = await objectExists(client, object);
      if (recorded && !exists) {
        throw new ProductionMigrationError(
          "MIGRATION_SCHEMA",
          `applied migration ${migration.id} is missing ${objectLabel(object)}; refusing to continue`,
        );
      }
      if (!recorded && exists) {
        throw new ProductionMigrationError(
          "MIGRATION_SCHEMA",
          `pending migration ${migration.id} already has ${objectLabel(object)}; refusing to repair a history/schema mismatch`,
        );
      }
    }
  }
}

/**
 * Applies migrations on one session.
 * A session advisory lock stops a second runner from applying the same version.
 * Each migration commits on its own. A failure rolls that migration back and
 * leaves it out of schema_migrations.
 */
export async function runProductionMigrations(
  client: MigrationQueryClient,
  migrations: readonly MigrationScript[],
): Promise<ProductionMigrationReport> {
  const ids = assertUniqueIds(migrations);
  await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
    ADVISORY_LOCK_KEY_1,
    ADVISORY_LOCK_KEY_2,
  ]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    const history = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at ASC, version ASC",
    );
    const applied = history.rows.map((row) => row.version);
    assertCanonicalPrefix(applied, ids);
    const appliedSet = new Set(applied);
    await assertObjects(client, migrations, appliedSet);
    const newlyApplied: string[] = [];
    for (const migration of migrations) {
      if (appliedSet.has(migration.id)) {
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof ProductionMigrationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "migration failed";
        throw new ProductionMigrationError(
          "MIGRATION_FAILED",
          `migration ${migration.id} failed: ${message}`,
        );
      }
      newlyApplied.push(migration.id);
      appliedSet.add(migration.id);
    }
    return { applied: [...applied, ...newlyApplied], newlyApplied };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
        ADVISORY_LOCK_KEY_1,
        ADVISORY_LOCK_KEY_2,
      ])
      .catch(() => undefined);
  }
}
