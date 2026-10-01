import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatMachineDiagnostics } from "./machine-diagnostics.ts";
import {
  PRODUCT_SCREEN_BY_CONTROL_STATE,
  TEST_UI_SERVER_RESULT_EVENT_NAMES,
  TEST_UI_USER_EVENT_NAMES,
  productScreenIdFor,
  renderProductScreen,
  type TestUiScreenDiagnostics,
} from "./product-screens.ts";

const USER_A = "user-a-internal";
const USER_B = "user-b-internal";

function banAFirst() {
  return {
    id: "ban-a",
    senderId: "sender-a",
    receiverId: USER_B,
    banText: "BAN_A_TEXT",
    durationMinutes: 5,
    acceptance: "PENDING",
    status: "OVERBOARD",
  };
}

function banBActive() {
  return {
    id: "ban-b",
    senderId: "sender-b",
    receiverId: USER_B,
    banText: "BAN_B_TEXT",
    durationMinutes: 99,
    acceptance: "PENDING",
    status: "OVERBOARD",
  };
}

function diagnostics(
  controlState: string | null,
  extra: Partial<TestUiScreenDiagnostics> = {},
): TestUiScreenDiagnostics {
  return {
    controlState,
    currentUserId: extra.currentUserId ?? USER_A,
    selectedContactId: extra.selectedContactId ?? null,
    createBanDraft: extra.createBanDraft ?? null,
    contacts: extra.contacts ?? [],
    ...(extra.bans === undefined ? {} : { bans: extra.bans }),
    ...(extra.incomingItems === undefined ? {} : { incomingItems: extra.incomingItems }),
    ...(extra.notificationItems === undefined
      ? {}
      : { notificationItems: extra.notificationItems }),
    ...(extra.activeNotificationItemId === undefined
      ? {}
      : { activeNotificationItemId: extra.activeNotificationItemId }),
    ...(extra.hasUnprocessedNotifications === undefined
      ? {}
      : { hasUnprocessedNotifications: extra.hasUnprocessedNotifications }),
    ...(extra.replyBanDraft === undefined ? {} : { replyBanDraft: extra.replyBanDraft }),
    ...(extra.replySource === undefined ? {} : { replySource: extra.replySource }),
    ...(extra.successfulBanId === undefined ? {} : { successfulBanId: extra.successfulBanId }),
    ...(extra.domainTimers === undefined ? {} : { domainTimers: extra.domainTimers }),
    ...(extra.checkPairs === undefined ? {} : { checkPairs: extra.checkPairs }),
    ...(extra.priorities === undefined ? {} : { priorities: extra.priorities }),
    ...(extra.activeShareAttemptId === undefined
      ? {}
      : { activeShareAttemptId: extra.activeShareAttemptId }),
    ...(extra.telegramShare === undefined ? {} : { telegramShare: extra.telegramShare }),
    ...(extra.telegramPersistentReentry === undefined
      ? {}
      : { telegramPersistentReentry: extra.telegramPersistentReentry }),
    ...(extra.rimChat === undefined ? {} : { rimChat: extra.rimChat }),
  };
}

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "../test-ui.html");
const htmlSource = readFileSync(htmlPath, "utf8");
const screensSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "product-screens.ts"),
  "utf8",
);

