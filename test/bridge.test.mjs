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
const { handle, createAgySession, conversationStore, runBoundTurn, ConversationMismatch, openCodeMode, primaryModePrompt } = await import("../agy-openai-bridge.mjs")
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
  const f = await fixture(t, [{ events: [failure], result: { status: "SUCCESS", response: "Summary" } }])
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

for (const directory of ["", "relative/path", "%ZZ", encodeURIComponent(import.meta.filename)]) {
  test(`invalid or missing project directory is refused: ${directory}`, async (t) => {
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
  await assert.rejects(forwardSessionContext(ctx, event), /no project directory/)
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
