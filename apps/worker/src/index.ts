import { IMPLEMENTATION_STAGE, STAGE_1_EXCLUDES } from "@98plus/product-model";
import {
  expireElapsedDomainTimers,
  TIMER_CHECK_STATUS_STAGE,
  type CreateBanContactRuntime,
} from "@98plus/api";

export const WORKER_STAGE = IMPLEMENTATION_STAGE;
export const WORKER_STAGE_1_EXCLUDES = STAGE_1_EXCLUDES;
export const WORKER_TIMER_CHECK_STATUS_STAGE = TIMER_CHECK_STATUS_STAGE;

export async function runDurationExpirationTick(runtime: CreateBanContactRuntime): Promise<number> {
  return expireElapsedDomainTimers(runtime);
}