describe("Stage 6 TEST UI product screens", () => {
  it("A. RIM.LOBBY renders LobbyTestScreen content", () => {
    const screen = renderProductScreen(diagnostics("RIM.LOBBY"));
    expect(screen.screenId).toBe("LobbyTestScreen");
    expect(screen.title).toBe("RIM LOBBY");
    expect(screen.html).toContain("RIM LOBBY");
    expect(screen.html).not.toContain("спросить RIM");
    expect(screen.html).toContain('data-screen="LobbyTestScreen"');
  });

  it("RIM.LOBBY ignores leftover Reply Ban source and activeNotificationItemId", () => {
    const screen = renderProductScreen(
      diagnostics("RIM.LOBBY", {
        replySource: { kind: "INCOMING_BAN", itemId: "incoming-1", banId: "ban-1" },
        activeNotificationItemId: "incoming-1",
        replyBanDraft: { banText: "stale", durationMinutes: 15 },
        hasUnprocessedNotifications: true,
      }),
    );
    expect(screen.screenId).toBe("LobbyTestScreen");
    expect(screen.html).not.toContain("REPLY BAN");
    expect(screen.html).not.toContain("incoming-1");
    expect(screen.html).toContain('data-event="RIM.PRESS_NOTIFICATIONS"');
  });

  it("B. Lobby primary action corresponds to CREATE_BAN.PRESS_START", () => {
    const screen = renderProductScreen(diagnostics("RIM.LOBBY"));
    expect(screen.html).toContain(">CREATE BAN</button>");
    expect(screen.html).toContain('data-event="CREATE_BAN.PRESS_START"');
    expect(screen.html).not.toContain("E-01");
    expect(screen.html).not.toContain("NOTIFICATIONS");
    expect(screen.html).not.toContain("RIM.PRESS_NOTIFICATIONS");
  });

  it("C. CREATE_BAN.WHO renders receiver selection rather than generic event buttons", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.WHO", {
        contacts: [{ userId: USER_B, telegramUserId: "1002" }],
      }),
    );
    expect(screen.screenId).toBe("CreateBanWhoTestScreen");
    expect(screen.title).toBe("CREATE BAN — WHO");
    expect(screen.html).toContain("Choose receiver:");
    expect(screen.html).toContain(">Choose</button>");
    expect(screen.html).not.toContain("E-02");
    expect(screen.html).not.toContain("SELECT_CONTACT 1002");
  });

  it("D. registered users appear on WHO", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.WHO", {
        contacts: [
          { userId: USER_B, telegramUserId: "1002" },
          { userId: "user-c", telegramUserId: "1003" },
        ],
      }),
    );
    expect(screen.html).toContain(USER_B);
    expect(screen.html).toContain("user-c");
    expect(screen.html).toContain("dev telegram (not identity): 1002");
  });

  it("E. selecting User B is wired to E-02 with internal UserId, not Telegram id", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.WHO", {
        contacts: [{ userId: USER_B, telegramUserId: "1002" }],
      }),
    );
    expect(screen.html).toContain('data-event="CREATE_BAN.SELECT_CONTACT"');
    expect(screen.html).toContain(`data-contact-id="${USER_B}"`);
    expect(screen.html).not.toContain('data-contact-id="1002"');
  });

  it("does not allow self-selection on WHO", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.WHO", {
        contacts: [
          { userId: USER_A, telegramUserId: "1001" },
          { userId: USER_B, telegramUserId: "1002" },
        ],
      }),
    );
    expect(screen.html).not.toContain(`data-contact-id="${USER_A}"`);
    expect(screen.html).toContain(`data-contact-id="${USER_B}"`);
  });

  it("F. WHAT screen renders selected receiver, text input, duration input, Back, Next", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.WHAT.CONTACT", {
        selectedContactId: USER_B,
        createBanDraft: {
          origin: "CONTACT",
          selectedContactId: USER_B,
          banText: "не пропускай зал",
          durationMinutes: 10,
        },
      }),
    );
    expect(screen.screenId).toBe("CreateBanWhatContactTestScreen");
    expect(screen.html).toContain("CREATE BAN — WHAT");
    expect(screen.html).toContain(USER_B);
    expect(screen.html).toContain('id="banText"');
    expect(screen.html).toContain('data-change-event="CREATE_BAN.CHANGE_BAN_TEXT"');
    expect(screen.html).toContain('id="durationMinutes"');
    expect(screen.html).toContain('data-change-event="CREATE_BAN.CHANGE_DURATION"');
    expect(screen.html).toContain('data-event="CREATE_BAN.PRESS_BACK"');
    expect(screen.html).toContain(">BACK</button>");
    expect(screen.html).toContain('data-event="CREATE_BAN.PRESS_NEXT"');
    expect(screen.html).toContain(">NEXT</button>");
  });

  it("G. CONFIRM screen renders authoritative draft and only Back + Forbid user actions", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.CONFIRM.CONTACT", {
        selectedContactId: USER_B,
        createBanDraft: {
          origin: "CONTACT",
          selectedContactId: USER_B,
          banText: "не пропускай зал",
          durationMinutes: 10,
        },
      }),
    );
    expect(screen.screenId).toBe("CreateBanConfirmContactTestScreen");
    expect(screen.html).toContain("CREATE BAN — CONFIRM");
    expect(screen.html).toContain(USER_B);
    expect(screen.html).toContain("не пропускай зал");
    expect(screen.html).toContain("10");
    expect(screen.html).toContain(">BACK</button>");
    expect(screen.html).toContain(">FORBID</button>");
    expect(screen.html).toContain('data-event="CREATE_BAN.PRESS_FORBID"');
    expect(screen.html).toContain('data-event="CREATE_BAN.PRESS_BACK"');
    expect(screen.html.match(/data-event="/g)?.length).toBe(2);
  });

  it("H. E-10/E-11 do not appear as user controls", () => {
    const states = [
      "RIM.LOBBY",
      "CREATE_BAN.WHO",
      "CREATE_BAN.WHAT.CONTACT",
      "CREATE_BAN.CONFIRM.CONTACT",
      "CREATE_BAN.SUCCESS",
    ];
    for (const state of states) {
      const html = renderProductScreen(diagnostics(state)).html;
      expect(html).not.toContain("SEND_CONFIRMED");
      expect(html).not.toContain("SEND_FAILED");
      expect(html).not.toContain("E-10");
      expect(html).not.toContain("E-11");
    }
    expect(TEST_UI_USER_EVENT_NAMES).not.toEqual(
      expect.arrayContaining([...TEST_UI_SERVER_RESULT_EVENT_NAMES]),
    );
    expect(htmlSource).not.toContain("CREATE_BAN.SEND_CONFIRMED");
    expect(htmlSource).not.toContain("CREATE_BAN.SEND_FAILED");
  });

  it("A / I. SUCCESS renders FORBID AGAIN for existing E-09", () => {
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.SUCCESS", {
        selectedContactId: USER_B,
        createBanDraft: {
          origin: "CONTACT",
          selectedContactId: USER_B,
          banText: "не пропускай зал",
          durationMinutes: 10,
        },
      }),
    );
    expect(screen.screenId).toBe("CreateBanSuccessTestScreen");
    expect(screen.title).toBe("SUCCESS");
    expect(screen.html).toContain("Ban sent.");
    expect(screen.html).toContain(">FORBID AGAIN</button>");
    expect(screen.html).toContain('data-event="CREATE_BAN.PRESS_FORBID_MORE"');
    expect(TEST_UI_USER_EVENT_NAMES).toContain("CREATE_BAN.PRESS_FORBID_MORE");
    expect(screen.html).not.toContain("no further implemented user action");
  });

  it("MULTIPLE-BANS SUCCESS PROJECTION resolves the Ban identified by successfulBanId", () => {
    const oldBan = {
      id: "ban-old",
      senderId: USER_A,
      receiverId: "user-old-receiver",
      banText: "не срать и ссать",
      durationMinutes: 15,
      acceptance: "PENDING",
      status: null,
    };
    const newBan = {
      id: "ban-db033565-83ca-458d-bc34-5bc5fe85f01e",
      senderId: USER_A,
      receiverId: "7239e147-09d7-42c7-bc62-e8c6308f7f77",
      banText: "не опаздывать",
      durationMinutes: 3,
      acceptance: "PENDING",
      status: null,
    };
    const screen = renderProductScreen(
      diagnostics("CREATE_BAN.SUCCESS", {
        createBanDraft: null,
        successfulBanId: newBan.id,
        bans: [oldBan, newBan],
      }),
    );
    expect(screen.screenId).toBe("CreateBanSuccessTestScreen");
    expect(screen.title).toBe("SUCCESS");
    expect(screen.html).toContain('data-success-receiver="7239e147-09d7-42c7-bc62-e8c6308f7f77"');
    expect(screen.html).toContain('data-success-text="не опаздывать"');
    expect(screen.html).toContain('data-success-duration="3"');
    expect(screen.html).toContain(JSON.stringify("не опаздывать"));
    expect(screen.html).not.toContain("не срать и ссать");
    expect(screen.html).not.toContain("user-old-receiver");
    expect(screen.html).not.toContain('data-success-duration="15"');
  });

  it("J. changing backend controlState changes the Product Screen representation", () => {
    expect(productScreenIdFor("RIM.LOBBY")).toBe("LobbyTestScreen");
    expect(productScreenIdFor("CREATE_BAN.WHO")).toBe("CreateBanWhoTestScreen");
    expect(productScreenIdFor("CREATE_BAN.WHAT.CONTACT")).toBe("CreateBanWhatContactTestScreen");
    expect(productScreenIdFor("CREATE_BAN.CONFIRM.CONTACT")).toBe(
      "CreateBanConfirmContactTestScreen",
    );
    expect(productScreenIdFor("CREATE_BAN.SUCCESS")).toBe("CreateBanSuccessTestScreen");
    expect(renderProductScreen(diagnostics("RIM.LOBBY")).title).not.toBe(
      renderProductScreen(diagnostics("CREATE_BAN.WHO")).title,
    );
    expect(PRODUCT_SCREEN_BY_CONTROL_STATE["RIM.LOBBY"]).toBe("LobbyTestScreen");
  });

  it("K. Product Screen does not use independent frontend navigation state", () => {
    expect(screensSource).toContain("only screen selector");
    expect(screensSource).not.toContain("history.pushState");
    expect(screensSource).not.toContain("currentScreen");
    expect(htmlSource).toContain('data-nav="controlState"');
    expect(htmlSource).toContain("renderProductScreen(diagnostics");
    expect(htmlSource).not.toContain("history.pushState");
    expect(htmlSource).not.toContain("localStorage");
    expect(productScreenIdFor("RIM.CHAT")).toBe("RimChatTestScreen");
    expect(productScreenIdFor("RIM.SELECT_CONTACT")).toBe("RimSelectContactTestScreen");
    expect(productScreenIdFor("CREATE_BAN.WHAT.RIM")).toBe("CreateBanWhatRimTestScreen");
    expect(productScreenIdFor("CREATE_BAN.CONFIRM.RIM")).toBe("CreateBanConfirmRimTestScreen");
    expect(productScreenIdFor(null)).toBe("EmptySnapshotTestScreen");
    expect(productScreenIdFor(undefined)).toBe("DisconnectedTestScreen");
  });

  it("renders RIM Chat proposals and keeps Select Contact available after a contact is chosen", () => {
    const screen = renderProductScreen(
      diagnostics("RIM.CHAT", {
        rimChat: {
          id: "rim-chat-1",
          selectedContactId: USER_B,
          inputDraft: "",
          relationshipContext: { status: "ready", requestId: "context-1" },
          aiOperation: { status: "IDLE" },
          messages: [
            { kind: "RIM", text: "я могу предложить 3 запрета, написать?" },
            {
              kind: "BAN_PROPOSALS",
              message: "вот три",
              proposals: [
                { proposalId: "proposal-1", banText: "запрет один", executionProbability: 0.2 },
              ],
            },
          ],
        },
      }),
    );
    expect(screen.screenId).toBe("RimChatTestScreen");
    expect(screen.html).toContain('data-selected-contact="user-b-internal"');
    expect(screen.html).toContain('data-event="RIM.PRESS_SELECT_CONTACT"');
    expect(screen.html).toContain('data-rim-message="BAN_PROPOSALS"');
    expect(screen.html).toContain('data-proposal-id="proposal-1"');
    expect(screen.html).toContain('data-event="RIM.PRESS_SUGGESTION_FORBID"');
    expect(screen.html).toContain('data-rim-chat-id="rim-chat-1"');
    expect(screen.html).toContain('data-event="RIM.PRESS_SEND"');
  });

  it("renders the pre-contact RIM screen without a domain chat or a send control", () => {
    const screen = renderProductScreen(diagnostics("RIM.CHAT", { rimChat: null }));
    expect(screen.screenId).toBe("RimChatTestScreen");
    expect(screen.html).toContain("выбери человека и я предложу новые запреты");
    expect(screen.html).toContain('data-rim-pre-contact="true"');
    expect(screen.html).toContain('data-event="RIM.PRESS_SELECT_CONTACT"');
    expect(screen.html).toContain('data-event="RIM.PRESS_BACK"');
    expect(screen.html).not.toContain("data-rim-chat-id");
    expect(screen.html).not.toContain("data-rim-message");
    expect(screen.html).not.toContain("rimInputDraft");
    expect(screen.html).not.toContain('data-event="RIM.PRESS_SEND"');
    expect(screen.html).not.toContain("data-selected-contact");
  });

  it("renders Select Contact without a domain chat and keeps Back", () => {
    const screen = renderProductScreen(
      diagnostics("RIM.SELECT_CONTACT", {
        rimChat: null,
        contacts: [{ userId: USER_B, telegramUserId: "1002" }],
      }),
    );
    expect(screen.screenId).toBe("RimSelectContactTestScreen");
    expect(screen.html).toContain('data-contact-user-id="user-b-internal"');
    expect(screen.html).toContain('data-event="RIM.SELECT_CONTACT"');
    expect(screen.html).toContain('data-event="RIM.PRESS_BACK"');
    expect(screen.html).not.toContain("data-rim-chat-id");
    expect(screen.html).not.toContain("выбери человека и я предложу новые запреты");
  });

  it("L. diagnostics remain visible and show canonical machine fields", () => {
    const text = formatMachineDiagnostics({
      controlState: "CREATE_BAN.SUCCESS",
      currentUserId: USER_A,
      selectedContactId: USER_B,
      createBanDraft: { origin: "CONTACT", banText: "x", durationMinutes: 10 },
      lastEvent: { id: "E-10", name: "CREATE_BAN.SEND_CONFIRMED" },
      previousEvent: { id: "E-08", name: "CREATE_BAN.PRESS_FORBID" },
      kernelOutcome: "APPLIED",
      applicationStatus: "APPLIED",
      persisted: true,
      revision: 8,
      pendingOperations: {},
      effects: ["UPSERT_BAN"],
      bans: [{}],
      incomingItems: [],
      domainTimers: [],
      checkPairs: [],
      savedFrozenRimChatPresent: false,
      error: null,
    });
    expect(text).toContain("STATE: CREATE_BAN.SUCCESS");
    expect(text).toContain(`CURRENT USER: ${USER_A}`);
    expect(text).toContain(`SELECTED USER: ${USER_B}`);
    expect(text).toContain("LAST EVENT: E-10 CREATE_BAN.SEND_CONFIRMED");
    expect(text).toContain("PREVIOUS EVENT: E-08 CREATE_BAN.PRESS_FORBID");
    expect(text).toContain("KERNEL RESULT: APPLIED");
    expect(text).toContain("APPLICATION STATUS: APPLIED");
    expect(text).toContain("PERSISTED: true");
    expect(text).toContain("REVISION: 8");
    expect(text).toContain("PENDING OPERATIONS:");
    expect(text).toContain("EFFECTS:");
    expect(text).toContain("BANS: 1");
    expect(text).toContain("INCOMING: 0");
    expect(text).toContain("DOMAIN TIMERS: 0");
    expect(text).toContain("CHECK PAIRS: 0");
    expect(text).toContain("FROZEN RIM CHAT: false");
    expect(text).toContain("ERROR: (none)");
    expect(text).toContain("ACTIVE NOTIFICATION ITEM: (none)");
    expect(text).toContain("NOTIFICATION ITEMS: 0");
    expect(text).toContain("PRIORITIES: {}");
    expect(htmlSource).toContain("MACHINE DIAGNOSTICS");
    expect(htmlSource).toContain('id="machine"');
  });

  it("M. raw JSON is still available but is not required to use the flow", () => {
    expect(htmlSource).toContain("<details>");
    expect(htmlSource).toContain("Raw JSON (not required to operate the flow)");
    expect(htmlSource).toContain('id="raw"');
    expect(htmlSource.indexOf("PRODUCT SCREEN")).toBeLessThan(
      htmlSource.indexOf("RAW DIAGNOSTICS"),
    );
  });

  it("keeps DEV / AUTH outside the Product Screen", () => {
    expect(htmlSource).toContain("DEV / AUTH CONTROLS");
    const authAt = htmlSource.indexOf("DEV / AUTH CONTROLS");
    const productAt = htmlSource.indexOf("PRODUCT SCREEN");
    const machineAt = htmlSource.indexOf("MACHINE DIAGNOSTICS");
    expect(authAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(productAt);
    expect(productAt).toBeLessThan(machineAt);
  });
});

