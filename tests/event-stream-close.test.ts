// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { EventStream } from "../src/reader/event-stream";

describe("EventStream close semantics", () => {
  it("pending next() + close() resolves {done:true,value:undefined}", async () => {
    const stream = new EventStream<string>();
    const it = stream[Symbol.asyncIterator]();
    const pending = it.next();
    stream.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("push a then close then for-await yields [a]", async () => {
    const stream = new EventStream<string>();
    stream.push("a");
    stream.close();
    const out: string[] = [];
    for await (const x of stream) out.push(x);
    expect(out).toEqual(["a"]);
  });

  it("double close idempotent, push-after-close dropped", async () => {
    const stream = new EventStream<string>();
    stream.close();
    expect(() => stream.close()).not.toThrow();
    stream.push("late");
    const out: string[] = [];
    for await (const x of stream) out.push(x);
    expect(out).toEqual([]);
  });
});
