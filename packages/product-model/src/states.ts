import type { AuthorityReference, ReferencedDefinition } from "./authority.ts";
import { AUTHORITY_DOCUMENTS } from "./authority.ts";
import type { BanStatus, Role } from "./primitives.ts";

const stateRegistry = AUTHORITY_DOCUMENTS.stateRegistry;
const matrix = AUTHORITY_DOCUMENTS.matrix;

function refs(
  locator: string,
  extras: readonly AuthorityReference[] = [],
): readonly [AuthorityReference, ...AuthorityReference[]] {
  return [
    { document: stateRegistry, locator },
    { document: matrix, locator: "all-30-states" },
    ...extras,
  ];
}

export type ProductSection = "RIM" | "CREATE_BAN" | "NOTIFICATIONS" | "REPLY_BAN";

export type ProductControlState =
  | "RIM.LOBBY"
  | "RIM.CHAT"
  | "RIM.SELECT_CONTACT"
  | "CREATE_BAN.WHO"
  | "CREATE_BAN.WHAT.CONTACT"
  | "CREATE_BAN.WHAT.TEMPLATE"
  | "CREATE_BAN.WHAT.RIM"
  | "CREATE_BAN.CONFIRM.CONTACT"
  | "CREATE_BAN.CONFIRM.TEMPLATE"
  | "CREATE_BAN.CONFIRM.RIM"
  | "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING"
  | "CREATE_BAN.SUCCESS"
  | "NOTIFICATIONS.INCOMING_BAN"
  | "NOTIFICATIONS.TIMER"
  | "NOTIFICATIONS.CHECK.RECEIVER"
  | "NOTIFICATIONS.CHECK.SENDER"
  | `NOTIFICATIONS.STATUS.${BanStatus}.${Role}`
  | "REPLY_BAN.WHAT.FROM_INCOMING_BAN"
  | "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN"
  | "REPLY_BAN.SUCCESS.FROM_INCOMING_BAN"
  | "REPLY_BAN.WHAT.FROM_STATUS"
  | "REPLY_BAN.CONFIRM.FROM_STATUS"
  | "REPLY_BAN.SUCCESS.FROM_STATUS";

export type ProductControlStateId =
  | "RIM-01"
  | "RIM-02"
  | "RIM-03"
  | "CB-01"
  | "CB-02"
  | "CB-03"
  | "CB-05"
  | "CB-06"
  | "CB-07"
  | "CB-08"
  | "CB-09"
  | "CB-10"
  | "N-01"
  | "N-02"
  | "N-03"
  | "N-04"
  | "N-05"
  | "N-06"
  | "N-07"
  | "N-08"
  | "N-09"
  | "N-10"
  | "N-11"
  | "N-12"
  | "RB-01"
  | "RB-02"
  | "RB-03"
  | "RB-04"
  | "RB-05"
  | "RB-06";

export type ProductControlStateDefinition = ReferencedDefinition &
  Readonly<{
    id: ProductControlStateId;
    state: ProductControlState;
    section: ProductSection;
  }>;