describe("Stage 7 TEST UI Incoming / OVERBOARD screens", () => {
  it("D / E. Lobby Notifications entry is conditional on the frozen queue", () => {
    const empty = renderProductScreen(diagnostics("RIM.LOBBY"));
    expect(empty.html).not.toContain('data-event="RIM.PRESS_NOTIFICATIONS"');
    const queued = renderProductScreen(
      diagnostics("RIM.LOBBY", { hasUnprocessedNotifications: true }),
    );
    expect(queued.html).toContain(">NOTIFICATIONS</button>");
    expect(queued.html).toContain('data-event="RIM.PRESS_NOTIFICATIONS"');
    expect(queued.html).not.toContain("E-60");
  });

  it("F / G. Notifications click is E-60 and screens do not implement FIFO selection", () => {
    expect(TEST_UI_USER_EVENT_NAMES).toContain("RIM.PRESS_NOTIFICATIONS");
    expect(TEST_UI_USER_EVENT_NAMES).toContain("NOTIFICATIONS.PRESS_OVERBOARD");
    expect(TEST_UI_USER_EVENT_NAMES).toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
    expect(TEST_UI_USER_EVENT_NAMES).toContain("NOTIFICATIONS.PRESS_BAN_MORE");
    expect(TEST_UI_USER_EVENT_NAMES).toContain("NOTIFICATIONS.PRESS_TO_BANS");
    expect(TEST_UI_SERVER_RESULT_EVENT_NAMES).toEqual(
      expect.arrayContaining([
        "NOTIFICATIONS.OVERBOARD_CONFIRMED",
        "NOTIFICATIONS.ACTION_FAILED",
        "NOTIFICATIONS.SELECT_NEXT",
        "REPLY_BAN.SEND_CONFIRMED",
        "REPLY_BAN.SEND_FAILED",
      ]),
    );
    expect(screensSource).not.toContain("fifoSequence");
    expect(screensSource).not.toContain("sort(");
    expect(screensSource).toContain("only screen selector");
  });

  it("I / J. Incoming Ban screen renders the real Ban, OVERBOARD, and Reply Ban", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.INCOMING_BAN", {
        currentUserId: USER_B,
        activeNotificationItemId: "incoming-1",
        incomingItems: [
          { id: "incoming-1", ownerId: USER_B, banId: "ban-1", kind: "INCOMING_BAN" },
        ],
        notificationItems: [
          { id: "incoming-1", ownerId: USER_B, banId: "ban-1", kind: "INCOMING_BAN" },
        ],
        bans: [
          {
            id: "ban-1",
            senderId: USER_A,
            receiverId: USER_B,
            banText: "не пропускай зал",
            durationMinutes: 10,
            acceptance: "PENDING",
            status: null,
          },
        ],
      }),
    );
    expect(screen.screenId).toBe("IncomingBanTestScreen");
    expect(screen.title).toBe("INCOMING BAN");
    expect(screen.html).toContain(USER_A);
    expect(screen.html).toContain("не пропускай зал");
    expect(screen.html).toContain("10");
    expect(screen.html).toContain(">OVERBOARD</button>");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_OVERBOARD"');
    expect(screen.html).toContain("ЗАПРЕТИТЬ В ОТВЕТ");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).not.toContain("OVERBOARD_CONFIRMED");
    expect(screen.html).not.toContain("SELECT_NEXT");
  });

  it("Incoming Ban screen binds the active Incoming item, not the first Ban", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.INCOMING_BAN", {
        currentUserId: USER_B,
        activeNotificationItemId: "incoming-b",
        incomingItems: [
          { id: "incoming-a", ownerId: USER_B, banId: "ban-a", kind: "INCOMING_BAN" },
          { id: "incoming-b", ownerId: USER_B, banId: "ban-b", kind: "INCOMING_BAN" },
        ],
        notificationItems: [
          { id: "incoming-a", ownerId: USER_B, banId: "ban-a", kind: "INCOMING_BAN" },
          { id: "incoming-b", ownerId: USER_B, banId: "ban-b", kind: "INCOMING_BAN" },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain('data-incoming-sender="sender-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).toContain('data-incoming-duration="99"');
    expect(screen.html).toContain('data-active-incoming="incoming-b"');
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain('data-incoming-sender="sender-a"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_OVERBOARD"');
  });

  it("Incoming Ban screen does not fall back to the first Incoming when active item is missing", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.INCOMING_BAN", {
        currentUserId: USER_B,
        activeNotificationItemId: "incoming-missing",
        incomingItems: [
          { id: "incoming-a", ownerId: USER_B, banId: "ban-a", kind: "INCOMING_BAN" },
        ],
        notificationItems: [
          { id: "incoming-a", ownerId: USER_B, banId: "ban-a", kind: "INCOMING_BAN" },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain("data-binding-error=");
    expect(screen.html).toContain("TEST UI INVARIANT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain("BAN_B_TEXT");
    expect(screen.html).not.toContain("data-incoming-sender=");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_OVERBOARD"');
  });

  it("R. OVERBOARD result screen exposes К ЗАПРЕТАМ as E-19 and Reply Ban", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-receiver-1",
        notificationItems: [
          {
            id: "status-receiver-1",
            ownerId: USER_B,
            banId: "ban-1",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [
          {
            id: "ban-1",
            senderId: USER_A,
            receiverId: USER_B,
            banText: "не пропускай зал",
            durationMinutes: 10,
            acceptance: "PENDING",
            status: "OVERBOARD",
          },
        ],
      }),
    );
    expect(screen.screenId).toBe("StatusOverboardReceiverTestScreen");
    expect(screen.title).toBe("STATUS OVERBOARD RECEIVER");
    expect(screen.html).toContain("PENDING");
    expect(screen.html).toContain("OVERBOARD");
    expect(screen.html).toContain(">К ЗАПРЕТАМ</button>");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).toContain("ЗАПРЕТИТЬ В ОТВЕТ");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).not.toContain("PRESS_BAN_MORE");
    expect(screen.html).not.toContain("SELECT_NEXT");
  });

  it("Status OVERBOARD screen displays Ban B when Ban A is first in the snapshot", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-receiver-b",
        notificationItems: [
          {
            id: "status-sender-a",
            ownerId: USER_A,
            banId: "ban-a",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
          {
            id: "status-receiver-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain('data-status-sender="sender-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).toContain('data-status-duration="99"');
    expect(screen.html).toContain('data-active-status="status-receiver-b"');
    expect(screen.html).toContain('data-ban-acceptance="PENDING"');
    expect(screen.html).toContain('data-ban-status="OVERBOARD"');
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain('data-status-sender="sender-a"');
    expect(screen.html).not.toContain("data-binding-error=");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).toContain(">К ЗАПРЕТАМ</button>");
  });

  it("Status OVERBOARD screen resolves Ban through the active receiver STATUS item", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-receiver-b",
        notificationItems: [
          {
            id: "status-receiver-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain('data-active-status="status-receiver-b"');
    expect(screen.html).toContain('data-status-sender="sender-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).toContain('data-status-duration="99"');
  });

  it("Status OVERBOARD screen errors when activeNotificationItemId is missing instead of using bans[0]", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        notificationItems: [
          {
            id: "status-receiver-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain("data-binding-error=");
    expect(screen.html).toContain("requires activeNotificationItemId");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain("BAN_B_TEXT");
    expect(screen.html).not.toContain("data-status-sender=");
    expect(screen.html).toContain(">К ЗАПРЕТАМ</button>");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
  });

  it("Status OVERBOARD screen errors when active item is another owner's sender Status", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-sender-a",
        notificationItems: [
          {
            id: "status-sender-a",
            ownerId: USER_A,
            banId: "ban-a",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
          {
            id: "status-receiver-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain("data-binding-error=");
    expect(screen.html).toContain("TEST UI INVARIANT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain("BAN_B_TEXT");
    expect(screen.html).not.toContain("data-status-sender=");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
  });

  it("Status OVERBOARD screen errors when the active Status Ban is missing", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-receiver-b",
        notificationItems: [
          {
            id: "status-receiver-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst()],
      }),
    );
    expect(screen.html).toContain("data-binding-error=");
    expect(screen.html).toContain("no Ban matches");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain("data-status-sender=");
  });

  it("N-06. OVERBOARD.SENDER renders inside the existing Notifications Status OVERBOARD screen", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.SENDER", {
        currentUserId: USER_A,
        activeNotificationItemId: "status-sender-1",
        notificationItems: [
          {
            id: "status-sender-1",
            ownerId: USER_A,
            banId: "ban-1",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
        ],
        bans: [
          {
            id: "ban-1",
            senderId: USER_A,
            receiverId: USER_B,
            banText: "sender overboard ban",
            durationMinutes: 12,
            acceptance: "PENDING",
            status: "OVERBOARD",
          },
        ],
      }),
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.OVERBOARD.SENDER")).toBe(
      "StatusOverboardReceiverTestScreen",
    );
    expect(screensSource).not.toContain("StatusOverboardSenderTestScreen");
    expect(screen.screenId).toBe("StatusOverboardReceiverTestScreen");
    expect(screen.title).toBe("STATUS OVERBOARD SENDER");
    expect(screen.html).not.toContain("UNSUPPORTED STAGE 9 SCREEN");
    expect(screen.html).toContain('data-status-role="SENDER"');
    expect(screen.html).toContain('data-active-status="status-sender-1"');
    expect(screen.html).toContain("sender overboard ban");
    expect(screen.html).toContain('data-ban-status="OVERBOARD"');
    expect(screen.html).toContain(">К ЗАПРЕТАМ</button>");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).toContain("ЗАПРЕТИТЬ ЕЩЁ");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_BAN_MORE"');
    expect(screen.html).not.toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).not.toContain("FROM_STATUS is deferred");
    expect(screen.html).not.toContain("Stage 10");
  });

  it("N-06. binds the exact active sender Status Ban amid multi-Ban data", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.SENDER", {
        currentUserId: USER_A,
        activeNotificationItemId: "status-sender-b",
        notificationItems: [
          {
            id: "status-sender-a",
            ownerId: USER_A,
            banId: "ban-a",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
          {
            id: "status-sender-b",
            ownerId: USER_A,
            banId: "ban-b",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
          {
            id: "status-receiver-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(screen.html).toContain('data-active-status="status-sender-b"');
    expect(screen.html).toContain('data-status-sender="sender-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).toContain('data-status-duration="99"');
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).not.toContain("data-binding-error=");
  });

  it("N-06. errors on missing active id, wrong role, or missing Ban", () => {
    const missingActive = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.SENDER", {
        currentUserId: USER_A,
        notificationItems: [
          {
            id: "status-sender-b",
            ownerId: USER_A,
            banId: "ban-b",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst(), banBActive()],
      }),
    );
    expect(missingActive.html).toContain("requires activeNotificationItemId");
    expect(missingActive.html).not.toContain("BAN_B_TEXT");
    expect(missingActive.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');

    const wrongRole = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.SENDER", {
        currentUserId: USER_A,
        activeNotificationItemId: "status-receiver-b",
        notificationItems: [
          {
            id: "status-receiver-b",
            ownerId: USER_A,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [banBActive()],
      }),
    );
    expect(wrongRole.html).toContain("expected SENDER");
    expect(wrongRole.html).not.toContain("BAN_B_TEXT");

    const missingBan = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.SENDER", {
        currentUserId: USER_A,
        activeNotificationItemId: "status-sender-b",
        notificationItems: [
          {
            id: "status-sender-b",
            ownerId: USER_A,
            banId: "ban-b",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
        ],
        bans: [banAFirst()],
      }),
    );
    expect(missingBan.html).toContain("no Ban matches");
    expect(missingBan.html).not.toContain("BAN_A_TEXT");
  });

  it("Y. Stage 7 still uses only backend controlState as screen selector", () => {
    expect(productScreenIdFor("NOTIFICATIONS.INCOMING_BAN")).toBe("IncomingBanTestScreen");
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER")).toBe(
      "StatusOverboardReceiverTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.OVERBOARD.SENDER")).toBe(
      "StatusOverboardReceiverTestScreen",
    );
    expect(screensSource).not.toContain("history.pushState");
    expect(screensSource).not.toContain("currentScreen");
    expect(htmlSource).not.toContain("history.pushState");
    expect(htmlSource).toContain("NOTIFICATIONS.PRESS_OVERBOARD");
    expect(htmlSource).not.toContain("NOTIFICATIONS.OVERBOARD_CONFIRMED");
  });
});

