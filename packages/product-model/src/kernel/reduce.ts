import { CANONICAL_EVENT_DEFINITIONS, isAbsentEventId, isCanonicalEventName } from "../events.ts";
import type { CanonicalEvent, CanonicalEventId } from "../events.ts";
import type { Effect } from "../effects.ts";
import type { ProductSnapshot } from "../extended-state.ts";
import type { MatrixContractRow } from "../matrix.ts";
import { MATRIX_CONTRACT_ROWS } from "../matrix.ts";
import { isProductControlState } from "../states.ts";
import { applyEffects, resolveSymbolicState } from "./effects.ts";
import { instantiateEffects } from "./instantiate.ts";
import type { InstantiateOptions } from "./instantiate.ts";
import {
  correlatedPendingOperation,
  evaluateRowGuard,
  isLateServerResult,
} from "./evaluate-guard.ts";
import { fifoHead } from "./snapshot.ts";
import type {
  AppliedRuleTrace,
  CompositionOrder,
  ExecutionContext,
  KernelError,
  ResolveInput,
  TransitionResult,
} from "./types.ts";

const EVENT_ID_BY_NAME = Object.fromEntries(
  CANONICAL_EVENT_DEFINITIONS.map((definition) => [definition.name, definition.id]),
) as Record<string, CanonicalEventId>;

function eventIdOf(event: CanonicalEvent): CanonicalEventId | null {
  if (!isCanonicalEventName(event.name)) {
    return null;
  }
  return EVENT_ID_BY_NAME[event.name] ?? null;
}

function traceOf(row: MatrixContractRow, order: number): AppliedRuleTrace {
  return {
    identity: row.id,
    kind: row.kind,
    state: row.state,
    eventId: row.eventId,
    branch: row.branch,
    result: row.result,
    order,
  };
}

function invariant(snapshot: ProductSnapshot, error: KernelError): TransitionResult {
  return {
    outcome: "KERNEL_INVARIANT",
    result: "UNDEFINED",
    controlState: snapshot.controlState,
    snapshot,
    effects: [],
    declaredEffects: [],
    traces: [],
    composition: "UNDEFINED",
    error,
  };
}

function undefinedResult(snapshot: ProductSnapshot): TransitionResult {
  return {
    outcome: "UNDEFINED",
    result: "UNDEFINED",
    controlState: snapshot.controlState,
    snapshot,
    effects: [],
    declaredEffects: [],
    traces: [],
    composition: "UNDEFINED",
    error: null,
  };
}

function matchingRows(
  rows: readonly MatrixContractRow[],
  input: ResolveInput,
): MatrixContractRow[] {
  return rows.filter((row) => evaluateRowGuard(row, input));
}

function requireExclusive(
  rows: readonly MatrixContractRow[],
  input: ResolveInput,
  snapshot: ProductSnapshot,
): MatrixContractRow | TransitionResult | null {
  const matched = matchingRows(rows, input);
  if (matched.length === 0) {
    return null;
  }
  if (matched.length > 1) {
    return invariant(snapshot, {
      code: "MULTIPLE_BRANCHES_MATCHED",
      message: `Multiple Matrix branches matched: ${matched.map((row) => row.id).join(", ")}`,
      identities: matched.map((row) => row.id),
    });
  }
  return matched[0] ?? null;
}

function applyRow(
  row: MatrixContractRow,
  input: ResolveInput,
  snapshot: ProductSnapshot,
  order: number,
  options: InstantiateOptions = {},
):
  | {
      snapshot: ProductSnapshot;
      effects: Effect[];
      declared: MatrixContractRow["effects"];
      trace: AppliedRuleTrace;
      nextState: ReturnType<typeof resolveSymbolicState>;
    }
  | TransitionResult {
  const nextState = resolveSymbolicState(row, snapshot);
  const resolved =
    nextState === "RESULT_OF_NOTIFICATIONS_SELECT_NEXT" ? snapshot.controlState : nextState;
  const instantiated = instantiateEffects(row, { ...input, snapshot }, resolved, options);
  if (!instantiated.ok) {
    return invariant(snapshot, instantiated.error);
  }
  return {
    snapshot: applyEffects(snapshot, instantiated.effects),
    effects: instantiated.effects,
    declared: row.effects,
    trace: traceOf(row, order),
    nextState,
  };
}

