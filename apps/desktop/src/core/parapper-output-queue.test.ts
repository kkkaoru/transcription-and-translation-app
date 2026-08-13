import { describe, expect, it, vi } from "vitest";
import { buildCaptionAbMatrix } from "../overlay/caption-surface-ab.matrix";
import { shouldAppendDisjointSameTurnSurfaces } from "./caption-updates";
import {
  compareParapperTurnCursor,
  createParapperOutputQueue,
  PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
  PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS,
  type ParapperOutputQueueItem,
  shouldSkipParapperNormalize,
} from "./parapper-output-queue";

type Item = ParapperOutputQueueItem & { id: string };

const item = (id: string, isFinal = false): Item => ({ id, isFinal });

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Parapper output coalescing queue", () => {
  it("keeps only the newest pending partial while one normalizer is running", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const process = vi.fn(
      (next: Item) =>
        new Promise<void>((resolve) => {
          started.push(next.id);
          release.push(resolve);
        }),
    );
    const queue = createParapperOutputQueue(process);

    queue.enqueue(item("partial-1"));
    await flush();
    queue.enqueue(item("partial-2"));
    queue.enqueue(item("partial-3"));
    queue.enqueue(item("partial-4"));
    expect(queue.getStats()).toMatchObject({ pending: 1, droppedPartials: 2, inFlight: true });
    expect(started).toEqual(["partial-1"]);

    release.shift()?.();
    await flush();
    expect(started).toEqual(["partial-1", "partial-4"]);
    expect(queue.getStats().droppedPartials).toBe(2);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 2, pending: 0, inFlight: false });
  });

  it("drops stale partials when a final arrives and processes every final in order", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      started.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });

    queue.enqueue(item("partial-active"));
    await flush();
    queue.enqueue(item("partial-stale"));
    queue.enqueue(item("final-1", true));
    queue.enqueue(item("partial-next"));
    queue.enqueue(item("final-2", true));
    expect(queue.getStats()).toMatchObject({ pending: 2, droppedPartials: 2 });

    release.shift()?.();
    await flush();
    expect(started).toEqual(["partial-active", "final-1"]);
    release.shift()?.();
    await flush();
    expect(started).toEqual(["partial-active", "final-1", "final-2"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 3, pending: 0, inFlight: false });
  });

  it("drains accepted events after a processing failure and can be closed safely", async () => {
    const process = vi
      .fn<(next: Item) => Promise<void>>()
      .mockRejectedValueOnce(new Error("normalizer failed"))
      .mockResolvedValue(undefined);
    const queue = createParapperOutputQueue(process);
    queue.enqueue(item("partial"));
    queue.enqueue(item("final", true));
    await queue.whenIdle();
    expect(process).toHaveBeenCalledTimes(2);
    queue.close();
    queue.enqueue(item("ignored", true));
    await flush();
    expect(process).toHaveBeenCalledTimes(2);
    expect(queue.getStats()).toMatchObject({ pending: 0, inFlight: false });
  });

  it("close drops queued events from a paused session and ignores later arrivals", async () => {
    // stopCapture closes the queue while a normalization can still be in
    // flight with events waiting behind it. Those pending events belong to
    // the paused session: they must be dropped and accounted for, and later
    // outputs must not start processing. A resumed capture owns a fresh
    // queue, so nothing here may leak into it.
    const started: string[] = [];
    const release: Array<() => void> = [];
    const turn = (id: string, turnId: number, isFinal = false): Item => ({
      id,
      isFinal,
      sessionId: "socket-1",
      turnSessionId: 1,
      turnId,
      revision: 0,
    });
    const queue = createParapperOutputQueue<Item>((next) => {
      started.push(next.id);
      return new Promise<void>((resolve) => {
        release.push(resolve);
      });
    });

    queue.enqueue(turn("in-flight-partial", 0));
    await flush();
    queue.enqueue(turn("pending-partial", 1));
    queue.enqueue(turn("pending-final", 2, true));
    expect(queue.getStats()).toMatchObject({ pending: 2, inFlight: true });

    queue.close();
    expect(queue.getStats()).toMatchObject({
      pending: 0,
      droppedPartials: 1,
      droppedFinals: 1,
    });

    // Outputs that arrive while paused are ignored outright.
    queue.enqueue(turn("after-close", 3, true));
    await flush();
    expect(started).toEqual(["in-flight-partial"]);

    // The in-flight normalization settles after close; no queued work may
    // start once the paused session has been torn down. close() abandons the
    // active result but cannot cancel the Promise, so drain after release.
    release.shift()?.();
    await queue.whenIdle();
    expect(started).toEqual(["in-flight-partial"]);
    expect(queue.getStats().pending).toBe(0);
  });

  it("drops a late partial after the same-turn final, even when both share a revision", async () => {
    const processed: string[] = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      processed.push(next.id);
    });
    const base = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
      revision: 2,
      segmentId: 11,
    };

    queue.enqueue({ id: "partial", isFinal: false, outputSequence: 10, ...base });
    queue.enqueue({ id: "final", isFinal: true, outputSequence: 11, ...base });
    queue.enqueue({ id: "late-partial", isFinal: false, outputSequence: 10, ...base });
    await queue.whenIdle();

    expect(processed).toEqual(["partial", "final"]);
    expect(queue.getStats()).toMatchObject({ droppedPartials: 1, droppedFinals: 0 });
  });

  it("orders cursors, drops stale finals, and keeps a different turn", async () => {
    expect(
      compareParapperTurnCursor({ isFinal: true, revision: 2 }, { isFinal: false, revision: 1 }),
    ).toBe(1);
    expect(
      compareParapperTurnCursor(
        { isFinal: false, outputSequence: 1 },
        { isFinal: false, outputSequence: 2 },
      ),
    ).toBe(-1);

    const processed: string[] = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      processed.push(next.id);
    });
    const firstTurn = {
      sessionId: "socket-1",
      turnSessionId: 1,
      turnId: 1,
    };
    queue.enqueue({ id: "new-final", isFinal: true, revision: 2, ...firstTurn });
    queue.enqueue({ id: "old-final", isFinal: true, revision: 1, ...firstTurn });
    queue.enqueue({
      id: "other-turn-partial",
      isFinal: false,
      revision: 0,
      ...firstTurn,
      turnId: 2,
    });

    await queue.whenIdle();

    expect(processed).toEqual(["new-final", "other-turn-partial"]);
    expect(queue.getStats()).toMatchObject({ droppedFinals: 1, droppedPartials: 0 });
  });

  it("does not let a later shorter rewrite replace a pending longer same-turn rewrite", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "in-flight",
      text: "電車が",
      isFinal: false,
      revision: 1,
      outputSequence: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "longer-rewrite",
      text: "電車が遅延してただから僕は学校に行かない",
      isFinal: false,
      revision: 5,
      outputSequence: 5,
      ...turn,
    });
    queue.enqueue({
      id: "truncated-rewrite",
      text: "電車が遅延してたから僕は学校",
      isFinal: false,
      revision: 6,
      outputSequence: 6,
      ...turn,
    });

    expect(queue.getStats()).toMatchObject({ pending: 1, droppedPartials: 1, inFlight: true });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-rewrite"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(processed).toEqual(["in-flight", "longer-rewrite"]);
    expect(queue.getStats()).toMatchObject({ processed: 2, pending: 0, droppedPartials: 1 });
  });

  it("joins a pending lead with a disjoint same-turn tail instead of replacing it", async () => {
    const processed: string[] = [];
    const surfaces: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.id);
      surfaces.push(next.text);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "in-flight",
      text: "会議を始めます",
      isFinal: false,
      revision: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "lead",
      text: "会議を始めます",
      isFinal: false,
      revision: 2,
      ...turn,
    });
    queue.enqueue({
      id: "tail",
      text: "続きがあります",
      isFinal: false,
      revision: 3,
      ...turn,
    });

    release.shift()?.();
    await flush();
    release.shift()?.();
    await queue.whenIdle();
    expect(
      surfaces.some((text) => text.includes("会議を始めます") && text.includes("続きがあります")),
    ).toBe(true);
  });

  it("returns the concatenated surface so first paint is not lead-only while the join is queued", async () => {
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>(
      () => new Promise<void>((resolve) => release.push(resolve)),
    );
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };
    queue.enqueue({
      id: "in-flight",
      text: "会議を始めます",
      isFinal: false,
      revision: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "lead",
      text: "会議を始めます",
      isFinal: false,
      revision: 2,
      ...turn,
    });
    const accepted = queue.enqueue({
      id: "tail",
      text: "続きがあります",
      isFinal: false,
      revision: 3,
      ...turn,
    });
    expect(accepted?.text).toContain("会議を始めます");
    expect(accepted?.text).toContain("続きがあります");
    expect(accepted?.text).not.toBe("続きがあります");
    release.shift()?.();
    await flush();
    release.shift()?.();
    await queue.whenIdle();
  });

  it("joins a key-less legacy disjoint tail onto the previous lead", async () => {
    const processed: string[] = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.text);
    });
    expect(
      queue.enqueue({
        id: "legacy-final",
        text: "会議を始めます",
        isFinal: true,
      })?.text,
    ).toBe("会議を始めます");
    const accepted = queue.enqueue({
      id: "legacy-tail",
      text: "続きがあります",
      isFinal: false,
    });
    expect(accepted?.text).toContain("会議を始めます");
    expect(accepted?.text).toContain("続きがあります");
    await queue.whenIdle();
    expect(
      processed.some((text) => text.includes("会議を始めます") && text.includes("続きがあります")),
    ).toBe(true);
  });

  it("does not let a truncated same-turn final discard a longer pending rewrite", async () => {
    // Completion ASR can finalize on a prefix while a longer Nemotron rewrite is
    // still queued behind an in-flight normalizer. Dropping that pending surface
    // is the "spoke but no caption tail" failure: the long text never paints.
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "in-flight",
      text: "電車が",
      isFinal: false,
      revision: 1,
      outputSequence: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "longer-rewrite",
      text: "電車が遅延してただから僕は学校に行かない",
      isFinal: false,
      revision: 5,
      outputSequence: 5,
      ...turn,
    });
    queue.enqueue({
      id: "truncated-final",
      text: "電車が遅延してたから僕は学校",
      isFinal: true,
      revision: 6,
      outputSequence: 6,
      ...turn,
    });

    expect(queue.getStats()).toMatchObject({ pending: 2, droppedPartials: 0, inFlight: true });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-rewrite"]);
    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-rewrite", "truncated-final"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 3, pending: 0, droppedPartials: 0 });
  });

  it("does not replace a longer kana pending rewrite with a shorter kanji partial or final", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 11,
    };

    queue.enqueue({
      id: "in-flight",
      text: "きょうは",
      isFinal: false,
      revision: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "longer-kana",
      text: "きょうはいいてんきですね",
      isFinal: false,
      revision: 5,
      ...turn,
    });
    queue.enqueue({
      id: "short-kanji-partial",
      text: "今日は",
      isFinal: false,
      revision: 6,
      ...turn,
    });
    queue.enqueue({
      id: "short-kanji-final",
      text: "今日は",
      isFinal: true,
      revision: 7,
      ...turn,
    });

    expect(queue.getStats()).toMatchObject({ pending: 2, droppedPartials: 1, inFlight: true });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-kana"]);
    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-kana", "short-kanji-final"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 3, pending: 0 });
  });

  it("skips AzooKey for a stale shorter partial when a longer same-id surface already painted", () => {
    expect(
      shouldSkipParapperNormalize(
        { id: "parapper:s:1:8", sourceText: "きょうはいいてんきですね" },
        {
          isFinal: false,
          sessionId: "s",
          turnSessionId: 1,
          turnId: 8,
          text: "今日は",
        },
      ),
    ).toBe(true);
    expect(
      shouldSkipParapperNormalize(
        { id: "parapper:s:1:8", sourceText: "きょうはいいてんきですね" },
        {
          isFinal: true,
          sessionId: "s",
          turnSessionId: 1,
          turnId: 8,
          text: "今日は",
        },
      ),
    ).toBe(false);
    expect(
      shouldSkipParapperNormalize(
        { id: "parapper:s:1:9", sourceText: "きょうはいいてんきですね" },
        {
          isFinal: false,
          sessionId: "s",
          turnSessionId: 1,
          turnId: 8,
          text: "今日は",
        },
      ),
    ).toBe(false);
    expect(
      shouldSkipParapperNormalize(
        { id: "parapper:s:1:8", sourceText: "こんにちはきこえますか" },
        {
          isFinal: false,
          sessionId: "s",
          turnSessionId: 1,
          turnId: 8,
          text: "きこえますか",
        },
      ),
    ).toBe(true);
    expect(
      shouldSkipParapperNormalize(
        { id: "parapper:s:1:8", sourceText: "本日はどうぞよろしくお願いします" },
        {
          isFinal: false,
          sessionId: "s",
          turnSessionId: 1,
          turnId: 8,
          text: "終わりますか",
        },
      ),
    ).toBe(false);
  });

  it("uses sourceText when deciding to keep a longer pending rewrite", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { sourceText: string }>((next) => {
      processed.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 9,
    };

    queue.enqueue({
      id: "in-flight",
      sourceText: "電車が",
      isFinal: false,
      revision: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "longer-rewrite",
      sourceText: "電車が遅延してただから僕は学校に行かない",
      isFinal: false,
      revision: 5,
      ...turn,
    });
    queue.enqueue({
      id: "truncated-rewrite",
      sourceText: "電車が遅延してたから僕は学校",
      isFinal: false,
      revision: 6,
      ...turn,
    });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-rewrite"]);
    release.shift()?.();
    await queue.whenIdle();
  });

  it("still replaces a pending partial with a later longer same-turn rewrite", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "in-flight",
      text: "電車が",
      isFinal: false,
      revision: 1,
      outputSequence: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "short-partial",
      text: "電車が遅延してた",
      isFinal: false,
      revision: 5,
      outputSequence: 5,
      ...turn,
    });
    queue.enqueue({
      id: "longer-rewrite",
      text: "電車が遅延してただから僕は学校に行かない",
      isFinal: false,
      revision: 6,
      outputSequence: 6,
      ...turn,
    });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["in-flight", "longer-rewrite"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 2, pending: 0, droppedPartials: 1 });
  });

  it("does not let a later short hearing-check suffix replace a pending greeting line", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.text);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "in-flight",
      text: "こんにちは",
      isFinal: false,
      revision: 1,
      outputSequence: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "full-utterance",
      text: "こんにちはーきこえますかー",
      isFinal: false,
      revision: 5,
      outputSequence: 5,
      ...turn,
    });
    queue.enqueue({
      id: "hearing-suffix",
      text: "きこえますか",
      isFinal: false,
      revision: 6,
      outputSequence: 6,
      ...turn,
    });

    expect(queue.getStats()).toMatchObject({ pending: 1, droppedPartials: 1, inFlight: true });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["こんにちは", "こんにちはーきこえますかー"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(processed).toEqual(["こんにちは", "こんにちはーきこえますかー"]);
    expect(queue.getStats()).toMatchObject({ processed: 2, pending: 0, droppedPartials: 1 });
  });

  it("does not let a later short suffix replace a pending greeting+hearing line", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.text);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 9,
    };

    queue.enqueue({
      id: "in-flight",
      text: "こんにちは",
      isFinal: false,
      revision: 1,
      outputSequence: 1,
      ...turn,
    });
    await flush();
    queue.enqueue({
      id: "full-utterance",
      text: "こんにちはきこえますか",
      isFinal: false,
      revision: 5,
      outputSequence: 5,
      ...turn,
    });
    queue.enqueue({
      id: "hearing-suffix",
      text: "きこえますか",
      isFinal: false,
      revision: 6,
      outputSequence: 6,
      ...turn,
    });

    expect(queue.getStats()).toMatchObject({ pending: 1, droppedPartials: 1, inFlight: true });

    release.shift()?.();
    await flush();
    expect(processed).toEqual(["こんにちは", "こんにちはきこえますか"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(processed).toEqual(["こんにちは", "こんにちはきこえますか"]);
  });

  it("still processes a longer greeting continuation after an early same-turn final", async () => {
    const processed: string[] = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.text);
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "early-final",
      text: "こんにちは",
      isFinal: true,
      revision: 2,
      outputSequence: 2,
      ...turn,
    });
    queue.enqueue({
      id: "full-continuation",
      text: "こんにちはーきこえますかー",
      isFinal: false,
      revision: 3,
      outputSequence: 3,
      ...turn,
    });

    await queue.whenIdle();
    expect(processed).toEqual(["こんにちは", "こんにちはーきこえますかー"]);
  });

  it("still processes a disjoint same-turn tail after an early-finalized lead", async () => {
    const processed: string[] = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.text);
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
    };

    queue.enqueue({
      id: "early-final",
      text: "会議を始めます",
      isFinal: true,
      revision: 2,
      outputSequence: 2,
      ...turn,
    });
    queue.enqueue({
      id: "disjoint-tail",
      text: "続きがあります",
      isFinal: false,
      revision: 3,
      outputSequence: 3,
      ...turn,
    });

    await queue.whenIdle();
    expect(
      processed.some((text) => text.includes("会議を始めます") && text.includes("続きがあります")),
    ).toBe(true);
  });

  it("joins a pending early final with a disjoint same-turn tail before drain", async () => {
    const processed: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
      processed.push(next.text);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    const turn = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 11,
    };

    queue.enqueue({
      id: "in-flight",
      text: "前置きです",
      isFinal: false,
      revision: 1,
      outputSequence: 1,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 10,
    });
    await flush();
    queue.enqueue({
      id: "early-final",
      text: "会議を始めます",
      isFinal: true,
      revision: 2,
      outputSequence: 2,
      ...turn,
    });
    queue.enqueue({
      id: "disjoint-tail",
      text: "続きがあります",
      isFinal: false,
      revision: 3,
      outputSequence: 3,
      ...turn,
    });

    release.shift()?.();
    await flush();
    release.shift()?.();
    await queue.whenIdle();
    expect(
      processed.some((text) => text.includes("会議を始めます") && text.includes("続きがあります")),
    ).toBe(true);
  });

  it("forwards an early-final disjoint tail for every glue lead×tail row", async () => {
    const rows = buildCaptionAbMatrix().filter(
      (row) =>
        row.structure === "glue" &&
        row.tail.length > 0 &&
        shouldAppendDisjointSameTurnSurfaces(row.lead, row.tail),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.tail === "続きがあります")).toBe(true);

    for (const [index, row] of rows.entries()) {
      const processed: string[] = [];
      const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
        processed.push(next.text);
      });
      const turn = {
        sessionId: "socket-1",
        turnSessionId: 4,
        turnId: 80 + index,
      };
      queue.enqueue({
        id: "early-final",
        text: row.lead,
        isFinal: true,
        revision: 2,
        outputSequence: 2,
        ...turn,
      });
      queue.enqueue({
        id: "disjoint-tail",
        text: row.tail,
        isFinal: false,
        revision: 3,
        outputSequence: 3,
        ...turn,
      });
      await queue.whenIdle();
      expect(
        processed.some((text) => text.includes(row.lead) && text.includes(row.tail)),
        row.id,
      ).toBe(true);
    }
  });

  it("keeps a longer pending surface over a later short suffix across a lead×tail matrix", async () => {
    const rows = buildCaptionAbMatrix().filter(
      (row) => row.tail.length > 0 && (row.structure === "glue" || row.structure === "elong-q"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.some((row) => row.tail === "続きがあります")).toBe(true);
    expect(rows.some((row) => row.tail === "終わりますか")).toBe(true);

    for (const [index, row] of rows.entries()) {
      const processed: string[] = [];
      const release: Array<() => void> = [];
      const queue = createParapperOutputQueue<Item & { text: string }>((next) => {
        processed.push(next.text);
        return new Promise<void>((resolve) => release.push(resolve));
      });
      const turn = {
        sessionId: "socket-1",
        turnSessionId: 4,
        turnId: 40 + index,
      };
      queue.enqueue({
        id: "in-flight",
        text: row.lead,
        isFinal: false,
        revision: 1,
        outputSequence: 1,
        ...turn,
      });
      await flush();
      queue.enqueue({
        id: "full-utterance",
        text: row.full,
        isFinal: false,
        revision: 5,
        outputSequence: 5,
        ...turn,
      });
      queue.enqueue({
        id: "short-suffix",
        text: row.tail,
        isFinal: false,
        revision: 6,
        outputSequence: 6,
        ...turn,
      });
      release.shift()?.();
      await flush();
      release.shift()?.();
      await queue.whenIdle();
      expect(processed, row.id).toEqual([row.lead, row.full]);
      expect(processed[1], row.id).toContain(row.tail);
    }
  });

  it("does not let an older final remove a newer turn's pending partial", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      started.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    queue.enqueue({
      id: "turn-1-partial",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 1,
      revision: 1,
      outputSequence: 1,
    });
    await flush();
    queue.enqueue({
      id: "turn-2-partial",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 2,
      revision: 0,
      outputSequence: 2,
    });
    queue.enqueue({
      id: "turn-1-final",
      isFinal: true,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 1,
      revision: 1,
      outputSequence: 3,
    });
    release.shift()?.();
    await flush();

    expect(started).toEqual(["turn-1-partial", "turn-2-partial"]);
    release.shift()?.();
    await flush();
    expect(started).toEqual(["turn-1-partial", "turn-2-partial", "turn-1-final"]);
    release.shift()?.();
    await queue.whenIdle();
  });

  it("bounds queued finals and cursor tracking while normalization is blocked", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createParapperOutputQueue<Item>(() => blocked);
    queue.enqueue({
      id: "active",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 1,
      turnId: 0,
      revision: 0,
    });
    await flush();
    const finalCount = PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS + 8;
    for (let turnId = 1; turnId <= finalCount; turnId += 1) {
      queue.enqueue({
        id: `final-${turnId}`,
        isFinal: true,
        sessionId: "socket-1",
        turnSessionId: 1,
        turnId,
        revision: 1,
      });
    }

    expect(queue.getStats()).toMatchObject({
      pending: PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
      droppedFinals: finalCount - PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
      trackedTurns: PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS,
    });
    release();
    queue.close();
  });

  it("bounds queued partials from distinct turns while normalization is blocked", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createParapperOutputQueue<Item>(() => blocked);
    queue.enqueue({
      id: "active",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 1,
      turnId: 0,
      revision: 0,
    });
    await flush();

    for (let turnId = 1; turnId <= PARAPPER_OUTPUT_QUEUE_MAX_PENDING + 4; turnId += 1) {
      queue.enqueue({
        id: `partial-${turnId}`,
        isFinal: false,
        sessionId: "socket-1",
        turnSessionId: 1,
        turnId,
        revision: 1,
      });
    }

    expect(queue.getStats()).toMatchObject({
      pending: PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
      droppedPartials: 4,
      droppedFinals: 0,
    });
    release();
    queue.close();
  });

  it("settles whenIdle after its finite timeout when a normalizer never returns", async () => {
    vi.useFakeTimers();
    const queue = createParapperOutputQueue<Item>(() => new Promise<void>(() => undefined));
    queue.enqueue(item("stuck"));
    const idle = queue.whenIdle(25);
    vi.advanceTimersByTime(25);
    await expect(idle).rejects.toThrow(/did not become idle/i);
    queue.close();
  });

  it("uses the default and minimum idle timeout for malformed timeout values", async () => {
    vi.useFakeTimers();
    const queue = createParapperOutputQueue<Item>(() => new Promise<void>(() => undefined));
    queue.enqueue(item("stuck"));
    const defaultTimeout = queue.whenIdle(Number.NaN);
    const minimumTimeout = queue.whenIdle(0);

    vi.advanceTimersByTime(8_000);
    await expect(defaultTimeout).rejects.toThrow(/did not become idle/i);
    await expect(minimumTimeout).rejects.toThrow(/did not become idle/i);
    queue.close();
  });

  it("resolves immediately when whenIdle is called on an already-idle queue", async () => {
    const queue = createParapperOutputQueue<Item>(() => Promise.resolve());
    // An idle queue with no pending or in-flight work must resolve without
    // installing a timer or waiting for the event loop.
    await expect(queue.whenIdle()).resolves.toBeUndefined();
    await expect(queue.whenIdle(5)).resolves.toBeUndefined();
    queue.close();
  });
});
