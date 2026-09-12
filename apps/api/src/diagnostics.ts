import {
  CANONICAL_EVENT_DEFINITIONS,
  type CanonicalEvent,
  type CanonicalEventId,
  type Effect,
  type ProductSnapshot,
} from "@98plus/product-model";
import type { ApplicationExecutionResult } from "@98plus/application";
import type { SelectableRegisteredUser } from "./directory.ts";

export type TestUiDiagnostics = Readonly<{
  controlState: ProductSnapshot["controlState"];
  currentUserId: string;
  selectedContactId: string | null;
  createBanDraft: ProductSnapshot["extended"]["createBanDraft"];
  replyBanDraft: ProductSnapshot["extended"]["replyBanDraft"];
  replySource: ProductSnapshot["extended"]["replySource"];
  successfulBanId: ProductSnapshot["extended"]["successfulBanId"];
  lastEvent: Readonly<{ id: CanonicalEventId | null; name: string }> | null;
  previousEvent: Readonly<{ id: CanonicalEventId | null; name: string }> | null;
  kernelOutcome: ApplicationExecutionResult["outcome"];
  matrixResult: ApplicationExecutionResult["result"];
  applicationStatus: ApplicationExecutionResult["status"] | "LOADED";
  persisted: boolean;
  revision: number;
  pendingOperations: ProductSnapshot["runtime"]["pendingOperations"];
  effects: readonly Effect["type"][];
  pendingExternalEffects: readonly string[];
  bans: readonly unknown[];
  incomingItems: readonly unknown[];
  notificationItems: readonly unknown[];
  activeNotificationItemId: string | null;
  priorities: ProductSnapshot["extended"]["priorities"];
  hasUnprocessedNotifications: boolean;
  domainTimers: readonly unknown[];
  checkPairs: readonly unknown[];
  shareOperations: readonly unknown[];
  activeShareAttemptId: string | null;
  telegramShare: Readonly<{
    attemptId: string;
    token: string;
    preparedMessageId: string;
    shareUrl: string;
    api: "shareMessage";
  }> | null;
  savedFrozenRimChatPresent: boolean;
  error: Readonly<{ code: string; message: string }> | null;
  contacts: readonly SelectableRegisteredUser[];
}>;

function eventIdOf(event: CanonicalEvent): CanonicalEventId | null {
  const found = CANONICAL_EVENT_DEFINITIONS.find((definition) => definition.name === event.name);
  return found?.id ?? null;
}

export function toTestUiDiagnostics(input: {
  currentUserId: string;
  snapshot: ProductSnapshot;
  revision: number;
  contacts?: readonly SelectableRegisteredUser[];
  execution?: ApplicationExecutionResult | null;
  previousExecution?: ApplicationExecutionResult | null;
  telegramShare?: TestUiDiagnostics["telegramShare"];
}): TestUiDiagnostics {
  const snapshot = input.execution?.snapshot ?? input.snapshot;
  const draft = snapshot.extended.createBanDraft;
  const notificationItems = Object.values(snapshot.extended.entities.notificationItems);
  const incomingItems = notificationItems.filter((item) => item.kind === "INCOMING_BAN");
  const shareOperations = Object.values(snapshot.extended.entities.shareOperations);
  const activeShare = shareOperations.find((operation) => operation.status === "ACTIVE") ?? null;
  return {
    controlState: snapshot.controlState,
    currentUserId: input.currentUserId,
    selectedContactId: draft?.selectedContactId ?? null,
    createBanDraft: draft,
    replyBanDraft: snapshot.extended.replyBanDraft,
    replySource: snapshot.extended.replySource,
    successfulBanId: snapshot.extended.successfulBanId,
    lastEvent: input.execution
      ? { id: eventIdOf(input.execution.event), name: input.execution.event.name }
      : null,
    previousEvent: input.previousExecution
      ? { id: eventIdOf(input.previousExecution.event), name: input.previousExecution.event.name }
      : null,
    kernelOutcome: input.execution?.outcome ?? null,
    matrixResult: input.execution?.result ?? null,
    applicationStatus: input.execution?.status ?? "LOADED",
    persisted: input.execution?.persisted ?? false,
    revision: input.execution?.revision ?? input.revision,
    pendingOperations: snapshot.runtime.pendingOperations,
    effects: (input.execution?.effects ?? []).map((effect) => effect.type),
    pendingExternalEffects: (input.execution?.pendingExternalEffects ?? []).map(
      (item) => item.effect.type,
    ),
    bans: Object.values(snapshot.extended.entities.bans),
    incomingItems,
    notificationItems,
    activeNotificationItemId: snapshot.extended.activeNotificationItemId,
    priorities: snapshot.extended.priorities,
    hasUnprocessedNotifications: notificationItems.some(
      (item) => item.ownerId === input.currentUserId && item.lifecycle.status === "UNPROCESSED",
    ),
    domainTimers: Object.values(snapshot.extended.entities.domainTimers),
    checkPairs: Object.values(snapshot.extended.entities.checkPairs),
    shareOperations,
    activeShareAttemptId: activeShare ? String(activeShare.attemptId) : null,
    telegramShare: input.telegramShare ?? null,
    savedFrozenRimChatPresent: snapshot.extended.savedFrozenRimChat !== null,
    error: input.execution?.error
      ? { code: input.execution.error.code, message: input.execution.error.message }
      : null,
    contacts: input.contacts ?? [],
  };
}
