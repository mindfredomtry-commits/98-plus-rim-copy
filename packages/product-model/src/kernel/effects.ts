import type { BanDraft, RelationshipContext, RimChat, RimMessage } from "../entities.ts";
import { isTimerNotificationItem, markTimerNotificationItemProcessed } from "../entities.ts";
import type { Effect } from "../effects.ts";
import type { CanonicalEvent } from "../events.ts";
import type { ProductSnapshot } from "../extended-state.ts";
import type { MatrixContractRow } from "../matrix.ts";
import type { ContextRequestId, DurationMinutes, RimChatId, UserId } from "../ids.ts";
import type { ProductControlState } from "../states.ts";
import type { ResolveInput } from "./types.ts";
import { statusControlState } from "./snapshot.ts";

function introMessage(): RimMessage {
  return { kind: "RIM", text: "я могу предложить 3 запрета, написать?" };
}

function lobbyPrompt(): RimMessage {
  return { kind: "RIM", text: "выбери человека и я предложу новые запреты" };
}

function eventField<T>(event: CanonicalEvent, key: string): T | undefined {
  return (event.payload as Record<string, T | undefined>)[key];
}

function emptyDraft(origin: BanDraft["origin"], contactId: UserId | null = null): BanDraft {
  return {
    origin,
    selectedContactId: contactId,
    banText: "",
    durationMinutes: null,
  };
}

export function nextRimChat(
  row: MatrixContractRow,
  snapshot: ProductSnapshot,
  event: CanonicalEvent,
  context: ResolveInput["context"],
): RimChat | null {
  const current = snapshot.extended.rimChat;
  if (row.eventId === "E-47") {
    return {
      id: context.allocateId("rim-chat") as RimChatId,
      selectedContactId: null,
      relationshipContext: null,
      messages: [lobbyPrompt()],
      inputDraft: "",
      aiOperation: { status: "IDLE" },
    };
  }
  if (row.eventId === "E-50" && row.state === "RIM.CHAT") {
    return null;
  }
  if (row.eventId === "E-45" && row.branch === "guard-a") {
    return null;
  }
  if (row.eventId === "E-32") {
    return null;
  }
  if (row.eventId === "E-07" && snapshot.extended.savedFrozenRimChat) {
    return snapshot.extended.savedFrozenRimChat;
  }
  if (!current) {
    return current;
  }
  if (row.eventId === "E-49" && row.branch === "initial-selected-contact") {
    const contactId = eventField<UserId>(event, "contactId");
    if (!contactId) {
      return current;
    }
    const requestId = context.allocateId("context") as ContextRequestId;
    const relationshipContext: RelationshipContext = {
      selectedContactId: contactId,
      status: "loading",
      requestId,
      data: null,
      failure: null,
    };
    return {
      ...current,
      selectedContactId: contactId,
      relationshipContext,
    };
  }
  if (row.eventId === "E-49" && row.branch === "change-selected-contact") {
    const contactId = eventField<UserId>(event, "contactId");
    if (!contactId) {
      return current;
    }
    const requestId = context.allocateId("context") as ContextRequestId;
    return {
      ...current,
      selectedContactId: contactId,
      relationshipContext: {
        selectedContactId: contactId,
        status: "loading",
        requestId,
        data: null,
        failure: null,
      },
      messages: [],
      inputDraft: "",
      aiOperation: { status: "IDLE" },
    };
  }
  if (row.eventId === "E-49" && row.branch === "same-current-selected-contact") {
    return current;
  }
  if (row.eventId === "E-51") {
    return { ...current, inputDraft: eventField<string>(event, "inputDraft") ?? "" };
  }
  if (row.eventId === "E-52" && row.branch === "valid") {
    const text = current.inputDraft;
    return {
      ...current,
      messages: [...current.messages, { kind: "USER", text }],
      inputDraft: "",
      aiOperation: {
        status: "PENDING",
        requestId: context.allocateId("ai") as import("../ids.ts").AiRequestId,
      },
    };
  }
  if (row.eventId === "E-53") {
    const contactId = current.selectedContactId;
    if (!contactId) {
      return current;
    }
    const requestId = context.allocateId("context") as ContextRequestId;
    return {
      ...current,
      relationshipContext: {
        selectedContactId: contactId,
        status: "loading",
        requestId,
        data: null,
        failure: null,
      },
    };
  }
  if (row.eventId === "E-54") {
    return {
      ...current,
      aiOperation: {
        status: "PENDING",
        requestId: context.allocateId("ai") as import("../ids.ts").AiRequestId,
      },
    };
  }
  if (row.eventId === "E-56" && row.result === "STAY") {
    const data = eventField<RelationshipContext["data"]>(event, "relationshipContext");
    const requestId = eventField<ContextRequestId>(event, "requestId");
    const selectedContactId = eventField<UserId>(event, "selectedContactId");
    if (!requestId || !selectedContactId || !data) {
      return current;
    }
    const ready: RelationshipContext = {
      selectedContactId,
      status: "ready",
      requestId,
      data,
      failure: null,
    };
    const hasIntro = current.messages.some(
      (message) => message.kind === "RIM" && message.text.includes("я могу предложить 3 запрета"),
    );
    return {
      ...current,
      relationshipContext: ready,
      messages: hasIntro ? current.messages : [...current.messages, introMessage()],
    };
  }
  if (row.eventId === "E-57") {
    const requestId = eventField<ContextRequestId>(event, "requestId");
    const selectedContactId = eventField<UserId>(event, "selectedContactId");
    if (!current.relationshipContext || !requestId || !selectedContactId) {
      return current;
    }
    return {
      ...current,
      relationshipContext: {
        ...current.relationshipContext,
        status: "error",
        failure: eventField(event, "failure") ?? current.relationshipContext.failure,
      },
    };
  }
  if (
    row.eventId === "E-58" &&
    row.branch !== "stale-request" &&
    row.branch !== "stale-replaced-contact"
  ) {
    const result = eventField<{
      kind: string;
      text?: string;
      suggestions?: RimChat["messages"][number] extends infer _ ? never : never;
    }>(event, "result") as import("../entities.ts").RimAiResult | undefined;
    if (!result) {
      return current;
    }
    const message: RimMessage =
      result.kind === "BAN_SUGGESTIONS"
        ? { kind: "SUGGESTIONS", suggestions: result.suggestions }
        : { kind: "RIM", text: result.text };
    return {
      ...current,
      messages: [...current.messages, message],
      aiOperation: { status: "IDLE" },
    };
  }
  if (row.eventId === "E-59") {
    return {
      ...current,
      aiOperation: {
        status: "FAILED",
        requestId: eventField(event, "requestId") ?? ("" as import("../ids.ts").AiRequestId),
        failure: eventField(event, "failure") as import("../primitives.ts").Failure,
      },
    };
  }
  if (row.eventId === "E-07" && snapshot.extended.savedFrozenRimChat && row.state.includes("RIM")) {
    return snapshot.extended.savedFrozenRimChat;
  }
  return current;
}

