/**
 * Stage 6–11 TEST UI product screens.
 *
 * The current backend `controlState` is the only screen selector.
 * Do not implement a frontend navigation machine or notification FIFO here.
 */

export type TestUiScreenId =
  | "DisconnectedTestScreen"
  | "EmptySnapshotTestScreen"
  | "LobbyTestScreen"
  | "RimChatTestScreen"
  | "RimSelectContactTestScreen"
  | "CreateBanWhoTestScreen"
  | "CreateBanWhatContactTestScreen"
  | "CreateBanWhatTemplateTestScreen"
  | "CreateBanWhatRimTestScreen"
  | "CreateBanConfirmRimTestScreen"
  | "CreateBanConfirmContactTestScreen"
  | "CreateBanConfirmTemplateTestScreen"
  | "CreateBanSharePendingTestScreen"
  | "CreateBanSuccessTestScreen"
  | "IncomingBanTestScreen"
  | "StatusOverboardReceiverTestScreen"
  | "ReplyBanWhatFromIncomingTestScreen"
  | "ReplyBanConfirmFromIncomingTestScreen"
  | "ReplyBanSuccessFromIncomingTestScreen"
  | "ReplyBanWhatFromStatusTestScreen"
  | "ReplyBanConfirmFromStatusTestScreen"
  | "ReplyBanSuccessFromStatusTestScreen"
  | "TimerTestScreen"
  | "CheckReceiverTestScreen"
  | "CheckSenderTestScreen"
  | "StatusBantasticReceiverTestScreen"
  | "StatusBantasticSenderTestScreen"
  | "StatusBanflictReceiverTestScreen"
  | "StatusBanflictSenderTestScreen"
  | "StatusFairEnoughReceiverTestScreen"
  | "StatusFairEnoughSenderTestScreen"
  | "UnsupportedProductTestScreen";

export const PRODUCT_SCREEN_BY_CONTROL_STATE = {
  "RIM.LOBBY": "LobbyTestScreen",
  "RIM.CHAT": "RimChatTestScreen",
  "RIM.SELECT_CONTACT": "RimSelectContactTestScreen",
  "CREATE_BAN.WHAT.RIM": "CreateBanWhatRimTestScreen",
  "CREATE_BAN.CONFIRM.RIM": "CreateBanConfirmRimTestScreen",
  "CREATE_BAN.WHO": "CreateBanWhoTestScreen",
  "CREATE_BAN.WHAT.CONTACT": "CreateBanWhatContactTestScreen",
  "CREATE_BAN.WHAT.TEMPLATE": "CreateBanWhatTemplateTestScreen",
  "CREATE_BAN.CONFIRM.CONTACT": "CreateBanConfirmContactTestScreen",
  "CREATE_BAN.CONFIRM.TEMPLATE": "CreateBanConfirmTemplateTestScreen",
  "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING": "CreateBanSharePendingTestScreen",
  "CREATE_BAN.SUCCESS": "CreateBanSuccessTestScreen",
  "NOTIFICATIONS.INCOMING_BAN": "IncomingBanTestScreen",
  // N-05 and N-06 share the existing Notifications Status OVERBOARD renderer.
  // OVERBOARD.SENDER is a Product Control State, not a separate Product Screen.
  "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER": "StatusOverboardReceiverTestScreen",
  "NOTIFICATIONS.STATUS.OVERBOARD.SENDER": "StatusOverboardReceiverTestScreen",
  "REPLY_BAN.WHAT.FROM_INCOMING_BAN": "ReplyBanWhatFromIncomingTestScreen",
  "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN": "ReplyBanConfirmFromIncomingTestScreen",
  "REPLY_BAN.SUCCESS.FROM_INCOMING_BAN": "ReplyBanSuccessFromIncomingTestScreen",
  "REPLY_BAN.WHAT.FROM_STATUS": "ReplyBanWhatFromStatusTestScreen",
  "REPLY_BAN.CONFIRM.FROM_STATUS": "ReplyBanConfirmFromStatusTestScreen",
  "REPLY_BAN.SUCCESS.FROM_STATUS": "ReplyBanSuccessFromStatusTestScreen",
  "NOTIFICATIONS.TIMER": "TimerTestScreen",
  "NOTIFICATIONS.CHECK.RECEIVER": "CheckReceiverTestScreen",
  "NOTIFICATIONS.CHECK.SENDER": "CheckSenderTestScreen",
  "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER": "StatusBantasticReceiverTestScreen",
  "NOTIFICATIONS.STATUS.BANTASTIC.SENDER": "StatusBantasticSenderTestScreen",
  "NOTIFICATIONS.STATUS.BANFLICT.RECEIVER": "StatusBanflictReceiverTestScreen",
  "NOTIFICATIONS.STATUS.BANFLICT.SENDER": "StatusBanflictSenderTestScreen",
  "NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER": "StatusFairEnoughReceiverTestScreen",
  "NOTIFICATIONS.STATUS.FAIR_ENOUGH.SENDER": "StatusFairEnoughSenderTestScreen",
} as const satisfies Record<string, TestUiScreenId>;

export const TEST_UI_USER_EVENT_NAMES = [
  "CREATE_BAN.PRESS_START",
  "RIM.PRESS_START_CHAT",
  "RIM.PRESS_SELECT_CONTACT",
  "RIM.SELECT_CONTACT",
  "RIM.PRESS_BACK",
  "RIM.CHANGE_INPUT_DRAFT",
  "RIM.PRESS_SEND",
  "RIM.PRESS_RETRY_CONTEXT",
  "RIM.PRESS_RETRY_AI",
  "RIM.PRESS_SUGGESTION_FORBID",
  "CREATE_BAN.SELECT_CONTACT",
  "CREATE_BAN.SELECT_TEMPLATE",
  "CREATE_BAN.CHANGE_BAN_TEXT",
  "CREATE_BAN.CHANGE_DURATION",
  "CREATE_BAN.PRESS_NEXT",
  "CREATE_BAN.PRESS_BACK",
  "CREATE_BAN.PRESS_FORBID",
  "CREATE_BAN.PRESS_FORBID_MORE",
  "CREATE_BAN.SHARE_CONFIRMED",
  "CREATE_BAN.SHARE_CANCELLED",
  "RIM.PRESS_NOTIFICATIONS",
  "NOTIFICATIONS.PRESS_OVERBOARD",
  "NOTIFICATIONS.PRESS_REPLY_BAN",
  "NOTIFICATIONS.PRESS_BAN_MORE",
  "NOTIFICATIONS.PRESS_TO_BANS",
  "NOTIFICATIONS.PRESS_ASK_RIM",
  "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
  "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
  "REPLY_BAN.CHANGE_BAN_TEXT",
  "REPLY_BAN.CHANGE_DURATION",
  "REPLY_BAN.PRESS_NEXT",
  "REPLY_BAN.PRESS_BACK",
  "REPLY_BAN.PRESS_FORBID",
  "REPLY_BAN.PRESS_FORBID_MORE",
  "TELEGRAM_PERSISTENT_REENTRY.GRANTED",
  "TELEGRAM_PERSISTENT_REENTRY.DECLINED",
] as const;

export const TEST_UI_SERVER_RESULT_EVENT_NAMES = [
  "CREATE_BAN.SEND_CONFIRMED",
  "CREATE_BAN.SEND_FAILED",
  "NOTIFICATIONS.OVERBOARD_CONFIRMED",
  "NOTIFICATIONS.ACTION_FAILED",
  "NOTIFICATIONS.SELECT_NEXT",
  "REPLY_BAN.SEND_CONFIRMED",
  "REPLY_BAN.SEND_FAILED",
  "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
  "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
  "BAN.DURATION_EXPIRED",
] as const;

export type TestUiContact = Readonly<{
  userId: string;
  telegramUserId: string;
}>;

export type TestUiCreateBanDraft = Readonly<{
  origin?: string | null;
  selectedContactId?: string | null;
  banText?: string | null;
  durationMinutes?: number | null;
  proposalId?: string | null;
}>;

export type TestUiBan = Readonly<{
  id?: string;
  senderId?: string | null;
  receiverId?: string | null;
  banText?: string;
  durationMinutes?: number;
  acceptance?: string;
  status?: string | null;
}>;

export type TestUiNotificationLifecycle = Readonly<{
  status?: string;
  display?: string;
}>;

export type TestUiNotificationItem = Readonly<{
  id?: string;
  ownerId?: string;
  banId?: string;
  kind?: string;
  role?: string;
  status?: string;
  domainTimerId?: string;
  checkPairId?: string;
  lifecycle?: TestUiNotificationLifecycle;
}>;

export type TestUiReplyBanDraft = Readonly<{
  banText?: string | null;
  durationMinutes?: number | null;
}>;

export type TestUiReplySource = Readonly<{
  kind?: string;
  itemId?: string;
  banId?: string;
}>;

export type TestUiDomainTimer = Readonly<{
  id?: string;
  banId?: string;
  startedAt?: number;
  durationMinutes?: number;
  state?: string;
}>;

