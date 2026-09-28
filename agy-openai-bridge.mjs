import { randomUUID } from "node:crypto"
import { mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { spawn } from "node:child_process"
import { createServer } from "node:http"

const HOST = "127.0.0.1"
const PORT = Number(process.env.AGY_BRIDGE_PORT ?? 47381)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("AGY_BRIDGE_PORT must be an integer from 1024 to 65535")
const servers = new Map()
const conversations = new Map()

const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/gif", ".gif"],
  ["image/webp", ".webp"], ["image/bmp", ".bmp"], ["image/tiff", ".tiff"],
  ["image/svg+xml", ".svg"], ["application/pdf", ".pdf"],
  ["video/mp4", ".mp4"], ["video/quicktime", ".mov"], ["video/webm", ".webm"], ["video/x-msvideo", ".avi"],
  ["audio/mpeg", ".mp3"], ["audio/wav", ".wav"], ["audio/mp4", ".m4a"],
  ["application/msword", ".doc"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.oasis.opendocument.text", ".odt"], ["application/rtf", ".rtf"],
  ["application/vnd.ms-powerpoint", ".ppt"], ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/vnd.ms-excel", ".xls"], ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/epub+zip", ".epub"],
  ["text/plain", ".txt"], ["text/markdown", ".md"], ["text/csv", ".csv"],
  ["text/html", ".html"], ["text/xml", ".xml"],
  ["application/json", ".json"], ["application/xml", ".xml"],
  ["application/zip", ".zip"], ["application/octet-stream", ".bin"],
])

function attachmentUrl(part) {
  const value = part.image_url?.url ?? part.image_url ?? part.file?.url ?? part.file?.data ?? part.url ?? part.data
  return typeof value === "string" ? value : undefined
}

async function saveAttachment(part, directory) {
  const url = attachmentUrl(part)
  if (!url?.startsWith("data:")) return undefined
  const match = /^data:([^;,]+)?;base64,([\s\S]*)$/i.exec(url)
  if (!match) throw new Error("Only base64 data-URI attachments can be forwarded to agy")
  const mime = (match[1] || part.mimeType || part.mime_type || "application/octet-stream").toLowerCase()
  const extension = MIME_EXTENSIONS.get(mime) ?? extname(part.filename ?? part.name ?? "")
  const filePath = join(directory, `${randomUUID()}${extension || ".bin"}`)
  const file = await open(filePath, "w")
  try {
    const encoded = match[2]
    const chunkSize = 256 * 1024 // multiple of four so base64 groups are never split
    for (let index = 0; index < encoded.length; index += chunkSize) {
      const bytes = Buffer.from(encoded.slice(index, index + chunkSize), "base64")
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset)
        offset += bytesWritten
      }
    }
  } finally {
    await file.close()
  }
  return { mime, filePath }
}

async function promptFrom(messages = [], attachmentDir) {
  const prompt = []
  for (const message of messages) {
    const sections = []
    if (typeof message.content === "string") sections.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part.text === "string") sections.push(part.text)
        else if (["image_url", "image", "input_image", "file", "input_file"].includes(part.type)) {
          const attachment = await saveAttachment(part, attachmentDir)
          if (attachment) sections.push(`Attached ${attachment.mime} file: @${attachment.filePath}`)
          else {
            const url = attachmentUrl(part)
            if (url) sections.push(`Attached file URL: ${url}`)
          }
        }
      }
    }
    prompt.push(`--- ${message.role ?? "user"} ---\n${sections.join("\n")}`)
  }
  return prompt.join("\n\n")
}

