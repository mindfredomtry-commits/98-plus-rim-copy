import { CREATE_BAN_MATRIX_ROWS } from "./matrix/create-ban.ts";
import { E43_ROWS, GLOBAL_AND_BOOTSTRAP_ROWS } from "./matrix/global.ts";
import { NOTIFICATIONS_MATRIX_ROWS } from "./matrix/notifications.ts";
import { REPLY_BAN_MATRIX_ROWS } from "./matrix/reply-ban.ts";
import { RIM_MATRIX_ROWS } from "./matrix/rim.ts";
import type { MatrixContractRow } from "./matrix/types.ts";
import { isCanonicalEventId } from "./events.ts";
import {
  isProductControlState,
  PRODUCT_CONTROL_STATES,
  type ProductControlState,
} from "./states.ts";

export type {
  MatrixContractRow,
  MatrixNextState,
  MatrixRowKind,
  MatrixScope,
  MatrixSource,
} from "./matrix/types.ts";
export { E43_ROWS, GLOBAL_AND_BOOTSTRAP_ROWS } from "./matrix/global.ts";
export { RIM_MATRIX_ROWS } from "./matrix/rim.ts";
export { CREATE_BAN_MATRIX_ROWS } from "./matrix/create-ban.ts";
export { NOTIFICATIONS_MATRIX_ROWS } from "./matrix/notifications.ts";
export { REPLY_BAN_MATRIX_ROWS } from "./matrix/reply-ban.ts";

export const MATRIX_CONTRACT_ROWS: readonly MatrixContractRow[] = [
  ...GLOBAL_AND_BOOTSTRAP_ROWS,
  ...E43_ROWS,
  ...RIM_MATRIX_ROWS,
  ...CREATE_BAN_MATRIX_ROWS,
  ...NOTIFICATIONS_MATRIX_ROWS,
  ...REPLY_BAN_MATRIX_ROWS,
];

export const MATRIX_SPEC_GAP_COUNT = 0;

export const MATRIX_GLOBAL_RULE_COUNT = GLOBAL_AND_BOOTSTRAP_ROWS.filter(
  (row) => row.kind === "GLOBAL",
).length;

export const MATRIX_BOOTSTRAP_RULE_COUNT = GLOBAL_AND_BOOTSTRAP_ROWS.filter(
  (row) => row.kind === "BOOTSTRAP",
).length;

export const MATRIX_E43_RULE_COUNT = E43_ROWS.length;

export function matrixRowIdentity(row: MatrixContractRow): string {
  return row.id;
}

export function countMatrixRowsByProductControlState(
  rows: readonly MatrixContractRow[] = MATRIX_CONTRACT_ROWS,
): Readonly<Record<ProductControlState, number>> {
  const counts = Object.fromEntries(PRODUCT_CONTROL_STATES.map((state) => [state, 0])) as Record<
    ProductControlState,
    number
  >;
  for (const row of rows) {
    if (row.kind === "LOCAL" && isProductControlState(row.state)) {
      counts[row.state] += 1;
    }
  }
  return counts;
}

const SYMBOLIC_NEXT_STATES = new Set([
  "CURRENT",
  "RESULT_OF_NOTIFICATIONS_SELECT_NEXT",
  "STATUS_PRIORITY_ITEM",
  "FIFO_STATUS_ITEM",
  "SOURCE_STATUS_ITEM",
  "ASK_RIM_ORIGIN_STATUS",
]);

export function isValidMatrixNextState(nextState: MatrixContractRow["nextState"]): boolean {
  if (nextState === null) {
    return true;
  }
  if (SYMBOLIC_NEXT_STATES.has(nextState)) {
    return true;
  }
  return isProductControlState(nextState);
}

export function isAuthoritativeEventReference(eventId: MatrixContractRow["eventId"]): boolean {
  return eventId === "LATE_RESULT" || isCanonicalEventId(eventId);
}
