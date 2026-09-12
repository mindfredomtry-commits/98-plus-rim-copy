import { describe, expect, it } from "vitest";
import {
  everyEventHasReferenceMetadata,
  everyStateHasReferenceMetadata,
  isRejectedEventId,
} from "./index.ts";

describe("testkit contract helpers", () => {
  it("reports complete authority metadata", () => {
    expect(everyStateHasReferenceMetadata()).toBe(true);
    expect(everyEventHasReferenceMetadata()).toBe(true);
  });

  it("rejects the unused Event IDs", () => {
    expect(isRejectedEventId("E-36")).toBe(true);
    expect(isRejectedEventId("E-01")).toBe(false);
  });
});
