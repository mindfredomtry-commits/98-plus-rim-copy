import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.ts";

describe("canonicalJson", () => {
  it("sorts object keys, preserves array order, and keeps null", () => {
    expect(canonicalJson({ z: 1, a: { d: true, b: null }, m: [3, 1] })).toBe(
      '{"a":{"b":null,"d":true},"m":[3,1],"z":1}',
    );
    expect(canonicalJson({ origin: null })).toBe('{"origin":null}');
  });

  it("emits the same text for the same values regardless of key insertion order", () => {
    const first = {
      relationshipContext: {
        recentBans: [{ banText: "первый", direction: "USER_TO_CONTACT" }],
        aggregates: { userToContact: { bansSentCount: 1 }, contactToUser: { bansSentCount: 0 } },
      },
    };
    const reversed = {
      relationshipContext: {
        aggregates: { contactToUser: { bansSentCount: 0 }, userToContact: { bansSentCount: 1 } },
        recentBans: [{ direction: "USER_TO_CONTACT", banText: "первый" }],
      },
    };
    expect(canonicalJson(reversed)).toBe(canonicalJson(first));
    expect(canonicalJson(first).indexOf("первый")).toBeGreaterThan(0);
  });
});
