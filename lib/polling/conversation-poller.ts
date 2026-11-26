/**
 * Button taps and keyword DMs read from conversations, for Unified login accounts.
 *
 * Meta does not deliver messaging webhooks (messages, messaging_postbacks) to
 * Unified login apps on Standard Access: comment webhooks arrive, but a tap on
 * the opening DM's button or the follow prompt's "I'm following", and a DM
 * carrying a campaign keyword, never reach the app. Both still land in the
 * conversation, a tap as a message whose text is the button's label, so they
 * are read from there and queued as the same jobs a webhook would queue.
 *
 * Taps are looked for only among people we sent a comment DM in the last 24
 * hours. Keyword DMs are looked for, on accounts with a campaign that answers
 * DMs, among all messages from the last hour; a message that is a tap is never
 * also treated as a keyword DM. Message text is only compared in memory: nothing
 * from the conversations is stored except the ids of the messages acted on.
 *
 * Tap matching adapted from kattilathubiyon-lab/openreply
 * (lib/polling/confirmation-poller.ts), extended to the follow prompt's button.
 */

import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import {
  getRecentConversationPage,
  MetaApiError,
  type InstagramConversation,
} from "@/lib/meta/client";
import {
  getDMQueue,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
} from "@/lib/queue/client";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

const WINDOW_MS = 24 * 60 * 60 * 1000;
// How far back a keyword DM is still answered. Bounds the first sweep after a
// deploy or restart, so old DMs are not answered hours late.
const DM_LOOKBACK_MS = 60 * 60 * 1000;
// 25 conversations a page. A normal sweep reads one; the cap matters only when
// catching up after an outage or a rate-limit pause.
const MAX_PAGES = 20;
const PAGE_GAP_MS = 600;
// Re-read a little before the last sweep, so a conversation updated while the
// previous sweep was paging is not skipped.
const OVERLAP_MS = 2 * 60 * 1000;
const BACKOFF_MS = 5 * 60 * 1000;
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
// The defaults processComment and processMessage send when a campaign leaves
// the follow prompt's button label empty.
const DEFAULT_FOLLOW_LABELS = ["i'm following", "I'm following ✅"];
// Instagram keeps at most 20 characters of a button title.
const BUTTON_TITLE_MAX = 20;

/** Someone we sent a comment DM to, and the buttons that DM could lead to. */
export interface PendingTap {
  automationId: string;
  commenterId: string;
  sentAt: Date;
  /** Label of the opening DM's button, when the campaign sends one. */
  openingLabel: string | null;
  /** Labels of the follow prompt's button, when the campaign gates on follow. */
  followLabels: string[];
  requireFollow: boolean;
}

export interface Tap {
  automationId: string;
  userId: string;
  messageId: string;
  /** The postback payload the tapped button carries. */
  payload: string;
  tappedAt: Date;
}

const normalize = (value: string) =>
  value.trim().slice(0, BUTTON_TITLE_MAX).trim().toLowerCase();

/**
 * Match messages to the buttons waiting on their senders. A message counts as
 * a tap when its sender got a comment DM from the campaign, it was sent no
 * earlier than that DM, and its text is one of the campaign's button labels.
 * The payload is the one the tapped button would have sent in a webhook.
 */
export function findTaps(
  conversations: InstagramConversation[],
  pending: PendingTap[]
): Tap[] {
  const byUser = new Map<string, PendingTap[]>();
  for (const p of pending)
    byUser.set(p.commenterId, [...(byUser.get(p.commenterId) ?? []), p]);

  const taps: Tap[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages?.data ?? []) {
      const { id, from, created_time: createdTime, message: text } = message;
      if (!id || !from?.id || !createdTime || !text) continue;
      const candidates = byUser.get(from.id);
      if (!candidates) continue;
      const at = Date.parse(createdTime);
      const label = normalize(text);
      // created_time has whole seconds.
      const eligible = candidates
        .filter((p) => at >= Math.floor(p.sentAt.getTime() / 1000) * 1000)
        .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
      for (const p of eligible) {
        let payload: string | null = null;
        // Same payloads processComment puts on the buttons it sends.
        if (p.openingLabel && normalize(p.openingLabel) === label)
          payload = `${p.requireFollow ? "followcheck" : "reveal"}:${p.automationId}:open`;
        else if (p.followLabels.some((l) => normalize(l) === label))
          payload = `followcheck:${p.automationId}`;
        if (!payload) continue;
        taps.push({
          automationId: p.automationId,
          userId: from.id,
          messageId: id,
          payload,
          tappedAt: new Date(at),
        });
        break;
      }
    }
  }
  return taps;
}