function runAgy(command, model, prompt, attachmentDir, signal, conversationId, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model", model,
      "--add-dir", attachmentDir,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", "30m",
    ]
    if (conversationId) args.push("--conversation", conversationId)
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let result
    let settled = false
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      child.kill()
      reject(error)
    }
    const abort = () => fail(signal.reason ?? new Error("Request aborted"))
    signal?.addEventListener("abort", abort, { once: true })
    const handleLine = (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        onEvent(event)
        if (event.event === "result") result = event.result
      } catch {
        // Ignore non-JSON diagnostic lines; agy writes its machine stream as NDJSON.
      }
    }
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk
      let newline
      while ((newline = stdout.indexOf("\n")) !== -1) {
        handleLine(stdout.slice(0, newline).replace(/\r$/, ""))
        stdout = stdout.slice(newline + 1)
      }
    })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.stdin.on("error", fail)
    child.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n")
    child.once("error", fail)
    child.once("close", (code) => {
      cleanup()
      if (settled) return
      settled = true
      handleLine(stdout)
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

function chunk(id, model, created, delta = {}, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function writeSse(response, id, model, created, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify(chunk(id, model, created, delta, finishReason))}\n\n`)
}

const TOOL_LABELS = new Map([
  ["run_command", "Run command"], ["view_file", "Read file"], ["write_to_file", "Write file"],
  ["replace_file_content", "Edit file"], ["multi_replace_file_content", "Edit files"],
  ["grep_search", "Search project"], ["find_by_name", "Find file"],
  ["manage_task", "Manage task"], ["ask_question", "Ask a question"],
])

const FIELD_LABELS = new Map([
  ["AbsolutePath", "File path"], ["FilePath", "File path"], ["file_path", "File path"], ["Path", "Path"],
  ["CommandLine", "Command"], ["Action", "Action"], ["TaskId", "Task ID"],
  ["Content", "Content"], ["content", "Content"], ["NewContent", "New content"],
  ["OldContent", "Previous content"], ["output", "Output"], ["error", "Error"],
])

const SUMMARY_PARAMETER_KEYS = new Map([
  ["run_command", ["CommandLine", "command", "cmd"]],
  ["view_file", ["AbsolutePath", "FilePath", "file_path", "path"]],
  ["write_to_file", ["AbsolutePath", "FilePath", "file_path", "path"]],
  ["replace_file_content", ["AbsolutePath", "FilePath", "file_path", "path"]],
  ["multi_replace_file_content", ["AbsolutePath", "FilePath", "file_path", "path"]],
  ["grep_search", ["Query", "query", "SearchQuery", "search_query", "pattern"]],
  ["find_by_name", ["Pattern", "pattern", "Name", "name"]],
  ["manage_task", ["Action", "action", "TaskId", "task_id"]],
  ["ask_question", ["Question", "question"]],
])

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}

function formatStepSummary(stepNumber, tool, toolLabel, parameters) {
  const fields = parameters && typeof parameters === "object" ? parameters : {}
  const candidates = SUMMARY_PARAMETER_KEYS.get(tool) ?? Object.keys(fields).filter((key) => !/content|output|result/i.test(key))
  const normalized = new Map(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]))
  const previews = []
  for (const key of candidates) {
    const value = normalized.get(key.toLowerCase())
    if (value == null || (typeof value !== "string" && typeof value !== "number")) continue
    const text = String(value).trim()
    if (!text) continue
    previews.push(`<span>${escapeHtml(FIELD_LABELS.get(key) ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase()))}: <code>${escapeHtml(text)}</code></span>`)
    if (previews.length === 2) break
  }
  return `<summary>Step ${stepNumber} · ${escapeHtml(toolLabel)}${previews.length ? ` · ${previews.join(" · ")}` : ""}</summary>`
}

function formatActivityFields(value) {
  if (value == null) return ""
  if (typeof value !== "object") return `<pre><code>${escapeHtml(value)}</code></pre>`
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item]) : Object.entries(value)
  return entries.map(([key, item]) => {
    const label = FIELD_LABELS.get(key) ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())
    return `<div><strong>${escapeHtml(label)}</strong>${formatActivityFields(item)}</div>`
  }).join("")
}

function formatAgyEvent(event, activityState) {
  if (event.event === "init") return `<p><strong>AGY CLI started</strong> · ${escapeHtml(event.init?.model ?? "Unknown model")}</p>\n\n`
  if (event.event === "result") {
    if (activityState.openStep !== undefined) {
      activityState.openStep = undefined
      if (event.result?.status === "SUCCESS") return "</details>\n\n"
      const error = event.result?.error
      return `</details>\n<p><strong>AGY request failed</strong>${error ? ` · ${escapeHtml(error)}` : ""}</p>\n\n`
    }
    if (event.result?.status === "SUCCESS") return ""
    const error = event.result?.error
    return `<p><strong>AGY error</strong>${error ? ` · ${escapeHtml(error)}` : ""}</p>\n\n`
  }
  const step = event.step_update
  if (event.event !== "step_update" || !step || step.step_type !== "tool") return ""

  const tool = step.tool_name ?? step.tool_info?.name ?? "Tool"
  const toolLabel = TOOL_LABELS.get(tool) ?? tool.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  const index = Number(step.step_index)
  const stepNumber = Number.isFinite(index) ? index : "?"
  const info = step.tool_info ?? {}
  const parameters = info.parameters ?? {}
  const output = info.output
  const error = info.error
  if (step.state === "ACTIVE") {
    if (activityState.seenSteps.has(stepNumber)) return ""
    if (activityState.openStep !== undefined) {
      const previous = `</details>\n\n`
      activityState.openStep = undefined
      const next = formatAgyEvent(event, activityState)
      return previous + next
    }
    activityState.openStep = stepNumber
    activityState.seenSteps.add(stepNumber)
    return `<details>\n${formatStepSummary(stepNumber, tool, toolLabel, parameters)}\n<p><strong>Status:</strong> In progress</p>\n<div><strong>Action</strong>${formatActivityFields(parameters)}</div>\n`
  }

  if (activityState.completedSteps.has(stepNumber)) return ""
  const failed = step.state === "ERROR" || error !== undefined
  const status = failed ? "Failed" : step.state === "DONE" ? "Completed" : "Updated"
  let text = ""
  if (activityState.openStep !== stepNumber) {
    if (activityState.openStep !== undefined) text += "</details>\n\n"
    activityState.openStep = stepNumber
    activityState.seenSteps.add(stepNumber)
    text += `<details>\n${formatStepSummary(stepNumber, tool, toolLabel, parameters)}\n`
  }
  text += `<p><strong>Status:</strong> ${status}</p>\n`
  if (output !== undefined) text += `<div><strong>Output</strong>${formatActivityFields(output)}</div>\n`
  if (error !== undefined) text += `<div><strong>Error</strong>${formatActivityFields(error)}</div>\n`
  activityState.openStep = undefined
  activityState.completedSteps.add(stepNumber)
  return `${text}</details>\n\n`
}

function inlineValue(value) {
  if (typeof value !== "string") return `\`${String(value)}\``
  const fence = "`".repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)))
  return `${fence}${value}${fence}`
}

