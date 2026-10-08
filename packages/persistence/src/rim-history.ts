import type { Ban, RimChat, RimMessage, UserId } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";
import { SQL } from "./sql.ts";
import type { AppliedProductRule, PersistenceSqlClient } from "./types.ts";

export const RIM_TERMINATION_REASONS = [
  "contact_changed",
  "chat_closed",
  "full_close",
  "create_ban_success",
  "ask_rim_replaced",
  "initialization_unrecoverable",
  "session_reset",
  "external_entry",
] as const;

export type RimTerminationReason = (typeof RIM_TERMINATION_REASONS)[number];

type ChatRow = {
  rim_chat_id: string;
  owner_user_id: string;
  contact_user_id: string;
  openai_conversation_id: string | null;
  termination_reason: string | null;
  resulting_ban_id: string | null;
};

type MessageRow = {
  message_key: string;
  ordinal: number;
  kind: string;
  payload: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function idsOf(live: RimChat | null, frozen: RimChat | null): string[] {
  const ids: string[] = [];
  if (live) {
    ids.push(live.id);
  }
  if (frozen && frozen.id !== live?.id) {
    ids.push(frozen.id);
  }
  return ids;
}

export function rimHistoryChanged(
  previousLive: RimChat | null,
  previousFrozen: RimChat | null,
  nextLive: RimChat | null,
  nextFrozen: RimChat | null,
): boolean {
  const previous = new Set(idsOf(previousLive, previousFrozen));
  const next = new Set(idsOf(nextLive, nextFrozen));
  if (previous.size !== next.size) {
    return true;
  }
  for (const id of previous) {
    if (!next.has(id)) {
      return true;
    }
  }
  if (previousLive && nextLive && previousLive.id === nextLive.id) {
    return stable(previousLive.messages) !== stable(nextLive.messages);
  }
  return false;
}

function terminationReason(rule: AppliedProductRule): RimTerminationReason | null {
  switch (rule.eventId) {
    case "E-49":
      return rule.branch === "change-selected-contact" ? "contact_changed" : null;
    case "E-50":
      return "chat_closed";
    case "E-32":
      return "full_close";
    case "E-10":
      return "create_ban_success";
    case "E-63":
      return "ask_rim_replaced";
    case "E-64":
      return "initialization_unrecoverable";
    case "E-33":
      return "session_reset";
    case "E-45":
      return "external_entry";
    default:
      return null;
  }
}

function payloadOf(message: RimMessage): unknown {
  if (message.kind === "BAN_PROPOSALS") {
    return {
      message: message.message,
      proposals: message.proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        banText: proposal.banText,
        executionProbability: proposal.executionProbability,
      })),
    };
  }
  return { text: message.text };
}

type MessageIdentity = {
  key: string;
  kind: RimMessage["kind"];
  aiRequestId: string | null;
  contextRequestId: string | null;
};

function acceptedPrefixIdentity(
  chat: RimChat,
  ordinal: number,
  message: RimMessage,
): MessageIdentity {
  const sourceId = `accepted:${chat.id}:${ordinal}`;
  if (message.kind === "RIM") {
    return {
      key: `${chat.id}:accepted:${ordinal}`,
      kind: "RIM",
      aiRequestId: null,
      contextRequestId: sourceId,
    };
  }
  return {
    key: `${chat.id}:accepted:${ordinal}`,
    kind: message.kind,
    aiRequestId: sourceId,
    contextRequestId: null,
  };
}

function appendIdentity(
  rule: AppliedProductRule,
  previous: RimChat,
  next: RimChat,
  message: RimMessage,
): MessageIdentity {
  if (rule.eventId === "E-52" && message.kind === "USER") {
    if (next.aiOperation.status !== "PENDING") {
      throw new PersistenceError(
        "INVARIANT",
        "RIM history USER message requires the pending AI request",
      );
    }
    const requestId = next.aiOperation.requestId;
    if (next.aiOperation.snapshot.userMessage !== message.text) {
      throw new PersistenceError(
        "INVARIANT",
        "RIM history USER message does not match the pending request",
      );
    }
    return {
      key: `${next.id}:${requestId}:user`,
      kind: "USER",
      aiRequestId: requestId,
      contextRequestId: null,
    };
  }
  if (rule.eventId === "E-58" && message.kind !== "USER") {
    if (previous.aiOperation.status !== "PENDING") {
      throw new PersistenceError("INVARIANT", "RIM history reply requires the pending AI request");
    }
    const requestId = previous.aiOperation.requestId;
    return {
      key: `${next.id}:${requestId}:reply`,
      kind: message.kind,
      aiRequestId: requestId,
      contextRequestId: null,
    };
  }
  if (rule.eventId === "E-56" && message.kind === "RIM") {
    const requestId = next.relationshipContext?.requestId ?? null;
    if (!requestId) {
      throw new PersistenceError(
        "INVARIANT",
        "RIM history prompt requires the relationship context request",
      );
    }
    return {
      key: `${next.id}:${requestId}:prompt`,
      kind: "RIM",
      aiRequestId: null,
      contextRequestId: requestId,
    };
  }
  throw new PersistenceError("INVARIANT", "RIM history cannot key this accepted message");
}

