import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolves once a file made now gets a birth time whose whole millisecond is after `time`.
 *
 * File timestamps come from the kernel's coarse clock, not from `Date.now()`. On Linux that clock moves in
 * scheduler ticks (4 ms on common kernels) and reads up to a tick behind the wall clock, so a file made a
 * few milliseconds after `Date.now()` can still be stamped before it. A fixed sleep only shrinks that
 * window. Tests that need "made after X" or "born later than Y" wait on the file clock itself.
 * Where the file system records no birth time it falls back to the wall clock.
 */
export async function fileClockPast(time: number, dir = tmpdir()): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const probe = await mkdtemp(join(dir, "pi-warden-clock-"));
    let birth: number;
    try { birth = (await stat(probe)).birthtimeMs; } finally { await rm(probe, { recursive: true, force: true }); }
    if (birth > 0 ? Math.floor(birth) > time : Date.now() > time + 1) return;
    if (Date.now() > deadline) throw new Error(`file clock did not pass ${time} within 2s (last birth ${birth})`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
