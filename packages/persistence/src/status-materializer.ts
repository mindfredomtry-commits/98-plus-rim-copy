/**
 * Pass 12D-2 — Status pair materialization + durable ID reconciliation (frozen Option E″ C3 + M1).
 * Logical Status identity: (ban_id, status_type, role).
 */
import { randomUUID } from "node:crypto";
import {
  emitDiagnostic,
  stageMaterializerOutcome,
} from "@98plus/diagnostics";
import type {
  Ban,
  BanId,
  BanStatus,
  Effect,
  NotificationItem,
  NotificationItemId,
  ProductSnapshot,
  Role,
  StatusNotificationItem,
  TransitionResult,
  UserId,
} from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";
import type { BanMutationAuthority } from "./hybrid-persist.ts";
import { mergeNotificationItem } from "./item-write.ts";

export type StatusLogicalKey = Readonly<{
  banId: BanId;
  status: BanStatus;
  role: Role;
}>;

export type IdRemap = Readonly<Record<string, NotificationItemId>>;

export type StatusMaterializationResult = Readonly<{
  snapshot: ProductSnapshot;
  effects: readonly Effect[];
  idRemap: IdRemap;
  createdItemIds: readonly NotificationItemId[];
  updatedItemIds: readonly NotificationItemId[];
  /** Union of created + updated — feeds materializerWrittenItemIds (M1). */
  materializerWrittenItemIds: readonly NotificationItemId[];
}>;

function logicalKeyOf(item: StatusNotificationItem): string {
  return `${item.banId}\0${item.status}\0${item.role}`;
}

function keyString(key: StatusLogicalKey): string {
  return `${key.banId}\0${key.status}\0${key.role}`;
}

export function isStatusNotificationItem(
  item: NotificationItem,
): item is StatusNotificationItem {
  return item.kind === "STATUS";
}

export function statusMaterializationAuthorized(
  authority: BanMutationAuthority,
  effects: readonly Effect[],
): boolean {
  if (authority.kind === "APPLIED_RULE" && (authority.eventId === "E-20" || authority.eventId === "E-23")) {
    return true;
  }
  return effects.some(
    (effect) =>
      effect.type === "UPSERT_NOTIFICATION_ITEM" && effect.item.kind === "STATUS",
  );
}

function remapId(id: NotificationItemId | null | undefined, remap: IdRemap): NotificationItemId | null {
  if (id === null || id === undefined) {
    return id ?? null;
  }
  return remap[id] ?? id;
}

function remapEffects(effects: readonly Effect[], remap: IdRemap): Effect[] {
  return effects.map((effect) => {
    switch (effect.type) {
      case "UPSERT_NOTIFICATION_ITEM": {
        const nextId = remap[effect.item.id] ?? effect.item.id;
        if (nextId === effect.item.id) {
          return effect;
        }
        return {
          type: "UPSERT_NOTIFICATION_ITEM" as const,
          item: { ...effect.item, id: nextId } as NotificationItem,
        };
      }
      case "SET_NOTIFICATION_LIFECYCLE":
      case "PROCESS_TIMER_NOTIFICATION_ITEM": {
        const nextId = remap[effect.itemId] ?? effect.itemId;
        return nextId === effect.itemId ? effect : { ...effect, itemId: nextId };
      }
      default:
        return effect;
    }
  });
}

/**
 * Apply kernel→durable Item ID remap across snapshot pointers, entities, and operations.
 */