export const PRODUCT_CONTROL_STATE_DEFINITIONS = [
  { id: "RIM-01", state: "RIM.LOBBY", section: "RIM", references: refs("RIM-01 RIM.LOBBY") },
  { id: "RIM-02", state: "RIM.CHAT", section: "RIM", references: refs("RIM-02 RIM.CHAT") },
  {
    id: "RIM-03",
    state: "RIM.SELECT_CONTACT",
    section: "RIM",
    references: refs("RIM-03 RIM.SELECT_CONTACT"),
  },
  {
    id: "CB-01",
    state: "CREATE_BAN.WHO",
    section: "CREATE_BAN",
    references: refs("CB-01 CREATE_BAN.WHO"),
  },
  {
    id: "CB-02",
    state: "CREATE_BAN.WHAT.CONTACT",
    section: "CREATE_BAN",
    references: refs("CB-02 CREATE_BAN.WHAT.CONTACT"),
  },
  {
    id: "CB-03",
    state: "CREATE_BAN.WHAT.TEMPLATE",
    section: "CREATE_BAN",
    references: refs("CB-03 CREATE_BAN.WHAT.TEMPLATE"),
  },
  {
    id: "CB-05",
    state: "CREATE_BAN.WHAT.RIM",
    section: "CREATE_BAN",
    references: refs("CB-05 CREATE_BAN.WHAT.RIM"),
  },
  {
    id: "CB-06",
    state: "CREATE_BAN.CONFIRM.CONTACT",
    section: "CREATE_BAN",
    references: refs("CB-06 CREATE_BAN.CONFIRM.CONTACT"),
  },
  {
    id: "CB-07",
    state: "CREATE_BAN.CONFIRM.TEMPLATE",
    section: "CREATE_BAN",
    references: refs("CB-07 CREATE_BAN.CONFIRM.TEMPLATE"),
  },
  {
    id: "CB-08",
    state: "CREATE_BAN.CONFIRM.RIM",
    section: "CREATE_BAN",
    references: refs("CB-08 CREATE_BAN.CONFIRM.RIM"),
  },
  {
    id: "CB-09",
    state: "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING",
    section: "CREATE_BAN",
    references: refs("CB-09 CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING"),
  },
  {
    id: "CB-10",
    state: "CREATE_BAN.SUCCESS",
    section: "CREATE_BAN",
    references: refs("CB-10 CREATE_BAN.SUCCESS"),
  },
  {
    id: "N-01",
    state: "NOTIFICATIONS.INCOMING_BAN",
    section: "NOTIFICATIONS",
    references: refs("N-01 NOTIFICATIONS.INCOMING_BAN"),
  },
  {
    id: "N-02",
    state: "NOTIFICATIONS.TIMER",
    section: "NOTIFICATIONS",
    references: refs("N-02 NOTIFICATIONS.TIMER"),
  },
  {
    id: "N-03",
    state: "NOTIFICATIONS.CHECK.RECEIVER",
    section: "NOTIFICATIONS",
    references: refs("N-03 NOTIFICATIONS.CHECK.RECEIVER"),
  },
  {
    id: "N-04",
    state: "NOTIFICATIONS.CHECK.SENDER",
    section: "NOTIFICATIONS",
    references: refs("N-04 NOTIFICATIONS.CHECK.SENDER"),
  },
  {
    id: "N-05",
    state: "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER",
    section: "NOTIFICATIONS",
    references: refs("N-05 NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"),
  },
  {
    id: "N-06",
    state: "NOTIFICATIONS.STATUS.OVERBOARD.SENDER",
    section: "NOTIFICATIONS",
    references: refs("N-06 NOTIFICATIONS.STATUS.OVERBOARD.SENDER"),
  },
  {
    id: "N-07",
    state: "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER",
    section: "NOTIFICATIONS",
    references: refs("N-07 NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER"),
  },
  {
    id: "N-08",
    state: "NOTIFICATIONS.STATUS.BANTASTIC.SENDER",
    section: "NOTIFICATIONS",
    references: refs("N-08 NOTIFICATIONS.STATUS.BANTASTIC.SENDER"),
  },
  {
    id: "N-09",
    state: "NOTIFICATIONS.STATUS.BANFLICT.RECEIVER",
    section: "NOTIFICATIONS",
    references: refs("N-09 NOTIFICATIONS.STATUS.BANFLICT.RECEIVER"),
  },
  {
    id: "N-10",
    state: "NOTIFICATIONS.STATUS.BANFLICT.SENDER",
    section: "NOTIFICATIONS",
    references: refs("N-10 NOTIFICATIONS.STATUS.BANFLICT.SENDER"),
  },
  {
    id: "N-11",
    state: "NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER",
    section: "NOTIFICATIONS",
    references: refs("N-11 NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER"),
  },
  {
    id: "N-12",
    state: "NOTIFICATIONS.STATUS.FAIR_ENOUGH.SENDER",
    section: "NOTIFICATIONS",
    references: refs("N-12 NOTIFICATIONS.STATUS.FAIR_ENOUGH.SENDER"),
  },
  {
    id: "RB-01",
    state: "REPLY_BAN.WHAT.FROM_INCOMING_BAN",
    section: "REPLY_BAN",
    references: refs("RB-01 REPLY_BAN.WHAT.FROM_INCOMING_BAN"),
  },
  {
    id: "RB-02",
    state: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
    section: "REPLY_BAN",
    references: refs("RB-02 REPLY_BAN.CONFIRM.FROM_INCOMING_BAN"),
  },
  {
    id: "RB-03",
    state: "REPLY_BAN.SUCCESS.FROM_INCOMING_BAN",
    section: "REPLY_BAN",
    references: refs("RB-03 REPLY_BAN.SUCCESS.FROM_INCOMING_BAN"),
  },
  {
    id: "RB-04",
    state: "REPLY_BAN.WHAT.FROM_STATUS",
    section: "REPLY_BAN",
    references: refs("RB-04 REPLY_BAN.WHAT.FROM_STATUS"),
  },
  {
    id: "RB-05",
    state: "REPLY_BAN.CONFIRM.FROM_STATUS",
    section: "REPLY_BAN",
    references: refs("RB-05 REPLY_BAN.CONFIRM.FROM_STATUS"),
  },
  {
    id: "RB-06",
    state: "REPLY_BAN.SUCCESS.FROM_STATUS",
    section: "REPLY_BAN",
    references: refs("RB-06 REPLY_BAN.SUCCESS.FROM_STATUS"),
  },
] as const satisfies readonly ProductControlStateDefinition[];

export const PRODUCT_CONTROL_STATES = PRODUCT_CONTROL_STATE_DEFINITIONS.map(
  (definition) => definition.state,
) as unknown as readonly ProductControlState[];

export const PRODUCT_CONTROL_STATE_IDS = PRODUCT_CONTROL_STATE_DEFINITIONS.map(
  (definition) => definition.id,
) as unknown as readonly ProductControlStateId[];

export const PRODUCT_CONTROL_STATE_COUNT = 30;
export const ABSENT_CREATE_BAN_STATE_ID = "CB-04";

export type ProductControlStateCount = typeof PRODUCT_CONTROL_STATE_DEFINITIONS.length;

export function isProductControlState(value: string): value is ProductControlState {
  return PRODUCT_CONTROL_STATE_DEFINITIONS.some((definition) => definition.state === value);
}
