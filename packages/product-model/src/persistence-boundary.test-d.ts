import type {
  Ban,
  BanAcceptance,
  BanDraft,
  BanStatus,
  EventPayloadMap,
  NotificationItem,
  RimChat,
  ShareOperationStatus,
  UserId,
} from "./index.ts";

type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type BanAcceptanceIsPendingOrAccepted = Assert<
  Equals<BanAcceptance, "PENDING" | "ACCEPTED">
>;
export type OverboardIsBanStatusNotAcceptance = Assert<
  "OVERBOARD" extends BanStatus ? ("OVERBOARD" extends BanAcceptance ? false : true) : false
>;
export type BanReceiverIsUserIdOrNull = Assert<
  Ban["receiverId"] extends UserId | null ? true : false
>;
export type SelectedContactIsUserId = Assert<
  BanDraft["selectedContactId"] extends UserId | null ? true : false
>;
export type RimSelectedContactIsUserId = Assert<Equals<RimChat["selectedContactId"], UserId>>;
export type E02ContactPayloadIsUserId = Assert<
  EventPayloadMap["CREATE_BAN.SELECT_CONTACT"]["contactId"] extends UserId ? true : false
>;
export type E49ContactPayloadIsUserId = Assert<
  EventPayloadMap["RIM.SELECT_CONTACT"]["contactId"] extends UserId ? true : false
>;
export type NotificationOwnerIsTypedUserId = Assert<
  NotificationItem["ownerId"] extends UserId ? true : false
>;
export type ShareInvalidatedRemainsOnContract = Assert<
  Extract<ShareOperationStatus, "INVALIDATED"> extends "INVALIDATED" ? true : false
>;

export function rejectOverboardAcceptance(): BanAcceptance {
  // @ts-expect-error OVERBOARD is Ban.status, not Ban.acceptance.
  const acceptance: BanAcceptance = "OVERBOARD";
  return acceptance;
}

export function rejectNullRimSelectedContact(): RimChat["selectedContactId"] {
  // @ts-expect-error a domain RimChat requires a CONTACT from birth.
  const selectedContactId: RimChat["selectedContactId"] = null;
  return selectedContactId;
}

export function rejectRemovedContactIdBrand(): void {
  // @ts-expect-error ContactId is not a separate identity brand; selected contact is UserId.
  const id: import("./ids.ts").ContactId = "x";
  void id;
}
