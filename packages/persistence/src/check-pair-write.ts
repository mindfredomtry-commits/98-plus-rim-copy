import type { CheckPair } from "@98plus/product-model";
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