export function nextCreateDraft(
  row: MatrixContractRow,
  snapshot: ProductSnapshot,
  event: CanonicalEvent,
): BanDraft | null {
  const current = snapshot.extended.createBanDraft;
  if (row.eventId === "E-01") {
    return emptyDraft("CONTACT");
  }
  if (row.eventId === "E-02") {
    const contactId = eventField<UserId>(event, "contactId");
    if (!contactId) {
      return current;
    }
    return {
      origin: "CONTACT",
      selectedContactId: contactId,
      banText: current?.banText ?? "",
      durationMinutes: current?.durationMinutes ?? null,
    };
  }
  if (row.eventId === "E-03") {
    return emptyDraft("TEMPLATE");
  }
  if (row.eventId === "E-55") {
    return {
      origin: "RIM",
      selectedContactId: eventField<UserId>(event, "selectedContactId") ?? null,
      banText: eventField<{ banText: string }>(event, "suggestion")?.banText ?? "",
      durationMinutes: null,
    };
  }
  if (
    row.eventId === "E-07" &&
    (row.state === "CREATE_BAN.WHO" ||
      row.state === "CREATE_BAN.WHAT.CONTACT" ||
      row.state === "CREATE_BAN.WHAT.TEMPLATE" ||
      row.state === "CREATE_BAN.WHAT.RIM" ||
      row.effectsText.includes("удаляются") ||
      row.effectsText.includes("прекращается"))
  ) {
    if (row.state === "CREATE_BAN.CONFIRM.CONTACT" || row.state === "CREATE_BAN.CONFIRM.RIM") {
      return current;
    }
    if (row.state === "CREATE_BAN.WHAT.RIM") {
      return null;
    }
    if (row.state === "CREATE_BAN.WHO") {
      return null;
    }
    if (row.state === "CREATE_BAN.WHAT.CONTACT" || row.state === "CREATE_BAN.WHAT.TEMPLATE") {
      return emptyDraft(row.state.includes("TEMPLATE") ? "TEMPLATE" : "CONTACT");
    }
  }
  if (row.eventId === "E-04" && current) {
    return { ...current, banText: eventField<string>(event, "banText") ?? current.banText };
  }
  if (row.eventId === "E-05" && current) {
    return {
      ...current,
      durationMinutes: (eventField<number>(event, "durationMinutes") ??
        null) as DurationMinutes | null,
    };
  }
  if (row.eventId === "E-32" || row.eventId === "E-45") {
    return null;
  }
  if (row.eventId === "E-10" || row.eventId === "E-12") {
    return null;
  }
  return current;
}

