import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer, request } from "node:http"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forwardSessionContext } from "../agy-model-provider.ts"

process.env.AGY_BRIDGE_PORT = "49381"
const { handle, createAgySession, conversationStore, runBoundTurn, ConversationMismatch, openCodeMode, primaryModePrompt, summaryText, fallbackCheckpoint } = await import("../agy-openai-bridge.mjs")
const tools = [{ type: "function", function: { name: "agy_read" } }]
const failure = { event: "step_update", step_update: {
  step_type: "tool", step_index: 0, tool_name: "view_file", state: "ERROR",
  tool_info: { parameters: { AbsolutePath: "denied.txt" }, error: { message: "Permission denied. Do not retry." } },
} }
const done = { event: "step_update", step_update: {
  step_type: "tool", step_index: 0, tool_name: "view_file", state: "DONE",
  tool_info: { parameters: { AbsolutePath: "allowed.txt" }, output: "OK" },
} }

async function fixture(t, results) {
  const inputs = [], factories = [], signals = []
  let disposed = 0
  const session = {
    runTurn: async (messages, onEvent, signal) => {
      inputs.push(messages)
      signals.push(signal)
      if (signal.aborted) throw new Error("aborted")
      const next = results.shift()
      assert.ok(next, "unexpected AGY turn/replayed action")
      for (const event of next.events ?? []) onEvent(event)
      if (next.throw) throw new Error(next.throw)
      return next.result
    },
    dispose: () => disposed++,
  }
  const server = createServer((req, res) => void handle(req, res, "mock-agy", async (...args) => {
    factories.push(args)
    return session
  }).catch((error) => res.destroy(error)))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  async function post(messages, stream = false, headers = {}) {
    const { status, raw } = await new Promise((resolve, reject) => {
      const req = request(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
        method: "POST", headers: {
          host: "127.0.0.1:49381", "content-type": "application/json", "x-opencode-session": "test-session",
          "x-opencode-directory": encodeURIComponent(process.cwd()), ...headers,
        },
      }, (response) => {
        let raw = ""
        response.setEncoding("utf8").on("data", (chunk) => raw += chunk)
        response.on("end", () => resolve({ status: response.statusCode, raw }))
        response.on("error", reject)
      })
      req.on("error", reject)
      req.end(JSON.stringify({ model: "test-model", messages, tools, stream }))
    })
    return { status, raw, body: stream ? undefined : JSON.parse(raw), chunks: stream
      ? raw.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))) : [] }
  }
  return { post, inputs, factories, signals, disposed: () => disposed }
}
const user = [{ role: "user", content: "Perform allowed work; skip denied resources." }]
function acknowledge(messages, response) {
  return [...messages, response.choices[0].message, ...response.choices[0].message.tool_calls.map((call) => ({
    role: "tool", tool_call_id: call.id, content: "Display-only acknowledgement",
  }))]
}

for (const status of ["SUCCESS", "ERROR"]) test(`empty ${status} with failed tool continues before display and does not replay`, async (t) => {
  const f = await fixture(t, [
    { events: [failure], result: { status, response: "", usage: { input_tokens: 2 } } },
    { events: [done], result: { status: "SUCCESS", response: "Allowed work finished; denied resource skipped.", usage: { input_tokens: 3 } } },
  ])
  const first = await f.post(user)
  assert.equal(first.status, 200)
  assert.equal(first.body.choices[0].finish_reason, "tool_calls")
  assert.equal(first.body.choices[0].message.tool_calls.length, 2, "step indexes restarting must not overwrite failures")
  assert.equal(first.body.usage.prompt_tokens, 5)
  assert.equal(f.inputs.length, 2)
  assert.match(f.inputs[1][0].content, /do not retry denied actions/)
  assert.match(f.inputs[1][0].content, /must not be repeated/)
  const final = await f.post(acknowledge(user, first.body))
  assert.equal(final.body.choices[0].message.content, "Allowed work finished; denied resource skipped.")
  assert.equal(f.inputs.length, 2, "display acknowledgement must not run AGY again")
})

test("empty result uses streamed answer, not a fabricated error message", async (t) => {
  const f = await fixture(t, [{ events: [failure, { event: "step_update", step_update: {
    step_type: "agent_response", text_delta: "A real final answer.",
  } }], result: { status: "SUCCESS", response: "" } }])
  const first = await f.post(user)
  const final = await f.post(acknowledge(user, first.body), true)
  assert.match(final.raw, /A real final answer/)
  assert.doesNotMatch(final.raw, /Folgende Aktion|\[object Object\]/)
  assert.equal(f.inputs.length, 1)
})

