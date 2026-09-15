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
  {
    authority: "persistence",
    file: "packages/persistence/schema/003_telegram_persistent_reentry.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "003_telegram_persistent_reentry.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/004_telegram_persistent_reentry_bootstrap_claim.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "004_telegram_persistent_reentry_bootstrap_claim.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/005_telegram_persistent_reentry_bootstrap_claim_token.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "005_telegram_persistent_reentry_bootstrap_claim_token.sql"),
  },
] as const;

export function identitySchemaSql(): string {
  return readFileSync(IDENTITY_MIGRATION_PATH, "utf8");
}

export function productPersistenceSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "002_product_persistence.sql"), "utf8");
}

export function telegramPersistentReentrySql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "003_telegram_persistent_reentry.sql"), "utf8");
}

export function telegramPersistentReentryBootstrapClaimSql(): string {
  return readFileSync(
    join(PERSISTENCE_SCHEMA_DIR, "004_telegram_persistent_reentry_bootstrap_claim.sql"),
    "utf8",
  );
}

export function telegramPersistentReentryBootstrapClaimTokenSql(): string {
  return readFileSync(
    join(PERSISTENCE_SCHEMA_DIR, "005_telegram_persistent_reentry_bootstrap_claim_token.sql"),
    "utf8",
  );
}

export function allMigrationSql(): readonly string[] {
  return [
    identitySchemaSql(),
    productPersistenceSql(),
    telegramPersistentReentrySql(),
    telegramPersistentReentryBootstrapClaimSql(),
    telegramPersistentReentryBootstrapClaimTokenSql(),
  ];
}