export function nextReplyDraft(
  row: MatrixContractRow,
  snapshot: ProductSnapshot,
  event: CanonicalEvent,
) {
  const current = snapshot.extended.replyBanDraft;
  if (row.eventId === "E-14" || row.eventId === "E-18") {
    return { banText: "", durationMinutes: null };
  }
  if (row.eventId === "E-24") {
    return {
      banText: eventField<string>(event, "banText") ?? "",
      durationMinutes: current?.durationMinutes ?? null,
    };
  }
  if (row.eventId === "E-25") {
    return {
      banText: current?.banText ?? "",
      durationMinutes: (eventField<number>(event, "durationMinutes") ??
        null) as DurationMinutes | null,
    };
  }
  if (row.eventId === "E-27" && row.branch !== "no-pending-send") {
    return null;
  }
  if (row.eventId === "E-32" || row.eventId === "E-45" || row.eventId === "E-30") {
    return null;
  }
  return current;
}

export function applyEffects(
  snapshot: ProductSnapshot,
  effects: readonly Effect[],
): ProductSnapshot {
  let next: ProductSnapshot = {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: { ...snapshot.extended.entities },
      priorities: { ...snapshot.extended.priorities },
    },
    runtime: {
      ...snapshot.runtime,
      pendingOperations: { ...snapshot.runtime.pendingOperations },
    },
  };
  for (const effect of effects) {
    switch (effect.type) {
      case "SET_CONTROL_STATE":
        if (effect.state !== next.controlState) {
          next = {
            ...next,
            controlState: effect.state,
            extended: {
              ...next.extended,
              telegramPersistentReentryCtaSurfaceGeneration:
                next.extended.telegramPersistentReentryCtaSurfaceGeneration + 1,
            },
          };
        } else {
          next = { ...next, controlState: effect.state };
        }
        break;
      case "END_SESSION":
        next = {
          ...next,
          controlState: null,
          extended: {
            ...next.extended,
            telegramPersistentReentryCtaSurfaceGeneration:
              next.controlState === null
                ? next.extended.telegramPersistentReentryCtaSurfaceGeneration
                : next.extended.telegramPersistentReentryCtaSurfaceGeneration + 1,
          },
          runtime: { ...next.runtime, session: "CLOSED" },
        };
        break;
      case "SET_CONNECTION":
        next = { ...next, runtime: { ...next.runtime, connection: effect.connection } };
        break;
      case "SET_RIM_CHAT":
        next = { ...next, extended: { ...next.extended, rimChat: effect.chat } };
        break;
      case "SET_FROZEN_RIM_CHAT":
        next = { ...next, extended: { ...next.extended, savedFrozenRimChat: effect.chat } };
        break;
      case "SET_CREATE_BAN_DRAFT":
        next = { ...next, extended: { ...next.extended, createBanDraft: effect.draft } };
        break;
      case "SET_REPLY_BAN_DRAFT":
        next = { ...next, extended: { ...next.extended, replyBanDraft: effect.draft } };
        break;
      case "SET_REPLY_SOURCE":
        next = { ...next, extended: { ...next.extended, replySource: effect.source } };
        break;
      case "SET_ACTIVE_NOTIFICATION":
        next = {
          ...next,
          extended: { ...next.extended, activeNotificationItemId: effect.itemId },
        };
        break;
      case "SET_PENDING_EXTERNAL_ENTRY":
        next = { ...next, extended: { ...next.extended, pendingExternalEntry: effect.entry } };
        if (effect.entry?.firstLaunch) {
          next = {
            ...next,
            runtime: {
              ...next.runtime,
              bootstrap: { status: "FIRST_LAUNCH_EXTERNAL_ENTRY" },
            },
          };
        }
        break;
      case "SET_TELEGRAM_PERSISTENT_REENTRY_ELIGIBLE":
        next = {
          ...next,
          extended: {
            ...next.extended,
            telegramPersistentReentryEligible: effect.eligible,
          },
        };
        break;
      case "SET_TELEGRAM_PERSISTENT_REENTRY_ESTABLISHED":
        next = {
          ...next,
          extended: {
            ...next.extended,
            telegramPersistentReentryEstablished: effect.established,
          },
        };
        break;
      case "SET_TELEGRAM_PERSISTENT_REENTRY_ACTIVE_REQUEST":
        next = {
          ...next,
          extended: {
            ...next.extended,
            telegramPersistentReentryActiveRequestId: effect.requestId,
          },
        };
        break;
      case "CONSUME_TELEGRAM_PERSISTENT_REENTRY_CTA_OPPORTUNITY":
        next = {
          ...next,
          extended: {
            ...next.extended,
            telegramPersistentReentryCtaConsumedSurfaceGeneration:
              next.extended.telegramPersistentReentryCtaSurfaceGeneration,
          },
        };
        break;
      case "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE":
        break;
      case "SET_TIMER_PRIORITY":
        next = {
          ...next,
          extended: {
            ...next.extended,
            priorities: { ...next.extended.priorities, timerItemId: effect.itemId },
          },
        };
        break;
      case "CLEAR_TIMER_PRIORITY":
        next = {
          ...next,
          extended: {
            ...next.extended,
            priorities: { ...next.extended.priorities, timerItemId: null },
          },
        };
        break;
      case "SET_STATUS_PRIORITY":
        next = {
          ...next,
          extended: {
            ...next.extended,
            priorities: { ...next.extended.priorities, statusItemId: effect.itemId },
          },
        };
        break;
      case "CLEAR_STATUS_PRIORITY":
        next = {
          ...next,
          extended: {
            ...next.extended,
            priorities: { ...next.extended.priorities, statusItemId: null },
          },
        };
        break;
      case "START_OPERATION":
        next = {
          ...next,
          runtime: {
            ...next.runtime,
            pendingOperations: {
              ...next.runtime.pendingOperations,
              [effect.operation.operationId]: effect.operation,
            },
          },
        };
        break;
      case "CLEAR_OPERATION": {
        const pendingOperations = { ...next.runtime.pendingOperations };
        delete pendingOperations[effect.operationId];
        next = { ...next, runtime: { ...next.runtime, pendingOperations } };
        break;
      }
      case "MARK_OPERATION_RESULT_APPLIED": {
        const operation = next.runtime.pendingOperations[effect.operationId];
        if (operation) {
          next = {
            ...next,
            runtime: {
              ...next.runtime,
              pendingOperations: {
                ...next.runtime.pendingOperations,
                [effect.operationId]: { ...operation, resultApplied: true },
              },
            },
          };
        }
        break;
      }
      case "MARK_OPERATION_SUPERSEDED_BY_EXTERNAL_ENTRY": {
        const operation = next.runtime.pendingOperations[effect.operationId];
        if (operation && !operation.resultApplied) {
          next = {
            ...next,
            runtime: {
              ...next.runtime,
              pendingOperations: {
                ...next.runtime.pendingOperations,
                [effect.operationId]: { ...operation, supersededByExternalEntry: true },
              },
            },
          };
        }
        break;
      }
      case "UPSERT_BAN": {
        const isNew = next.extended.entities.bans[effect.ban.id] === undefined;
        next = {
          ...next,
          extended: {
            ...next.extended,
            entities: {
              ...next.extended.entities,
              bans: { ...next.extended.entities.bans, [effect.ban.id]: effect.ban },
            },
            successfulBanId: isNew ? effect.ban.id : next.extended.successfulBanId,
          },
        };
        break;
      }
      case "UPSERT_CHECK_PAIR":
        next = {
          ...next,
          extended: {
            ...next.extended,
            entities: {
              ...next.extended.entities,
              checkPairs: { ...next.extended.entities.checkPairs, [effect.pair.id]: effect.pair },
            },
          },
        };
        break;
      case "UPSERT_DOMAIN_TIMER":
        next = {
          ...next,
          extended: {
            ...next.extended,
            entities: {
              ...next.extended.entities,
              domainTimers: {
                ...next.extended.entities.domainTimers,
                [effect.timer.id]: effect.timer,
              },
            },
          },
        };
        break;
      case "UPSERT_NOTIFICATION_ITEM":
        next = {
          ...next,
          extended: {
            ...next.extended,
            entities: {
              ...next.extended.entities,
              notificationItems: {
                ...next.extended.entities.notificationItems,
                [effect.item.id]: effect.item,
              },
            },
          },
        };
        break;
      case "SET_NOTIFICATION_LIFECYCLE": {
        const item = next.extended.entities.notificationItems[effect.itemId];
        if (item) {
          next = {
            ...next,
            extended: {
              ...next.extended,
              entities: {
                ...next.extended.entities,
                notificationItems: {
                  ...next.extended.entities.notificationItems,
                  [effect.itemId]: { ...item, lifecycle: effect.lifecycle },
                },
              },
            },
          };
        }
        break;
      }
      case "PROCESS_TIMER_NOTIFICATION_ITEM": {
        const item = next.extended.entities.notificationItems[effect.itemId];
        if (item && isTimerNotificationItem(item)) {
          next = {
            ...next,
            extended: {
              ...next.extended,
              entities: {
                ...next.extended.entities,
                notificationItems: {
                  ...next.extended.entities.notificationItems,
                  [effect.itemId]: markTimerNotificationItemProcessed(item),
                },
              },
            },
          };
        }
        break;
      }
      case "OPEN_TELEGRAM_SHARE":
        break;
      case "UPSERT_SHARE_OPERATION":
        next = {
          ...next,
          extended: {
            ...next.extended,
            entities: {
              ...next.extended.entities,
              shareOperations: {
                ...next.extended.entities.shareOperations,
                [effect.operation.attemptId]: effect.operation,
              },
            },
          },
        };
        break;
      case "REQUEST_RELATIONSHIP_CONTEXT": {
        const chat = next.extended.rimChat;
        if (chat) {
          next = {
            ...next,
            extended: {
              ...next.extended,
              rimChat: {
                ...chat,
                selectedContactId: chat.selectedContactId ?? effect.contactId,
                relationshipContext: {
                  selectedContactId: effect.contactId,
                  status: "loading",
                  requestId: effect.requestId,
                  data: null,
                  failure: null,
                },
              },
            },
          };
        }
        break;
      }
      case "REQUEST_RIM_AI": {
        const chat = next.extended.rimChat;
        if (chat) {
          next = {
            ...next,
            extended: {
              ...next.extended,
              rimChat: {
                ...chat,
                aiOperation: { status: "PENDING", requestId: effect.requestId },
              },
            },
          };
        }
        break;
      }
      default:
        break;
    }
  }
  return next;
}