test("non-success tool result with diagnostic text also continues", async (t) => {
  const f = await fixture(t, [
    { events: [failure], result: { status: "ERROR", response: "A read failed." } },
    { result: { status: "SUCCESS", response: "Independent work finished." } },
  ])
  const first = await f.post(user)
  const final = await f.post(acknowledge(user, first.body))
  assert.equal(f.inputs.length, 2)
  assert.equal(final.body.choices[0].message.content, "Independent work finished.")
})

test("streaming failed tool recovery returns valid tool_calls and final SSE", async (t) => {
  const f = await fixture(t, [
    { events: [failure], result: { status: "SUCCESS", response: "" } },
    { result: { status: "SUCCESS", response: "Recovered." } },
  ])
  const first = await f.post(user, true)
  assert.equal(first.status, 200)
  assert.equal(first.chunks.at(-1).choices[0].finish_reason, "tool_calls")
  assert.ok(first.raw.endsWith("data: [DONE]\n\n"))
  const calls = first.chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
  const final = await f.post([...user, { role: "assistant", content: null, tool_calls: calls },
    ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: "displayed" }))], true)
  assert.match(final.raw, /Recovered/)
  assert.equal(final.chunks.at(-1).choices[0].finish_reason, "stop")
})

test("recovery is bounded and never falsely claims success", async (t) => {
  const f = await fixture(t, Array.from({ length: 4 }, () => ({ events: [failure], result: { status: "SUCCESS", response: "" } })))
  const first = await f.post(user)
  const final = await f.post(acknowledge(user, first.body))
  assert.equal(f.inputs.length, 4)
  assert.match(final.body.choices[0].message.content, /nicht als abgeschlossen/)
})

test("plan mode is never automatically continued or approved", async (t) => {
  const f = await fixture(t, [{ events: [failure], result: { status: "SUCCESS", response: "" } }])
  const first = await f.post(user, false, { "x-opencode-agent": "plan" })
  const final = await f.post(acknowledge(user, first.body))
  assert.equal(f.inputs.length, 1)
  assert.equal(f.factories[0][4], "plan")
  assert.match(final.body.choices[0].message.content, /keine automatische/)
})

test("compaction is isolated, includes history, and emits no display calls", async (t) => {
  const f = await fixture(t, [{ result: { status: "SUCCESS", response: "Summary" } }])
  const result = await f.post(user, false, { "x-opencode-kind": "compaction", "x-opencode-agent": "plan" })
  assert.equal(f.factories[0][3], true, "one-shot includes history")
  assert.equal(f.factories[0][4], "default")
  assert.notEqual(f.factories[0][2], "test-session:test-model:default")
  assert.equal(result.body.choices[0].finish_reason, "stop")
  assert.equal(f.disposed(), 1)
})

test("provider failure without tool activity stays a real provider error", async (t) => {
  const f = await fixture(t, [{ result: { status: "ERROR", error: { message: "Authentication failed" } } }])
  const result = await f.post(user)
  assert.equal(result.status, 502)
  assert.match(result.raw, /Authentication failed/)
  assert.doesNotMatch(result.raw, /\[object Object\]/)
  assert.equal(f.inputs.length, 1)
})

test("new user message must not consume stale display acknowledgement", async (t) => {
  const f = await fixture(t, [
    { events: [failure], result: { status: "SUCCESS", response: "Old answer" } },
    { result: { status: "SUCCESS", response: "New answer" } },
  ])
  const first = await f.post(user)
  const next = await f.post([...acknowledge(user, first.body), { role: "user", content: "New task" }])
  assert.equal(next.body.choices[0].message.content, "New answer")
  assert.equal(f.inputs.length, 2)
})

