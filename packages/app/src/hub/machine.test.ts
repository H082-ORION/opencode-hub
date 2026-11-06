import { describe, expect, test } from "bun:test"
import { createChatGPT, createFeed, transitionChatGPT, transitionFeed, viewChatGPT } from "./machine"

describe("machine feed", () => {
  test("backs off after failures and reconnects with a new attempt", () => {
    const opened = transitionFeed(createFeed().state, { type: "opened", attempt: 1 })
    expect(opened.state).toEqual({ status: "live", attempt: 1 })
    const dropped = transitionFeed(opened.state, { type: "failed", attempt: 1 })
    expect(dropped.effects).toEqual([{ type: "close" }, { type: "schedule", attempt: 1, delayMs: 1000 }])
    const retry = transitionFeed(dropped.state, { type: "retry.due", attempt: 1 })
    expect(retry.effects).toEqual([{ type: "connect", attempt: 2 }])
    const again = transitionFeed(retry.state, { type: "failed", attempt: 2 })
    expect(again.effects.at(-1)).toEqual({ type: "schedule", attempt: 2, delayMs: 2000 })
  })

  test("ignores events from a replaced connection", () => {
    const retry = transitionFeed(transitionFeed(createFeed().state, { type: "failed", attempt: 1 }).state, {
      type: "retry.due",
      attempt: 1,
    }).state
    const stale = transitionFeed(retry, { type: "failed", attempt: 1 })
    expect(stale.state).toBe(retry)
    expect(stale.effects).toEqual([])
  })

  test("a lost session stops the feed for good", () => {
    const out = transitionFeed(createFeed().state, { type: "unauthorized", attempt: 1 })
    expect(out.state).toEqual({ status: "signed-out" })
    expect(transitionFeed(out.state, { type: "opened", attempt: 1 }).state).toBe(out.state)
  })
})

describe("ChatGPT sign-in", () => {
  const signIn = { attempt: "a1", url: "https://auth.example/authorize" }

  test("completes with the pasted callback and reports the connection", () => {
    const ready = transitionChatGPT(createChatGPT().state, { type: "begin.succeeded", request: 1, signIn }).state
    const typed = transitionChatGPT(ready, { type: "callback.changed", value: " http://127.0.0.1:1455/cb?code=x " })
    const submitted = transitionChatGPT(typed.state, { type: "submitted" })
    expect(submitted.effects).toEqual([
      { type: "complete", request: 2, attempt: "a1", callback: "http://127.0.0.1:1455/cb?code=x" },
    ])
    const done = transitionChatGPT(submitted.state, { type: "complete.succeeded", request: 2 })
    expect(done.effects).toEqual([{ type: "connected" }])
    expect(viewChatGPT(done.state).done).toBe(true)
  })

  test("a failed completion keeps the pasted URL and shows the error", () => {
    const ready = transitionChatGPT(createChatGPT().state, { type: "begin.succeeded", request: 1, signIn }).state
    const typed = transitionChatGPT(ready, { type: "callback.changed", value: "bad" }).state
    const submitted = transitionChatGPT(typed, { type: "submitted" }).state
    const failed = transitionChatGPT(submitted, { type: "complete.failed", request: 2, error: "expired" }).state
    expect(viewChatGPT(failed)).toMatchObject({ error: "expired", callback: "bad", canSubmit: true, canRestart: true })
  })

  test("a restart drops the previous sign-in's late answer", () => {
    const failed = transitionChatGPT(createChatGPT().state, { type: "begin.failed", request: 1, error: "down" }).state
    const restarted = transitionChatGPT(failed, { type: "restarted" })
    expect(restarted.effects).toEqual([{ type: "begin", request: 2 }])
    const late = transitionChatGPT(restarted.state, { type: "begin.succeeded", request: 1, signIn })
    expect(late.state).toBe(restarted.state)
  })
})
