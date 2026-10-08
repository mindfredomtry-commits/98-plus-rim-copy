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

  it("reads 001–011 from the canonical files in order", () => {
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
      "packages/persistence/schema/010_rim_history.sql",
      "packages/persistence/schema/011_rim_provider_ownership.sql",
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
    const history = declaredMigrationObjects(
      byId.get("packages/persistence/schema/010_rim_history.sql") ?? "",
    );
    expect(history).toEqual([
      { kind: "table", name: "rim_chats" },
      { kind: "table", name: "rim_messages" },
      { kind: "index", name: "rim_chats_owner_created_idx" },
      { kind: "index", name: "rim_chats_resulting_ban_idx" },
      { kind: "constraint", name: "rim_chats_termination_chk" },
      { kind: "constraint", name: "rim_chats_termination_reason_chk" },
      { kind: "constraint", name: "rim_messages_ordinal_positive_chk" },
      { kind: "constraint", name: "rim_messages_chat_ordinal_key" },
      { kind: "constraint", name: "rim_messages_kind_chk" },
      { kind: "constraint", name: "rim_messages_source_chk" },
    ]);
    const ownership = declaredMigrationObjects(
      byId.get("packages/persistence/schema/011_rim_provider_ownership.sql") ?? "",
    );
    expect(ownership).toEqual([
      { kind: "table", name: "rim_provider_ownership" },
      { kind: "index", name: "rim_provider_ownership_open_lease_idx" },
      { kind: "constraint", name: "rim_provider_ownership_pkey" },
      { kind: "constraint", name: "rim_provider_ownership_operation_kind_chk" },
      { kind: "constraint", name: "rim_provider_ownership_attempt_id_chk" },
      { kind: "constraint", name: "rim_provider_ownership_request_id_chk" },
      { kind: "constraint", name: "rim_provider_ownership_release_reason_chk" },
      { kind: "constraint", name: "rim_provider_ownership_release_pair_chk" },
      { kind: "constraint", name: "rim_provider_ownership_user_fk" },
    ]);
  });
});
