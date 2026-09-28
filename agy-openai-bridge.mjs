import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { createServer } from "node:http"

const HOST = "127.0.0.1"
const PORT = Number(process.env.AGY_BRIDGE_PORT ?? 47381)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("AGY_BRIDGE_PORT must be an integer from 1024 to 65535")
const MAX_BODY_BYTES = 2 * 1024 * 1024
const servers = new Map()

function promptFrom(messages = []) {
  return messages.map((message) => {
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part.text ?? "").join("")
        : ""
    return `--- ${message.role ?? "user"} ---\n${content}`
  }).join("\n\n")
}

function runAgy(command, model, prompt, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      "--model", model,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", "30m",
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let result
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }
    const abort = () => fail(signal.reason ?? new Error("Request aborted"))
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.stdin.on("error", fail)
    child.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n")
    child.once("error", fail)
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort)
      if (settled) return
      settled = true
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line)
          if (event.event === "result") result = event.result
        } catch {}
      }
      if (code !== 0 || result?.status !== "SUCCESS") {
        reject(new Error(result?.error || stderr.trim() || `agy exited with code ${code}`))
        return
      }
      resolve(result)
    })
  })
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(body))
}

function chunk(id, model, created, content, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finishReason }],
  }
}

async function handle(request, response, command) {
  // Loopback is not an authentication boundary by itself. Refuse browser-origin
  // requests (including DNS-rebinding attempts) and unexpected Host headers.
  if (request.headers.origin || request.headers.host !== `${HOST}:${PORT}`) {
    sendJson(response, 403, { error: { message: "Forbidden" } })
    return
  }
  if (request.method === "GET" && request.url === "/healthz") {
    sendJson(response, 200, { service: "agy-openai-bridge", version: 1 })
    return
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [] })
    return
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    sendJson(response, 404, { error: { message: "Not found" } })
    return
  }

  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    sendJson(response, 415, { error: { message: "Content-Type must be application/json" } })
    return
  }
  let raw = ""
  for await (const part of request) {
    raw += part
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: { message: "Request body too large" } })
      return
    }
  }
  let body
  try { body = JSON.parse(raw) } catch {
    sendJson(response, 400, { error: { message: "Invalid JSON body" } })
    return
  }

  const model = String(body.model ?? "").replace(/^agy-cli\//, "")
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) {
    sendJson(response, 400, { error: { message: "Invalid or missing model slug" } })
    return
  }
  const prompt = promptFrom(body.messages)
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableEnded) controller.abort()
  })

  try {
    const result = await runAgy(command, model, prompt, controller.signal)
    const id = `chatcmpl-${result.conversation_id ?? randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const text = result.response ?? ""
    if (!body.stream) {
      sendJson(response, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: result.usage?.input_tokens ?? 0,
          completion_tokens: result.usage?.output_tokens ?? 0,
          total_tokens: result.usage?.total_tokens ?? 0,
        },
      })
      return
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    response.write(`data: ${JSON.stringify(chunk(id, model, created, ""))}\n\n`)
    for (let offset = 0; offset < text.length; offset += 96) {
      if (controller.signal.aborted || response.destroyed) return
      response.write(`data: ${JSON.stringify(chunk(id, model, created, text.slice(offset, offset + 96)))}\n\n`)
    }
    response.write(`data: ${JSON.stringify(chunk(id, model, created, undefined, "stop"))}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    if (response.headersSent) {
      response.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
      response.end("data: [DONE]\n\n")
    } else {
      sendJson(response, 502, { error: { message: error.message } })
    }
  }
}

export function startBridge(command) {
  if (servers.has(command)) return servers.get(command)
  const server = createServer((request, response) => {
    void handle(request, response, command)
  })
  const ready = new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        fetch(`http://${HOST}:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) })
          .then(async (response) => {
            const health = await response.json()
            if (!response.ok || health.service !== "agy-openai-bridge" || health.version !== 1) {
              throw new Error("another service is using the agy bridge port")
            }
            resolve()
          })
          .catch(() => reject(new Error(`Port ${PORT} is occupied by an unverified service; refusing to connect`)))
      } else {
        reject(error)
      }
    })
    server.listen(PORT, HOST, () => {
      server.unref()
      servers.set(command, ready)
      resolve()
    })
  })
  servers.set(command, ready)
  return ready
}
