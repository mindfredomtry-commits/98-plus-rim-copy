import type { DomainTimer } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";

export function mergeDomainTimer(
  dbCurrent: DomainTimer | undefined,
  next: DomainTimer,
): DomainTimer {
  if (!dbCurrent) {
    return { ...next };
  }
  if (dbCurrent.id !== next.id) {
    throw new PersistenceError("INVARIANT", "DomainTimer id mismatch during merge");
  }
  if (dbCurrent.banId !== next.banId) {
    throw new PersistenceError("INVARIANT", "DomainTimer banId is immutable");
  }
  if (dbCurrent.startedAt !== next.startedAt) {
    // keep durable startedAt
  }
  if (dbCurrent.durationMinutes !== next.durationMinutes) {
    // keep durable duration
  }

  let state = dbCurrent.state;
  if (dbCurrent.state === "RUNNING" && next.state === "EXPIRED") {
    state = "EXPIRED";
  } else if (dbCurrent.state === "EXPIRED" && next.state === "RUNNING") {
    state = "EXPIRED";
  } else if (dbCurrent.state === next.state) {
    state = dbCurrent.state;
  }

  let checkPairCreated = dbCurrent.checkPairCreated;
  if (!dbCurrent.checkPairCreated && next.checkPairCreated) {
    checkPairCreated = true;
  }

  return {
    id: dbCurrent.id,
    banId: dbCurrent.banId,
    startedAt: dbCurrent.startedAt,
    durationMinutes: dbCurrent.durationMinutes,
    state,
    checkPairCreated,
  };
}
