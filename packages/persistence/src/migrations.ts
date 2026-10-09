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
  {
    authority: "persistence",
    file: "packages/persistence/schema/006_telegram_persistent_reentry_cta_opportunity.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "006_telegram_persistent_reentry_cta_opportunity.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/007_ban_source_proposal.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "007_ban_source_proposal.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/008_rim_provider_runtime.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "008_rim_provider_runtime.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/009_share_operation_token_unique.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "009_share_operation_token_unique.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/010_rim_history.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "010_rim_history.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/011_rim_provider_ownership.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "011_rim_provider_ownership.sql"),
  },
  {
    authority: "persistence",
    file: "packages/persistence/schema/012_telegram_ban_message.sql",
    path: join(PERSISTENCE_SCHEMA_DIR, "012_telegram_ban_message.sql"),
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

export function telegramPersistentReentryCtaOpportunitySql(): string {
  return readFileSync(
    join(PERSISTENCE_SCHEMA_DIR, "006_telegram_persistent_reentry_cta_opportunity.sql"),
    "utf8",
  );
}

export function banSourceProposalSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "007_ban_source_proposal.sql"), "utf8");
}

export function rimProviderRuntimeSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "008_rim_provider_runtime.sql"), "utf8");
}

export function shareOperationTokenUniqueSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "009_share_operation_token_unique.sql"), "utf8");
}

export function rimHistorySql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "010_rim_history.sql"), "utf8");
}

export function rimProviderOwnershipSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "011_rim_provider_ownership.sql"), "utf8");
}

export function telegramBanMessageSql(): string {
  return readFileSync(join(PERSISTENCE_SCHEMA_DIR, "012_telegram_ban_message.sql"), "utf8");
}

export type CanonicalMigrationScript = Readonly<{
  id: string;
  sql: string;
}>;

/** Stable ids are the canonical file paths. SQL is read from those files. */
export function canonicalMigrationScripts(): readonly CanonicalMigrationScript[] {
  return MIGRATION_CHAIN.map((entry) => ({
    id: entry.file,
    sql: readFileSync(entry.path, "utf8"),
  }));
}

export function allMigrationSql(): readonly string[] {
  return [
    identitySchemaSql(),
    productPersistenceSql(),
    telegramPersistentReentrySql(),
    telegramPersistentReentryBootstrapClaimSql(),
    telegramPersistentReentryBootstrapClaimTokenSql(),
    telegramPersistentReentryCtaOpportunitySql(),
    banSourceProposalSql(),
    rimProviderRuntimeSql(),
    shareOperationTokenUniqueSql(),
    rimHistorySql(),
    rimProviderOwnershipSql(),
    telegramBanMessageSql(),
  ];
}
