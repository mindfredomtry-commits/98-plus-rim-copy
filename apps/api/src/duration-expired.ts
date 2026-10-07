import type { ApplicationExecutionResult } from "@98plus/application";
import { asTelegramUserId, type AuthenticatedContext } from "@98plus/identity";
import { SQL } from "@98plus/persistence";
import {
  asInstant,
  reduce,
  type BanId,
  type ProductSnapshot,
  type UserId,
} from "@98plus/product-model";
import { executeAuthenticatedEvent, type CreateBanContactRuntime } from "./runtime.ts";

function instantMs(value: unknown): number {
  return Number(value);
}

export function elapsedAcceptedBanIds(snapshot: ProductSnapshot, nowMs: number): BanId[] {
  const paired = new Set(
    Object.values(snapshot.extended.entities.checkPairs).map((pair) => pair.banId),
  );
  const ids: BanId[] = [];
  for (const timer of Object.values(snapshot.extended.entities.domainTimers)) {
    if (timer.state === "EXPIRED" || timer.checkPairCreated || paired.has(timer.banId)) {
      continue;
    }
    const ban = snapshot.extended.entities.bans[timer.banId];
    if (!ban || ban.acceptance !== "ACCEPTED" || ban.status === "OVERBOARD" || !ban.receiverId) {
      continue;
    }
    const elapsedAt = instantMs(timer.startedAt) + Number(timer.durationMinutes) * 60 * 1000;
    if (nowMs >= elapsedAt) {
      ids.push(timer.banId);
    }
  }
  return ids;
}

async function persistClosedDurationExpired(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  banId: BanId,
): Promise<ApplicationExecutionResult | null> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const forReduce: ProductSnapshot = {
    ...loaded.snapshot,
    controlState: "RIM.LOBBY",
  };
  const transition = reduce(
    forReduce,
    { name: "BAN.DURATION_EXPIRED", payload: { banId } },
    {
      now: asInstant(runtime.clock.nowMs()),
      currentUserId: context.currentUserId,
      allocateId: runtime.allocateId,
    },
  );
  if (transition.outcome !== "APPLIED") {
    return null;
  }
  const closed = {
    ...transition,
    controlState: null,
    snapshot: {
      ...transition.snapshot,
      controlState: null,
      runtime: { ...transition.snapshot.runtime, session: "CLOSED" as const },
    },
  };
  const saved = await runtime.productStore.persistTransition({
    currentUserId: context.currentUserId,
    expectedRevision: loaded.revision,
    result: closed,
  });
  return {
    status: "APPLIED",
    currentUserId: context.currentUserId,
    event: { name: "BAN.DURATION_EXPIRED", payload: { banId } },
    outcome: closed.outcome,
    result: closed.result,
    controlState: saved.snapshot.controlState,
    snapshot: saved.snapshot,
    revision: saved.revision,
    persisted: true,
    effects: closed.effects,
    pendingExternalEffects: [],
    traces: closed.traces,
    composition: closed.composition,
    kernelError: null,
    error: null,
  };
}

export async function applyElapsedDomainTimers(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
): Promise<ApplicationExecutionResult | null> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const banIds = elapsedAcceptedBanIds(loaded.snapshot, runtime.clock.nowMs());
  let last: ApplicationExecutionResult | null = null;
  for (const banId of banIds) {
    const closed = loaded.snapshot.controlState === null;
    const applied = closed
      ? await persistClosedDurationExpired(runtime, context, banId)
      : await executeAuthenticatedEvent(runtime, context, {
          name: "BAN.DURATION_EXPIRED",
          payload: { banId },
        });
    if (applied && applied.status === "APPLIED") {
      last = applied;
    }
  }
  return last;
}

/**
 * Test/worker helper. Production expiry stays request-scoped through
 * applyElapsedDomainTimers. This scan is not a scheduler.
 */
export async function expireElapsedDomainTimers(runtime: CreateBanContactRuntime): Promise<number> {
  const identities = await runtime.sql.query<{ user_id: string; telegram_user_id: string }>(
    SQL.selectAllIdentities,
    [],
  );
  let applied = 0;
  for (const identity of identities.rows) {
    const context: AuthenticatedContext = {
      currentUserId: identity.user_id as UserId,
      currentTelegramUser: { telegramUserId: asTelegramUserId(identity.telegram_user_id) },
      authenticationMethod: "development",
    };
    const result = await applyElapsedDomainTimers(runtime, context);
    if (result?.status === "APPLIED") {
      applied += 1;
    }
  }
  return applied;
}
