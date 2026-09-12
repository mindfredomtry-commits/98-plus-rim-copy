import { createHmac } from "node:crypto";

export function createTelegramInitData(
  user: { id: number; first_name?: string },
  options: { authDate?: number; botToken?: string; extra?: Record<string, string> } = {},
): string {
  const botToken = options.botToken ?? "test-bot-token";
  const authDate = options.authDate ?? 1_700_000_000 - 10;
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify(user),
    ...options.extra,
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}
