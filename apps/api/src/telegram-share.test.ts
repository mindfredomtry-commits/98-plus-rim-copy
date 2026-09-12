import { describe, expect, it, vi } from "vitest";
import {
  buildTemplateShareDeepLink,
  invokeTelegramShareMessage,
  telegramShareOutcomeToEventName,
  prepareTelegramShareMessage,
  TelegramShareConfigurationError,
} from "./telegram-share.ts";

describe("Telegram Share adapter boundary", () => {
  it("builds the Template Share deep link from bot username + opaque token", () => {
    expect(buildTemplateShareDeepLink({ botUsername: "98plus_bot", token: "tok-1" })).toBe(
      "https://t.me/98plus_bot?startapp=share_tok-1",
    );
    expect(buildTemplateShareDeepLink({ botUsername: "@98plus_bot", token: "tok-1" })).toBe(
      "https://t.me/98plus_bot?startapp=share_tok-1",
    );
  });

  it("maps shareMessage outcomes to canonical E-12 / E-13 names only", () => {
    expect(telegramShareOutcomeToEventName("CONFIRMED")).toBe("CREATE_BAN.SHARE_CONFIRMED");
    expect(telegramShareOutcomeToEventName("CANCELLED")).toBe("CREATE_BAN.SHARE_CANCELLED");
  });

  it("invokeTelegramShareMessage returns null when shareMessage is unavailable", () => {
    expect(invokeTelegramShareMessage({}, "prep-1")).toBeNull();
    expect(invokeTelegramShareMessage(null, "prep-1")).toBeNull();
  });

  it("invokeTelegramShareMessage maps boolean callback without inventing success", async () => {
    const confirmed = invokeTelegramShareMessage(
      {
        shareMessage: (_id, callback) => {
          callback?.(true);
        },
      },
      "prep-1",
    );
    expect(confirmed).not.toBeNull();
    await expect(confirmed!).resolves.toBe("CONFIRMED");

    const cancelled = invokeTelegramShareMessage(
      {
        shareMessage: (_id, callback) => {
          callback?.(false);
        },
      },
      "prep-1",
    );
    await expect(cancelled!).resolves.toBe("CANCELLED");
  });

  it("prepareTelegramShareMessage requires telegramUserId and posts savePreparedInlineMessage", async () => {
    let capturedBody = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({ ok: true, result: { id: "prepared-abc" } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const prepared = await prepareTelegramShareMessage({
        attemptId: "share-1",
        token: "tok-1",
        banText: "no phones",
        durationMinutes: 10,
        telegramUserId: "1001",
        botToken: "bot-token",
        botUsername: "98plus_bot",
      });
      expect(prepared.preparedMessageId).toBe("prepared-abc");
      expect(prepared.api).toBe("shareMessage");
      expect(prepared.shareUrl).toContain("startapp=share_tok-1");
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(capturedBody);
      expect(body.user_id).toBe(1001);
      expect(body.result.type).toBe("article");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prepareTelegramShareMessage rejects invalid telegramUserId", async () => {
    await expect(
      prepareTelegramShareMessage({
        attemptId: "share-1",
        token: "tok-1",
        banText: "no phones",
        durationMinutes: 10,
        telegramUserId: "not-a-number",
        botToken: "bot-token",
        botUsername: "98plus_bot",
      }),
    ).rejects.toBeInstanceOf(TelegramShareConfigurationError);
  });
});
