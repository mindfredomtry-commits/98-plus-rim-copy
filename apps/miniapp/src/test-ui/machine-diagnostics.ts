export type MachineDiagnosticsBan = Readonly<{
  id?: string;
  acceptance?: string;
  status?: string | null;
}>;

export type MachineDiagnosticsInput = Readonly<{
  controlState?: string | null;
  currentUserId?: string;
  selectedContactId?: string | null;
  createBanDraft?: Readonly<{
    origin?: string | null;
    selectedContactId?: string | null;
    banText?: string | null;
    durationMinutes?: number | null;
  }> | null;
  replyBanDraft?: Readonly<{
    banText?: string | null;
    durationMinutes?: number | null;
  }> | null;
  replySource?: Readonly<{
    kind?: string;
    itemId?: string;
    banId?: string;
  }> | null;
  successfulBanId?: string | null;
  lastEvent?: Readonly<{ id?: string | null; name: string }> | null;
  previousEvent?: Readonly<{ id?: string | null; name: string }> | null;
  kernelOutcome?: string | null;
  matrixResult?: string | null;
  applicationStatus?: string | null;
  persisted?: boolean;
  revision?: number;
  pendingOperations?: unknown;
  effects?: readonly string[];
  bans?: readonly MachineDiagnosticsBan[];
  incomingItems?: readonly unknown[];
  notificationItems?: readonly unknown[];
  activeNotificationItemId?: string | null;
  priorities?: unknown;
  hasUnprocessedNotifications?: boolean;
  domainTimers?: readonly unknown[];
  checkPairs?: readonly unknown[];
  savedFrozenRimChatPresent?: boolean;
  error?: Readonly<{ code?: string; message?: string }> | null;
}>;

export function formatEventLabel(
  event: Readonly<{ id?: string | null; name: string }> | null | undefined,
): string {
  if (!event) {
    return "(none)";
  }
  return event.id ? `${event.id} ${event.name}` : event.name;
}

export function formatMachineDiagnostics(diagnostics: MachineDiagnosticsInput | null): string {
  if (diagnostics === null) {
    return [
      "STATE: (not connected)",
      "CURRENT USER: (none)",
      "SELECTED USER: (none)",
      "DRAFT: (none)",
      "REPLY DRAFT: (none)",
      "REPLY SOURCE: (none)",
      "SUCCESSFUL REPLY BAN: (none)",
      "LAST EVENT: (none)",
      "PREVIOUS EVENT: (none)",
      "KERNEL RESULT: (none)",
      "APPLICATION STATUS: (none)",
      "PERSISTED: (none)",
      "REVISION: (none)",
      "PENDING OPERATIONS: (none)",
      "EFFECTS: (none)",
      "BANS: (none)",
      "BAN ACCEPTANCE: (none)",
      "BAN STATUS: (none)",
      "ACTIVE NOTIFICATION ITEM: (none)",
      "NOTIFICATION ITEMS: (none)",
      "TIMER ITEMS: (none)",
      "INCOMING: (none)",
      "PRIORITIES: (none)",
      "DOMAIN TIMERS: (none)",
      "CHECK PAIRS: (none)",
      "FROZEN RIM CHAT: (none)",
      "ERROR: (none)",
    ].join("\n");
  }
  const draft = diagnostics.createBanDraft ?? {};
  const replyDraft = diagnostics.replyBanDraft ?? {};
  const source = diagnostics.replySource;
  const sourceBan = source?.banId
    ? diagnostics.bans?.find((ban) => ban.id === source.banId)
    : undefined;
  const replyBan = diagnostics.successfulBanId
    ? diagnostics.bans?.find((ban) => ban.id === diagnostics.successfulBanId)
    : undefined;
  const timerItems = (diagnostics.notificationItems ?? []).filter(
    (item) => (item as { kind?: string }).kind === "TIMER",
  );
  const error = diagnostics.error;
  const ban = sourceBan ?? diagnostics.bans?.[0];
  return [
    `STATE: ${diagnostics.controlState || "(null)"}`,
    `CURRENT USER: ${diagnostics.currentUserId ?? "(none)"}`,
    `SELECTED USER: ${diagnostics.selectedContactId || "(none)"}`,
    "DRAFT:",
    `  origin: ${draft.origin || "(none)"}`,
    `  banText: ${JSON.stringify(draft.banText ?? "")}`,
    `  durationMinutes: ${String(draft.durationMinutes ?? "(none)")}`,
    "REPLY DRAFT:",
    `  banText: ${JSON.stringify(replyDraft.banText ?? "")}`,
    `  durationMinutes: ${String(replyDraft.durationMinutes ?? "(none)")}`,
    `REPLY SOURCE: ${source ? `${source.kind ?? "(none)"} item=${source.itemId ?? "(none)"} ban=${source.banId ?? "(none)"}` : "(none)"}`,
    `SUCCESSFUL REPLY BAN: ${diagnostics.successfulBanId ?? "(none)"}`,
    `SOURCE BAN ACCEPTANCE: ${sourceBan?.acceptance ?? "(none)"}`,
    `REPLY BAN SENDER: ${(replyBan as { senderId?: string } | undefined)?.senderId ?? "(none)"}`,
    `LAST EVENT: ${formatEventLabel(diagnostics.lastEvent)}`,
    `PREVIOUS EVENT: ${formatEventLabel(diagnostics.previousEvent)}`,
    `KERNEL RESULT: ${diagnostics.kernelOutcome || "(none)"}`,
    `MATRIX: ${diagnostics.matrixResult || "(none)"}`,
    `APPLICATION STATUS: ${diagnostics.applicationStatus ?? "(none)"}`,
    `PERSISTED: ${String(diagnostics.persisted ?? "(none)")}`,
    `REVISION: ${String(diagnostics.revision ?? "(none)")}`,
    `PENDING OPERATIONS: ${JSON.stringify(diagnostics.pendingOperations ?? {})}`,
    `EFFECTS: ${JSON.stringify(diagnostics.effects ?? [])}`,
    `BANS: ${diagnostics.bans?.length ?? 0}`,
    `BAN ACCEPTANCE: ${ban?.acceptance ?? "(none)"}`,
    `BAN STATUS: ${ban?.status ?? "(none)"}`,
    `ACTIVE NOTIFICATION ITEM: ${diagnostics.activeNotificationItemId ?? "(none)"}`,
    `NOTIFICATION ITEMS: ${diagnostics.notificationItems?.length ?? 0}`,
    `TIMER ITEMS: ${timerItems.length}`,
    `INCOMING: ${diagnostics.incomingItems?.length ?? 0}`,
    `PRIORITIES: ${JSON.stringify(diagnostics.priorities ?? {})}`,
    `DOMAIN TIMERS: ${diagnostics.domainTimers?.length ?? 0}`,
    `CHECK PAIRS: ${diagnostics.checkPairs?.length ?? 0}`,
    `FROZEN RIM CHAT: ${String(diagnostics.savedFrozenRimChatPresent ?? false)}`,
    error ? `ERROR: ${error.code ?? ""} ${error.message ?? ""}`.trim() : "ERROR: (none)",
  ].join("\n");
}
