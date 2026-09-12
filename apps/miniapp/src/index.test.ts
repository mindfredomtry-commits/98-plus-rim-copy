import { describe, expect, it } from "vitest";
import {
  MINIAPP_STAGE,
  MINIAPP_STAGE_1_EXCLUDES,
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  TEST_UI_ONLY,
  TIMER_CHECK_STATUS_STAGE,
} from "./index.ts";

describe("miniapp TEST UI Stage 6 Create Ban CONTACT", () => {
  it("keeps the frozen Kernel stage marker and adds the Create Ban CONTACT vertical marker", () => {
    expect(MINIAPP_STAGE).toBe(2);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(INCOMING_OVERBOARD_STAGE).toBe(7);
    expect(REPLY_BAN_FROM_INCOMING_STAGE).toBe(8);
    expect(TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(TEST_UI_ONLY).toBe(true);
    expect(MINIAPP_STAGE_1_EXCLUDES).toContain("ui-screens");
  });
});
