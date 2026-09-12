import { describe, expect, it } from "vitest";
import { createCreateBanContactRuntime } from "@98plus/api";
import {
  WORKER_STAGE,
  WORKER_STAGE_1_EXCLUDES,
  WORKER_TIMER_CHECK_STATUS_STAGE,
  runDurationExpirationTick,
} from "./index.ts";

describe("worker Stage 9 duration expiration", () => {
  it("keeps the frozen Kernel stage and exposes the Stage 9 timer tick", () => {
    expect(WORKER_STAGE).toBe(2);
    expect(WORKER_TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(WORKER_STAGE_1_EXCLUDES).toContain("timer-flow");
    expect(typeof runDurationExpirationTick).toBe("function");
  });

  it("can run a duration-expiration tick without an open user session", async () => {
    const runtime = createCreateBanContactRuntime();
    await expect(runDurationExpirationTick(runtime)).resolves.toBe(0);
  });
});