describe("Stage 8 TEST UI Reply Ban FROM_INCOMING screens", () => {
  it("TEST UI header reports implementation through Stage 13A", () => {
    expect(htmlSource).toContain("<title>98+ TEST UI — implemented through Stage 13A</title>");
    expect(htmlSource).toContain("<h1>98+ TEST UI — implemented through Stage 13A</h1>");
    expect(htmlSource).not.toContain("Incoming OVERBOARD (Stage 7)");
    expect(htmlSource).not.toContain("Create Ban CONTACT (Stage 6)");
  });
  const originalB = {
    id: "ban-b",
    senderId: USER_A,
    receiverId: USER_B,
    banText: "BAN_B_TEXT",
    durationMinutes: 10,
    acceptance: "PENDING" as const,
    status: null,
  };
  const originalA = {
    id: "ban-a",
    senderId: "sender-a",
    receiverId: USER_B,
    banText: "BAN_A_TEXT",
    durationMinutes: 5,
    acceptance: "PENDING" as const,
    status: null,
  };
  const replyBan = {
    id: "ban-reply-b",
    senderId: USER_B,
    receiverId: USER_A,
    banText: "REPLY_B_TEXT",
    durationMinutes: 15,
    acceptance: "PENDING" as const,
    status: null,
  };
  const incomingB = {
    id: "incoming-b",
    ownerId: USER_B,
    banId: "ban-b",
    kind: "INCOMING_BAN",
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  };
  const source = { kind: "INCOMING_BAN", itemId: "incoming-b", banId: "ban-b" };

  it("N-01 exposes ЗАПРЕТИТЬ В ОТВЕТ as E-14 and keeps OVERBOARD", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.INCOMING_BAN", {
        currentUserId: USER_B,
        activeNotificationItemId: "incoming-b",
        notificationItems: [incomingB],
        incomingItems: [incomingB],
        bans: [originalA, originalB],
      }),
    );
    expect(screen.html).toContain("ЗАПРЕТИТЬ В ОТВЕТ");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_OVERBOARD"');
  });

  it("AR. RB-01 binds source Ban B when Ban A is first", () => {
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.WHAT.FROM_INCOMING_BAN", {
        currentUserId: USER_B,
        replySource: source,
        replyBanDraft: { banText: "REPLY_B_TEXT", durationMinutes: 15 },
        notificationItems: [incomingB],
        incomingItems: [incomingB],
        bans: [originalA, originalB],
      }),
    );
    expect(screen.screenId).toBe("ReplyBanWhatFromIncomingTestScreen");
    expect(screen.html).toContain('data-reply-to="' + USER_A + '"');
    expect(screen.html).toContain('data-source-ban="ban-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_BACK"');
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_NEXT"');
    expect(screen.html).toContain('data-change-event="REPLY_BAN.CHANGE_BAN_TEXT"');
    expect(screen.html).toContain('data-change-event="REPLY_BAN.CHANGE_DURATION"');
  });

  it("AS. RB-02 binds source Ban B when Ban A is first", () => {
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN", {
        currentUserId: USER_B,
        replySource: source,
        replyBanDraft: { banText: "REPLY_B_TEXT", durationMinutes: 15 },
        notificationItems: [incomingB],
        incomingItems: [incomingB],
        bans: [originalA, originalB],
      }),
    );
    expect(screen.screenId).toBe("ReplyBanConfirmFromIncomingTestScreen");
    expect(screen.html).toContain('data-reply-receiver="' + USER_A + '"');
    expect(screen.html).toContain('data-source-ban="ban-b"');
    expect(screen.html).toContain("REPLY_B_TEXT");
    expect(screen.html).toContain("15");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_FORBID"');
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_BACK"');
  });

  it("AT. RB-03 distinguishes source Ban B from the newly created reply Ban", () => {
    const acceptedB = { ...originalB, acceptance: "ACCEPTED" as const };
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN", {
        currentUserId: USER_B,
        replySource: source,
        successfulBanId: "ban-reply-b",
        notificationItems: [
          { ...incomingB, lifecycle: { status: "PROCESSED" } },
          {
            id: "timer-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "TIMER",
            lifecycle: { status: "UNPROCESSED", display: "WAITING" },
          },
        ],
        bans: [originalA, acceptedB, replyBan],
        domainTimers: [
          {
            id: "timer-domain-b",
            banId: "ban-b",
            startedAt: 9_000_000,
            durationMinutes: 10,
            state: "RUNNING",
          },
        ],
      }),
    );
    expect(screen.screenId).toBe("ReplyBanSuccessFromIncomingTestScreen");
    expect(screen.html).toContain('data-source-ban="ban-b"');
    expect(screen.html).toContain('data-source-acceptance="ACCEPTED"');
    expect(screen.html).toContain('data-reply-ban="ban-reply-b"');
    expect(screen.html).toContain('data-reply-sender="' + USER_B + '"');
    expect(screen.html).toContain('data-reply-receiver="' + USER_A + '"');
    expect(screen.html).toContain("REPLY_B_TEXT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain("ЗАПРЕТИТЬ ЕЩЁ");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_FORBID_MORE"');
    expect(screen.html).not.toContain("PRESS_TO_BANS");
  });

  it("AU. N-02 binds the active Timer to the original Ban, not bans[0]", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.TIMER", {
        currentUserId: USER_B,
        activeNotificationItemId: "timer-b",
        notificationItems: [
          {
            id: "timer-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "TIMER",
            domainTimerId: "timer-domain-b",
            lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
          },
        ],
        bans: [originalA, { ...originalB, acceptance: "ACCEPTED" }],
        domainTimers: [
          {
            id: "timer-domain-b",
            banId: "ban-b",
            startedAt: 9_000_000,
            durationMinutes: 10,
            state: "RUNNING",
          },
        ],
      }),
    );
    expect(screen.screenId).toBe("TimerTestScreen");
    expect(screen.html).toContain('data-timer-ban="ban-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).toContain('data-timer-duration="10"');
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).not.toContain("PRESS_BAN_MORE");
    expect(screen.html).not.toContain("Stage 9");
  });

  it("AX. Reply Ban FROM_STATUS maps RB-04/05/06 and Status CTAs", () => {
    expect(productScreenIdFor("REPLY_BAN.WHAT.FROM_STATUS")).toBe(
      "ReplyBanWhatFromStatusTestScreen",
    );
    expect(productScreenIdFor("REPLY_BAN.CONFIRM.FROM_STATUS")).toBe(
      "ReplyBanConfirmFromStatusTestScreen",
    );
    expect(productScreenIdFor("REPLY_BAN.SUCCESS.FROM_STATUS")).toBe(
      "ReplyBanSuccessFromStatusTestScreen",
    );
    const status = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-1",
        notificationItems: [
          {
            id: "status-1",
            ownerId: USER_B,
            banId: "ban-1",
            kind: "STATUS",
            role: "RECEIVER",
            status: "OVERBOARD",
          },
        ],
        bans: [
          {
            id: "ban-1",
            senderId: USER_A,
            receiverId: USER_B,
            banText: "x",
            durationMinutes: 10,
            status: "OVERBOARD",
          },
        ],
      }),
    );
    expect(status.html).not.toContain("FROM_STATUS is deferred");
    expect(status.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(status.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
  });
});