export function resolveSymbolicState(
  row: MatrixContractRow,
  snapshot: ProductSnapshot,
): ProductControlState | null | "RESULT_OF_NOTIFICATIONS_SELECT_NEXT" {
  if (row.nextState === "CURRENT") {
    return snapshot.controlState;
  }
  if (row.nextState === "RESULT_OF_NOTIFICATIONS_SELECT_NEXT") {
    return "RESULT_OF_NOTIFICATIONS_SELECT_NEXT";
  }
  if (row.nextState === "STATUS_PRIORITY_ITEM") {
    const id = snapshot.extended.priorities.statusItemId;
    const item = id ? snapshot.extended.entities.notificationItems[id] : null;
    if (item && item.kind === "STATUS") {
      return statusControlState(item.status, item.role);
    }
    return snapshot.controlState;
  }
  if (row.nextState === "FIFO_STATUS_ITEM") {
    const items = Object.values(snapshot.extended.entities.notificationItems)
      .filter((item) => item.lifecycle.status === "UNPROCESSED" && item.kind === "STATUS")
      .sort((a, b) => a.fifoSequence - b.fifoSequence);
    const item = items[0];
    return item && item.kind === "STATUS"
      ? statusControlState(item.status, item.role)
      : "RIM.LOBBY";
  }
  if (row.nextState === "SOURCE_STATUS_ITEM") {
    const source = snapshot.extended.replySource;
    if (source?.kind === "STATUS") {
      const item = snapshot.extended.entities.notificationItems[source.itemId];
      if (item && item.kind === "STATUS") {
        return statusControlState(item.status, item.role);
      }
    }
    return snapshot.controlState;
  }
  return row.nextState;
}

export { statusControlState };
