import { describe, expect, it } from "bun:test";
import { mapWithConcurrency } from "../src/Client.ts";

// Deterministic, no real network or timers: each task only resolves once explicitly released,
// so "how many were running at once" is observed directly instead of inferred from wall-clock
// timing. A network-round-trip version of this test (many real fetches through a mock Bun.serve)
// worked in isolation but made an UNRELATED readiness.test.ts test flaky when the whole suite ran
// together (a hung fetch there started failing with "socket connection was closed unexpectedly"
// instead of hitting its own internal timeout) — almost certainly some shared connection-pool
// pressure across test files in the same process. This version has no such dependency.
describe("mapWithConcurrency (internal, backs Client hydration — sbx-omnichannel-ui report item G)", () => {
  it("never runs more than `limit` tasks at once, but still runs every item", async () => {
    const total = 12;
    const limit = 5;
    let running = 0;
    let maxRunning = 0;
    const releases: Array<() => void> = [];

    const donePromise = mapWithConcurrency(
      Array.from({ length: total }, (_, i) => i),
      limit,
      (i) => new Promise<number>((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        releases.push(() => { running -= 1; resolve(i); });
      }),
    );

    // Let every microtask/worker actually start before releasing anything.
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(limit); // exactly `limit` in flight, not all 12 at once
    expect(maxRunning).toBe(limit);

    // Release them one at a time — each release should let exactly one more start, until all 12
    // have run, never exceeding `limit` concurrently. A fixed-count loop (not "while something's
    // left to release"): the next worker's promise executor runs synchronously the moment it
    // calls `fn`, so a new entry can appear in `releases` before this loop's next iteration even
    // starts — tracking "did the queue length change" instead of a plain counter proved wrong.
    for (let released = 0; released < total; released++) {
      while (releases.length === 0) await new Promise((r) => setTimeout(r, 1));
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 3));
      expect(running).toBeLessThanOrEqual(limit);
    }

    const results = await donePromise;
    expect(results).toHaveLength(total);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(maxRunning).toBeLessThanOrEqual(limit);
  });

  it("preserves per-item order and result, and isolates one rejection from the rest", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (i) => {
      if (i === 3) throw new Error(`boom-${i}`);
      return i * 10;
    });

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(10);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(20);
    expect(String((results[2] as PromiseRejectedResult).reason)).toContain("boom-3");
    expect((results[3] as PromiseFulfilledResult<number>).value).toBe(40);
  });

  it("caps at the item count when limit exceeds it, and handles zero items", async () => {
    const results = await mapWithConcurrency([1, 2], 5, async (i) => i);
    expect(results).toHaveLength(2);

    const empty = await mapWithConcurrency([], 5, async (i: number) => i);
    expect(empty).toHaveLength(0);
  });
});