export type TestUiCheckPair = Readonly<{
  id?: string;
  banId?: string;
  receiverAnswer?: string | null;
  senderAnswer?: string | null;
  resultingStatus?: string | null;
}>;

export type TestUiPriorities = Readonly<{
  statusItemId?: string | null;
  timerItemId?: string | null;
}>;

export type TestUiScreenDiagnostics = Readonly<{
  controlState: string | null;
  currentUserId: string;
  selectedContactId: string | null;
  createBanDraft: TestUiCreateBanDraft | null;
  contacts: readonly TestUiContact[];
  bans?: readonly TestUiBan[];
  incomingItems?: readonly TestUiNotificationItem[];
  notificationItems?: readonly TestUiNotificationItem[];
  activeNotificationItemId?: string | null;
  hasUnprocessedNotifications?: boolean;
  replyBanDraft?: TestUiReplyBanDraft | null;
  replySource?: TestUiReplySource | null;
  successfulBanId?: string | null;
  domainTimers?: readonly TestUiDomainTimer[];
  checkPairs?: readonly TestUiCheckPair[];
  priorities?: TestUiPriorities;
  activeShareAttemptId?: string | null;
  telegramShare?: Readonly<{
    attemptId: string;
    token: string;
    preparedMessageId: string;
    shareUrl: string;
    api: "shareMessage";
  }> | null;
  telegramPersistentReentryEligible?: boolean;
  telegramPersistentReentryEstablished?: boolean;
  telegramPersistentReentryActiveRequestId?: string | null;
  telegramPersistentReentry?: Readonly<{
    showCta: boolean;
    label: string;
    api: "requestWriteAccess";
  }> | null;
  rimChat?: TestUiRimChat | null;
}>;

export type TestUiRimProposal = Readonly<{
  proposalId: string;
  banText: string;
  executionProbability: number;
}>;

export type TestUiRimMessage = Readonly<{
  kind: "USER" | "RIM" | "BAN_PROPOSALS";
  text?: string;
  message?: string;
  proposals?: readonly TestUiRimProposal[];
}>;

export type TestUiRimChat = Readonly<{
  id: string;
  selectedContactId: string | null;
  messages: readonly TestUiRimMessage[];
  inputDraft: string;
  relationshipContext: {
    status: "loading" | "ready" | "error";
    requestId: string;
  } | null;
  aiOperation: {
    status: "IDLE" | "PENDING" | "FAILED";
    requestId?: string;
  };
}>;

export type ProductScreenRender = Readonly<{
  screenId: TestUiScreenId;
  title: string;
  html: string;
}>;

export type RenderProductScreenOptions = Readonly<{
  sending?: boolean;
}>;

export function productScreenIdFor(controlState: string | null | undefined): TestUiScreenId {
  if (controlState === undefined) {
    return "DisconnectedTestScreen";
  }
  if (controlState === null) {
    return "EmptySnapshotTestScreen";
  }
  return (
    PRODUCT_SCREEN_BY_CONTROL_STATE[controlState as keyof typeof PRODUCT_SCREEN_BY_CONTROL_STATE] ??
    "UnsupportedProductTestScreen"
  );
}

export function renderProductScreen(
  diagnostics: TestUiScreenDiagnostics | null,
  options: RenderProductScreenOptions = {},
): ProductScreenRender {
  if (diagnostics === null) {
    return disconnectedScreen();
  }
  const screenId = productScreenIdFor(diagnostics.controlState);
  let screen: ProductScreenRender;
  switch (screenId) {
    case "DisconnectedTestScreen":
      screen = disconnectedScreen();
      break;
    case "EmptySnapshotTestScreen":
      screen = emptySnapshotScreen(diagnostics);
      break;
    case "LobbyTestScreen":
      screen = lobbyScreen(diagnostics);
      break;
    case "RimChatTestScreen":
      screen = rimChatScreen(diagnostics);
      break;
    case "RimSelectContactTestScreen":
      screen = rimSelectContactScreen(diagnostics);
      break;
    case "CreateBanWhatRimTestScreen":
      screen = whatRimScreen(diagnostics);
      break;
    case "CreateBanConfirmRimTestScreen":
      screen = confirmRimScreen(diagnostics, options.sending === true);
      break;
    case "CreateBanWhoTestScreen":
      screen = whoScreen(diagnostics);
      break;
    case "CreateBanWhatContactTestScreen":
      screen = whatContactScreen(diagnostics);
      break;
    case "CreateBanWhatTemplateTestScreen":
      screen = whatTemplateScreen(diagnostics);
      break;
    case "CreateBanConfirmContactTestScreen":
      screen = confirmContactScreen(diagnostics, options.sending === true);
      break;
    case "CreateBanConfirmTemplateTestScreen":
      screen = confirmTemplateScreen(diagnostics, options.sending === true);
      break;
    case "CreateBanSharePendingTestScreen":
      screen = sharePendingScreen(diagnostics);
      break;
    case "CreateBanSuccessTestScreen":
      screen = successScreen(diagnostics);
      break;
    case "IncomingBanTestScreen":
      screen = incomingBanScreen(diagnostics, options.sending === true);
      break;
    case "StatusOverboardReceiverTestScreen":
      screen = overboardStatusScreen(
        diagnostics,
        diagnostics.controlState === "NOTIFICATIONS.STATUS.OVERBOARD.SENDER"
          ? "SENDER"
          : "RECEIVER",
      );
      break;
    case "ReplyBanWhatFromIncomingTestScreen":
      screen = replyBanWhatFromIncomingScreen(diagnostics);
      break;
    case "ReplyBanConfirmFromIncomingTestScreen":
      screen = replyBanConfirmFromIncomingScreen(diagnostics, options.sending === true);
      break;
    case "ReplyBanSuccessFromIncomingTestScreen":
      screen = replyBanSuccessFromIncomingScreen(diagnostics);
      break;
    case "ReplyBanWhatFromStatusTestScreen":
      screen = replyBanWhatFromStatusScreen(diagnostics);
      break;
    case "ReplyBanConfirmFromStatusTestScreen":
      screen = replyBanConfirmFromStatusScreen(diagnostics, options.sending === true);
      break;
    case "ReplyBanSuccessFromStatusTestScreen":
      screen = replyBanSuccessFromStatusScreen(diagnostics);
      break;
    case "TimerTestScreen":
      screen = timerScreen(diagnostics);
      break;
    case "CheckReceiverTestScreen":
      screen = checkScreen(diagnostics, "RECEIVER", options.sending === true);
      break;
    case "CheckSenderTestScreen":
      screen = checkScreen(diagnostics, "SENDER", options.sending === true);
      break;
    case "StatusBantasticReceiverTestScreen":
      screen = derivedStatusScreen(diagnostics, "BANTASTIC", "RECEIVER");
      break;
    case "StatusBantasticSenderTestScreen":
      screen = derivedStatusScreen(diagnostics, "BANTASTIC", "SENDER");
      break;
    case "StatusBanflictReceiverTestScreen":
      screen = derivedStatusScreen(diagnostics, "BANFLICT", "RECEIVER");
      break;
    case "StatusBanflictSenderTestScreen":
      screen = derivedStatusScreen(diagnostics, "BANFLICT", "SENDER");
      break;
    case "StatusFairEnoughReceiverTestScreen":
      screen = derivedStatusScreen(diagnostics, "FAIR_ENOUGH", "RECEIVER");
      break;
    case "StatusFairEnoughSenderTestScreen":
      screen = derivedStatusScreen(diagnostics, "FAIR_ENOUGH", "SENDER");
      break;
    case "UnsupportedProductTestScreen":
      screen = unsupportedScreen(diagnostics);
      break;
  }
  const cta = telegramPersistentReentryCtaHtml(diagnostics);
  return cta.length === 0 ? screen : { ...screen, html: `${screen.html}${cta}` };
}

/** Nonblocking overlay — must not appear in PRODUCT_SCREEN_BY_CONTROL_STATE. */
export function telegramPersistentReentryCtaHtml(diagnostics: TestUiScreenDiagnostics): string {
  const cta = diagnostics.telegramPersistentReentry;
  if (!cta?.showCta) {
    return "";
  }
  return [
    '<aside class="telegram-persistent-reentry-cta" data-telegram-persistent-reentry-cta="1" data-nonblocking="1">',
    `<button type="button" data-action="telegram-persistent-reentry-pin">${escapeHtml(cta.label)}</button>`,
    '<p class="dev-label">DEV ONLY — simulate requestWriteAccess outside Telegram (does not fake production grant).</p>',
    '<div class="row"><button type="button" data-action="telegram-persistent-reentry-dev-grant" data-dev-only="reentry">DEV: GRANT</button>',
    '<button type="button" data-action="telegram-persistent-reentry-dev-decline" data-dev-only="reentry">DEV: DECLINE</button></div>',
    "</aside>",
  ].join("");
}

