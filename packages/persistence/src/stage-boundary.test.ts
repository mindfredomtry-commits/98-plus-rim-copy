import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  PRODUCT_CONTROL_STATES,
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import { SNAPSHOT_FIELD_CLASSIFICATION } from "./classification.ts";
import {
  IDENTITY_MIGRATION_AUTHORITY,
  identitySchemaSql,
  MIGRATION_CHAIN,
  productPersistenceSql,
} from "./migrations.ts";
import { SQL } from "./sql.ts";
import { PERSISTENCE_STAGE, STAGE_4_EXCLUDES } from "./stage.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Stage 4 boundary", () => {
  it("marks persistence as Stage 4 without relabeling kernel or identity", () => {
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(351);
    expect(STAGE_4_EXCLUDES).toContain("external-entry");
    expect(STAGE_4_EXCLUDES).toContain("openai");
    expect(STAGE_4_EXCLUDES).toContain("ui-screens");
    expect(STAGE_4_EXCLUDES).toContain("telegram-adapters");
  });
});

describe("snapshot field classification", () => {
  it("classifies durable facts, session state, transient execution, and derived data", () => {
    expect(SNAPSHOT_FIELD_CLASSIFICATION["extended.entities.bans"]).toBe("DURABLE_PRODUCT_FACT");
    expect(SNAPSHOT_FIELD_CLASSIFICATION["extended.entities.bans.sourceProposalId"]).toBe(
      "DURABLE_PRODUCT_FACT",
    );
    expect(SNAPSHOT_FIELD_CLASSIFICATION["runtime.pendingOperations"]).toBe("DURABLE_PRODUCT_FACT");
    expect(SNAPSHOT_FIELD_CLASSIFICATION["extended.rimChat"]).toBe("DURABLE_USER_SESSION_STATE");
    expect(SNAPSHOT_FIELD_CLASSIFICATION.controlState).toBe("DURABLE_USER_SESSION_STATE");
    expect(SNAPSHOT_FIELD_CLASSIFICATION["runtime.transitionInFlight"]).toBe(
      "TRANSIENT_EXECUTION_STATE",
    );
    expect(SNAPSHOT_FIELD_CLASSIFICATION["relationshipContext.data.recentBans"]).toBe(
      "EXTERNAL_DERIVED_DATA",
    );
    expect(SNAPSHOT_FIELD_CLASSIFICATION.REQUEST_RIM_AI).toBe("TRANSIENT_EXECUTION_STATE");
  });
});

describe("Stage 4 migrations", () => {
  it("applies identity then product schema from a single identity authority", () => {
    expect(IDENTITY_MIGRATION_AUTHORITY).toBe("packages/identity/schema/001_identity_users.sql");
    expect(MIGRATION_CHAIN.map((entry) => entry.file)).toEqual([
      "packages/identity/schema/001_identity_users.sql",
      "packages/persistence/schema/002_product_persistence.sql",
      "packages/persistence/schema/003_telegram_persistent_reentry.sql",
      "packages/persistence/schema/004_telegram_persistent_reentry_bootstrap_claim.sql",
      "packages/persistence/schema/005_telegram_persistent_reentry_bootstrap_claim_token.sql",
      "packages/persistence/schema/006_telegram_persistent_reentry_cta_opportunity.sql",
      "packages/persistence/schema/007_ban_source_proposal.sql",
      "packages/persistence/schema/008_rim_provider_runtime.sql",
    ]);
    expect(MIGRATION_CHAIN[0]?.authority).toBe("identity");
    expect(MIGRATION_CHAIN[1]?.authority).toBe("persistence");
    expect(MIGRATION_CHAIN[2]?.authority).toBe("persistence");
    expect(MIGRATION_CHAIN[3]?.authority).toBe("persistence");
    expect(MIGRATION_CHAIN[4]?.authority).toBe("persistence");
    expect(MIGRATION_CHAIN[5]?.authority).toBe("persistence");
    expect(MIGRATION_CHAIN[6]?.authority).toBe("persistence");
    expect(MIGRATION_CHAIN[7]?.authority).toBe("persistence");
    expect(identitySchemaSql()).toContain("identity_users");
    expect(identitySchemaSql()).toContain("telegram_user_id");
  });

  it("declares identity FKs, uniqueness, and retrieval indexes without Matrix logic", () => {
    const sql = productPersistenceSql();
    expect(sql).toContain("REFERENCES identity_users (user_id)");
    expect(sql).toContain("CONSTRAINT domain_timers_one_per_ban UNIQUE (ban_id)");
    expect(sql).toContain("CONSTRAINT check_pairs_one_per_ban UNIQUE (ban_id)");
    expect(sql).toContain(
      "CONSTRAINT bans_acceptance_chk CHECK (acceptance IN ('PENDING', 'ACCEPTED'))",
    );
    expect(sql).toContain(
      "CONSTRAINT share_operations_status_chk CHECK (status IN ('ACTIVE', 'CONFIRMED', 'CANCELLED'))",
    );
    expect(sql).not.toContain("INVALIDATED");
    expect(sql).toContain("bans_sender_created_seq_idx");
    expect(sql).toContain("bans_receiver_created_seq_idx");
    expect(sql).toContain("notification_items_owner_fifo_idx");
    expect(sql).not.toMatch(/\bE-43\b/);
    expect(sql).not.toMatch(/\bFIFO\b/);
    expect(sql).not.toMatch(/CASE\s+WHEN\s+acceptance/i);
    for (const state of PRODUCT_CONTROL_STATES) {
      expect(sql).toContain(`'${state}'`);
    }
    expect(SQL.selectSessionForUpdate).toContain("FOR UPDATE");
    expect(SQL.selectPairForUpdate).toContain("FOR UPDATE");
    expect(SQL.selectPairForUpdate).toContain("check_pairs");
    expect(SQL.selectPairForUpdate).toContain("pair_id");
    expect(SQL.selectRelationshipBans).toContain("ORDER BY created_seq DESC");
    expect(SQL.selectRelationshipBans).toContain("LIMIT 10");
  });
});

function walkTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTs(path));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("kernel isolation", () => {
  it("does not import persistence or database infrastructure from the Product Kernel", () => {
    for (const file of walkTs(join(ROOT, "product-model/src"))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("@98plus/persistence");
      expect(source).not.toMatch(/from ["']pg["']/);
    }
  });
});
