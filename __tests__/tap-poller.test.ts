/**
 * Button taps read from conversations — matching.
 *
 * Unified login apps get no messaging webhooks, so a tap is recognised as a
 * message from the commenter whose text is the button's label. Shapes below are
 * what /{ig-id}/conversations returned for a real tap on 2026-11-26.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: vi.fn() }),
  POSTBACK_JOB_NAME: "process-postback",
}));

import { findTaps, type PendingTap } from "../lib/polling/tap-poller";

const ACCOUNT = { username: "movewithells", id: "17841454405925967" };
const USER = { username: "atchia.adam", id: "29787222810966599" };
const SENT = new Date("2026-11-26T05:24:41.900Z");

function conversation(
  messages: { id: string; at: string; from: typeof USER; text: string }[]
) {
  return {
    id: "conv",
    messages: {
      data: messages.map((m) => ({
        id: m.id,
        created_time: m.at,
        from: m.from,
        message: m.text,
      })),
    },
  };
}

const realThread = conversation([
  { id: "m3", at: "2026-11-26T05:25:26+0000", from: USER, text: "Hello 1" },
  { id: "m2", at: "2026-11-26T05:24:50+0000", from: USER, text: "Link" },
  { id: "m1", at: "2026-11-26T05:24:41+0000", from: ACCOUNT, text: "" },
]);

function pending(overrides: Partial<PendingTap> = {}): PendingTap {
  return {
    automationId: "auto1",
    commenterId: USER.id,
    sentAt: SENT,
    openingLabel: "Link",
    followLabels: [],
    requireFollow: false,
    ...overrides,
  };
}

describe("findTaps", () => {
  it("reads the opening DM tap from the real thread, ignoring the typed message", () => {
    expect(findTaps([realThread], [pending()])).toEqual([
      {
        automationId: "auto1",
        userId: USER.id,
        messageId: "m2",
        payload: "reveal:auto1:open",
        tappedAt: new Date("2026-11-26T05:24:50Z"),
      },
    ]);
  });

  it("routes the opening tap into the follow check when the campaign gates on follow", () => {
    const [tap] = findTaps(
      [realThread],
      [pending({ requireFollow: true, followLabels: ["i'm following"] })]
    );
    expect(tap.payload).toBe("followcheck:auto1:open");
  });

  it("reads a follow prompt tap, including the default label", () => {
    const thread = conversation([
      { id: "m9", at: "2026-11-26T05:30:00+0000", from: USER, text: "i'm following" },
    ]);
    const [tap] = findTaps(
      [thread],
      [pending({ requireFollow: true, followLabels: ["i'm following", "I'm following ✅"] })]
    );
    expect(tap.payload).toBe("followcheck:auto1");
  });

  it("compares labels case-insensitively and as Instagram truncates them", () => {
    const thread = conversation([
      { id: "m9", at: "2026-11-26T05:30:00+0000", from: USER, text: "send me the reformer" },
    ]);
    const taps = findTaps(
      [thread],
      [pending({ openingLabel: "Send me the Reformer guide please" })]
    );
    expect(taps).toHaveLength(1);
  });

  it("ignores messages from people with no pending DM", () => {
    const other = { username: "someone", id: "111" };
    const thread = conversation([
      { id: "m9", at: "2026-11-26T05:30:00+0000", from: other, text: "Link" },
    ]);
    expect(findTaps([thread], [pending()])).toEqual([]);
  });

  it("ignores a matching message sent before the comment DM", () => {
    const thread = conversation([
      { id: "m0", at: "2026-11-26T05:00:00+0000", from: USER, text: "Link" },
    ]);
    expect(findTaps([thread], [pending()])).toEqual([]);
  });

  it("ignores our own messages, even with the button's text", () => {
    const thread = conversation([
      { id: "m9", at: "2026-11-26T05:30:00+0000", from: ACCOUNT, text: "Link" },
    ]);
    expect(findTaps([thread], [pending({ commenterId: USER.id })])).toEqual([]);
  });
});
