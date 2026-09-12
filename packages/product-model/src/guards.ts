import type { CanonicalEventName } from "./events.ts";
import type { PendingOperationKind } from "./extended-state.ts";
import type { NotificationItemId, OperationId } from "./ids.ts";
import type { NotificationItem } from "./entities.ts";

export type Guard =
  | { type: "ALWAYS" }
  | { type: "BAN_DRAFT_VALID"; draft: "CREATE" | "REPLY" }
  | { type: "NO_PENDING_OPERATION"; kind: PendingOperationKind }
  | {
      type: "MATCHING_OPERATION";
      operationId: OperationId;
      resultApplied: boolean;
    }
  | { type: "ACTIVE_ITEM"; itemId: NotificationItemId }
  | {
      type: "ITEM_KIND";
      itemId: NotificationItemId;
      kind: NotificationItem["kind"];
    }
  | { type: "ITEM_UNPROCESSED"; itemId: NotificationItemId }
  | { type: "HAS_UNPROCESSED_ITEMS" }
  | { type: "QUEUE_EMPTY" }
  | { type: "STATUS_PRIORITY_APPLICABLE" }
  | { type: "TIMER_PRIORITY_APPLICABLE" }
  | { type: "NO_APPLICABLE_PRIORITY" }
  | { type: "PENDING_EXTERNAL_ENTRY_EXISTS" }
  | { type: "PENDING_EXTERNAL_ENTRY_TTL_EXPIRED" }
  | { type: "EXTERNAL_ENTRY_GUARD_A" }
  | { type: "EXTERNAL_ENTRY_GUARD_B" }
  | { type: "CURRENT_RIM_REQUEST"; request: "CONTEXT" | "AI" }
  | { type: "SELECTED_CONTACT_ABSENT" }
  | { type: "SELECTED_CONTACT_IS_DIFFERENT" }
  | { type: "SELECTED_CONTACT_IS_UNCHANGED" }
  | { type: "RIM_INPUT_NON_WHITESPACE" }
  | { type: "RELATIONSHIP_CONTEXT_READY" }
  | { type: "NO_ACTIVE_AI_REQUEST" }
  | { type: "UNPROCESSED_TIMER_NOTIFICATION_ITEM_EXISTS" }
  | { type: "CONNECTION_OFFLINE" }
  | { type: "SOURCE_TEXT"; text: string }
  | { type: "NOT"; guard: Guard }
  | { type: "ALL"; guards: readonly Guard[] }
  | { type: "ANY"; guards: readonly Guard[] };

export type MatrixResult =
  "TRANSITION" | "STAY" | "IGNORE_NOT_ALLOWED" | "SESSION_END" | "SPEC_GAP";

export type MatrixStateRef =
  "GLOBAL" | "BOOTSTRAP" | "ALL_STATES" | "E43" | import("./states.ts").ProductControlState;

export type MatrixReference = Readonly<{
  document: "MVP7_STATE_EVENT_MATRIX";
  state: MatrixStateRef;
  event: CanonicalEventName;
  branch?: string;
  locator: string;
}>;

export type MatrixNextState =
  | import("./states.ts").ProductControlState
  | "CURRENT"
  | "RESULT_OF_NOTIFICATIONS_SELECT_NEXT"
  | "STATUS_PRIORITY_ITEM"
  | "FIFO_STATUS_ITEM"
  | "SOURCE_STATUS_ITEM"
  | null;

export type MatrixEffectDeclaration = Readonly<{
  type: import("./effects.ts").EffectType;
  appliesWhen?: string;
}>;
