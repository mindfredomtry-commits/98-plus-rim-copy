import { describe, expect, it } from "vitest";
import type { RelationshipContextSource } from "@98plus/persistence";
import type { BanId, UserId } from "@98plus/product-model";
import { buildRelationshipContextData } from "./relationship-context.ts";

const USER = "user" as UserId;
const CONTACT = "contact" as UserId;

function source(
  seq: number,
  sender: UserId,
  overrides: Partial<RelationshipContextSource> = {},
): RelationshipContextSource {
  return {
    banId: `ban-${seq}` as BanId,
    senderId: sender,
    receiverId: sender === USER ? CONTACT : USER,
    banText: `ban ${seq}`,
    acceptance: "PENDING",
    status: null,
    createdSeq: seq,
    createdAtMs: seq * 3_600_000,
    timerStartedAtMs: null,
    timerState: null,
    checkPairCreated: false,
    receiverAnswer: null,
    senderAnswer: null,
    resultingStatus: null,
    ...overrides,
  };
}

describe("RelationshipContext builder", () => {
  it("counts both directions, including unresolved bans, and keeps the last 10 chronological", () => {
    const sources = [
      source(1, USER, {
        status: "BANTASTIC",
        resultingStatus: "BANTASTIC",
        acceptance: "ACCEPTED",
      }),
      source(2, CONTACT, { acceptance: "PENDING" }),
      ...Array.from({ length: 10 }, (_, index) =>
        source(index + 3, USER, { acceptance: "ACCEPTED" }),
      ),
    ];
    const data = buildRelationshipContextData({
      currentUserId: USER,
      sources,
      nowMs: 20 * 3_600_000,
    });
    expect(data.aggregates.userToContact.bansSentCount).toBe(11);
    expect(data.aggregates.contactToUser.bansSentCount).toBe(1);
    expect(data.aggregates.userToContact.statusCounts.bantastic).toBe(1);
    expect(data.aggregates.contactToUser.statusCounts).toEqual({
      bantastic: 0,
      banflict: 0,
      fairEnough: 0,
      overboard: 0,
    });
    expect(data.recentBans).toHaveLength(10);
    expect(data.recentBans.map((ban) => ban.banText)).toEqual(
      Array.from({ length: 10 }, (_, index) => `ban ${index + 3}`),
    );
    expect(data.recentBans[0]?.ageHours).toBeGreaterThanOrEqual(0);
    expect(data.recentBans[0]?.result.kind).toBe("ACTIVE");
    expect(data.recentBans.every((ban) => ban.ageHours >= 0)).toBe(true);
  });

  it("maps check answers USER-relative and keeps completed final status", () => {
    const data = buildRelationshipContextData({
      currentUserId: USER,
      nowMs: 10 * 3_600_000,
      sources: [
        source(1, USER, {
          acceptance: "ACCEPTED",
          status: "BANFLICT",
          checkPairCreated: true,
          senderAnswer: "FULFILLED",
          receiverAnswer: "NOT_FULFILLED",
          resultingStatus: "BANFLICT",
        }),
        source(2, CONTACT, { status: "OVERBOARD", acceptance: "PENDING" }),
      ],
    });
    expect(data.recentBans[0]?.result).toEqual({
      kind: "CHECK_COMPLETED",
      userAnswer: "FULFILLED",
      contactAnswer: "NOT_FULFILLED",
      status: "BANFLICT",
    });
    expect(data.recentBans[1]?.direction).toBe("CONTACT_TO_USER");
    expect(data.recentBans[1]?.result).toEqual({ kind: "OVERBOARD" });
    expect(data.aggregates.userToContact.statusCounts.banflict).toBe(1);
    expect(data.aggregates.contactToUser.statusCounts.overboard).toBe(1);
  });

  it("maps a CONTACT_TO_USER ban so the current user's answer stays userAnswer", () => {
    const data = buildRelationshipContextData({
      currentUserId: USER,
      nowMs: 4 * 3_600_000,
      sources: [
        source(1, CONTACT, {
          senderAnswer: "NOT_FULFILLED",
          receiverAnswer: "FULFILLED",
        }),
      ],
    });
    expect(data.recentBans[0]?.direction).toBe("CONTACT_TO_USER");
    expect(data.recentBans[0]?.result).toEqual({
      kind: "CHECK_PENDING",
      userAnswer: "FULFILLED",
      contactAnswer: "NOT_FULFILLED",
    });
  });
});