function disconnectedScreen(): ProductScreenRender {
  return wrap(
    "DisconnectedTestScreen",
    "NO PRODUCT SCREEN",
    "<p>Connect in DEV / AUTH CONTROLS. Product screens follow backend controlState only.</p>",
  );
}

function emptySnapshotScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  return wrap(
    "EmptySnapshotTestScreen",
    "NO CONTROL STATE",
    [
      "<p>This snapshot has no Product Control State.</p>",
      `<p>Current user: <code>${escapeHtml(diagnostics.currentUserId)}</code></p>`,
      "<p>Use Connect / open lobby in DEV / AUTH if this user needs RIM.LOBBY. Incoming, OVERBOARD, Reply Ban, and Timer screens appear only when backend controlState reaches those frozen states.</p>",
    ].join(""),
  );
}

function lobbyScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const notifications =
    diagnostics.hasUnprocessedNotifications === true
      ? actionButton("NOTIFICATIONS", "RIM.PRESS_NOTIFICATIONS")
      : "";
  return wrap(
    "LobbyTestScreen",
    "RIM LOBBY",
    [
      actionButton("START CHAT", "RIM.PRESS_START_CHAT"),
      actionButton("CREATE BAN", "CREATE_BAN.PRESS_START"),
      notifications,
    ].join(""),
  );
}

function whoScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const selectable = diagnostics.contacts.filter(
    (contact) => contact.userId !== diagnostics.currentUserId,
  );
  const choices =
    selectable.length === 0
      ? "<p class='warn'>No other registered 98+ users are selectable.</p>"
      : selectable
          .map((contact) => {
            return [
              '<div class="receiver-choice">',
              `<div>UserId: <code data-contact-user-id="${escapeAttr(contact.userId)}">${escapeHtml(contact.userId)}</code></div>`,
              `<div class="dev-label">dev telegram (not identity): ${escapeHtml(contact.telegramUserId)}</div>`,
              actionButton("Choose", "CREATE_BAN.SELECT_CONTACT", {
                contactId: contact.userId,
              }),
              "</div>",
            ].join("");
          })
          .join("");
  return wrap(
    "CreateBanWhoTestScreen",
    "CREATE BAN — WHO",
    [
      "<p>Choose receiver:</p>",
      choices,
      actionButton("TEMPLATE", "CREATE_BAN.SELECT_TEMPLATE"),
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
    ].join(""),
  );
}

function whatTemplateScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const draft = diagnostics.createBanDraft ?? {};
  const banText = draft.banText ?? "";
  const duration =
    draft.durationMinutes === null || draft.durationMinutes === undefined
      ? ""
      : String(draft.durationMinutes);
  return wrap(
    "CreateBanWhatTemplateTestScreen",
    "CREATE BAN — WHAT (TEMPLATE)",
    [
      "<p>Template Ban — receiver is not predetermined.</p>",
      '<div class="row"><label for="banText">Ban text</label> ',
      `<input id="banText" data-change-event="CREATE_BAN.CHANGE_BAN_TEXT" data-change-field="banText" value="${escapeAttr(banText)}" /></div>`,
      '<div class="row"><label for="durationMinutes">Duration</label> ',
      `<input id="durationMinutes" type="number" step="1" data-change-event="CREATE_BAN.CHANGE_DURATION" data-change-field="durationMinutes" data-change-type="number" value="${escapeAttr(duration)}" placeholder="3–60" /></div>`,
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
      actionButton("NEXT", "CREATE_BAN.PRESS_NEXT"),
    ].join(""),
  );
}

function confirmTemplateScreen(
  diagnostics: TestUiScreenDiagnostics,
  sending: boolean,
): ProductScreenRender {
  const draft = diagnostics.createBanDraft ?? {};
  const forbidDisabled = sending ? " disabled" : "";
  return wrap(
    "CreateBanConfirmTemplateTestScreen",
    "CREATE BAN — CONFIRM (TEMPLATE)",
    [
      `<p>Ban: <span data-template-text="${escapeAttr(String(draft.banText ?? ""))}">${escapeHtml(JSON.stringify(draft.banText ?? ""))}</span></p>`,
      `<p>Duration: <span data-template-duration="${escapeAttr(String(draft.durationMinutes ?? "(none)"))}">${escapeHtml(String(draft.durationMinutes ?? "(none)"))}</span></p>`,
      "<p>Receiver: not set until Share Link resolution (External Entry).</p>",
      sending
        ? "<p>Opening Telegram Share… Ban is not created until CREATE_BAN.SHARE_CONFIRMED.</p>"
        : "",
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
      `<div class="row"><button type="button" data-event="CREATE_BAN.PRESS_FORBID"${forbidDisabled}>FORBID / SHARE</button></div>`,
    ].join(""),
  );
}

function sharePendingScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const share = diagnostics.telegramShare;
  const attemptId = share?.attemptId ?? diagnostics.activeShareAttemptId ?? "(none)";
  return wrap(
    "CreateBanSharePendingTestScreen",
    "CREATE BAN — SHARE PENDING",
    [
      "<p>Active Telegram Share attempt. Product Ban is not created yet.</p>",
      `<p>Share attempt: <code data-share-attempt="${escapeAttr(String(attemptId))}">${escapeHtml(String(attemptId))}</code></p>`,
      share?.preparedMessageId
        ? `<p>Prepared message: <code data-prepared-message="${escapeAttr(share.preparedMessageId)}">${escapeHtml(share.preparedMessageId)}</code></p>`
        : '<p class="warn">Prepared message id missing — Telegram.WebApp.shareMessage cannot run until Bot API prepare succeeds.</p>',
      share?.shareUrl
        ? `<p>Share URL: <code data-share-url="${escapeAttr(share.shareUrl)}">${escapeHtml(share.shareUrl)}</code></p>`
        : "",
      '<p class="dev-label">DEV ONLY — isolated share outcome (not a product CTA). Prefer Telegram.WebApp.shareMessage callback.</p>',
      `<div class="row"><button type="button" data-event="CREATE_BAN.SHARE_CONFIRMED" data-share-attempt-id="${escapeAttr(String(attemptId))}" data-dev-only="share-outcome">DEV: SHARE_CONFIRMED</button></div>`,
      `<div class="row"><button type="button" data-event="CREATE_BAN.SHARE_CANCELLED" data-share-attempt-id="${escapeAttr(String(attemptId))}" data-dev-only="share-outcome">DEV: SHARE_CANCELLED</button></div>`,
    ].join(""),
  );
}

function whatContactScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const draft = diagnostics.createBanDraft ?? {};
  const receiverId = draft.selectedContactId ?? diagnostics.selectedContactId ?? "(none)";
  const banText = draft.banText ?? "";
  const duration =
    draft.durationMinutes === null || draft.durationMinutes === undefined
      ? ""
      : String(draft.durationMinutes);
  return wrap(
    "CreateBanWhatContactTestScreen",
    "CREATE BAN — WHAT",
    [
      `<p>Receiver: <code data-selected-receiver="${escapeAttr(String(receiverId))}">${escapeHtml(String(receiverId))}</code></p>`,
      '<div class="row"><label for="banText">Ban text</label> ',
      `<input id="banText" data-change-event="CREATE_BAN.CHANGE_BAN_TEXT" data-change-field="banText" value="${escapeAttr(banText)}" /></div>`,
      '<div class="row"><label for="durationMinutes">Duration</label> ',
      `<input id="durationMinutes" type="number" step="1" data-change-event="CREATE_BAN.CHANGE_DURATION" data-change-field="durationMinutes" data-change-type="number" value="${escapeAttr(duration)}" placeholder="3–60" /></div>`,
      "<p>Kernel remains authoritative for text/duration rules. This screen does not replace Matrix guards.</p>",
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
      actionButton("NEXT", "CREATE_BAN.PRESS_NEXT"),
    ].join(""),
  );
}

function confirmContactScreen(
  diagnostics: TestUiScreenDiagnostics,
  sending: boolean,
): ProductScreenRender {
  const draft = diagnostics.createBanDraft ?? {};
  const forbidDisabled = sending ? " disabled" : "";
  return wrap(
    "CreateBanConfirmContactTestScreen",
    "CREATE BAN — CONFIRM",
    [
      `<p>Receiver: <code>${escapeHtml(String(draft.selectedContactId ?? diagnostics.selectedContactId ?? "(none)"))}</code></p>`,
      `<p>Ban: ${escapeHtml(JSON.stringify(draft.banText ?? ""))}</p>`,
      `<p>Duration: ${escapeHtml(String(draft.durationMinutes ?? "(none)"))}</p>`,
      sending
        ? '<p id="confirm-sending">Sending… E-08 is dispatched; backend then completes CREATE_BAN_SEND with E-10 or E-11. SUCCESS is not local.</p>'
        : "",
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
      `<div class="row"><button type="button" data-event="CREATE_BAN.PRESS_FORBID"${forbidDisabled}>FORBID</button></div>`,
    ].join(""),
  );
}

function successScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const projected = projectSuccessfulBan(diagnostics);
  if (!projected.ok) {
    return wrap(
      "CreateBanSuccessTestScreen",
      "SUCCESS",
      [
        `<p class="warn" data-binding-error="${escapeAttr(projected.reason)}">${escapeHtml(projected.reason)}</p>`,
        actionButton("FORBID AGAIN", "CREATE_BAN.PRESS_FORBID_MORE"),
        "<p>Incoming remains owner-scoped to the receiver snapshot. Switch user in DEV / AUTH to inspect it.</p>",
      ].join(""),
    );
  }
  const { receiver, banText, duration } = projected;
  return wrap(
    "CreateBanSuccessTestScreen",
    "SUCCESS",
    [
      "<p>Ban sent.</p>",
      `<p>Receiver: <code data-success-receiver="${escapeAttr(receiver)}">${escapeHtml(receiver)}</code></p>`,
      `<p>Ban: <span data-success-text="${escapeAttr(banText)}">${escapeHtml(JSON.stringify(banText))}</span></p>`,
      `<p>Duration: <span data-success-duration="${escapeAttr(String(duration))}">${escapeHtml(String(duration))}</span></p>`,
      actionButton("FORBID AGAIN", "CREATE_BAN.PRESS_FORBID_MORE"),
      "<p>Incoming remains owner-scoped to the receiver snapshot. Switch user in DEV / AUTH to inspect it.</p>",
    ].join(""),
  );
}

/**
 * CREATE_BAN.SUCCESS identifies the Ban by successfulBanId.
 * bans[0] is only a fallback when that id is absent (draft-only and older fixtures).
 */
function projectSuccessfulBan(
  diagnostics: TestUiScreenDiagnostics,
):
  | { ok: true; receiver: string; banText: string; duration: number | string }
  | { ok: false; reason: string } {
  if (diagnostics.successfulBanId) {
    const successfulBan = diagnostics.bans?.find((ban) => ban.id === diagnostics.successfulBanId);
    if (!successfulBan) {
      return {
        ok: false,
        reason: `TEST UI INVARIANT: successfulBanId ${diagnostics.successfulBanId} is not in bans.`,
      };
    }
    return {
      ok: true,
      receiver: String(successfulBan.receiverId ?? "(none)"),
      banText: successfulBan.banText ?? "",
      duration: successfulBan.durationMinutes ?? "(none)",
    };
  }
  const draft = diagnostics.createBanDraft ?? {};
  const ban = diagnostics.bans?.[0];
  return {
    ok: true,
    receiver: String(
      draft.selectedContactId ?? diagnostics.selectedContactId ?? ban?.receiverId ?? "(none)",
    ),
    banText: draft.banText ?? ban?.banText ?? "",
    duration: draft.durationMinutes ?? ban?.durationMinutes ?? "(none)",
  };
}

function incomingBanScreen(
  diagnostics: TestUiScreenDiagnostics,
  sending: boolean,
): ProductScreenRender {
  const bound = bindActiveNotification(diagnostics, "INCOMING_BAN");
  if (!bound.ok) {
    return wrap(
      "IncomingBanTestScreen",
      "INCOMING BAN",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        `<p>Active item id: <code>${escapeHtml(String(diagnostics.activeNotificationItemId ?? "(none)"))}</code></p>`,
        `<div class="row"><button type="button" data-event="NOTIFICATIONS.PRESS_OVERBOARD"${sending ? " disabled" : ""}>OVERBOARD</button></div>`,
        `<div class="row"><button type="button" data-event="NOTIFICATIONS.PRESS_REPLY_BAN"${sending ? " disabled" : ""}>ЗАПРЕТИТЬ В ОТВЕТ</button></div>`,
      ].join(""),
    );
  }
  const { item, ban } = bound;
  const overboardDisabled = sending ? " disabled" : "";
  return wrap(
    "IncomingBanTestScreen",
    "INCOMING BAN",
    [
      `<p>From: <code data-incoming-sender="${escapeAttr(String(ban.senderId ?? "(none)"))}">${escapeHtml(String(ban.senderId ?? "(none)"))}</code></p>`,
      `<p>Ban: <span data-incoming-text="${escapeAttr(String(ban.banText ?? ""))}">${escapeHtml(JSON.stringify(ban.banText ?? ""))}</span></p>`,
      `<p>Duration: <span data-incoming-duration="${escapeAttr(String(ban.durationMinutes ?? "(none)"))}">${escapeHtml(String(ban.durationMinutes ?? "(none)"))}</span></p>`,
      `<p>Active item: <code data-active-incoming="${escapeAttr(String(item.id ?? "(none)"))}">${escapeHtml(String(item.id ?? "(none)"))}</code></p>`,
      sending
        ? '<p id="incoming-overboard-sending">OVERBOARD… E-15 is dispatched; backend then completes with E-20 or E-21. Result is not local.</p>'
        : "",
      `<div class="row"><button type="button" data-event="NOTIFICATIONS.PRESS_OVERBOARD"${overboardDisabled}>OVERBOARD</button></div>`,
      `<div class="row"><button type="button" data-event="NOTIFICATIONS.PRESS_REPLY_BAN"${overboardDisabled}>ЗАПРЕТИТЬ В ОТВЕТ</button></div>`,
    ].join(""),
  );
}

/**
 * N-05 / N-06 Status OVERBOARD content inside the existing Notifications TEST UI.
 * Same Product Screen identity for both roles; controlState selects RECEIVER vs SENDER.
 */
function overboardStatusScreen(
  diagnostics: TestUiScreenDiagnostics,
  role: "RECEIVER" | "SENDER",
): ProductScreenRender {
  const bound = bindActiveNotification(diagnostics, "STATUS", { role, status: "OVERBOARD" });
  const title = `STATUS OVERBOARD ${role}`;
  const actions = statusRoleActions(role);
  if (!bound.ok) {
    return wrap(
      "StatusOverboardReceiverTestScreen",
      title,
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        `<p>Active item id: <code>${escapeHtml(String(diagnostics.activeNotificationItemId ?? "(none)"))}</code></p>`,
        actions,
      ].join(""),
    );
  }
  const { item, ban } = bound;
  return wrap(
    "StatusOverboardReceiverTestScreen",
    title,
    [
      "<p>OVERBOARD result.</p>",
      `<p>Ban acceptance: <code data-ban-acceptance="${escapeAttr(String(ban.acceptance ?? "(none)"))}">${escapeHtml(String(ban.acceptance ?? "(none)"))}</code></p>`,
      `<p>Ban status: <code data-ban-status="${escapeAttr(String(ban.status ?? "(none)"))}">${escapeHtml(String(ban.status ?? "(none)"))}</code></p>`,
      `<p>From: <code data-status-sender="${escapeAttr(String(ban.senderId ?? "(none)"))}">${escapeHtml(String(ban.senderId ?? "(none)"))}</code></p>`,
      `<p>Ban: <span data-status-text="${escapeAttr(String(ban.banText ?? ""))}">${escapeHtml(JSON.stringify(ban.banText ?? ""))}</span></p>`,
      `<p>Duration: <span data-status-duration="${escapeAttr(String(ban.durationMinutes ?? "(none)"))}">${escapeHtml(String(ban.durationMinutes ?? "(none)"))}</span></p>`,
      `<p>Active Status: <code data-active-status="${escapeAttr(String(item.id ?? "(none)"))}">${escapeHtml(String(item.id ?? "(none)"))}</code></p>`,
      `<p>Role: <code data-status-role="${escapeAttr(role)}">${escapeHtml(role)}</code></p>`,
      actions,
    ].join(""),
  );
}

function statusRoleActions(role: "RECEIVER" | "SENDER"): string {
  const stage10 =
    role === "RECEIVER"
      ? actionButton("ЗАПРЕТИТЬ В ОТВЕТ", "NOTIFICATIONS.PRESS_REPLY_BAN")
      : actionButton("ЗАПРЕТИТЬ ЕЩЁ", "NOTIFICATIONS.PRESS_BAN_MORE");
  return [
    stage10,
    actionButton("К ЗАПРЕТАМ", "NOTIFICATIONS.PRESS_TO_BANS"),
    actionButton("спросить RIM", "NOTIFICATIONS.PRESS_ASK_RIM"),
  ].join("");
}

type ActiveBinding =
  { ok: true; item: TestUiNotificationItem; ban: TestUiBan } | { ok: false; reason: string };

