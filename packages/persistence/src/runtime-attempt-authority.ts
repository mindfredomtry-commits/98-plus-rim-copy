/**
 * Structural check of the Application-owned runtime JSON.
 * Persistence does not parse the full runtime schema. It only proves, under the
 * session row lock, that this technical attempt is still current and that an
 * accepted retry of this attempt has not already been recorded.
 */
export type RuntimeAttemptAuthority = Readonly<{
  rimChatId: string;
  selectedContactId: string;
  contextRequestId: string;
  requestId: string;
  attemptId: string;
  continuityMode: "provider-conversation" | "local-canonical-history";
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runtimeAttemptAllowsCommit(
  runtime: unknown,
  authority: RuntimeAttemptAuthority,
): boolean {
  if (!isRecord(runtime) || !isRecord(runtime.attempt)) {
    return false;
  }
  const continuity =
    runtime.continuityMode === undefined ? "provider-conversation" : runtime.continuityMode;
  if (
    runtime.rimChatId !== authority.rimChatId ||
    runtime.selectedContactId !== authority.selectedContactId ||
    runtime.contextRequestId !== authority.contextRequestId ||
    runtime.attempt.requestId !== authority.requestId ||
    runtime.attempt.attemptId !== authority.attemptId ||
    continuity !== authority.continuityMode
  ) {
    return false;
  }
  if (!isRecord(runtime.retryIntent)) {
    return true;
  }
  return runtime.retryIntent.attemptId !== authority.attemptId;
}