describe("Stage 10 TEST UI Reply Ban FROM_STATUS screens", () => {
  const originalB = {
    id: "ban-b",
    senderId: USER_A,
    receiverId: USER_B,
    banText: "BAN_B_TEXT",
    durationMinutes: 10,
    acceptance: "PENDING" as const,
    status: "OVERBOARD" as const,
  };
  const originalA = {
    id: "ban-a",
    senderId: "sender-a",
    receiverId: USER_B,
    banText: "BAN_A_TEXT",
    durationMinutes: 5,
    acceptance: "PENDING" as const,
    status: "OVERBOARD" as const,
  };
  const replyBan = {
    id: "ban-reply-b",
    senderId: USER_B,
    receiverId: USER_A,
    banText: "REPLY_B_TEXT",
    durationMinutes: 15,
    acceptance: "PENDING" as const,
    status: null,
  };
  const statusB = {
    id: "status-b",
    ownerId: USER_B,
    banId: "ban-b",
    kind: "STATUS",
    role: "RECEIVER",
    status: "OVERBOARD",
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  };
  const source = { kind: "STATUS", itemId: "status-b", banId: "ban-b" };

  it("RB-04 binds source Ban B when Ban A is first", () => {
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.WHAT.FROM_STATUS", {
        currentUserId: USER_B,
        replySource: source,
        replyBanDraft: { banText: "REPLY_B_TEXT", durationMinutes: 15 },
        notificationItems: [statusB],
        bans: [originalA, originalB],
      }),
    );
    expect(screen.screenId).toBe("ReplyBanWhatFromStatusTestScreen");
    expect(screen.html).toContain('data-reply-to="' + USER_A + '"');
    expect(screen.html).toContain('data-source-ban="ban-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_BACK"');
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_NEXT"');
    expect(screen.html).toContain('data-change-event="REPLY_BAN.CHANGE_BAN_TEXT"');
    expect(screen.html).toContain('data-change-event="REPLY_BAN.CHANGE_DURATION"');
  });

  it("RB-05 binds source Ban B when Ban A is first", () => {
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.CONFIRM.FROM_STATUS", {
        currentUserId: USER_B,
        replySource: source,
        replyBanDraft: { banText: "REPLY_B_TEXT", durationMinutes: 15 },
        notificationItems: [statusB],
        bans: [originalA, originalB],
      }),
    );
    expect(screen.screenId).toBe("ReplyBanConfirmFromStatusTestScreen");
    expect(screen.html).toContain('data-reply-receiver="' + USER_A + '"');
    expect(screen.html).toContain('data-source-ban="ban-b"');
    expect(screen.html).toContain("REPLY_B_TEXT");
    expect(screen.html).toContain("15");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_FORBID"');
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_BACK"');
  });

  it("RB-06 shows reply Ban facts and that FROM_STATUS creates no Timer", () => {
    const processedStatus = {
      ...statusB,
      lifecycle: { status: "PROCESSED", display: "ACTIVE" },
    };
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.SUCCESS.FROM_STATUS", {
        currentUserId: USER_B,
        replySource: source,
        successfulBanId: "ban-reply-b",
        notificationItems: [
          processedStatus,
          {
            id: "timer-unrelated",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "TIMER",
            lifecycle: { status: "UNPROCESSED", display: "WAITING" },
          },
        ],
        bans: [originalA, originalB, replyBan],
      }),
    );
    expect(screen.screenId).toBe("ReplyBanSuccessFromStatusTestScreen");
    expect(screen.html).toContain('data-source-ban="ban-b"');
    expect(screen.html).toContain('data-source-status="status-b"');
    expect(screen.html).toContain("PROCESSED");
    expect(screen.html).toContain('data-reply-ban="ban-reply-b"');
    expect(screen.html).toContain('data-reply-sender="' + USER_B + '"');
    expect(screen.html).toContain('data-reply-receiver="' + USER_A + '"');
    expect(screen.html).toContain("REPLY_B_TEXT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
    expect(screen.html).toContain('data-from-status-created-timer="false"');
    expect(screen.html).toContain('data-source-ban-timer-item-exists="true"');
    expect(screen.html).toContain("unrelated Timer may exist");
    expect(screen.html).toContain("ЗАПРЕТИТЬ ЕЩЁ");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_FORBID_MORE"');
    expect(screen.html).not.toContain("PRESS_TO_BANS");
  });

  it("bindReplySource STATUS rejects INCOMING_BAN kind with invariant", () => {
    const screen = renderProductScreen(
      diagnostics("REPLY_BAN.WHAT.FROM_STATUS", {
        currentUserId: USER_B,
        replySource: { kind: "INCOMING_BAN", itemId: "status-b", banId: "ban-b" },
        replyBanDraft: { banText: "x", durationMinutes: 10 },
        notificationItems: [statusB],
        bans: [originalB],
      }),
    );
    expect(screen.html).toContain("data-binding-error=");
    expect(screen.html).toContain("expected STATUS");
    expect(screen.html).toContain("INCOMING_BAN");
    expect(screen.html).not.toContain("BAN_B_TEXT");
    expect(screen.html).toContain('data-event="REPLY_BAN.PRESS_BACK"');
  });

  it("receiver Status screens expose PRESS_REPLY_BAN and PRESS_TO_BANS", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-b",
        notificationItems: [
          {
            id: "status-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "BANTASTIC",
          },
        ],
        bans: [{ ...originalB, status: "BANTASTIC", acceptance: "ACCEPTED" }],
      }),
    );
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).not.toContain("PRESS_BAN_MORE");
    expect(screen.html).toContain('data-active-status="status-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
  });

  it("sender Status screens expose PRESS_BAN_MORE and PRESS_TO_BANS", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.OVERBOARD.SENDER", {
        currentUserId: USER_A,
        activeNotificationItemId: "status-sender-b",
        notificationItems: [
          {
            id: "status-sender-a",
            ownerId: USER_A,
            banId: "ban-a",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
          {
            id: "status-sender-b",
            ownerId: USER_A,
            banId: "ban-b",
            kind: "STATUS",
            role: "SENDER",
            status: "OVERBOARD",
          },
        ],
        bans: [originalA, originalB],
      }),
    );
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_BAN_MORE"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).not.toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).toContain('data-active-status="status-sender-b"');
    expect(screen.html).toContain("BAN_B_TEXT");
    expect(screen.html).not.toContain("BAN_A_TEXT");
  });

  it("does not use localStorage", () => {
    expect(screensSource).not.toContain("localStorage");
    expect(htmlSource).not.toContain("localStorage");
  });
});