/** A campaign that answers DMs carrying its keywords (dmTriggerEnabled). */
export interface DmCampaign {
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
}

export interface KeywordDm {
  messageId: string;
  senderId: string;
  text: string;
}

/**
 * Inbound messages that at least one DM campaign would answer. processMessage
 * matches them again per campaign, as it does for a webhook; this only keeps
 * the rest from being queued. Our own messages, messages without text, button
 * taps and anything older than `notBefore` are skipped.
 */
export function findKeywordDms(
  conversations: InstagramConversation[],
  accountInstagramId: string,
  campaigns: DmCampaign[],
  tapMessageIds: Set<string>,
  notBefore: number
): KeywordDm[] {
  const found: KeywordDm[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages?.data ?? []) {
      const { id, from, created_time: createdTime } = message;
      const text = message.message?.trim();
      if (!id || !from?.id || !createdTime || !text) continue;
      if (from.id === accountInstagramId || tapMessageIds.has(id)) continue;
      if (Date.parse(createdTime) < notBefore) continue;
      const matches = campaigns.some(
        (c) =>
          c.matchAnyWord ||
          matchKeywords(text, c.keywords, c.wholeWordMatch).matched
      );
      if (matches) found.push({ messageId: id, senderId: from.id, text });
    }
  }
  return found;
}

type PolledAccount = {
  id: string;
  workspaceId: string;
  instagramId: string;
  provider: "META" | "ZERNIO";
  metaLogin: "INSTAGRAM" | "UNIFIED";
  zernioAccountId: string | null;
  accessToken: string;
};

const lastSweep = new Map<string, number>();
const pausedUntil = new Map<string, number>();
let running = false;

/**
 * One sweep over every Unified login account with a campaign that waits on a
 * tap or answers DMs.
 */
export async function pollConversations(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const accounts: PolledAccount[] = await prisma.instagramAccount.findMany({
      where: {
        provider: "META",
        metaLogin: "UNIFIED",
        automations: {
          some: {
            isActive: true,
            OR: [
              { openingDmEnabled: true },
              { requireFollow: true },
              { dmTriggerEnabled: true },
            ],
          },
        },
      },
    });
    for (const account of accounts) {
      if ((pausedUntil.get(account.id) ?? 0) > now) continue;
      try {
        await sweepAccount(account, now);
      } catch (error) {
        if (error instanceof MetaApiError && RATE_LIMIT_CODES.has(error.code))
          pausedUntil.set(account.id, now + BACKOFF_MS);
        const detail = error instanceof Error ? error.message : "Unknown error";
        console.error("[Conversation Poll] Sweep failed:", detail);
      }
    }
  } finally {
    running = false;
  }
}

