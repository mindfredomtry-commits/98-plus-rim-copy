import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  PRODUCT_CONTROL_STATE_COUNT,
} from "./index.ts";

describe("shared contracts package", () => {
  it("re-exports the closed Stage 1 counts", () => {
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(55);
  });
});
