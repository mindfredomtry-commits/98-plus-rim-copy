import type { Ban, CheckPair } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";

function answered(value: CheckPair["receiverAnswer"]): boolean {
  return value !== null;
}

export function assertCheckPairWriteAllowed(
  existing: CheckPair | undefined,
  incoming: CheckPair,
): void {
  if (!existing) {
    return;
  }
  if (existing.id !== incoming.id) {
    throw new PersistenceError("INVARIANT", "CheckPair id mismatch");
  }
  if (existing.banId !== incoming.banId) {
    throw new PersistenceError("INVARIANT", "CheckPair banId is immutable");
  }
  if (
    existing.receiverItemId !== incoming.receiverItemId ||
    existing.senderItemId !== incoming.senderItemId
  ) {
    throw new PersistenceError("INVARIANT", "CheckPair item IDs are immutable after commit");
  }
  // Nullification forbidden.
  if (answered(existing.receiverAnswer) && incoming.receiverAnswer === null) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair receiver answer cannot be cleared once confirmed",
    );
  }
  if (answered(existing.senderAnswer) && incoming.senderAnswer === null) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair sender answer cannot be cleared once confirmed",
    );
  }
  if (existing.resultingStatus !== null && incoming.resultingStatus === null) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair resultingStatus cannot be cleared once determined",
    );
  }
  if (
    answered(existing.receiverAnswer) &&
    answered(incoming.receiverAnswer) &&
    existing.receiverAnswer !== incoming.receiverAnswer
  ) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair receiver answer is already confirmed and cannot be replaced",
    );
  }
  if (
    answered(existing.senderAnswer) &&
    answered(incoming.senderAnswer) &&
    existing.senderAnswer !== incoming.senderAnswer
  ) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair sender answer is already confirmed and cannot be replaced",
    );
  }
  if (
    existing.resultingStatus !== null &&
    incoming.resultingStatus !== null &&
    existing.resultingStatus !== incoming.resultingStatus
  ) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair resulting Status is already determined and cannot be replaced",
    );
  }
  const incomingCount =
    Number(answered(incoming.receiverAnswer)) + Number(answered(incoming.senderAnswer));
  if (incoming.resultingStatus !== null || incomingCount !== 1) {
    return;
  }
  const otherExisting = answered(incoming.receiverAnswer)
    ? existing.senderAnswer
    : existing.receiverAnswer;
  if (otherExisting !== null) {
    throw new PersistenceError(
      "CHECK_PAIR_CONFLICT",
      "FIRST confirmation cannot commit after the other participant already confirmed",
    );
  }
}

export function mergeCheckPair(
  dbCurrent: CheckPair | undefined,
  incoming: CheckPair,
): CheckPair {
  assertCheckPairWriteAllowed(dbCurrent, incoming);
  if (!dbCurrent) {
    return { ...incoming };
  }
  return {
    id: dbCurrent.id,
    banId: dbCurrent.banId,
    receiverItemId: dbCurrent.receiverItemId,
    senderItemId: dbCurrent.senderItemId,
    receiverAnswer: incoming.receiverAnswer ?? dbCurrent.receiverAnswer,
    senderAnswer: incoming.senderAnswer ?? dbCurrent.senderAnswer,
    resultingStatus: incoming.resultingStatus ?? dbCurrent.resultingStatus,
  };
}

export function assertBanPairStatusConsistency(
  ban: Ban | undefined,
  pair: CheckPair,
): void {
  if (pair.resultingStatus === null) {
    return;
  }
  if (!ban) {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair resultingStatus requires the Ban row in the same transaction",
    );
  }
  if (ban.status === "OVERBOARD") {
    throw new PersistenceError(
      "INVARIANT",
      "CheckPair resultingStatus conflicts with Ban.status=OVERBOARD",
    );
  }
  if (ban.status !== null && ban.status !== pair.resultingStatus) {
    throw new PersistenceError(
      "INVARIANT",
      `Ban.status ${ban.status} conflicts with CheckPair.resultingStatus ${pair.resultingStatus}`,
    );
  }
}