describe("Stage 9 TEST UI Timer Check Status screens", () => {
  const ban = {
    id: "ban-b",
    senderId: USER_A,
    receiverId: USER_B,
    banText: "BAN_B_TEXT",
    durationMinutes: 10,
    acceptance: "ACCEPTED" as const,
    status: "BANTASTIC" as const,
  };
  const checkItem = {
    id: "check-b",
    ownerId: USER_B,
    banId: "ban-b",
    kind: "CHECK",
    role: "RECEIVER",
    checkPairId: "pair-b",
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  };

  it("maps N-03/N-04 and N-05…N-12 Status/Check states without Unsupported", () => {
    expect(productScreenIdFor("NOTIFICATIONS.CHECK.RECEIVER")).toBe("CheckReceiverTestScreen");
    expect(productScreenIdFor("NOTIFICATIONS.CHECK.SENDER")).toBe("CheckSenderTestScreen");
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER")).toBe(
      "StatusOverboardReceiverTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.OVERBOARD.SENDER")).toBe(
      "StatusOverboardReceiverTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER")).toBe(
      "StatusBantasticReceiverTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.BANTASTIC.SENDER")).toBe(
      "StatusBantasticSenderTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.BANFLICT.RECEIVER")).toBe(
      "StatusBanflictReceiverTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.BANFLICT.SENDER")).toBe(
      "StatusBanflictSenderTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER")).toBe(
      "StatusFairEnoughReceiverTestScreen",
    );
    expect(productScreenIdFor("NOTIFICATIONS.STATUS.FAIR_ENOUGH.SENDER")).toBe(
      "StatusFairEnoughSenderTestScreen",
    );
    expect(screensSource).not.toContain("StatusOverboardSenderTestScreen");
  });

  it("N-05…N-12 Notifications Status states render E-19 plus Stage 10 role CTA", () => {
    const cases = [
      {
        controlState: "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER",
        role: "RECEIVER",
        status: "OVERBOARD",
        userId: USER_B,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.OVERBOARD.SENDER",
        role: "SENDER",
        status: "OVERBOARD",
        userId: USER_A,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER",
        role: "RECEIVER",
        status: "BANTASTIC",
        userId: USER_B,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.BANTASTIC.SENDER",
        role: "SENDER",
        status: "BANTASTIC",
        userId: USER_A,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.BANFLICT.RECEIVER",
        role: "RECEIVER",
        status: "BANFLICT",
        userId: USER_B,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.BANFLICT.SENDER",
        role: "SENDER",
        status: "BANFLICT",
        userId: USER_A,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER",
        role: "RECEIVER",
        status: "FAIR_ENOUGH",
        userId: USER_B,
      },
      {
        controlState: "NOTIFICATIONS.STATUS.FAIR_ENOUGH.SENDER",
        role: "SENDER",
        status: "FAIR_ENOUGH",
        userId: USER_A,
      },
    ] as const;

    for (const entry of cases) {
      const screen = renderProductScreen(
        diagnostics(entry.controlState, {
          currentUserId: entry.userId,
          activeNotificationItemId: "status-active",
          notificationItems: [
            {
              id: "status-active",
              ownerId: entry.userId,
              banId: "ban-b",
              kind: "STATUS",
              role: entry.role,
              status: entry.status,
            },
          ],
          bans: [{ ...ban, status: entry.status }],
        }),
      );
      expect(screen.screenId).not.toBe("UnsupportedProductTestScreen");
      expect(screen.html).not.toContain("UNSUPPORTED PRODUCT SCREEN");
      expect(screen.html).not.toContain("UNSUPPORTED STAGE 9 SCREEN");
      expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
      expect(screen.html).toContain(">К ЗАПРЕТАМ</button>");
      expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_ASK_RIM"');
      expect(screen.html).toContain(">спросить RIM</button>");
      expect(screen.html).not.toContain("спросить у RIM");
      if (entry.role === "RECEIVER") {
        expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
        expect(screen.html).not.toContain('data-event="NOTIFICATIONS.PRESS_BAN_MORE"');
      } else {
        expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_BAN_MORE"');
        expect(screen.html).not.toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
      }
      expect(screen.html).toContain("BAN_B_TEXT");
      expect(screen.html).toContain('data-active-status="status-active"');
    }
  });

  it("Check screens expose E-16/E-17 and not server results", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.CHECK.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "check-b",
        notificationItems: [checkItem],
        bans: [ban],
        checkPairs: [{ id: "pair-b", banId: "ban-b", receiverAnswer: null, senderAnswer: null }],
      }),
    );
    expect(screen.screenId).toBe("CheckReceiverTestScreen");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.CHECK_ANSWER.FULFILLED"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED"');
    expect(screen.html).not.toContain("CHECK_ANSWER_CONFIRMED");
    expect(screen.html).not.toContain("NOTIFICATIONS.PRESS_ASK_RIM");
    expect(screen.html).not.toContain("спросить RIM");
    expect(screen.html).toContain("BAN_B_TEXT");
  });

  it("receiver Status screens expose E-19 and E-14", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER", {
        currentUserId: USER_B,
        activeNotificationItemId: "status-b",
        notificationItems: [
          {
            id: "status-b",
            ownerId: USER_B,
            banId: "ban-b",
            kind: "STATUS",
            role: "RECEIVER",
            status: "BANTASTIC",
          },
        ],
        bans: [ban],
      }),
    );
    expect(screen.screenId).toBe("StatusBantasticReceiverTestScreen");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_REPLY_BAN"');
    expect(screen.html).not.toContain("FROM_STATUS is deferred");
    expect(screen.html).not.toContain("Stage 10");
  });

  it("sender Status screens expose E-19 and E-18", () => {
    const screen = renderProductScreen(
      diagnostics("NOTIFICATIONS.STATUS.BANFLICT.SENDER", {
        currentUserId: USER_A,
        activeNotificationItemId: "status-a",
        notificationItems: [
          {
            id: "status-a",
            ownerId: USER_A,
            banId: "ban-b",
            kind: "STATUS",
            role: "SENDER",
            status: "BANFLICT",
          },
        ],
        bans: [{ ...ban, status: "BANFLICT" }],
      }),
    );
    expect(screen.screenId).toBe("StatusBanflictSenderTestScreen");
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_TO_BANS"');
    expect(screen.html).toContain('data-event="NOTIFICATIONS.PRESS_BAN_MORE"');
    expect(screen.html).not.toContain("FROM_STATUS is deferred");
    expect(screen.html).not.toContain("Stage 10");
  });
});