function bindActiveNotification(
  diagnostics: TestUiScreenDiagnostics,
  expectedKind: "INCOMING_BAN" | "STATUS" | "TIMER" | "CHECK",
  expected?: { role?: string; status?: string },
): ActiveBinding {
  const activeId = diagnostics.activeNotificationItemId;
  if (activeId === undefined || activeId === null || activeId === "") {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: ${diagnostics.controlState ?? "(null)"} requires activeNotificationItemId.`,
    };
  }
  const item =
    (diagnostics.notificationItems ?? []).find((candidate) => candidate.id === activeId) ??
    (diagnostics.incomingItems ?? []).find((candidate) => candidate.id === activeId);
  if (!item) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: activeNotificationItemId ${activeId} is not in notificationItems.`,
    };
  }
  if (item.kind !== expectedKind) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: active item ${activeId} kind is ${item.kind ?? "(none)"}, expected ${expectedKind}.`,
    };
  }
  if (item.ownerId !== undefined && item.ownerId !== diagnostics.currentUserId) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: active item ${activeId} owner ${item.ownerId} is not the current user.`,
    };
  }
  if (expected?.role !== undefined && item.role !== expected.role) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: active item ${activeId} role is ${item.role ?? "(none)"}, expected ${expected.role}.`,
    };
  }
  if (expected?.status !== undefined && item.status !== expected.status) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: active item ${activeId} status is ${item.status ?? "(none)"}, expected ${expected.status}.`,
    };
  }
  if (item.banId === undefined || item.banId === "") {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: active item ${activeId} has no banId.`,
    };
  }
  const ban = (diagnostics.bans ?? []).find((candidate) => candidate.id === item.banId);
  if (!ban) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: no Ban matches active item ${activeId} banId ${item.banId}.`,
    };
  }
  return { ok: true, item, ban };
}

function replyBanWhatFromIncomingScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const bound = bindReplySource(diagnostics);
  const draft = diagnostics.replyBanDraft ?? {};
  const banText = draft.banText ?? "";
  const duration =
    draft.durationMinutes === null || draft.durationMinutes === undefined
      ? ""
      : String(draft.durationMinutes);
  if (!bound.ok) {
    return wrap(
      "ReplyBanWhatFromIncomingTestScreen",
      "REPLY BAN — WHAT",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
        actionButton("NEXT", "REPLY_BAN.PRESS_NEXT"),
      ].join(""),
    );
  }
  const { originalBan, otherParticipantId } = bound;
  return wrap(
    "ReplyBanWhatFromIncomingTestScreen",
    "REPLY BAN — WHAT",
    [
      `<p>Reply to: <code data-reply-to="${escapeAttr(otherParticipantId)}">${escapeHtml(otherParticipantId)}</code></p>`,
      `<p>Source Ban: <code data-source-ban="${escapeAttr(String(originalBan.id ?? "(none)"))}">${escapeHtml(String(originalBan.id ?? "(none)"))}</code></p>`,
      `<p>Source from: <code data-source-sender="${escapeAttr(String(originalBan.senderId ?? "(none)"))}">${escapeHtml(String(originalBan.senderId ?? "(none)"))}</code></p>`,
      `<p>Source text: <span data-source-text="${escapeAttr(String(originalBan.banText ?? ""))}">${escapeHtml(JSON.stringify(originalBan.banText ?? ""))}</span></p>`,
      `<p>Source duration: <span data-source-duration="${escapeAttr(String(originalBan.durationMinutes ?? "(none)"))}">${escapeHtml(String(originalBan.durationMinutes ?? "(none)"))}</span></p>`,
      '<div class="row"><label for="replyBanText">Reply Ban</label> ',
      `<input id="replyBanText" data-change-event="REPLY_BAN.CHANGE_BAN_TEXT" data-change-field="banText" value="${escapeAttr(String(banText))}" /></div>`,
      '<div class="row"><label for="replyDurationMinutes">Duration</label> ',
      `<input id="replyDurationMinutes" type="number" step="1" data-change-event="REPLY_BAN.CHANGE_DURATION" data-change-field="durationMinutes" data-change-type="number" value="${escapeAttr(duration)}" placeholder="3–60" /></div>`,
      actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
      actionButton("NEXT", "REPLY_BAN.PRESS_NEXT"),
    ].join(""),
  );
}

function replyBanConfirmFromIncomingScreen(
  diagnostics: TestUiScreenDiagnostics,
  sending: boolean,
): ProductScreenRender {
  const bound = bindReplySource(diagnostics);
  const draft = diagnostics.replyBanDraft ?? {};
  const forbidDisabled = sending ? " disabled" : "";
  if (!bound.ok) {
    return wrap(
      "ReplyBanConfirmFromIncomingTestScreen",
      "REPLY BAN — CONFIRM",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
        `<div class="row"><button type="button" data-event="REPLY_BAN.PRESS_FORBID"${forbidDisabled}>FORBID</button></div>`,
      ].join(""),
    );
  }
  const { originalBan, otherParticipantId } = bound;
  return wrap(
    "ReplyBanConfirmFromIncomingTestScreen",
    "REPLY BAN — CONFIRM",
    [
      `<p>Receiver: <code data-reply-receiver="${escapeAttr(otherParticipantId)}">${escapeHtml(otherParticipantId)}</code></p>`,
      `<p>Source Ban: <code data-source-ban="${escapeAttr(String(originalBan.id ?? "(none)"))}">${escapeHtml(String(originalBan.id ?? "(none)"))}</code></p>`,
      `<p>Reply Ban: <span data-reply-text="${escapeAttr(String(draft.banText ?? ""))}">${escapeHtml(JSON.stringify(draft.banText ?? ""))}</span></p>`,
      `<p>Duration: <span data-reply-duration="${escapeAttr(String(draft.durationMinutes ?? "(none)"))}">${escapeHtml(String(draft.durationMinutes ?? "(none)"))}</span></p>`,
      sending
        ? '<p id="reply-confirm-sending">Sending… E-28 is dispatched; backend then completes REPLY_BAN_SEND with E-30 or E-31. SUCCESS is not local.</p>'
        : "",
      actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
      `<div class="row"><button type="button" data-event="REPLY_BAN.PRESS_FORBID"${forbidDisabled}>FORBID</button></div>`,
    ].join(""),
  );
}

function replyBanSuccessFromIncomingScreen(
  diagnostics: TestUiScreenDiagnostics,
): ProductScreenRender {
  const bound = bindReplySource(diagnostics);
  if (!bound.ok) {
    return wrap(
      "ReplyBanSuccessFromIncomingTestScreen",
      "REPLY BAN — SUCCESS",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        actionButton("ЗАПРЕТИТЬ ЕЩЁ", "REPLY_BAN.PRESS_FORBID_MORE"),
      ].join(""),
    );
  }
  const { originalBan, sourceItem } = bound;
  const replyBan = (diagnostics.bans ?? []).find(
    (candidate) => candidate.id === diagnostics.successfulBanId,
  );
  const timerItem = (diagnostics.notificationItems ?? []).find(
    (candidate) => candidate.kind === "TIMER" && candidate.banId === originalBan.id,
  );
  const timer = (diagnostics.domainTimers ?? []).find(
    (candidate) => candidate.banId === originalBan.id,
  );
  if (diagnostics.successfulBanId && !replyBan) {
    return wrap(
      "ReplyBanSuccessFromIncomingTestScreen",
      "REPLY BAN — SUCCESS",
      [
        `<p class="warn" data-binding-error="TEST UI INVARIANT: successfulBanId ${diagnostics.successfulBanId} is not in bans.">TEST UI INVARIANT: successfulBanId ${escapeHtml(diagnostics.successfulBanId)} is not in bans.</p>`,
        actionButton("ЗАПРЕТИТЬ ЕЩЁ", "REPLY_BAN.PRESS_FORBID_MORE"),
      ].join(""),
    );
  }
  return wrap(
    "ReplyBanSuccessFromIncomingTestScreen",
    "REPLY BAN — SUCCESS",
    [
      "<p>Reply Ban sent. Timer is not shown as the active Notifications card here.</p>",
      `<p>Source Ban: <code data-source-ban="${escapeAttr(String(originalBan.id ?? "(none)"))}">${escapeHtml(String(originalBan.id ?? "(none)"))}</code></p>`,
      `<p>Source acceptance: <code data-source-acceptance="${escapeAttr(String(originalBan.acceptance ?? "(none)"))}">${escapeHtml(String(originalBan.acceptance ?? "(none)"))}</code></p>`,
      `<p>Source Incoming: <code data-source-incoming="${escapeAttr(String(sourceItem.id ?? "(none)"))}">${escapeHtml(String(sourceItem.id ?? "(none)"))}</code> ${escapeHtml(sourceItem.lifecycle?.status ?? "(none)")}</p>`,
      `<p>Reply Ban: <code data-reply-ban="${escapeAttr(String(replyBan?.id ?? "(none)"))}">${escapeHtml(String(replyBan?.id ?? "(none)"))}</code></p>`,
      `<p>Reply from: <code data-reply-sender="${escapeAttr(String(replyBan?.senderId ?? "(none)"))}">${escapeHtml(String(replyBan?.senderId ?? "(none)"))}</code></p>`,
      `<p>Reply to: <code data-reply-receiver="${escapeAttr(String(replyBan?.receiverId ?? "(none)"))}">${escapeHtml(String(replyBan?.receiverId ?? "(none)"))}</code></p>`,
      `<p>Reply text: <span data-reply-text="${escapeAttr(String(replyBan?.banText ?? ""))}">${escapeHtml(JSON.stringify(replyBan?.banText ?? ""))}</span></p>`,
      `<p>Timer exists: <code data-timer-exists="${timerItem ? "true" : "false"}">${timerItem ? "true" : "false"}</code></p>`,
      `<p>Duration start: <code data-duration-started-at="${escapeAttr(String(timer?.startedAt ?? "(none)"))}">${escapeHtml(String(timer?.startedAt ?? "(none)"))}</code></p>`,
      actionButton("ЗАПРЕТИТЬ ЕЩЁ", "REPLY_BAN.PRESS_FORBID_MORE"),
    ].join(""),
  );
}

function timerScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const bound = bindActiveNotification(diagnostics, "TIMER");
  if (!bound.ok) {
    return wrap(
      "TimerTestScreen",
      "TIMER",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        `<p>Active item id: <code>${escapeHtml(String(diagnostics.activeNotificationItemId ?? "(none)"))}</code></p>`,
        actionButton("К ЗАПРЕТАМ", "NOTIFICATIONS.PRESS_TO_BANS"),
      ].join(""),
    );
  }
  const { item, ban } = bound;
  const timer =
    (diagnostics.domainTimers ?? []).find((candidate) => candidate.id === item.domainTimerId) ??
    (diagnostics.domainTimers ?? []).find((candidate) => candidate.banId === item.banId);
  return wrap(
    "TimerTestScreen",
    "TIMER",
    [
      `<p>Ban: <code data-timer-ban="${escapeAttr(String(ban.id ?? "(none)"))}">${escapeHtml(String(ban.id ?? "(none)"))}</code></p>`,
      `<p>From: <code data-timer-sender="${escapeAttr(String(ban.senderId ?? "(none)"))}">${escapeHtml(String(ban.senderId ?? "(none)"))}</code></p>`,
      `<p>Ban text: <span data-timer-text="${escapeAttr(String(ban.banText ?? ""))}">${escapeHtml(JSON.stringify(ban.banText ?? ""))}</span></p>`,
      `<p>Duration: <span data-timer-duration="${escapeAttr(String(ban.durationMinutes ?? "(none)"))}">${escapeHtml(String(ban.durationMinutes ?? "(none)"))}</span></p>`,
      `<p>Timer: <code data-timer-item="${escapeAttr(String(item.id ?? "(none)"))}">${escapeHtml(String(item.id ?? "(none)"))}</code></p>`,
      `<p>Timer state: <code data-timer-state="${escapeAttr(String(timer?.state ?? "(none)"))}">${escapeHtml(String(timer?.state ?? "(none)"))}</code></p>`,
      `<p>Started at: <code data-timer-started-at="${escapeAttr(String(timer?.startedAt ?? "(none)"))}">${escapeHtml(String(timer?.startedAt ?? "(none)"))}</code></p>`,
      actionButton("К ЗАПРЕТАМ", "NOTIFICATIONS.PRESS_TO_BANS"),
    ].join(""),
  );
}

type ReplySourceBinding =
  | {
      ok: true;
      sourceItem: TestUiNotificationItem;
      originalBan: TestUiBan;
      otherParticipantId: string;
    }
  | { ok: false; reason: string };

