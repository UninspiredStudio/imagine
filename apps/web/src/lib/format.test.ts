import { expect, test } from "bun:test";
import { DAY, formatRelative, formatSize, shortDigest } from "./format.ts";

test("relative times", () => {
  const now = Date.UTC(2026, 10, 25);
  const at = (delta: number) => formatRelative(now + delta, now);
  expect(at(-5_000)).toBe("just now");
  expect(at(-4 * 60_000)).toBe("4 minutes ago");
  expect(at(-DAY)).toBe("yesterday");
  expect(at(-13 * DAY)).toBe("last week");
  expect(at(DAY)).toBe("tomorrow");
  expect(at(5 * DAY - 1000)).toBe("in 5 days");
  expect(at(13 * DAY - 1000)).toBe("in 13 days");
  expect(at(60 * 60_000 - 1000)).toBe("in 1 hour");
});

test("sizes", () => {
  expect([0, 999, 1000, 4_800_000, 412_000_000, 999_999, 1_200_000_000].map(formatSize)).toEqual([
    "0 B",
    "999 B",
    "1 KB",
    "4.8 MB",
    "412 MB",
    "1 MB",
    "1.2 GB",
  ]);
});

test("short digest", () => {
  expect(shortDigest("sha256:1a2b3c4d5e6f")).toBe("sha256:1a2b3c4d…");
});