async function loadChatRow(tx: PersistenceSqlClient, rimChatId: string): Promise<ChatRow | null> {
  const existing = await tx.query<ChatRow>(SQL.selectRimChat, [rimChatId]);
  return existing.rows[0] ?? null;
}

async function loadArchive(tx: PersistenceSqlClient, rimChatId: string): Promise<MessageRow[]> {
  const archived = await tx.query<MessageRow>(SQL.selectRimMessages, [rimChatId]);
  return [...archived.rows];
}

function sameAcceptedMessage(row: MessageRow, message: RimMessage): boolean {
  return row.kind === message.kind && stable(row.payload) === stable(payloadOf(message));
}

function assertVerifiedPrefix(
  archived: readonly MessageRow[],
  messages: readonly RimMessage[],
): void {
  if (archived.length > messages.length) {
    throw new PersistenceError("INVARIANT", "RIM history has more messages than the accepted chat");
  }
  for (let index = 0; index < archived.length; index += 1) {
    const row = archived[index];
    const message = messages[index];
    if (
      !row ||
      !message ||
      Number(row.ordinal) !== index + 1 ||
      !sameAcceptedMessage(row, message)
    ) {
      throw new PersistenceError("INVARIANT", "RIM history archive prefix does not match");
    }
  }
}

async function ensureChat(
  tx: PersistenceSqlClient,
  chat: RimChat,
  ownerUserId: UserId,
): Promise<void> {
  const inserted = await tx.query<{ rim_chat_id: string }>(SQL.insertRimChat, [
    chat.id,
    ownerUserId,
    chat.selectedContactId,
  ]);
  if (inserted.rows[0]) {
    return;
  }
  const row = await loadChatRow(tx, chat.id);
  if (!row || row.owner_user_id !== ownerUserId || row.contact_user_id !== chat.selectedContactId) {
    throw new PersistenceError("INVARIANT", "RIM chat archive identity does not match");
  }
  if (row.termination_reason !== null) {
    throw new PersistenceError("INVARIANT", "RIM history cannot write a terminated chat");
  }
}

export async function rejectTerminatedRimChats(
  tx: PersistenceSqlClient,
  chats: readonly (RimChat | null)[],
): Promise<void> {
  for (const chat of chats) {
    if (!chat) {
      continue;
    }
    const row = await loadChatRow(tx, chat.id);
    if (row?.termination_reason) {
      throw new PersistenceError("INVARIANT", "RIM history cannot write a terminated chat");
    }
  }
}

async function alignAcceptedMessages(
  tx: PersistenceSqlClient,
  chat: RimChat,
  ownerUserId: UserId,
  accepted: readonly RimMessage[],
  eventSlot: { index: number; identity: MessageIdentity } | null,
): Promise<void> {
  await ensureChat(tx, chat, ownerUserId);
  const archived = await loadArchive(tx, chat.id);
  assertVerifiedPrefix(archived, accepted);
  for (let index = archived.length; index < accepted.length; index += 1) {
    const message = accepted[index];
    if (!message) {
      throw new PersistenceError("INVARIANT", "RIM history accepted message is missing");
    }
    if (eventSlot && index > eventSlot.index) {
      throw new PersistenceError("INVARIANT", "RIM history accepts one message per Product event");
    }
    const identity =
      eventSlot && index === eventSlot.index
        ? eventSlot.identity
        : acceptedPrefixIdentity(chat, index + 1, message);
    await archiveMessage(tx, chat, identity, message, index + 1);
  }
}