function isAppliedRow(
  value: ReturnType<typeof applyRow>,
): value is Exclude<ReturnType<typeof applyRow>, TransitionResult> {
  return !("outcome" in value);
}

function bootstrapRows(eventId: CanonicalEventId): MatrixContractRow[] {
  return MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "BOOTSTRAP" && row.eventId === eventId);
}

function globalRows(eventId: CanonicalEventId, late: boolean): MatrixContractRow[] {
  return MATRIX_CONTRACT_ROWS.filter((row) => {
    if (row.kind !== "GLOBAL") {
      return false;
    }
    if (late) {
      return row.eventId === "LATE_RESULT";
    }
    return row.eventId === eventId;
  });
}

function localRows(eventId: CanonicalEventId, state: string | null): MatrixContractRow[] {
  if (!state) {
    return [];
  }
  return MATRIX_CONTRACT_ROWS.filter(
    (row) => row.kind === "LOCAL" && row.eventId === eventId && row.state === state,
  );
}

function e43Rows(): MatrixContractRow[] {
  return MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "E43");
}

function resolveE43(
  input: ResolveInput,
  snapshot: ProductSnapshot,
  order: number,
): TransitionResult {
  const selected = requireExclusive(e43Rows(), { ...input, snapshot }, snapshot);
  if (selected && "outcome" in selected) {
    return selected;
  }
  if (!selected) {
    return invariant(snapshot, {
      code: "NO_BRANCH_MATCHED",
      message: "E-43 is defined but no exclusive branch matched",
      identities: e43Rows().map((row) => row.id),
    });
  }
  const applied = applyRow(selected, { ...input, snapshot }, snapshot, order);
  if (!isAppliedRow(applied)) {
    return applied;
  }
  const head = fifoHead(applied.snapshot, input.context.currentUserId);
  let controlState = applied.nextState;
  if (controlState === "RESULT_OF_NOTIFICATIONS_SELECT_NEXT") {
    controlState = applied.snapshot.controlState;
  }
  if (selected.branch === "fifo-status" && head?.kind === "STATUS") {
    controlState = applied.nextState;
  }
  if (typeof controlState === "string" && controlState !== "RESULT_OF_NOTIFICATIONS_SELECT_NEXT") {
    if (!isProductControlState(controlState) && controlState !== null) {
      return invariant(snapshot, {
        code: "NON_CANONICAL_NEXT_STATE",
        message: `E-43 produced non-canonical next state ${String(controlState)}`,
        identities: [selected.id],
      });
    }
  }
  const withState =
    typeof applied.nextState === "string" &&
    applied.nextState !== "RESULT_OF_NOTIFICATIONS_SELECT_NEXT" &&
    isProductControlState(applied.nextState)
      ? applyEffects(applied.snapshot, [{ type: "SET_CONTROL_STATE", state: applied.nextState }])
      : applied.snapshot;
  if (withState.controlState && !isProductControlState(withState.controlState)) {
    return invariant(snapshot, {
      code: "NON_CANONICAL_NEXT_STATE",
      message: "E-43 next state is not a Product Control State",
      identities: [selected.id],
    });
  }
  return {
    outcome: "APPLIED",
    result: selected.result,
    controlState: withState.controlState,
    snapshot: withState,
    effects: applied.effects,
    declaredEffects: [...applied.declared],
    traces: [applied.trace],
    composition: "E43_ONLY",
    error: null,
  };
}

