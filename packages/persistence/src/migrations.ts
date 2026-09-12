import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PERSISTENCE_SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../schema");
const IDENTITY_MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../identity/schema/001_identity_users.sql",
);

export const IDENTITY_MIGRATION_AUTHORITY = "packages/identity/schema/001_identity_users.sql";

export const MIGRATION_CHAIN = [
  {
    authority: "identity",
    file: IDENTITY_MIGRATION_AUTHORITY,
    path: IDENTITY_MIGRATION_PATH,
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/002_product_persistence.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "002_product_persistence.sql"),
  },
] as const;

export function identitySchemaSql(): string {
  return readFileSync(IDENTITY_MIGRATION_PATH, "utf8");
}

export function productPersistenceSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "002_product_persistence.sql"), "utf8");
}

export function allMigrationSql(): readonly string[] {
  return [identitySchemaSql(), productPersistenceSql()];
}