async function archiveMessage(
  tx: PersistenceSqlClient,
  chat: RimChat,
  identity: MessageIdentity,
  message: RimMessage,
  expectedOrdinal: number,
): Promise<void> {
  const row = await loadChatRow(tx, chat.id);
  if (!row || row.termination_reason !== null) {
    throw new PersistenceError("INVARIANT", "RIM history cannot write a terminated chat");
  }
  const listed = await loadArchive(tx, chat.id);
  const ordinal = listed.length + 1;
  if (ordinal !== expectedOrdinal) {
    throw new PersistenceError(
      "INVARIANT",
      "RIM history ordinal does not match the accepted message",
    );
  }
  const payload = payloadOf(message);
  const inserted = await tx.query<{ message_key: string }>(SQL.insertRimMessage, [
    identity.key,
    chat.id,
    ordinal,
    identity.kind,
    JSON.stringify(payload),
    identity.aiRequestId,
    identity.contextRequestId,
  ]);
  if (inserted.rows[0]) {
    return;
  }
  const current = listed.find((item) => item.message_key === identity.key);
  const stored =
    current ?? (await loadArchive(tx, chat.id)).find((item) => item.message_key === identity.key);
  if (
    !stored ||
    Number(stored.ordinal) !== expectedOrdinal ||
    !sameAcceptedMessage(stored, message)
  ) {
    throw new PersistenceError("INVARIANT", "RIM history message key payload conflict");
  }
}

function proposalIds(chat: RimChat | null): string[] {
  if (!chat) {
    return [];
  }
  const ids: string[] = [];
  for (const message of chat.messages) {
    if (message.kind !== "BAN_PROPOSALS") {
      continue;
    }
    for (const proposal of message.proposals) {
      ids.push(proposal.proposalId);
    }
  }
  return ids;
}

function resultingBanId(
  previousLive: RimChat | null,
  previousFrozen: RimChat | null,
  bans: Readonly<Record<string, Ban>>,
  createdBanIds: ReadonlySet<string>,
): string | null {
  const ids = new Set([...proposalIds(previousLive), ...proposalIds(previousFrozen)]);
  const proposalMatches = Object.values(bans).filter(
    (ban) => ban.sourceProposalId !== null && ids.has(ban.sourceProposalId),
  );
  const created = Object.values(bans).filter((ban) => createdBanIds.has(ban.id));
  const proposalBan = proposalMatches.length === 1 ? proposalMatches[0] : null;
  const createdBan = created.length === 1 ? created[0] : null;
  if (
    proposalMatches.length > 1 ||
    created.length > 1 ||
    (proposalBan && createdBan && proposalBan.id !== createdBan.id) ||
    (!proposalBan && !createdBan)
  ) {
    throw new PersistenceError(
      "INVARIANT",
      "RIM history Create Ban success requires exactly one linked Ban",
    );
  }
  return proposalBan?.id ?? createdBan?.id ?? null;
}

async function terminateChat(
  tx: PersistenceSqlClient,
  rimChatId: string,
  reason: RimTerminationReason,
  banId: string | null,
): Promise<void> {
  const updated = await tx.query<{ rim_chat_id: string }>(SQL.terminateRimChat, [
    rimChatId,
    reason,
    banId,
  ]);
  if (!updated.rows[0]) {
    throw new PersistenceError("INVARIANT", "RIM chat archive termination conflict");
  }
}

