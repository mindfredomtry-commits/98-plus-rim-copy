import type { CanonicalEventId, CanonicalEventName } from "../events.ts";
import type { Guard } from "../guards.ts";
import type {
  MatrixContractRow,
  MatrixEffectDeclaration,
  MatrixNextState,
  MatrixRowKind,
  MatrixScope,
  MatrixSource,
} from "./types.ts";

export function matrixRow(input: {
  kind: MatrixRowKind;
  state: MatrixScope;
  eventId: CanonicalEventId | "LATE_RESULT";
  eventName: CanonicalEventName | "LATE_RESULT";
  branch: string;
  guardsText: string;
  guards?: Guard;
  nextStateText: string;
  nextState: MatrixNextState;
  effectsText: string;
  effects?: readonly MatrixEffectDeclaration[];
  result: MatrixContractRow["result"];
  source: Omit<MatrixSource, "document">;
  appliesToEventIds?: readonly CanonicalEventId[];
}): MatrixContractRow {
  return {
    id: `${input.kind}:${input.state}:${input.eventId}:${input.branch}`,
    kind: input.kind,
    state: input.state,
    eventId: input.eventId,
    eventName: input.eventName,
    ...(input.appliesToEventIds ? { appliesToEventIds: input.appliesToEventIds } : {}),
    branch: input.branch,
    guardsText: input.guardsText,
    guards: input.guards ?? { type: "SOURCE_TEXT", text: input.guardsText },
    nextStateText: input.nextStateText,
    nextState: input.nextState,
    effectsText: input.effectsText,
    effects: input.effects ?? [],
    result: input.result,
    source: {
      document: "MVP9_STATE_EVENT_MATRIX",
      ...input.source,
    },
  };
}
