// Runs under `bun test`; the relay's tsconfig leaves tests out.
import { expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { overageUsd } = await import("./budget");

test("nothing is owed inside the plan's included amounts", () => {
  expect(
    overageUsd({
      doRequests: 500_000,
      frames: 9_000_000,
      workerRequests: 1_000_000,
    }),
  ).toBe(0);
});

test("frames are billed one request in twenty", () => {
  // 2 billion frames are 100 million billed requests: 99 million over the
  // included million at $0.15 a million. Their active time (about 362,500
  // GB-s) is still inside the included 400,000 GB-s. The cost analysis has
  // the same $14.85 for 1,000 heavy users.
  expect(
    overageUsd({ doRequests: 0, frames: 2_000_000_000, workerRequests: 0 }),
  ).toBeCloseTo(14.85, 6);
});

test("worker requests past ten million cost $0.30 a million", () => {
  expect(
    overageUsd({ doRequests: 0, frames: 0, workerRequests: 12_000_000 }),
  ).toBeCloseTo(0.6, 6);
});