describe("Stage 11 TEST UI Template Create Ban screens", () => {
  it("maps Template control states to dedicated screens", () => {
    expect(productScreenIdFor("CREATE_BAN.WHAT.TEMPLATE")).toBe("CreateBanWhatTemplateTestScreen");
    expect(productScreenIdFor("CREATE_BAN.CONFIRM.TEMPLATE")).toBe(
      "CreateBanConfirmTemplateTestScreen",
    );
    expect(productScreenIdFor("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING")).toBe(
      "CreateBanSharePendingTestScreen",
    );
    expect(PRODUCT_SCREEN_BY_CONTROL_STATE["CREATE_BAN.WHAT.TEMPLATE"]).toBe(
      "CreateBanWhatTemplateTestScreen",
    );
  });

  it("WHO exposes TEMPLATE as E-03", () => {
    const screen = renderProductScreen(diagnostics("CREATE_BAN.WHO"));
    expect(screen.html).toContain('data-event="CREATE_BAN.SELECT_TEMPLATE"');
    expect(screen.html).toContain("TEMPLATE");
  });

  it("CB-03 / CB-07 / CB-09 render Template draft and share-pending without inventing receiver", () => {
    const what = renderProductScreen(
      diagnostics("CREATE_BAN.WHAT.TEMPLATE", {
        createBanDraft: {
          origin: "TEMPLATE",
          selectedContactId: null,
          banText: "tpl",
          durationMinutes: 10,
        },
      }),
    );
    expect(what.screenId).toBe("CreateBanWhatTemplateTestScreen");
    expect(what.html).toContain("receiver is not predetermined");
    expect(what.html).toContain('data-change-event="CREATE_BAN.CHANGE_BAN_TEXT"');
    expect(what.html).toContain('data-change-event="CREATE_BAN.CHANGE_DURATION"');

    const confirm = renderProductScreen(
      diagnostics("CREATE_BAN.CONFIRM.TEMPLATE", {
        createBanDraft: {
          origin: "TEMPLATE",
          selectedContactId: null,
          banText: "tpl",
          durationMinutes: 10,
        },
      }),
    );
    expect(confirm.html).toContain("not set until Share Link resolution");
    expect(confirm.html).toContain('data-event="CREATE_BAN.PRESS_FORBID"');

    const pending = renderProductScreen(
      diagnostics("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING", {
        activeShareAttemptId: "share-1",
        telegramShare: {
          attemptId: "share-1",
          token: "tok",
          preparedMessageId: "prep-1",
          shareUrl: "https://t.me/98plus_bot?startapp=share_tok",
          api: "shareMessage",
        },
        createBanDraft: {
          origin: "TEMPLATE",
          selectedContactId: null,
          banText: "tpl",
          durationMinutes: 10,
        },
      }),
    );
    expect(pending.html).toContain("Ban is not created yet");
    expect(pending.html).toContain('data-share-attempt="share-1"');
    expect(pending.html).toContain("DEV: SHARE_CONFIRMED");
    expect(pending.html).toContain("data-dev-only");
  });
});

