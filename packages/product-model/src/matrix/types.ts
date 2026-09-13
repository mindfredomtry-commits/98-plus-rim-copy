import type { CanonicalEventId, CanonicalEventName } from "../events.ts";
import type { EffectType } from "../effects.ts";
import type { Guard, MatrixResult } from "../guards.ts";
import type { ProductControlState } from "../states.ts";

export type MatrixRowKind = "GLOBAL" | "BOOTSTRAP" | "E43" | "LOCAL";

export type MatrixScope = "GLOBAL" | "BOOTSTRAP" | "E43" | ProductControlState;

export type MatrixNextState =
  | ProductControlState
  | "CURRENT"
  | "RESULT_OF_NOTIFICATIONS_SELECT_NEXT"
  | "STATUS_PRIORITY_ITEM"
  | "FIFO_STATUS_ITEM"
  | "SOURCE_STATUS_ITEM"
  | null;

export type MatrixEffectDeclaration = Readonly<{
  type: EffectType;
  appliesWhen?: string;
}>;

export type MatrixSource = Readonly<{
  document: "MVP8_STATE_EVENT_MATRIX";
  section: string;
  locator: string;
  extractedLines: string;
}>;

export type MatrixContractRow = Readonly<{
  id: string;
  kind: MatrixRowKind;
  state: MatrixScope;
  eventId: CanonicalEventId | "LATE_RESULT";
  eventName: CanonicalEventName | "LATE_RESULT";
  appliesToEventIds?: readonly CanonicalEventId[];
  branch: string;
  guardsText: string;
  guards: Guard;
  nextStateText: string;
  nextState: MatrixNextState;
  effectsText: string;
  effects: readonly MatrixEffectDeclaration[];
  result: Exclude<MatrixResult, "SPEC_GAP">;
  source: MatrixSource;
}>;