export async function projectRimHistory(
  tx: PersistenceSqlClient,
  input: Readonly<{
    ownerUserId: UserId;
    previousLive: RimChat | null;
    previousFrozen: RimChat | null;
    nextLive: RimChat | null;
    nextFrozen: RimChat | null;
    bans: Readonly<Record<string, Ban>>;
    createdBanIds: ReadonlySet<string>;
    appliedRule: AppliedProductRule;
  }>,
): Promise<void> {
  const { previousLive, previousFrozen, nextLive, nextFrozen, appliedRule } = input;
  if (!rimHistoryChanged(previousLive, previousFrozen, nextLive, nextFrozen)) {
    return;
  }
  const previousIds = idsOf(previousLive, previousFrozen);
  const surviving = new Set(idsOf(nextLive, nextFrozen));
  if (nextLive && !previousIds.includes(nextLive.id)) {
    if (nextLive.messages.length > 0) {
      throw new PersistenceError(
        "INVARIANT",
        "RIM history cannot invent keys for a chat created with messages",
      );
    }
    await ensureChat(tx, nextLive, input.ownerUserId);
  }
  if (previousLive && nextLive && previousLive.id === nextLive.id) {
    if (nextLive.messages.length < previousLive.messages.length) {
      throw new PersistenceError("INVARIANT", "RIM history cannot drop accepted messages");
    }
    const prefixMatches = previousLive.messages.every(
      (message, index) => stable(message) === stable(nextLive.messages[index]),
    );
    if (!prefixMatches) {
      throw new PersistenceError("INVARIANT", "RIM history message prefix does not match");
    }
    const added = nextLive.messages.length - previousLive.messages.length;
    if (added > 1) {
      throw new PersistenceError("INVARIANT", "RIM history accepts one message per Product event");
    }
    const appended = added === 1 ? nextLive.messages[previousLive.messages.length] : undefined;
    await alignAcceptedMessages(
      tx,
      nextLive,
      input.ownerUserId,
      nextLive.messages,
      appended
        ? {
            index: previousLive.messages.length,
            identity: appendIdentity(appliedRule, previousLive, nextLive, appended),
          }
        : null,
    );
  }
  for (const rimChatId of previousIds) {
    if (surviving.has(rimChatId)) {
      continue;
    }
    const closing = previousLive?.id === rimChatId ? previousLive : previousFrozen;
    const reason = terminationReason(appliedRule);
    if (!reason) {
      throw new PersistenceError(
        "INVARIANT",
        "RIM history has no termination reason for this event",
      );
    }
    const banId =
      reason === "create_ban_success"
        ? resultingBanId(previousLive, previousFrozen, input.bans, input.createdBanIds)
        : null;
    await closeArchivedChat(tx, closing, rimChatId, input.ownerUserId, reason, banId);
  }
}

async function closeArchivedChat(
  tx: PersistenceSqlClient,
  closing: RimChat | null,
  rimChatId: string,
  ownerUserId: UserId,
  reason: RimTerminationReason,
  banId: string | null,
): Promise<void> {
  const row = await loadChatRow(tx, rimChatId);
  const accepted = closing?.messages ?? [];
  if (row?.termination_reason) {
    if (row.termination_reason !== reason || row.resulting_ban_id !== banId) {
      throw new PersistenceError("INVARIANT", "RIM chat archive termination conflict");
    }
    const archived = await loadArchive(tx, rimChatId);
    assertVerifiedPrefix(archived, accepted);
    if (archived.length !== accepted.length) {
      throw new PersistenceError("INVARIANT", "RIM history cannot write a terminated chat");
    }
    await terminateChat(tx, rimChatId, reason, banId);
    return;
  }
  if (closing) {
    await alignAcceptedMessages(tx, closing, ownerUserId, accepted, null);
  }
  const archived = await loadArchive(tx, rimChatId);
  if (archived.length !== accepted.length) {
    throw new PersistenceError(
      "INVARIANT",
      "RIM history is missing accepted messages for a chat being closed",
    );
  }
  await terminateChat(tx, rimChatId, reason, banId);
}

export async function persistOpenAiConversationId(
  tx: PersistenceSqlClient,
  runtime: unknown,
): Promise<void> {
  if (!isRecord(runtime) || !isRecord(runtime.initialization)) {
    return;
  }
  if (runtime.initialization.submissionState !== "stored") {
    return;
  }
  const rimChatId = runtime.rimChatId;
  const conversationId = runtime.initialization.conversationId;
  if (
    typeof rimChatId !== "string" ||
    typeof conversationId !== "string" ||
    conversationId.length === 0
  ) {
    return;
  }
  const existing = await tx.query<ChatRow>(SQL.selectRimChat, [rimChatId]);
  const row = existing.rows[0];
  if (!row) {
    return;
  }
  if (row.openai_conversation_id !== null && row.openai_conversation_id !== conversationId) {
    throw new PersistenceError("INVARIANT", "RIM history conversation id conflict");
  }
  const updated = await tx.query<{ rim_chat_id: string }>(SQL.setRimConversationId, [
    rimChatId,
    conversationId,
  ]);
  if (!updated.rows[0]) {
    throw new PersistenceError("INVARIANT", "RIM history conversation id conflict");
  }
}