describe("Stage 13A Telegram Persistent Re-entry CTA overlay", () => {
  it("renders nonblocking CTA without adding a PRODUCT_SCREEN_BY_CONTROL_STATE entry", () => {
    expect(Object.values(PRODUCT_SCREEN_BY_CONTROL_STATE)).not.toContain(
      "TelegramPersistentReentryCtaScreen",
    );
    expect(screensSource).toContain("telegramPersistentReentryCtaHtml");
    expect(screensSource).not.toMatch(/PRODUCT_SCREEN_BY_CONTROL_STATE[\s\S]*Закрепить 98\+/);
    const withCta = renderProductScreen(
      diagnostics("RIM.LOBBY", {
        telegramPersistentReentry: {
          showCta: true,
          label: "Закрепить 98+",
          api: "requestWriteAccess",
        },
      }),
    );
    expect(withCta.screenId).toBe("LobbyTestScreen");
    expect(withCta.html).toContain("Закрепить 98+");
    expect(withCta.html).toContain('data-telegram-persistent-reentry-cta="1"');
    expect(withCta.html).toContain("data-nonblocking");
    expect(withCta.html).toContain("DEV: GRANT");
    expect(htmlSource).toContain("telegram-persistent-reentry/begin");
    expect(htmlSource).toContain("requestWriteAccess");

    const without = renderProductScreen(
      diagnostics("RIM.LOBBY", {
        telegramPersistentReentry: {
          showCta: false,
          label: "Закрепить 98+",
          api: "requestWriteAccess",
        },
      }),
    );
    expect(without.html).not.toContain("data-telegram-persistent-reentry-cta");
  });
});