function originatingLocalRow(input: ResolveInput): MatrixContractRow | null {
  const payload = input.event.payload as {
    operationId?: string;
    resultingStatus?: string;
  };
  const pending = input.snapshot.runtime.pendingOperations;
  const op =
    correlatedPendingOperation(input) ??
    (payload.operationId ? pending[payload.operationId] : undefined) ??
    Object.values(pending).find((operation) => {
      if (input.eventId === "E-20") {
        return operation.kind === "OVERBOARD";
      }
      if (input.eventId === "E-30") {
        return operation.kind === "REPLY_BAN_SEND";
      }
      if (input.eventId === "E-10") {
        return operation.kind === "CREATE_BAN_SEND";
      }
      return false;
    });
  if (!op?.originatingState) {
    return null;
  }
  const rows = localRows(input.eventId, op.originatingState);
  if (input.eventId === "E-23") {
    const status = payload.resultingStatus;
    const branch =
      status === "BANTASTIC"
        ? "resulting-status-bantastic"
        : status === "BANFLICT"
          ? "resulting-status-banflict"
          : status === "FAIR_ENOUGH"
            ? "resulting-status-fair-enough"
            : null;
    return branch ? (rows.find((row) => row.branch === branch) ?? null) : null;
  }
  return (
    rows.find(
      (row) => row.branch === "matching-unapplied" || row.branch === "matching-first-of-pair",
    ) ?? null
  );
}

function resolveLate(input: ResolveInput, snapshot: ProductSnapshot): TransitionResult {
  const lateRow = MATRIX_CONTRACT_ROWS.find(
    (row) => row.kind === "GLOBAL" && row.eventId === "LATE_RESULT",
  );
  const originating = originatingLocalRow(input);
  if (!lateRow || !originating) {
    return invariant(snapshot, {
      code: "MISSING_REQUIRED_DATA",
      message: "Late result requires the originating Matrix row of the superseded operation",
      identities: lateRow ? [lateRow.id] : [],
    });
  }
  const applied = applyRow(originating, input, snapshot, 1, { suppressImmediateUi: true });
  if (!isAppliedRow(applied)) {
    return applied;
  }
  return {
    outcome: "APPLIED",
    result: lateRow.result,
    controlState: snapshot.controlState,
    snapshot: { ...applied.snapshot, controlState: snapshot.controlState },
    effects: applied.effects.filter(
      (effect) =>
        effect.type !== "SET_CONTROL_STATE" &&
        effect.type !== "SET_STATUS_PRIORITY" &&
        effect.type !== "SET_TIMER_PRIORITY" &&
        effect.type !== "SET_ACTIVE_NOTIFICATION",
    ),
    declaredEffects: [...lateRow.effects, ...applied.declared],
    traces: [traceOf(lateRow, 0), applied.trace],
    composition: "GLOBAL_THEN_LOCAL",
    error: null,
  };
}