export function applyIdRemapToSnapshot(
  snapshot: ProductSnapshot,
  remap: IdRemap,
  replacements: Readonly<Record<string, NotificationItem>> = {},
): ProductSnapshot {
  if (Object.keys(remap).length === 0 && Object.keys(replacements).length === 0) {
    return snapshot;
  }
  const items: Record<string, NotificationItem> = {
    ...snapshot.extended.entities.notificationItems,
  };
  for (const [from, to] of Object.entries(remap)) {
    if (from === to) {
      continue;
    }
    const existing = items[from];
    delete items[from];
    if (replacements[to]) {
      items[to] = replacements[to]!;
    } else if (existing) {
      items[to] = { ...existing, id: to as NotificationItemId } as NotificationItem;
    }
  }
  for (const [id, item] of Object.entries(replacements)) {
    items[id] = item;
  }

  const ops: Record<string, (typeof snapshot.runtime.pendingOperations)[string]> = {};
  for (const [opId, op] of Object.entries(snapshot.runtime.pendingOperations)) {
    const originatingItemId = op.originatingItemId
      ? (remapId(op.originatingItemId, remap) as typeof op.originatingItemId)
      : op.originatingItemId;
    ops[opId] = originatingItemId === op.originatingItemId ? op : { ...op, originatingItemId };
  }

  const replySource = snapshot.extended.replySource
    ? {
        ...snapshot.extended.replySource,
        itemId: remapId(snapshot.extended.replySource.itemId, remap)!,
      }
    : snapshot.extended.replySource;

  const rimChat = snapshot.extended.rimChat
    ? {
        ...snapshot.extended.rimChat,
        askRimOrigin: snapshot.extended.rimChat.askRimOrigin
          ? {
              ...snapshot.extended.rimChat.askRimOrigin,
              sourceStatusItemId: remapId(
                snapshot.extended.rimChat.askRimOrigin.sourceStatusItemId,
                remap,
              )!,
            }
          : null,
      }
    : snapshot.extended.rimChat;

  const savedFrozen = snapshot.extended.savedFrozenRimChat
    ? {
        ...snapshot.extended.savedFrozenRimChat,
        askRimOrigin: snapshot.extended.savedFrozenRimChat.askRimOrigin
          ? {
              ...snapshot.extended.savedFrozenRimChat.askRimOrigin,
              sourceStatusItemId: remapId(
                snapshot.extended.savedFrozenRimChat.askRimOrigin.sourceStatusItemId,
                remap,
              )!,
            }
          : null,
      }
    : snapshot.extended.savedFrozenRimChat;

  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      activeNotificationItemId: remapId(
        snapshot.extended.activeNotificationItemId,
        remap,
      ) as typeof snapshot.extended.activeNotificationItemId,
      priorities: {
        statusItemId: remapId(
          snapshot.extended.priorities.statusItemId,
          remap,
        ) as typeof snapshot.extended.priorities.statusItemId,
        timerItemId: remapId(
          snapshot.extended.priorities.timerItemId,
          remap,
        ) as typeof snapshot.extended.priorities.timerItemId,
      },
      replySource,
      rimChat,
      savedFrozenRimChat: savedFrozen,
      entities: {
        ...snapshot.extended.entities,
        notificationItems: items,
      },
    },
    runtime: {
      ...snapshot.runtime,
      pendingOperations: ops,
    },
  };
}

/**
 * PROCESSED Status must never be actionable priority (frozen priority safety).
 */
export function clearProcessedStatusPriority(snapshot: ProductSnapshot): ProductSnapshot {
  const statusItemId = snapshot.extended.priorities.statusItemId;
  if (!statusItemId) {
    return snapshot;
  }
  const item = snapshot.extended.entities.notificationItems[statusItemId];
  if (!item || item.kind !== "STATUS" || item.lifecycle.status !== "PROCESSED") {
    return snapshot;
  }
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      priorities: {
        ...snapshot.extended.priorities,
        statusItemId: null,
      },
    },
  };
}

function nextFifoSequence(
  snapshot: ProductSnapshot,
  durable: readonly StatusNotificationItem[],
  pending: readonly StatusNotificationItem[],
): number {
  let max = 0;
  for (const item of Object.values(snapshot.extended.entities.notificationItems)) {
    if (item.fifoSequence > max) {
      max = item.fifoSequence;
    }
  }
  for (const item of durable) {
    if (item.fifoSequence > max) {
      max = item.fifoSequence;
    }
  }
  for (const item of pending) {
    if (item.fifoSequence > max) {
      max = item.fifoSequence;
    }
  }
  return max + 1;
}

