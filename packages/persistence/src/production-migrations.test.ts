import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import { canonicalMigrationScripts } from "./migrations.ts";
import { declaredMigrationObjects } from "./production-migrations.ts";

describe("production migration authority", () => {
  it("keeps the Product Engine freeze at 30 / 60 / 360", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });

  it("reads 001–009 from the canonical files in order", () => {
    const scripts = canonicalMigrationScripts();
    expect(scripts.map((script) => script.id)).toEqual([
      "packages/identity/schema/001_identity_users.sql",
      "packages/persistence/schema/002_product_persistence.sql",
      "packages/persistence/schema/003_telegram_persistent_reentry.sql",
      "packages/persistence/schema/004_telegram_persistent_reentry_bootstrap_claim.sql",
      "packages/persistence/schema/005_telegram_persistent_reentry_bootstrap_claim_token.sql",
      "packages/persistence/schema/006_telegram_persistent_reentry_cta_opportunity.sql",
      "packages/persistence/schema/007_ban_source_proposal.sql",
      "packages/persistence/schema/008_rim_provider_runtime.sql",
      "packages/persistence/schema/009_share_operation_token_unique.sql",
    ]);
    expect(scripts.every((script) => script.sql.includes("IF NOT EXISTS"))).toBe(true);
  });

  it("names the tables, indexes, constraints, and columns those files declare", () => {
    const byId = new Map(canonicalMigrationScripts().map((script) => [script.id, script.sql]));
    const identity = declaredMigrationObjects(
      byId.get("packages/identity/schema/001_identity_users.sql") ?? "",
    );
    expect(identity).toEqual([{ kind: "table", name: "identity_users" }]);
    const product = declaredMigrationObjects(
      byId.get("packages/persistence/schema/002_product_persistence.sql") ?? "",
    );
    expect(product.some((object) => object.kind === "table" && object.name === "bans")).toBe(true);
    expect(
      product.some(
        (object) => object.kind === "index" && object.name === "bans_sender_created_seq_idx",
      ),
    ).toBe(true);
    expect(
      product.some(
        (object) => object.kind === "constraint" && object.name === "bans_duration_minutes_chk",
      ),
    ).toBe(true);
    const runtime = declaredMigrationObjects(
      byId.get("packages/persistence/schema/008_rim_provider_runtime.sql") ?? "",
    );
    expect(runtime).toEqual([
      { kind: "column", table: "product_user_sessions", name: "rim_provider_runtime" },
    ]);
    const share = declaredMigrationObjects(
      byId.get("packages/persistence/schema/009_share_operation_token_unique.sql") ?? "",
    );
    expect(share).toEqual([{ kind: "index", name: "share_operations_token_key" }]);
  });
});