function bindReplySource(
  diagnostics: TestUiScreenDiagnostics,
  expectedKind: "INCOMING_BAN" | "STATUS" = "INCOMING_BAN",
): ReplySourceBinding {
  const source = diagnostics.replySource;
  if (!source?.itemId || !source.banId) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: ${diagnostics.controlState ?? "(null)"} requires replySource itemId and banId.`,
    };
  }
  if (source.kind !== undefined && source.kind !== expectedKind) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: replySource kind is ${source.kind}, expected ${expectedKind}.`,
    };
  }
  const sourceItem =
    (diagnostics.notificationItems ?? []).find((candidate) => candidate.id === source.itemId) ??
    (diagnostics.incomingItems ?? []).find((candidate) => candidate.id === source.itemId);
  if (!sourceItem) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: replySource item ${source.itemId} is not in notificationItems.`,
    };
  }
  if (sourceItem.kind !== undefined && sourceItem.kind !== expectedKind) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: replySource item ${source.itemId} kind is ${sourceItem.kind ?? "(none)"}, expected ${expectedKind}.`,
    };
  }
  if (sourceItem.banId !== undefined && sourceItem.banId !== source.banId) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: replySource item ${source.itemId} banId ${sourceItem.banId} does not match source banId ${source.banId}.`,
    };
  }
  const originalBan = (diagnostics.bans ?? []).find((candidate) => candidate.id === source.banId);
  if (!originalBan) {
    return {
      ok: false,
      reason: `TEST UI INVARIANT: no Ban matches replySource banId ${source.banId}.`,
    };
  }
  const otherParticipantId =
    originalBan.senderId === diagnostics.currentUserId
      ? String(originalBan.receiverId ?? "(none)")
      : String(originalBan.senderId ?? "(none)");
  return { ok: true, sourceItem, originalBan, otherParticipantId };
}

function checkScreen(
  diagnostics: TestUiScreenDiagnostics,
  role: "RECEIVER" | "SENDER",
  sending: boolean,
): ProductScreenRender {
  const screenId = role === "RECEIVER" ? "CheckReceiverTestScreen" : "CheckSenderTestScreen";
  const title = role === "RECEIVER" ? "CHECK RECEIVER" : "CHECK SENDER";
  const bound = bindActiveNotification(diagnostics, "CHECK", { role });
  const fulfilledDisabled = sending ? " disabled" : "";
  if (!bound.ok) {
    return wrap(
      screenId,
      title,
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        `<p>Active item id: <code>${escapeHtml(String(diagnostics.activeNotificationItemId ?? "(none)"))}</code></p>`,
        `<div class="row"><button type="button" data-event="NOTIFICATIONS.CHECK_ANSWER.FULFILLED"${fulfilledDisabled}>FULFILLED</button></div>`,
        `<div class="row"><button type="button" data-event="NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED"${fulfilledDisabled}>NOT FULFILLED</button></div>`,
      ].join(""),
    );
  }
  const { item, ban } = bound;
  const pair = (diagnostics.checkPairs ?? []).find(
    (candidate) => candidate.id === item.checkPairId || candidate.banId === item.banId,
  );
  return wrap(
    screenId,
    title,
    [
      `<p>Role: <code data-check-role="${escapeAttr(role)}">${escapeHtml(role)}</code></p>`,
      `<p>Ban: <code data-check-ban="${escapeAttr(String(ban.id ?? "(none)"))}">${escapeHtml(String(ban.id ?? "(none)"))}</code></p>`,
      `<p>From: <code data-check-sender="${escapeAttr(String(ban.senderId ?? "(none)"))}">${escapeHtml(String(ban.senderId ?? "(none)"))}</code></p>`,
      `<p>Ban text: <span data-check-text="${escapeAttr(String(ban.banText ?? ""))}">${escapeHtml(JSON.stringify(ban.banText ?? ""))}</span></p>`,
      `<p>Active Check: <code data-active-check="${escapeAttr(String(item.id ?? "(none)"))}">${escapeHtml(String(item.id ?? "(none)"))}</code></p>`,
      `<p>Pair: <code data-check-pair="${escapeAttr(String(item.checkPairId ?? pair?.id ?? "(none)"))}">${escapeHtml(String(item.checkPairId ?? pair?.id ?? "(none)"))}</code></p>`,
      sending
        ? '<p id="check-answer-sending">Sending Check answer… E-16/E-17 is dispatched; backend then completes with E-22, E-23, or E-21. Result is not local.</p>'
        : "",
      `<div class="row"><button type="button" data-event="NOTIFICATIONS.CHECK_ANSWER.FULFILLED"${fulfilledDisabled}>FULFILLED</button></div>`,
      `<div class="row"><button type="button" data-event="NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED"${fulfilledDisabled}>NOT FULFILLED</button></div>`,
    ].join(""),
  );
}

function derivedStatusScreen(
  diagnostics: TestUiScreenDiagnostics,
  status: "BANTASTIC" | "BANFLICT" | "FAIR_ENOUGH",
  role: "RECEIVER" | "SENDER",
): ProductScreenRender {
  const screenId =
    status === "BANTASTIC" && role === "RECEIVER"
      ? "StatusBantasticReceiverTestScreen"
      : status === "BANTASTIC" && role === "SENDER"
        ? "StatusBantasticSenderTestScreen"
        : status === "BANFLICT" && role === "RECEIVER"
          ? "StatusBanflictReceiverTestScreen"
          : status === "BANFLICT" && role === "SENDER"
            ? "StatusBanflictSenderTestScreen"
            : status === "FAIR_ENOUGH" && role === "RECEIVER"
              ? "StatusFairEnoughReceiverTestScreen"
              : "StatusFairEnoughSenderTestScreen";
  const title = `STATUS ${status} ${role}`;
  const bound = bindActiveNotification(diagnostics, "STATUS", { role, status });
  const actions = statusRoleActions(role);
  if (!bound.ok) {
    return wrap(
      screenId,
      title,
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        `<p>Active item id: <code>${escapeHtml(String(diagnostics.activeNotificationItemId ?? "(none)"))}</code></p>`,
        actions,
      ].join(""),
    );
  }
  const { item, ban } = bound;
  return wrap(
    screenId,
    title,
    [
      `<p>Ban status: <code data-ban-status="${escapeAttr(String(ban.status ?? "(none)"))}">${escapeHtml(String(ban.status ?? "(none)"))}</code></p>`,
      `<p>From: <code data-status-sender="${escapeAttr(String(ban.senderId ?? "(none)"))}">${escapeHtml(String(ban.senderId ?? "(none)"))}</code></p>`,
      `<p>Ban: <span data-status-text="${escapeAttr(String(ban.banText ?? ""))}">${escapeHtml(JSON.stringify(ban.banText ?? ""))}</span></p>`,
      `<p>Active Status: <code data-active-status="${escapeAttr(String(item.id ?? "(none)"))}">${escapeHtml(String(item.id ?? "(none)"))}</code></p>`,
      `<p>Role: <code data-status-role="${escapeAttr(role)}">${escapeHtml(role)}</code></p>`,
      actions,
    ].join(""),
  );
}

function replyBanWhatFromStatusScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const bound = bindReplySource(diagnostics, "STATUS");
  const draft = diagnostics.replyBanDraft ?? {};
  const banText = draft.banText ?? "";
  const duration =
    draft.durationMinutes === null || draft.durationMinutes === undefined
      ? ""
      : String(draft.durationMinutes);
  if (!bound.ok) {
    return wrap(
      "ReplyBanWhatFromStatusTestScreen",
      "REPLY BAN FROM STATUS — WHAT",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
        actionButton("NEXT", "REPLY_BAN.PRESS_NEXT"),
      ].join(""),
    );
  }
  const { originalBan, otherParticipantId } = bound;
  return wrap(
    "ReplyBanWhatFromStatusTestScreen",
    "REPLY BAN FROM STATUS — WHAT",
    [
      `<p>Reply to: <code data-reply-to="${escapeAttr(otherParticipantId)}">${escapeHtml(otherParticipantId)}</code></p>`,
      `<p>Source Ban: <code data-source-ban="${escapeAttr(String(originalBan.id ?? "(none)"))}">${escapeHtml(String(originalBan.id ?? "(none)"))}</code></p>`,
      `<p>Source from: <code data-source-sender="${escapeAttr(String(originalBan.senderId ?? "(none)"))}">${escapeHtml(String(originalBan.senderId ?? "(none)"))}</code></p>`,
      `<p>Source text: <span data-source-text="${escapeAttr(String(originalBan.banText ?? ""))}">${escapeHtml(JSON.stringify(originalBan.banText ?? ""))}</span></p>`,
      `<p>Source duration: <span data-source-duration="${escapeAttr(String(originalBan.durationMinutes ?? "(none)"))}">${escapeHtml(String(originalBan.durationMinutes ?? "(none)"))}</span></p>`,
      '<div class="row"><label for="replyBanTextFromStatus">Reply Ban</label> ',
      `<input id="replyBanTextFromStatus" data-change-event="REPLY_BAN.CHANGE_BAN_TEXT" data-change-field="banText" value="${escapeAttr(String(banText))}" /></div>`,
      '<div class="row"><label for="replyDurationMinutesFromStatus">Duration</label> ',
      `<input id="replyDurationMinutesFromStatus" type="number" step="1" data-change-event="REPLY_BAN.CHANGE_DURATION" data-change-field="durationMinutes" data-change-type="number" value="${escapeAttr(duration)}" placeholder="3–60" /></div>`,
      actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
      actionButton("NEXT", "REPLY_BAN.PRESS_NEXT"),
    ].join(""),
  );
}

function replyBanConfirmFromStatusScreen(
  diagnostics: TestUiScreenDiagnostics,
  sending: boolean,
): ProductScreenRender {
  const bound = bindReplySource(diagnostics, "STATUS");
  const draft = diagnostics.replyBanDraft ?? {};
  const forbidDisabled = sending ? " disabled" : "";
  if (!bound.ok) {
    return wrap(
      "ReplyBanConfirmFromStatusTestScreen",
      "REPLY BAN FROM STATUS — CONFIRM",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
        `<div class="row"><button type="button" data-event="REPLY_BAN.PRESS_FORBID"${forbidDisabled}>FORBID</button></div>`,
      ].join(""),
    );
  }
  const { originalBan, otherParticipantId } = bound;
  return wrap(
    "ReplyBanConfirmFromStatusTestScreen",
    "REPLY BAN FROM STATUS — CONFIRM",
    [
      `<p>Receiver: <code data-reply-receiver="${escapeAttr(otherParticipantId)}">${escapeHtml(otherParticipantId)}</code></p>`,
      `<p>Source Ban: <code data-source-ban="${escapeAttr(String(originalBan.id ?? "(none)"))}">${escapeHtml(String(originalBan.id ?? "(none)"))}</code></p>`,
      `<p>Reply Ban: <span data-reply-text="${escapeAttr(String(draft.banText ?? ""))}">${escapeHtml(JSON.stringify(draft.banText ?? ""))}</span></p>`,
      `<p>Duration: <span data-reply-duration="${escapeAttr(String(draft.durationMinutes ?? "(none)"))}">${escapeHtml(String(draft.durationMinutes ?? "(none)"))}</span></p>`,
      sending
        ? '<p id="reply-confirm-from-status-sending">Sending… E-28 is dispatched; backend then completes REPLY_BAN_SEND with E-30 or E-31. SUCCESS is not local.</p>'
        : "",
      actionButton("BACK", "REPLY_BAN.PRESS_BACK"),
      `<div class="row"><button type="button" data-event="REPLY_BAN.PRESS_FORBID"${forbidDisabled}>FORBID</button></div>`,
    ].join(""),
  );
}

function replyBanSuccessFromStatusScreen(
  diagnostics: TestUiScreenDiagnostics,
): ProductScreenRender {
  const bound = bindReplySource(diagnostics, "STATUS");
  if (!bound.ok) {
    return wrap(
      "ReplyBanSuccessFromStatusTestScreen",
      "REPLY BAN FROM STATUS — SUCCESS",
      [
        `<p class="warn" data-binding-error="${escapeAttr(bound.reason)}">${escapeHtml(bound.reason)}</p>`,
        actionButton("ЗАПРЕТИТЬ ЕЩЁ", "REPLY_BAN.PRESS_FORBID_MORE"),
      ].join(""),
    );
  }
  const { originalBan, sourceItem } = bound;
  const replyBan = (diagnostics.bans ?? []).find(
    (candidate) => candidate.id === diagnostics.successfulBanId,
  );
  const timerItem = (diagnostics.notificationItems ?? []).find(
    (candidate) => candidate.kind === "TIMER" && candidate.banId === originalBan.id,
  );
  if (diagnostics.successfulBanId && !replyBan) {
    return wrap(
      "ReplyBanSuccessFromStatusTestScreen",
      "REPLY BAN FROM STATUS — SUCCESS",
      [
        `<p class="warn" data-binding-error="TEST UI INVARIANT: successfulBanId ${diagnostics.successfulBanId} is not in bans.">TEST UI INVARIANT: successfulBanId ${escapeHtml(diagnostics.successfulBanId)} is not in bans.</p>`,
        actionButton("ЗАПРЕТИТЬ ЕЩЁ", "REPLY_BAN.PRESS_FORBID_MORE"),
      ].join(""),
    );
  }
  return wrap(
    "ReplyBanSuccessFromStatusTestScreen",
    "REPLY BAN FROM STATUS — SUCCESS",
    [
      "<p>Reply Ban sent. This FROM_STATUS flow creates no Timer.</p>",
      `<p>Source Ban: <code data-source-ban="${escapeAttr(String(originalBan.id ?? "(none)"))}">${escapeHtml(String(originalBan.id ?? "(none)"))}</code></p>`,
      `<p>Source status: <code data-source-ban-status="${escapeAttr(String(originalBan.status ?? "(none)"))}">${escapeHtml(String(originalBan.status ?? "(none)"))}</code></p>`,
      `<p>Source Status: <code data-source-status="${escapeAttr(String(sourceItem.id ?? "(none)"))}">${escapeHtml(String(sourceItem.id ?? "(none)"))}</code> ${escapeHtml(sourceItem.lifecycle?.status ?? "(none)")}</p>`,
      `<p>Reply Ban: <code data-reply-ban="${escapeAttr(String(replyBan?.id ?? "(none)"))}">${escapeHtml(String(replyBan?.id ?? "(none)"))}</code></p>`,
      `<p>Reply from: <code data-reply-sender="${escapeAttr(String(replyBan?.senderId ?? "(none)"))}">${escapeHtml(String(replyBan?.senderId ?? "(none)"))}</code></p>`,
      `<p>Reply to: <code data-reply-receiver="${escapeAttr(String(replyBan?.receiverId ?? "(none)"))}">${escapeHtml(String(replyBan?.receiverId ?? "(none)"))}</code></p>`,
      `<p>Reply text: <span data-reply-text="${escapeAttr(String(replyBan?.banText ?? ""))}">${escapeHtml(JSON.stringify(replyBan?.banText ?? ""))}</span></p>`,
      `<p>FROM_STATUS created Timer: <code data-from-status-created-timer="false">false</code></p>`,
      `<p>Source Ban Timer Item exists (unrelated Timer may exist): <code data-source-ban-timer-item-exists="${timerItem ? "true" : "false"}">${timerItem ? "true" : "false"}</code></p>`,
      actionButton("ЗАПРЕТИТЬ ЕЩЁ", "REPLY_BAN.PRESS_FORBID_MORE"),
    ].join(""),
  );
}

function unsupportedScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  return wrap(
    "UnsupportedProductTestScreen",
    "UNSUPPORTED PRODUCT SCREEN",
    `<p>No TEST screen is registered for <code>${escapeHtml(diagnostics.controlState ?? "(null)")}</code>.</p>`,
  );
}

function wrap(screenId: TestUiScreenId, title: string, body: string): ProductScreenRender {
  return {
    screenId,
    title,
    html: [
      `<article class="product-screen-body" data-screen="${escapeAttr(screenId)}" data-nav="controlState">`,
      `<h3>${escapeHtml(title)}</h3>`,
      body,
      "</article>",
    ].join(""),
  };
}

function rimMessages(chat: TestUiRimChat): string {
  return chat.messages
    .map((message) => {
      if (message.kind === "BAN_PROPOSALS") {
        const proposals = (message.proposals ?? [])
          .map(
            (proposal) =>
              `<li data-proposal-id="${escapeAttr(proposal.proposalId)}"><span>${escapeHtml(proposal.banText)}</span> <span data-execution-probability="${escapeAttr(String(proposal.executionProbability))}">${escapeHtml(String(proposal.executionProbability))}</span> ${actionButton("запретить", "RIM.PRESS_SUGGESTION_FORBID", { proposalId: proposal.proposalId, rimChatId: chat.id })}</li>`,
          )
          .join("");
        return `<article data-rim-message="BAN_PROPOSALS"><p>${escapeHtml(message.message ?? "")}</p><ol>${proposals}</ol></article>`;
      }
      const text = message.text ?? "";
      return `<p data-rim-message="${escapeAttr(message.kind)}">${escapeHtml(text)}</p>`;
    })
    .join("");
}

function rimChatScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const chat = diagnostics.rimChat;
  if (!chat) {
    return wrap("RimChatTestScreen", "RIM CHAT", "<p>Canonical RIM Chat is absent.</p>");
  }
  const context = chat.relationshipContext;
  const ai = chat.aiOperation.status;
  const canSend = context?.status === "ready" && ai === "IDLE";
  const parts = [
    `<p>Chat <code data-rim-chat-id="${escapeAttr(chat.id)}">${escapeHtml(chat.id)}</code></p>`,
    chat.selectedContactId
      ? `<p>Contact <code data-selected-contact="${escapeAttr(chat.selectedContactId)}">${escapeHtml(chat.selectedContactId)}</code></p>`
      : '<p data-selected-contact="absent">selectedContact absent</p>',
    rimMessages(chat),
  ];
  parts.push(actionButton("Выбрать человека", "RIM.PRESS_SELECT_CONTACT"));
  if (context?.status === "loading") {
    parts.push('<p data-context-status="loading">Relationship context loading</p>');
  }
  if (context?.status === "error") {
    parts.push('<p data-context-status="error">Relationship context failed</p>');
    parts.push(
      actionButton("Retry context", "RIM.PRESS_RETRY_CONTEXT", {
        failedRequestId: context.requestId,
      }),
    );
  }
  if (ai === "PENDING") {
    parts.push('<p data-ai-status="pending">RIM is responding</p>');
  }
  if (ai === "FAILED" && chat.aiOperation.requestId) {
    parts.push('<p data-ai-status="failed">RIM request failed</p>');
    parts.push(
      actionButton("Retry AI", "RIM.PRESS_RETRY_AI", {
        failedRequestId: chat.aiOperation.requestId,
      }),
    );
  }
  if (canSend || !chat.selectedContactId) {
    parts.push(
      `<div class="row"><label for="rimInputDraft">Message</label> <input id="rimInputDraft" data-change-event="RIM.CHANGE_INPUT_DRAFT" data-change-field="inputDraft" value="${escapeAttr(chat.inputDraft)}" /></div>`,
    );
    if (canSend) {
      parts.push(actionButton("SEND", "RIM.PRESS_SEND"));
    }
  }
  parts.push(actionButton("BACK", "RIM.PRESS_BACK"));
  return wrap("RimChatTestScreen", "RIM CHAT", parts.join(""));
}

function rimSelectContactScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const selectable = diagnostics.contacts.filter(
    (contact) => contact.userId !== diagnostics.currentUserId,
  );
  const choices =
    selectable.length === 0
      ? "<p class='warn'>No other registered 98+ users are selectable.</p>"
      : selectable
          .map((contact) =>
            [
              '<div class="receiver-choice">',
              `<div>UserId: <code data-contact-user-id="${escapeAttr(contact.userId)}">${escapeHtml(contact.userId)}</code></div>`,
              actionButton("Choose", "RIM.SELECT_CONTACT", { contactId: contact.userId }),
              "</div>",
            ].join(""),
          )
          .join("");
  return wrap(
    "RimSelectContactTestScreen",
    "RIM — SELECT CONTACT",
    ["<p>Choose an internal contact.</p>", choices, actionButton("BACK", "RIM.PRESS_BACK")].join(
      "",
    ),
  );
}

function whatRimScreen(diagnostics: TestUiScreenDiagnostics): ProductScreenRender {
  const draft = diagnostics.createBanDraft ?? {};
  const duration =
    draft.durationMinutes === null || draft.durationMinutes === undefined
      ? ""
      : String(draft.durationMinutes);
  return wrap(
    "CreateBanWhatRimTestScreen",
    "CREATE BAN — WHAT (RIM)",
    [
      "<p>Frozen RIM Chat stays saved. Ban text comes from the selected proposal.</p>",
      `<p>Proposal: <code data-draft-proposal="${escapeAttr(String(draft.proposalId ?? ""))}">${escapeHtml(String(draft.proposalId ?? ""))}</code></p>`,
      `<p>Ban: ${escapeHtml(String(draft.banText ?? ""))}</p>`,
      '<div class="row"><label for="durationMinutes">Duration</label> ',
      `<input id="durationMinutes" type="number" step="1" data-change-event="CREATE_BAN.CHANGE_DURATION" data-change-field="durationMinutes" data-change-type="number" value="${escapeAttr(duration)}" placeholder="3–60" /></div>`,
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
      actionButton("NEXT", "CREATE_BAN.PRESS_NEXT"),
    ].join(""),
  );
}

function confirmRimScreen(
  diagnostics: TestUiScreenDiagnostics,
  sending: boolean,
): ProductScreenRender {
  const draft = diagnostics.createBanDraft ?? {};
  const forbidDisabled = sending ? " disabled" : "";
  return wrap(
    "CreateBanConfirmRimTestScreen",
    "CREATE BAN — CONFIRM (RIM)",
    [
      `<p>Ban: ${escapeHtml(String(draft.banText ?? ""))}</p>`,
      `<p>Duration: ${escapeHtml(String(draft.durationMinutes ?? "(none)"))}</p>`,
      `<p>Proposal: <code>${escapeHtml(String(draft.proposalId ?? ""))}</code></p>`,
      actionButton("BACK", "CREATE_BAN.PRESS_BACK"),
      `<div class="row"><button type="button" data-event="CREATE_BAN.PRESS_FORBID"${forbidDisabled}>FORBID</button></div>`,
    ].join(""),
  );
}

function actionButton(
  label: string,
  eventName: (typeof TEST_UI_USER_EVENT_NAMES)[number],
  extra: {
    contactId?: string;
    proposalId?: string;
    rimChatId?: string;
    failedRequestId?: string;
  } = {},
): string {
  const contactAttr =
    extra.contactId === undefined ? "" : ` data-contact-id="${escapeAttr(extra.contactId)}"`;
  const proposalAttr =
    extra.proposalId === undefined ? "" : ` data-proposal-id="${escapeAttr(extra.proposalId)}"`;
  const chatAttr =
    extra.rimChatId === undefined ? "" : ` data-rim-chat-id="${escapeAttr(extra.rimChatId)}"`;
  const failedAttr =
    extra.failedRequestId === undefined
      ? ""
      : ` data-failed-request-id="${escapeAttr(extra.failedRequestId)}"`;
  return `<div class="row"><button type="button" data-event="${escapeAttr(eventName)}"${contactAttr}${proposalAttr}${chatAttr}${failedAttr}>${escapeHtml(label)}</button></div>`;
}

export function escapeHtml(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