function allocateNotificationItemId(): NotificationItemId {
  return `status_${randomUUID()}` as NotificationItemId;
}

function terminalStatusFromBan(ban: Ban | undefined): BanStatus | null {
  if (!ban?.status) {
    return null;
  }
  if (
    ban.status === "OVERBOARD" ||
    ban.status === "BANTASTIC" ||
    ban.status === "BANFLICT" ||
    ban.status === "FAIR_ENOUGH"
  ) {
    return ban.status;
  }
  return null;
}

function bansNeedingStatusPair(
  snapshot: ProductSnapshot,
  effects: readonly Effect[],
): ReadonlyArray<{ banId: BanId; status: BanStatus; ban: Ban }> {
  const out = new Map<string, { banId: BanId; status: BanStatus; ban: Ban }>();
  for (const effect of effects) {
    if (effect.type === "UPSERT_BAN") {
      const status = terminalStatusFromBan(effect.ban);
      if (status && effect.ban.receiverId) {
        out.set(effect.ban.id, { banId: effect.ban.id, status, ban: effect.ban });
      }
    }
    if (effect.type === "UPSERT_NOTIFICATION_ITEM" && effect.item.kind === "STATUS") {
      const banEntity = snapshot.extended.entities.bans[effect.item.banId];
      if (banEntity?.receiverId) {
        out.set(effect.item.banId, {
          banId: effect.item.banId,
          status: effect.item.status,
          ban: banEntity,
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * Materialize the cross-owner Status pair under an already-held Ban lock.
 * Never uses owner-scoped absence as proof the counterpart does not exist.
 */
export function materializeStatusPairs(input: Readonly<{
  snapshot: ProductSnapshot;
  effects: readonly Effect[];
  mutationAuthority: BanMutationAuthority;
  /** Cross-owner durable STATUS rows for relevant Bans (already read under Ban locks). */
  durableStatusItems: readonly StatusNotificationItem[];
  allocateId?: () => NotificationItemId;
}>): StatusMaterializationResult {
  const effects = input.effects ?? [];
  if (!statusMaterializationAuthorized(input.mutationAuthority, effects)) {
    return {
      snapshot: input.snapshot,
      effects,
      idRemap: {},
      createdItemIds: [],
      updatedItemIds: [],
      materializerWrittenItemIds: [],
    };
  }

  const allocateId = input.allocateId ?? allocateNotificationItemId;
  const remap: Record<string, NotificationItemId> = {};
  const created: StatusNotificationItem[] = [];
  const updated: StatusNotificationItem[] = [];
  const createdIds: NotificationItemId[] = [];
  const updatedIds: NotificationItemId[] = [];
  const replacements: Record<string, NotificationItem> = {};

  const durableByKey = new Map<string, StatusNotificationItem[]>();
  for (const item of input.durableStatusItems) {
    if (!isStatusNotificationItem(item)) {
      continue;
    }
    const key = logicalKeyOf(item);
    const list = durableByKey.get(key) ?? [];
    list.push(item);
    durableByKey.set(key, list);
  }

  stageMaterializerOutcome({
    eventName: "status.materializer.started",
    meta: {
      phase: "staged",
      durableStatusCount: input.durableStatusItems.length,
    },
  });

  // Fail closed on historical duplicates before any write.
  for (const [key, list] of durableByKey) {
    if (list.length > 1) {
      const logicalStatusKey = key.replaceAll("\0", "/");
      emitDiagnostic({
        eventName: "status.materializer.failed",
        source: "materializer",
        meta: {
          phase: "staged",
          classification: "STATUS_LOGICAL_DUPLICATE",
          logicalStatusKey,
          durableStatusCount: list.length,
          errorCode: "INVARIANT",
          errorMessage: "Duplicate durable Status rows for logical key",
        },
      });
      throw new PersistenceError(
        "INVARIANT",
        `Duplicate durable Status rows for logical key ${logicalStatusKey}: ${list
          .map((item) => item.id)
          .join(",")}`,
      );
    }
  }

  const targets = bansNeedingStatusPair(input.snapshot, effects);
  const kernelStatusEffects = effects.filter(
    (effect): effect is Extract<Effect, { type: "UPSERT_NOTIFICATION_ITEM" }> =>
      effect.type === "UPSERT_NOTIFICATION_ITEM" && effect.item.kind === "STATUS",
  );

  // Index kernel proposals by logical key (reject multiple proposals for same key with different IDs).
  const kernelByKey = new Map<string, StatusNotificationItem>();
  for (const effect of kernelStatusEffects) {
    const item = effect.item as StatusNotificationItem;
    const key = logicalKeyOf(item);
    const prior = kernelByKey.get(key);
    if (prior && prior.id !== item.id) {
      const logicalStatusKey = key.replaceAll("\0", "/");
      emitDiagnostic({
        eventName: "status.materializer.failed",
        source: "materializer",
        meta: {
          phase: "staged",
          classification: "STATUS_ID_REMAP_FAILED",
          logicalStatusKey,
          kernelItemId: `${prior.id},${item.id}`,
          errorCode: "INVARIANT",
          errorMessage: "Multiple Kernel Status Item IDs for logical key",
        },
      });
      throw new PersistenceError(
        "INVARIANT",
        `Multiple Kernel Status Item IDs for logical key ${logicalStatusKey}: ${prior.id}, ${item.id}`,
      );
    }
    kernelByKey.set(key, item);
  }

  for (const target of targets) {
    const roles: Role[] = ["RECEIVER", "SENDER"];
    for (const role of roles) {
      const key: StatusLogicalKey = {
        banId: target.banId,
        status: target.status,
        role,
      };
      const keyStr = keyString(key);
      const logicalStatusKey = keyStr.replaceAll("\0", "/");
      const durableList = durableByKey.get(keyStr) ?? [];
      const durable = durableList[0];
      const proposed = kernelByKey.get(keyStr);

      if (durable && proposed) {
        // Reject cross-entity remap
        if (
          durable.banId !== proposed.banId ||
          durable.role !== proposed.role ||
          durable.status !== proposed.status ||
          durable.ownerId !== proposed.ownerId
        ) {
          emitDiagnostic({
            eventName: "status.materializer.failed",
            source: "materializer",
            meta: {
              phase: "staged",
              classification: "STATUS_ID_REMAP_FAILED",
              logicalStatusKey,
              kernelItemId: proposed.id,
              durableItemId: durable.id,
              errorCode: "INVARIANT",
              errorMessage: "Refusing Status ID remap across different logical entities",
            },
          });
          throw new PersistenceError(
            "INVARIANT",
            `Refusing Status ID remap across different logical entities (${proposed.id} → ${durable.id})`,
          );
        }
        if (proposed.id !== durable.id) {
          remap[proposed.id] = durable.id;
          stageMaterializerOutcome({
            eventName: "status.materializer.remapped",
            meta: {
              phase: "staged",
              logicalStatusKey,
              kernelItemId: proposed.id,
              durableItemId: durable.id,
              banId: target.banId,
            },
          });
        } else {
          stageMaterializerOutcome({
            eventName: "status.materializer.reused",
            meta: {
              phase: "staged",
              logicalStatusKey,
              durableItemId: durable.id,
              banId: target.banId,
            },
          });
        }
        // Preserve PROCESSED; never remint
        const merged = mergeNotificationItem(durable, {
          ...proposed,
          id: durable.id,
          lifecycle: durable.lifecycle.status === "PROCESSED" ? durable.lifecycle : proposed.lifecycle,
        });
        replacements[durable.id] = merged;
        updated.push(merged as StatusNotificationItem);
        updatedIds.push(durable.id);
      } else if (durable && !proposed) {
        // Reuse durable; ensure it remains in write-set for consistency when Ban status written
        replacements[durable.id] = durable;
        updated.push(durable);
        updatedIds.push(durable.id);
        stageMaterializerOutcome({
          eventName: "status.materializer.reused",
          meta: {
            phase: "staged",
            logicalStatusKey,
            durableItemId: durable.id,
            banId: target.banId,
          },
        });
      } else if (!durable && proposed) {
        // Create with Kernel-proposed ID (becomes durable)
        const createdItem = { ...proposed };
        replacements[createdItem.id] = createdItem;
        created.push(createdItem);
        createdIds.push(createdItem.id);
        durableByKey.set(keyStr, [createdItem]);
        stageMaterializerOutcome({
          eventName: "status.materializer.created",
          meta: {
            phase: "staged",
            logicalStatusKey,
            durableItemId: createdItem.id,
            kernelItemId: createdItem.id,
            banId: target.banId,
          },
        });
      } else {
        // Missing counterpart — create independently (never suppress because the other role exists)
        const ownerId: UserId =
          role === "RECEIVER" ? (target.ban.receiverId as UserId) : target.ban.senderId;
        if (!ownerId) {
          emitDiagnostic({
            eventName: "status.materializer.failed",
            source: "materializer",
            meta: {
              phase: "staged",
              classification: "PERSISTENCE_INVARIANT",
              logicalStatusKey,
              errorCode: "INVARIANT",
              errorMessage: "Cannot materialize Status without Ban participant",
            },
          });
          throw new PersistenceError(
            "INVARIANT",
            `Cannot materialize ${role} Status without Ban participant`,
          );
        }
        const id = allocateId();
        const item: StatusNotificationItem = {
          id,
          ownerId,
          banId: target.banId,
          fifoSequence: nextFifoSequence(input.snapshot, input.durableStatusItems, [
            ...created,
            ...updated,
          ]),
          lifecycle: { status: "UNPROCESSED", display: "WAITING" },
          kind: "STATUS",
          role,
          status: target.status,
        };
        replacements[id] = item;
        created.push(item);
        createdIds.push(id);
        durableByKey.set(keyStr, [item]);
        stageMaterializerOutcome({
          eventName: "status.materializer.created",
          meta: {
            phase: "staged",
            logicalStatusKey,
            durableItemId: id,
            banId: target.banId,
          },
        });
      }
    }
  }

  let snapshot = applyIdRemapToSnapshot(input.snapshot, remap, replacements);
  snapshot = clearProcessedStatusPriority(snapshot);
  const remappedEffects = remapEffects(effects, remap);

  // Ensure materializer items are present under durable IDs in the snapshot.
  const items = { ...snapshot.extended.entities.notificationItems };
  for (const item of [...created, ...updated]) {
    items[item.id] = item;
  }
  snapshot = {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: {
        ...snapshot.extended.entities,
        notificationItems: items,
      },
    },
  };

  const materializerWrittenItemIds = [
    ...new Set([...createdIds, ...updatedIds]),
  ].sort((a, b) => a.localeCompare(b)) as NotificationItemId[];

  return {
    snapshot,
    effects: remappedEffects,
    idRemap: remap,
    createdItemIds: createdIds,
    updatedItemIds: updatedIds,
    materializerWrittenItemIds,
  };
}

export function materializeFromTransition(input: Readonly<{
  result: TransitionResult;
  mutationAuthority: BanMutationAuthority;
  durableStatusItems: readonly StatusNotificationItem[];
  allocateId?: () => NotificationItemId;
}>): StatusMaterializationResult {
  const args: {
    snapshot: ProductSnapshot;
    effects: readonly Effect[];
    mutationAuthority: BanMutationAuthority;
    durableStatusItems: readonly StatusNotificationItem[];
    allocateId?: () => NotificationItemId;
  } = {
    snapshot: input.result.snapshot,
    effects: input.result.effects ?? [],
    mutationAuthority: input.mutationAuthority,
    durableStatusItems: input.durableStatusItems,
  };
  if (input.allocateId !== undefined) {
    args.allocateId = input.allocateId;
  }
  return materializeStatusPairs(args);
}
