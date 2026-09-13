import { describe, expect, it } from "vitest";
import { contactPartnerIdsFromBans, isQualifyingAuthoritativeBan } from "./contacts.ts";
import type { UserId } from "./ids.ts";

const A = "user-a" as UserId;
const B = "user-b" as UserId;
const C = "user-c" as UserId;

describe("MVP8 Contact derivation", () => {
  it("returns empty when no bans or only unbound Template bans", () => {
    expect(contactPartnerIdsFromBans([], A)).toEqual([]);
    expect(contactPartnerIdsFromBans([{ senderId: A, receiverId: null }], A)).toEqual([]);
  });

  it("establishes symmetric partners from one authoritative Ban", () => {
    const bans = [{ senderId: A, receiverId: B }];
    expect(contactPartnerIdsFromBans(bans, A)).toEqual([B]);
    expect(contactPartnerIdsFromBans(bans, B)).toEqual([A]);
  });

  it("does not duplicate partners across repeated or reverse bans", () => {
    const bans = [
      { senderId: A, receiverId: B },
      { senderId: A, receiverId: B },
      { senderId: B, receiverId: A },
      { senderId: A, receiverId: C },
    ];
    expect(contactPartnerIdsFromBans(bans, A)).toEqual([B, C]);
    expect(contactPartnerIdsFromBans(bans, B)).toEqual([A]);
  });

  it("excludes self and non-qualifying self bans", () => {
    expect(isQualifyingAuthoritativeBan({ senderId: A, receiverId: A })).toBe(false);
    expect(contactPartnerIdsFromBans([{ senderId: A, receiverId: A }], A)).toEqual([]);
  });
});