async function sweepAccount(account: PolledAccount, now: number): Promise<void> {
  const logs = await prisma.dmLog.findMany({
    where: {
      instagramAccountId: account.id,
      status: "SENT",
      dmSentAt: { gte: new Date(now - WINDOW_MS) },
      // Rows for taps already answered, not for comment DMs.
      NOT: { commentId: { startsWith: "reveal:" } },
      automation: {
        isActive: true,
        OR: [{ openingDmEnabled: true }, { requireFollow: true }],
      },
    },
    select: {
      automationId: true,
      commenterId: true,
      dmSentAt: true,
      automation: {
        select: {
          openingDmEnabled: true,
          openingDmMessage: true,
          openingDmButtonLabel: true,
          requireFollow: true,
          followPromptButtonLabel: true,
        },
      },
    },
  });

  const pending: PendingTap[] = logs.flatMap((log) => {
    if (!log.dmSentAt) return [];
    const a = log.automation;
    // Mirrors useOpeningDm in processComment.
    const opening =
      a.openingDmEnabled && a.openingDmMessage && a.openingDmButtonLabel
        ? a.openingDmButtonLabel
        : null;
    const followLabels = a.requireFollow
      ? a.followPromptButtonLabel?.trim()
        ? [a.followPromptButtonLabel]
        : DEFAULT_FOLLOW_LABELS
      : [];
    if (!opening && followLabels.length === 0) return [];
    return [
      {
        automationId: log.automationId,
        commenterId: log.commenterId,
        sentAt: log.dmSentAt,
        openingLabel: opening,
        followLabels,
        requireFollow: a.requireFollow,
      },
    ];
  });
  const dmCampaigns: DmCampaign[] = await prisma.automation.findMany({
    where: {
      instagramAccountId: account.id,
      isActive: true,
      dmTriggerEnabled: true,
    },
    select: { keywords: true, matchAnyWord: true, wholeWordMatch: true },
  });
  if (pending.length === 0 && dmCampaigns.length === 0) return;

  const dmNotBefore = now - DM_LOOKBACK_MS;
  const oldestOfInterest = Math.min(
    ...pending.map((p) => p.sentAt.getTime()),
    ...(dmCampaigns.length > 0 ? [dmNotBefore] : [])
  );
  const since = Math.max(
    oldestOfInterest,
    (lastSweep.get(account.id) ?? 0) - OVERLAP_MS
  );

  const context = await createInstagramContext(account);
  if (context.provider !== "META") return;

  let after: string | undefined;
  let covered = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await new Promise((done) => setTimeout(done, PAGE_GAP_MS));
    const result = await getRecentConversationPage(
      { accessToken: context.accessToken, unifiedLogin: context.unifiedLogin },
      account.instagramId,
      after
    );
    const taps = findTaps(result.conversations, pending);
    for (const tap of taps) await enqueueTap(account, tap);
    if (dmCampaigns.length > 0) {
      const dms = findKeywordDms(
        result.conversations,
        account.instagramId,
        dmCampaigns,
        new Set(taps.map((t) => t.messageId)),
        dmNotBefore
      );
      for (const dm of dms) await enqueueKeywordDm(account, dm);
    }
    // Conversations come newest first: stop at the first one older than `since`.
    const last = result.conversations.at(-1)?.updated_time;
    after = result.after;
    if (!after || !last || Date.parse(last) < since) {
      covered = true;
      break;
    }
  }
  // Move on only once everything back to the last sweep was read; otherwise the
  // next sweep starts from the same point and nothing is skipped.
  if (covered) lastSweep.set(account.id, now);
  else console.warn("[Conversation Poll] Page cap reached, will catch up next sweep");
}

/**
 * Queue a tap exactly once. A sweep sees the same tap again until it scrolls
 * out of the last few messages, and every sweep after a restart reads back 24
 * hours, so each tap's message id is claimed durably before it is acted on.
 */
async function enqueueTap(account: PolledAccount, tap: Tap): Promise<void> {
  const claimId = `tap-poll:${tap.messageId}`;
  if (await prisma.postbackDelivery.findUnique({ where: { id: claimId } }))
    return;
  // Same job id and data a webhook for this tap would produce, so the two
  // paths dedupe each other if Meta ever starts delivering the webhook.
  await getDMQueue().add(
    POSTBACK_JOB_NAME,
    {
      instagramAccountId: account.instagramId,
      accountConnectionId: account.id,
      userId: tap.userId,
      payload: tap.payload,
      mid: tap.messageId,
    },
    {
      jobId: `postback_${account.instagramId}_${tap.userId}_${tap.messageId.replace(/:/g, "_")}`,
    }
  );
  // After the add: a crash in between re-queues under the same job id, and
  // processPostback dedupes the send by message id.
  await prisma.postbackDelivery
    .create({ data: { id: claimId } })
    .catch(() => {});
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: account.workspaceId,
        source: "WORKER",
        level: "INFO",
        message: "Button tap read from conversation",
        payload: {
          automationId: tap.automationId,
          userId: tap.userId,
          messageId: tap.messageId,
          payload: tap.payload,
          tappedAt: tap.tappedAt.toISOString(),
        },
      },
    })
    .catch(() => {});
}

/**
 * Queue a keyword DM exactly once, as the same job a messages webhook would
 * produce. processMessage also dedupes per message id (DmLog dm:<id>); the
 * claim here keeps a re-read message from being queued again after its job
 * has left the queue.
 */
async function enqueueKeywordDm(
  account: PolledAccount,
  dm: KeywordDm
): Promise<void> {
  const claimId = `dm-poll:${dm.messageId}`;
  if (await prisma.postbackDelivery.findUnique({ where: { id: claimId } }))
    return;
  await getDMQueue().add(
    MESSAGE_JOB_NAME,
    {
      instagramAccountId: account.instagramId,
      accountConnectionId: account.id,
      messageId: dm.messageId,
      messageText: dm.text,
      senderId: dm.senderId,
    },
    {
      // Same id the webhook path builds (lib/queue/process-webhook.ts).
      jobId: `message_${account.instagramId}_${Buffer.from(
        dm.messageId
      ).toString("base64url")}`,
    }
  );
  await prisma.postbackDelivery
    .create({ data: { id: claimId } })
    .catch(() => {});
}
