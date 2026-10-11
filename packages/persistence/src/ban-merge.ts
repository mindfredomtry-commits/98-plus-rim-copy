import type { Ban } from "@98plus/product-model";
import {
  allowedBanFields,
  fieldDiffBan,
  type BanMutationAuthority,
  type BanFieldKey,
} from "./hybrid-persist.ts";
import { PersistenceError } from "./errors.ts";

const TERMINALS = new Set(["OVERBOARD", "BANTASTIC", "BANFLICT", "FAIR_ENOUGH"]);

function isTerminal(status: Ban["status"]): boolean {
  return status !== null && TERMINALS.has(status);
}

/**
 * Authorized Ban merge (C5+M3).
 * Unauthorized field diffs are ignored (db wins).
 * Conflicting authorized terminals / binds throw INVARIANT/CONFLICT semantics via PersistenceError.
 */
export function mergeBan(
  dbCurrent: Ban | undefined,
  baselineBan: Ban | undefined,
  nextBan: Ban,
  authority: BanMutationAuthority,
): Ban {
  if (!dbCurrent) {
    const allowed = allowedBanFields(authority);
    // Create requires full-create allowlist (banText present). BIND / status-only / preserve cannot create.
    if (authority.kind === "BIND_RECEIVER" || !allowed.has("banText")) {
      throw new PersistenceError("INVARIANT", "Cannot create Ban without create mutation authority");
    }
    return { ...nextBan };
  }

  if (nextBan.id !== dbCurrent.id) {
    throw new PersistenceError("INVARIANT", "Ban id mismatch during merge");
  }

  const diff = fieldDiffBan(baselineBan, nextBan);
  const allowed = allowedBanFields(authority);
  const apply = new Set<BanFieldKey>();
  for (const key of diff) {
    if (allowed.has(key)) {
      apply.add(key);
    }
  }

  // E-30: durable existing Ban → acceptance only (new Reply Ban uses the create path above).
  let effectiveApply = apply;
  if (authority.kind === "APPLIED_RULE" && authority.eventId === "E-30") {
    effectiveApply = new Set([...apply].filter((key) => key === "acceptance"));
  }

  let merged: Ban = { ...dbCurrent };

  if (effectiveApply.has("senderId") && nextBan.senderId !== dbCurrent.senderId) {
    throw new PersistenceError("INVARIANT", "Ban senderId is immutable");
  }

  if (effectiveApply.has("receiverId")) {
    if (dbCurrent.receiverId === null && nextBan.receiverId !== null) {
      merged = { ...merged, receiverId: nextBan.receiverId };
    } else if (
      dbCurrent.receiverId !== null &&
      nextBan.receiverId !== null &&
      dbCurrent.receiverId !== nextBan.receiverId
    ) {
      throw new PersistenceError(
        "INVARIANT",
        "Ban receiverId is already bound to a different user",
      );
    } else if (dbCurrent.receiverId !== null && nextBan.receiverId === null) {
      // ignore unauthorized clear
    }
  }

  if (effectiveApply.has("acceptance")) {
    if (dbCurrent.acceptance === "ACCEPTED" && nextBan.acceptance === "PENDING") {
      // sticky ACCEPTED
    } else if (dbCurrent.acceptance === "PENDING" && nextBan.acceptance === "ACCEPTED") {
      merged = { ...merged, acceptance: "ACCEPTED" };
    }
  }

  if (effectiveApply.has("status")) {
    const from = dbCurrent.status;
    const to = nextBan.status;
    if (from === to) {
      // idempotent
    } else if (from === null && isTerminal(to)) {
      merged = { ...merged, status: to };
    } else if (isTerminal(from) && to === null) {
      // ignore regression
    } else if (isTerminal(from) && isTerminal(to) && from !== to) {
      throw new PersistenceError(
        "INVARIANT",
        `Ban status terminal conflict: durable ${from} vs incoming ${to}`,
      );
    }
  }

  if (effectiveApply.has("boundViaTelegramShareLink")) {
    if (!dbCurrent.boundViaTelegramShareLink && nextBan.boundViaTelegramShareLink) {
      merged = { ...merged, boundViaTelegramShareLink: true };
    }
  }

  if (effectiveApply.has("sourceProposalId")) {
    if (dbCurrent.sourceProposalId === null && nextBan.sourceProposalId !== null) {
      merged = { ...merged, sourceProposalId: nextBan.sourceProposalId };
    } else if (
      dbCurrent.sourceProposalId !== null &&
      nextBan.sourceProposalId !== null &&
      dbCurrent.sourceProposalId !== nextBan.sourceProposalId
    ) {
      throw new PersistenceError("INVARIANT", "Ban sourceProposalId cannot be replaced");
    }
  }

  // banText / durationMinutes: only on create (no dbCurrent path for post-create allowlist).
  // Post-create allowlist never includes them for update events.

  return merged;
}