function formatAgyField(key, value, depth) {
  const indent = "  ".repeat(depth)
  const label = FIELD_LABELS.get(key) ?? key.replace(/_/g, " ")
  if (value && typeof value === "object") return `${indent}- **${label}:**\n${formatAgyFields(value, depth + 1)}`
  if (typeof value === "string" && value.includes("\n")) {
    const fence = "`".repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)))
    const content = value.split("\n").map((line) => `${indent}  ${line}`).join("\n")
    return `${indent}- **${label}:**\n${indent}  ${fence}text\n${content}\n${indent}  ${fence}`
  }
  return `${indent}- **${label}:** ${inlineValue(value)}`
}

function formatAgyFields(value, depth = 0) {
  const indent = "  ".repeat(depth)
  if (Array.isArray(value)) {
    return value.map((item) => item && typeof item === "object"
      ? `${indent}-\n${formatAgyFields(item, depth + 1)}`
      : `${indent}- ${inlineValue(item)}`).join("\n")
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, item]) => formatAgyField(key, item, depth)).join("\n")
  }
  return `${indent}${inlineValue(value)}`
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
  for await (const part of request) raw += part
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
  const attachmentDir = await mkdtemp(join(tmpdir(), "agy-openai-attachments-"))
  const sessionId = request.headers["x-opencode-session"]
  const conversationKey = typeof sessionId === "string" ? `${sessionId}:${model}` : undefined
  const conversationId = conversationKey ? conversations.get(conversationKey) : undefined
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableEnded) controller.abort()
  })

  const stream = Boolean(body.stream)
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let heartbeat
  let streamedText = false
  const activityState = { openStep: undefined, seenSteps: new Set(), completedSteps: new Set() }
  if (stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    response.flushHeaders()
    writeSse(response, id, model, created, { role: "assistant" })
    // Keep intermediaries from closing a long-running CLI request during quiet tool work.
    heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": agy-working\n\n")
    }, 10_000)
    heartbeat.unref?.()
  }

  try {
    const messages = conversationId
      ? body.messages.slice(Math.max(0, body.messages.map((message) => message.role).lastIndexOf("user")))
      : body.messages
    const prompt = await promptFrom(messages, attachmentDir)
    const result = await runAgy(command, model, prompt, attachmentDir, controller.signal, conversationId, (event) => {
      if (event.event === "result" && event.result?.conversation_id && conversationKey) {
        conversations.set(conversationKey, event.result.conversation_id)
      }
      if (!stream || controller.signal.aborted || response.destroyed) return
      if (event.event === "step_update" && event.step_update?.step_type === "agent_response") {
        if (typeof event.step_update.text_delta === "string" && event.step_update.text_delta) {
          streamedText = true
          writeSse(response, id, model, created, { content: event.step_update.text_delta })
        }
        // The answer delta is already visible live in the answer part. Repeating
        // every token event in the single Thought block would add noise, not detail.
        return
      }
      // Render each AGY tool step as its own safe HTML disclosure inside the Thought.
      // Omit session/protocol/token metadata; escape all AGY-supplied values.
      const activity = formatAgyEvent(event, activityState)
      if (activity) writeSse(response, id, model, created, { reasoning_content: activity })
    })
    if (result.status !== "SUCCESS") throw new Error(result.error || `agy finished with status ${result.status}`)
    if (result.conversation_id && conversationKey) conversations.set(conversationKey, result.conversation_id)
    const text = result.response ?? ""
    if (!stream) {
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

    if (!streamedText && text) writeSse(response, id, model, created, { content: text })
    clearInterval(heartbeat)
    writeSse(response, id, model, created, {}, "stop")
    response.end("data: [DONE]\n\n")
  } catch (error) {
    if (response.headersSent) {
      clearInterval(heartbeat)
      response.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
      response.end("data: [DONE]\n\n")
    } else {
      sendJson(response, 502, { error: { message: error.message } })
    }
  } finally {
    clearInterval(heartbeat)
    await rm(attachmentDir, { recursive: true, force: true })
  }
}

export function startBridge(command) {
  if (servers.has(command)) return servers.get(command)
  const server = createServer((request, response) => {
    void handle(request, response, command)
  })
  server.requestTimeout = 0
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