test("real session adapter keeps stdin open after a tool failure and does not replay history by keywords", async () => {
  const child = new EventEmitter()
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null,
    killed: false, kill() { this.killed = true; this.emit("close", 0) } })
  const inputs = []
  child.stdin.on("data", (data) => {
    inputs.push(JSON.parse(data.toString()).message.content)
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify(failure)}\n`)
      child.stdout.write(`${JSON.stringify({ event: "result", result: { status: "ERROR", response: "" } })}\n`)
    })
  })
  const directory = await mkdtemp(join(tmpdir(), "agy-bridge-test-"))
  let launched
  const session = createAgySession("mock", "model", "key", directory, false, false, "default", (command, args, options) => {
    launched = { args, options }
    return child
  }, directory)
  try {
    assert.equal(launched.options.cwd, directory)
    assert.ok(launched.args.includes(directory))
    assert.ok(!launched.args.includes("--dangerously-skip-permissions"))
    await session.runTurn(user)
    const latest = "Fix the komprimierung bug; context compaction is broken."
    await session.runTurn([...user, { role: "assistant", content: "OLD HISTORY" }, { role: "user", content: latest }])
    assert.ok(inputs[1].includes(latest))
    assert.ok(!inputs[1].includes("OLD HISTORY"))
    assert.equal(child.stdin.writableEnded, false)
    assert.equal(child.killed, false)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(session.runTurn(user, () => {}, controller.signal))
    assert.equal(inputs.length, 2)
  } finally { session.dispose() }
})

for (const directory of ["%ZZ", "bad%00header"]) {
  test(`malformed project directory header is refused: ${directory}`, async (t) => {
    const f = await fixture(t, [])
    const result = await f.post(user, false, { "x-opencode-directory": directory })
    assert.equal(result.status, 400)
    assert.equal(f.factories.length, 0, "must never start AGY in service cwd as fallback")
  })
}

test("request project directories are resolved per session, including Unicode and spaces", async (t) => {
  const first = await mkdtemp(join(tmpdir(), "agy-Projekt ü A-"))
  const second = await mkdtemp(join(tmpdir(), "agy-Projekt B-"))
  const f = await fixture(t, [
    { result: { status: "SUCCESS", response: "A" } },
    { result: { status: "SUCCESS", response: "B" } },
  ])
  await f.post(user, false, { "x-opencode-directory": encodeURIComponent(first) })
  await f.post(user, false, { "x-opencode-directory": encodeURIComponent(second) })
  const { realpath } = await import("node:fs/promises")
  assert.equal(f.factories[0][5], await realpath(first))
  assert.equal(f.factories[1][5], await realpath(second))
})

test("provider uses current session location, not plugin location or a stale cache", async () => {
  let directory = "C:/project A"
  const ctx = { location: { directory: "C:/WRONG" }, session: { get: async ({ sessionID }) => {
    assert.equal(sessionID, "ses-test")
    return { location: { directory } }
  } } }
  const event = { sessionID: "ses-test", headers: {}, agent: "build", kind: "primary" }
  await forwardSessionContext(ctx, event)
  assert.equal(decodeURIComponent(event.headers["x-opencode-directory"]), directory)
  directory = "C:/worktree ü B"
  await forwardSessionContext(ctx, event)
  assert.equal(decodeURIComponent(event.headers["x-opencode-directory"]), directory)
  directory = undefined
  await forwardSessionContext(ctx, event)
  assert.equal(event.headers["x-opencode-directory"], undefined)
})

test("display acknowledgement cannot cross project boundaries", async (t) => {
  const f = await fixture(t, [{ events: [done], result: { status: "SUCCESS", response: "A" } }])
  const first = await f.post(user)
  const other = await mkdtemp(join(tmpdir(), "agy-other-project-"))
  const result = await f.post(acknowledge(user, first.body), false, { "x-opencode-directory": encodeURIComponent(other) })
  assert.equal(result.status, 409)
  assert.equal(f.inputs.length, 1)
})

test("persistent mapping is scoped to session, model, mode and project; interrupted mappings are not resumed", async () => {
  process.env.AGY_BRIDGE_STATE_DIR = await mkdtemp(join(tmpdir(), "agy-conversations-test-"))
  const a = conversationStore("agy", "session-A:model:default", "project-A")
  const b = conversationStore("agy", "session-B:model:default", "project-A")
  const id = "11111111-1111-4111-8111-111111111111"
  await a.save(id, true)
  assert.equal(await a.load(), id)
  assert.equal(await b.load(), undefined)
  assert.equal(await conversationStore("agy", "session-A:model:plan", "project-A").load(), undefined)
  assert.equal(await conversationStore("agy", "session-A:other:default", "project-A").load(), undefined)
  assert.equal(await conversationStore("agy", "session-A:model:default", "project-B").load(), undefined)
  await a.save(id, false)
  assert.equal(await a.load(), undefined)
  await a.save(id, true)
  const path = join(process.env.AGY_BRIDGE_STATE_DIR, (await readdir(process.env.AGY_BRIDGE_STATE_DIR))[0])
  const saved = JSON.parse(await readFile(path, "utf8"))
  await writeFile(path, JSON.stringify({ ...saved, owner: "foreign session" }))
  assert.equal(await a.load(), undefined)
  await writeFile(path, "broken JSON")
  assert.equal(await a.load(), undefined)
  await a.clear()
  assert.equal(await a.load(), undefined)
})

test("missing conversation falls back once with only supplied history; transport failures are never replayed", async () => {
  let cleared = 0, created = 0, calls = 0
  const old = { runTurn: async () => { throw new ConversationMismatch("wrong init") }, dispose: () => {},
    persistenceStore: { clear: async () => cleared++ } }
  const supplied = [...user, { role: "assistant", content: "Only session A history" }, { role: "user", content: "Continue A" }]
  const fresh = async () => { created++; return { runTurn: async (messages) => {
    calls++
    assert.equal(messages, supplied)
    return { status: "SUCCESS", response: "A restored" }
  } } }
  const result = await runBoundTurn(old, supplied, () => {}, new AbortController().signal, fresh)
  assert.equal(result.response, "A restored")
  assert.equal(cleared, 1)
  assert.equal(created, 1)
  assert.equal(calls, 1)
  old.runTurn = async () => { throw new Error("process crashed") }
  await assert.rejects(runBoundTurn(old, supplied, () => {}, new AbortController().signal, fresh), /process crashed/)
  assert.equal(created, 1)
  old.runTurn = async (messages, onEvent) => { onEvent(done); throw new ConversationMismatch("late mismatch") }
  await assert.rejects(runBoundTurn(old, supplied, () => {}, new AbortController().signal, fresh), /late mismatch/)
  assert.equal(created, 1)
})

test("resumed adapter uses exact ID, rejects foreign init and has no idle expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const child = new EventEmitter()
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null,
    killed: false, kill() { this.killed = true; this.emit("close", 0) } })
  const directory = await mkdtemp(join(tmpdir(), "agy-resume-test-"))
  let args
  const id = "11111111-1111-4111-8111-111111111111"
  const session = createAgySession("mock", "model", "key", directory, false, false, "default", (cmd, arguments_) => {
    args = arguments_
    return child
  }, directory, { conversationID: id })
  try {
    t.mock.timers.tick(24 * 60 * 60 * 1000)
    assert.equal(session.closed, false)
    assert.equal(child.killed, false)
    assert.equal(args[args.indexOf("--conversation") + 1], id)
    assert.ok(!args.includes("--continue") && !args.includes("-c"))
    child.stdout.write(`${JSON.stringify({ event: "init", conversation_id: "22222222-2222-4222-8222-222222222222" })}\n`)
    assert.equal(session.closed, true)
    await assert.rejects(session.runTurn(user), ConversationMismatch)
  } finally { session.dispose(); t.mock.timers.reset() }
})

test("Build selection cannot be overridden by /plan in a checkpoint or quotation", async (t) => {
  const f = await fixture(t, [{ result: { status: "SUCCESS", response: "Build is active" } }])
  await f.post([{ role: "user", content: "Previously I used /plan. Now implement the approved change." }], false, { "x-opencode-agent": "build" })
  assert.equal(f.factories[0][4], "default")
  assert.equal(openCodeMode({ "x-opencode-agent": " Plan " }), "plan")
  assert.equal(openCodeMode({ "x-opencode-agent": "exec" }), "default")
})

test("mode boundary labels old plan reminders as historical without approving unrelated work", () => {
  const history = "User: You remain in Plan mode until the user switches agents.\nAssistant: Switch to Build.\nUser: Implement the agreed fix."
  const build = primaryModePrompt(history, "default", true)
  assert.match(build, /CURRENT selected agent is not Plan/)
  assert.match(build, /PREVIOUS state/)
  assert.match(build, /switching modes alone is not approval/)
  assert.ok(build.includes(history), "do not erase the user's history or permissions")
  assert.match(primaryModePrompt(history, "plan", true), /do not implement changes/)
  assert.equal(primaryModePrompt(history, "default", false), history, "auxiliary summaries get no execution instructions")
})

for (const stream of [false, true]) {
  test(`empty compaction retries in isolated sessions and returns only a validated summary (stream=${stream})`, async (t) => {
    const f = await fixture(t, [
      { result: { status: "SUCCESS", response: null, usage: { input_tokens: 2 } } },
      { result: { status: "SUCCESS", response: " \n ", usage: { input_tokens: 3 } } },
      { result: { status: "SUCCESS", response: "## Summary\nGoal: preserve current work.\nNext: implement the agreed fix.", usage: { input_tokens: 4 } } },
    ])
    const result = await f.post(user, stream, { "x-opencode-kind": "compaction" })
    assert.equal(result.status, 200)
    assert.equal(f.inputs.length, 3)
    assert.equal(f.factories.length, 3)
    assert.equal(new Set(f.factories.map((args) => args[2])).size, 3)
    for (const input of f.inputs) {
      assert.equal(input[0].content, user[0].content)
      assert.match(input.at(-1).content, /do not call tools/)
    }
    assert.match(result.raw, /preserve current work/)
    assert.doesNotMatch(result.raw, /keine abschließende Antwort|"content":null|tool_calls/)
    if (stream) assert.equal(result.chunks.at(-1).choices[0].finish_reason, "stop")
    else assert.equal(result.body.usage.prompt_tokens, 9)
  })

  test(`three empty compactions recover with factual excerpts instead of stopping (stream=${stream})`, async (t) => {
    const f = await fixture(t, Array.from({ length: 3 }, () => ({ result: { status: "SUCCESS", response: null } })))
    const result = await f.post(user, stream, { "x-opencode-kind": "compaction" })
    assert.equal(result.status, 200)
    assert.match(result.raw, /no non-empty summary after 3/)
    assert.match(result.raw, /local recovery/)
    assert.match(result.raw, /Perform allowed work/)
    assert.doesNotMatch(result.raw, /keine abschließende/)
    if (stream) assert.equal(result.chunks.at(-1).choices[0].finish_reason, "stop")
    else assert.ok(result.body.choices[0].message.content.trim().length > 100)
    assert.equal(f.inputs.length, 3)
  })
}

test("whitespace result falls back to valid streamed compaction text", async (t) => {
  const f = await fixture(t, [{ result: { status: "SUCCESS", response: "   " }, events: [
    { event: "step_update", step_update: { step_type: "agent_response", text_delta: "Actual summary of completed and remaining work." } },
  ] }])
  const result = await f.post(user, true, { "x-opencode-kind": "compaction" })
  assert.equal(result.status, 200)
  assert.match(result.raw, /Actual summary/)
  assert.equal(f.inputs.length, 1)
})

test("compaction errors recover from supplied history, not the failed response text", async (t) => {
  const f = await fixture(t, [{ result: { status: "ERROR", response: "Authentication failed", error: null } }])
  const result = await f.post(user, true, { "x-opencode-kind": "compaction" })
  assert.equal(result.status, 200)
  assert.match(result.raw, /compaction failed/)
  assert.match(result.raw, /Perform allowed work/)
  assert.match(result.raw, /local recovery/)
  assert.doesNotMatch(result.raw, /Authentication failed/)
  assert.equal(f.inputs.length, 1)
})

test("compaction tool execution is stopped and recovered without replaying it", async (t) => {
  const f = await fixture(t, [{ events: [failure], result: { status: "SUCCESS", response: "" } }])
  const result = await f.post(user, true, { "x-opencode-kind": "compaction" })
  assert.equal(result.status, 200)
  assert.match(result.raw, /attempted tool execution/)
  assert.match(result.raw, /local recovery/)
  assert.equal(f.inputs.length, 1)
})

test("summary validator rejects null placeholders and non-text values", () => {
  for (const response of [null, undefined, "", " \n ", "null", "undefined", "[object Object]", {}, []]) {
    assert.equal(summaryText({ response }, ""), "")
  }
  assert.equal(summaryText({ response: "null" }, "Valid streamed summary"), "Valid streamed summary")
})

test("compaction process failure provides a checkpoint so the prompt can continue", async (t) => {
  const f = await fixture(t, [{ throw: "CLI process crashed" }])
  const result = await f.post(user, true, { "x-opencode-kind": "compaction" })
  assert.equal(result.status, 200)
  assert.match(result.raw, /Perform allowed work/)
  assert.match(result.raw, /context recovery, NOT task completion/)
  assert.equal(result.chunks.at(-1).choices[0].finish_reason, "stop")
})

test("local fallback is bounded, grounded in only supplied history and retains denial constraints", () => {
  const source = [
    { role: "system", content: "Do not write outside project A." },
    { role: "user", content: "Implement SESSION_A_ONLY." },
    { role: "assistant", content: "Plan approved for task A, tests still pending." },
    { role: "tool", content: "Permission denied for forbidden.txt. Do not retry." },
    { role: "user", content: "Continue permitted work A." },
  ]
  const checkpoint = fallbackCheckpoint(source, "Empty summarization")
  assert.match(checkpoint, /SESSION_A_ONLY/)
  assert.match(checkpoint, /tests still pending/)
  assert.match(checkpoint, /Do not write outside project A/)
  assert.match(checkpoint, /Permission denied/)
  assert.match(checkpoint, /not instructions to repeat/)
  assert.doesNotMatch(checkpoint, /SESSION_B/)
  const large = source.map((message) => ({ ...message, content: message.content.repeat(10_000) }))
  const limited = fallbackCheckpoint(large)
  assert.ok(limited.length < 34_000)
  assert.match(limited, /omitted/)
  assert.equal(source.at(-1).content, "Continue permitted work A.", "do not modify original transcript")
})

test("primary prompt can continue after recovered compaction without a provider error", async (t) => {
  const f = await fixture(t, [
    { throw: "Summarizer failed" },
    { result: { status: "SUCCESS", response: "Continued the permitted task." } },
  ])
  const compact = await f.post(user, false, { "x-opencode-kind": "compaction" })
  assert.equal(compact.status, 200)
  const summary = compact.body.choices[0].message.content
  const continued = await f.post([{ role: "user", content: `<conversation-checkpoint>${summary}</conversation-checkpoint>\nContinue the original permitted task.` }])
  assert.equal(continued.status, 200)
  assert.equal(continued.body.choices[0].message.content, "Continued the permitted task.")
  assert.equal(f.inputs.length, 2)
  assert.equal(f.factories[0][3], true)
  assert.equal(f.factories[1][3], false)
})

for (const directory of ["", "relative/path", encodeURIComponent(import.meta.filename), encodeURIComponent(join(tmpdir(), "nonexistent-agy-project-123456789"))]) {
  test(`unavailable project directory allows a single no-project turn: ${directory}`, async (t) => {
    const f = await fixture(t, [{ result: { status: "SUCCESS", response: "Task answered without a project." } }])
    const result = await f.post(user, false, { "x-opencode-directory": directory })
    assert.equal(result.status, 200)
    assert.equal(f.factories[0][5], undefined)
    assert.equal(f.inputs.length, 1)
    assert.equal(result.body.choices[0].message.content, "Task answered without a project.")
  })
}

test("no-project process uses its own scratch cwd, never the service cwd, and explains missing context", async () => {
  const child = new EventEmitter()
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null,
    killed: false, kill() { this.killed = true; this.emit("close", 0) } })
  const scratch = await mkdtemp(join(tmpdir(), "agy-no-project-test-"))
  let launched, sent
  child.stdin.on("data", (data) => {
    sent = JSON.parse(data.toString()).message.content
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK" } })}\n`))
  })
  const session = createAgySession("mock", "model", "key", scratch, false, false, "default", (cmd, args, options) => {
    launched = { args, options }
    return child
  })
  try {
    const result = await session.runTurn([{ role: "user", content: "Answer a general question." }])
    assert.equal(result.response, "OK")
    assert.equal(launched.options.cwd, scratch)
    assert.notEqual(launched.options.cwd, process.cwd())
    assert.equal(launched.args.filter((argument) => argument === "--add-dir").length, 1)
    assert.ok(!launched.args.includes(undefined))
    assert.match(sent, /No project directory was supplied/)
    assert.match(sent, /ask once/)
    assert.match(sent, /Do not search for or guess/)
  } finally { session.dispose() }
})

test("provider supports wrapped and legacy session metadata without falling back to plugin cwd", async () => {
  const event = { sessionID: "ses-test", headers: {}, agent: "build", kind: "primary" }
  const ctx = { location: { directory: process.cwd() }, session: { get: async () => ({ data: { location: { directory: process.cwd() } } }) } }
  await forwardSessionContext(ctx, event)
  assert.equal(decodeURIComponent(event.headers["x-opencode-directory"]), process.cwd())
  ctx.session.get = async () => ({ directory: process.cwd() })
  await forwardSessionContext(ctx, event)
  assert.equal(decodeURIComponent(event.headers["x-opencode-directory"]), process.cwd())
  ctx.session.get = async () => { throw new Error("Metadata lookup unavailable") }
  await forwardSessionContext(ctx, event)
  assert.equal(event.headers["x-opencode-directory"], undefined)
  assert.equal(event.headers["x-opencode-session"], "ses-test")
})