export function reduce(
  snapshot: ProductSnapshot,
  event: CanonicalEvent,
  context: ExecutionContext,
): TransitionResult {
  const name = event.name as string;
  if (isAbsentEventId(name) || /^E-3[6-9]$|^E-40$/.test(name)) {
    return invariant(snapshot, {
      code: "ABSENT_EVENT",
      message: `${name} is intentionally absent and must not be executed`,
      identities: [],
    });
  }
  const eventId = eventIdOf(event);
  if (!eventId) {
    return invariant(snapshot, {
      code: "ABSENT_EVENT",
      message: `${event.name} is not a canonical Product Event`,
      identities: [],
    });
  }

  const input: ResolveInput = { snapshot, event, eventId, context };
  const late = isLateServerResult(input);

  if (eventId === "E-43") {
    return resolveE43(input, snapshot, 0);
  }

  if (late) {
    return resolveLate(input, snapshot);
  }

  if (snapshot.controlState === null) {
    const boot = requireExclusive(bootstrapRows(eventId), input, snapshot);
    if (boot && "outcome" in boot) {
      return boot;
    }
    if (boot) {
      const applied = applyRow(boot, input, snapshot, 0);
      if (!isAppliedRow(applied)) {
        return applied;
      }
      const next =
        typeof applied.nextState === "string" &&
        applied.nextState !== "RESULT_OF_NOTIFICATIONS_SELECT_NEXT" &&
        isProductControlState(applied.nextState)
          ? applyEffects(applied.snapshot, [
              { type: "SET_CONTROL_STATE", state: applied.nextState },
            ])
          : applied.snapshot;
      const bootstrapComplete =
        boot.result === "TRANSITION"
          ? {
              ...next,
              runtime: {
                ...next.runtime,
                bootstrap: { status: "COMPLETE" as const },
                ...(eventId === "E-33" ? { session: "ACTIVE" as const } : {}),
              },
            }
          : next;
      return {
        outcome: "APPLIED",
        result: boot.result,
        controlState: bootstrapComplete.controlState,
        snapshot: bootstrapComplete,
        effects: applied.effects,
        declaredEffects: [...applied.declared],
        traces: [applied.trace],
        composition: "BOOTSTRAP_ONLY",
        error: null,
      };
    }
    const global = requireExclusive(globalRows(eventId, late), input, snapshot);
    if (global && "outcome" in global) {
      return global;
    }
    if (global) {
      const applied = applyRow(global, input, snapshot, 0);
      if (!isAppliedRow(applied)) {
        return applied;
      }
      return {
        outcome: "APPLIED",
        result: global.result,
        controlState: applied.snapshot.controlState,
        snapshot: applied.snapshot,
        effects: applied.effects,
        declaredEffects: [...applied.declared],
        traces: [applied.trace],
        composition: "GLOBAL_ONLY",
        error: null,
      };
    }
    return undefinedResult(snapshot);
  }

  const globals = globalRows(eventId, false);
  const locals = localRows(eventId, snapshot.controlState);

  if (globals.length > 0 && locals.length > 0) {
    const globalSelected = requireExclusive(globals, input, snapshot);
    if (globalSelected && "outcome" in globalSelected) {
      return globalSelected;
    }
    const localSelected = requireExclusive(locals, input, snapshot);
    if (localSelected && "outcome" in localSelected) {
      return localSelected;
    }
    if (!globalSelected && !localSelected) {
      return undefinedResult(snapshot);
    }
    if (globalSelected && !localSelected && eventId !== "E-32") {
      const applied = applyRow(globalSelected, input, snapshot, 0);
      if (!isAppliedRow(applied)) {
        return applied;
      }
      return {
        outcome: "APPLIED",
        result: globalSelected.result,
        controlState: applied.snapshot.controlState,
        snapshot: applied.snapshot,
        effects: applied.effects,
        declaredEffects: [...applied.declared],
        traces: [applied.trace],
        composition: "GLOBAL_ONLY",
        error: null,
      };
    }
    if (!globalSelected && localSelected) {
      return finishLocal(localSelected, input, snapshot, "LOCAL_ONLY");
    }
    if (globalSelected && localSelected) {
      const globalApplied = applyRow(globalSelected, input, snapshot, 0);
      if (!isAppliedRow(globalApplied)) {
        return globalApplied;
      }
      const localApplied = applyRow(
        localSelected,
        { ...input, snapshot: globalApplied.snapshot },
        globalApplied.snapshot,
        1,
      );
      if (!isAppliedRow(localApplied)) {
        return localApplied;
      }
      let nextSnapshot = localApplied.snapshot;
      let traces = [globalApplied.trace, localApplied.trace];
      let effects = [...globalApplied.effects, ...localApplied.effects];
      let declared = [...globalApplied.declared, ...localApplied.declared];
      let composition: CompositionOrder = "GLOBAL_THEN_LOCAL";
      if (localApplied.nextState === "RESULT_OF_NOTIFICATIONS_SELECT_NEXT") {
        const e43 = resolveE43(
          {
            ...input,
            snapshot: nextSnapshot,
            event: { name: "NOTIFICATIONS.SELECT_NEXT", payload: {} },
          },
          nextSnapshot,
          2,
        );
        if (e43.outcome !== "APPLIED") {
          return e43;
        }
        nextSnapshot = e43.snapshot;
        traces = [...traces, ...e43.traces];
        effects = [...effects, ...e43.effects];
        declared = [...declared, ...e43.declaredEffects];
        composition = "LOCAL_THEN_E43";
      } else if (
        typeof localApplied.nextState === "string" &&
        isProductControlState(localApplied.nextState)
      ) {
        nextSnapshot = applyEffects(nextSnapshot, [
          { type: "SET_CONTROL_STATE", state: localApplied.nextState },
        ]);
      }
      if (nextSnapshot.controlState && !isProductControlState(nextSnapshot.controlState)) {
        return invariant(snapshot, {
          code: "NON_CANONICAL_NEXT_STATE",
          message: String(nextSnapshot.controlState),
          identities: traces.map((trace) => trace.identity),
        });
      }
      return {
        outcome: "APPLIED",
        result: localSelected.result,
        controlState: nextSnapshot.controlState,
        snapshot: nextSnapshot,
        effects,
        declaredEffects: declared,
        traces,
        composition,
        error: null,
      };
    }
  }

  if (globals.length > 0) {
    const selected = requireExclusive(globals, input, snapshot);
    if (selected && "outcome" in selected) {
      return selected;
    }
    if (!selected) {
      return locals.length > 0 ? missingLocal(locals, snapshot) : undefinedResult(snapshot);
    }
    const applied = applyRow(selected, input, snapshot, 0);
    if (!isAppliedRow(applied)) {
      return applied;
    }
    return {
      outcome: "APPLIED",
      result: selected.result,
      controlState: applied.snapshot.controlState,
      snapshot: applied.snapshot,
      effects: applied.effects,
      declaredEffects: [...applied.declared],
      traces: [applied.trace],
      composition: "GLOBAL_ONLY",
      error: null,
    };
  }

  if (locals.length > 0) {
    const selected = requireExclusive(locals, input, snapshot);
    if (selected && "outcome" in selected) {
      return selected;
    }
    if (!selected) {
      return missingLocal(locals, snapshot);
    }
    return finishLocal(selected, input, snapshot, "LOCAL_ONLY");
  }

  return undefinedResult(snapshot);
}

function missingLocal(
  locals: readonly MatrixContractRow[],
  snapshot: ProductSnapshot,
): TransitionResult {
  return invariant(snapshot, {
    code: "NO_BRANCH_MATCHED",
    message: `Defined local event had no matching branch among ${locals.map((row) => row.id).join(", ")}`,
    identities: locals.map((row) => row.id),
  });
}

function finishLocal(
  selected: MatrixContractRow,
  input: ResolveInput,
  snapshot: ProductSnapshot,
  composition: CompositionOrder,
): TransitionResult {
  const applied = applyRow(selected, input, snapshot, 0);
  if (!isAppliedRow(applied)) {
    return applied;
  }
  if (applied.nextState === "RESULT_OF_NOTIFICATIONS_SELECT_NEXT") {
    const e43 = resolveE43(
      {
        ...input,
        snapshot: applied.snapshot,
        event: { name: "NOTIFICATIONS.SELECT_NEXT", payload: {} },
        eventId: "E-43",
      },
      applied.snapshot,
      1,
    );
    if (e43.outcome !== "APPLIED") {
      return e43;
    }
    return {
      outcome: "APPLIED",
      result: e43.result,
      controlState: e43.controlState,
      snapshot: e43.snapshot,
      effects: [...applied.effects, ...e43.effects],
      declaredEffects: [...applied.declared, ...e43.declaredEffects],
      traces: [applied.trace, ...e43.traces],
      composition: "LOCAL_THEN_E43",
      error: null,
    };
  }
  let nextSnapshot = applied.snapshot;
  if (typeof applied.nextState === "string" && isProductControlState(applied.nextState)) {
    nextSnapshot = applyEffects(nextSnapshot, [
      { type: "SET_CONTROL_STATE", state: applied.nextState },
    ]);
  }
  if (nextSnapshot.controlState && !isProductControlState(nextSnapshot.controlState)) {
    return invariant(snapshot, {
      code: "NON_CANONICAL_NEXT_STATE",
      message: String(nextSnapshot.controlState),
      identities: [selected.id],
    });
  }
  return {
    outcome: "APPLIED",
    result: selected.result,
    controlState: nextSnapshot.controlState,
    snapshot: nextSnapshot,
    effects: applied.effects,
    declaredEffects: [...applied.declared],
    traces: [applied.trace],
    composition,
    error: null,
  };
}
