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
const pendingActivities = new Map()

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

const ACTIVITY_TOOL_NAMES = new Map([
  ["run_command", "agy_shell"], ["view_file", "agy_read"], ["write_to_file", "agy_write"],
  ["replace_file_content", "agy_edit"], ["multi_replace_file_content", "agy_edit"],
  ["grep_search", "agy_grep"], ["find_by_name", "agy_find"], ["manage_task", "agy_task"],
  ["ask_question", "agy_question"], ["web_search", "agy_web_search"],
  ["parallel_web_search", "agy_web_search"], ["web_fetch", "agy_web_fetch"],
])

function activityToolName(tool) {
  return ACTIVITY_TOOL_NAMES.get(tool) ?? "agy_activity"
}

const ACTIVITY_LABELS = new Map([
  ["run_command", "Run command"], ["view_file", "Read file"], ["write_to_file", "Write file"],
  ["replace_file_content", "Edit file"], ["multi_replace_file_content", "Edit files"],
  ["grep_search", "Search files"], ["find_by_name", "Find files"], ["manage_task", "Manage task"],
  ["ask_question", "Ask question"], ["web_search", "Web search"],
  ["parallel_web_search", "Web search"], ["web_fetch", "Fetch webpage"],
])

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char])
}

function displayValue(value) {
  if (typeof value === "string") return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function liveActivityStart(activity) {
  const parameters = activity.parameters && typeof activity.parameters === "object" ? activity.parameters : {}
  const priority = ["CommandLine", "TargetFile", "AbsolutePath", "Query", "Url", "URL", "path", "file_path"]
  const key = priority.find((name) => parameters[name] !== undefined) ?? Object.keys(parameters)[0]
  const label = ACTIVITY_LABELS.get(activity.tool) ?? activity.tool.replace(/_/g, " ")
  const summary = key
    ? `${label} · ${key}: ${displayValue(parameters[key])}`
    : label
  const action = escapeHtml(displayValue(parameters))
  return `<details><summary>${escapeHtml(summary)}</summary><p><strong>Status:</strong> In progress</p><p><strong>Action</strong></p><pre><code>${action}</code></pre>`
}

function liveActivityFinish(activity) {
  const output = activity.output === undefined ? "" : `<p><strong>Output</strong></p><pre><code>${escapeHtml(displayValue(activity.output))}</code></pre>`
  const error = activity.error === undefined ? "" : `<p><strong>Error</strong></p><pre><code>${escapeHtml(displayValue(activity.error))}</code></pre>`
  return `<p><strong>Status:</strong> ${escapeHtml(activity.status)}</p>${output}${error}</details>\n\n`
}

function activityToolCalls(activities, advertisedTools) {
  if (!activities.length) return undefined
  const available = new Set((advertisedTools ?? []).map((tool) => tool.function?.name ?? tool.name))
  if (!available.size) return undefined
  const visibleActivities = activities.filter((activity) => available.has(activityToolName(activity.tool)))
  if (!visibleActivities.length) return undefined
  const group = randomUUID()
  const toolCalls = visibleActivities.map((activity, index) => ({
    id: `agy-${group}-${index}`,
    type: "function",
    function: {
      name: activityToolName(activity.tool),
      arguments: JSON.stringify({
        tool: activity.tool,
        status: activity.status,
        parameters: activity.parameters,
        ...(activity.output !== undefined ? { output: activity.output } : {}),
        ...(activity.error !== undefined ? { error: activity.error } : {}),
      }),
    },
  }))
  return { group, toolCalls }
}

function activityGroupFromMessages(messages = []) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue
    const match = /^agy-([0-9a-f-]+)-\d+$/i.exec(message.tool_call_id)
    if (match) return match[1]
  }
}

function finishPendingActivity(body, response, model, id, created, stream) {
  const group = activityGroupFromMessages(body.messages)
  const pending = group && pendingActivities.get(group)
  if (!pending) return false
  const received = new Set((body.messages ?? [])
    .filter((message) => message.role === "tool" && typeof message.tool_call_id === "string")
    .map((message) => message.tool_call_id))
  if (!pending.toolCallIds.every((toolCallId) => received.has(toolCallId))) {
    sendJson(response, 409, { error: { message: "AGY activity display tools have not all completed" } })
    return true
  }
  pendingActivities.delete(group)
  if (stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    })
    response.flushHeaders()
    writeSse(response, id, model, created, { role: "assistant" })
    if (pending.text) writeSse(response, id, model, created, { content: pending.text })
    writeSse(response, id, model, created, {}, "stop")
    response.end("data: [DONE]\n\n")
  } else {
    sendJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: pending.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }
  return true
}

function sendActivityToolCalls(response, stream, model, id, created, result, toolCallData) {
  const { group, toolCalls } = toolCallData
  pendingActivities.set(group, {
    text: result.response ?? "",
    toolCallIds: toolCalls.map((toolCall) => toolCall.id),
    createdAt: Date.now(),
  })
  if (stream) {
    if (!response.headersSent) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      })
      response.flushHeaders()
      writeSse(response, id, model, created, { role: "assistant" })
    }
    toolCalls.forEach((toolCall, index) => writeSse(response, id, model, created, {
      tool_calls: [{ index, ...toolCall }],
    }))
    writeSse(response, id, model, created, {}, "tool_calls")
    response.end("data: [DONE]\n\n")
    return
  }
  sendJson(response, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: result.usage?.input_tokens ?? 0,
      completion_tokens: result.usage?.output_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
    },
  })
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
  const stream = Boolean(body.stream)
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const now = Date.now()
  for (const [key, pending] of pendingActivities) {
    if (now - pending.createdAt > 30 * 60 * 1000) pendingActivities.delete(key)
  }
  if (finishPendingActivity(body, response, model, id, created, stream)) return

  const attachmentDir = await mkdtemp(join(tmpdir(), "agy-openai-attachments-"))
  const sessionId = request.headers["x-opencode-session"]
  const conversationKey = typeof sessionId === "string" ? `${sessionId}:${model}` : undefined
  const conversationId = conversationKey ? conversations.get(conversationKey) : undefined
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableEnded) controller.abort()
  })

  let heartbeat
  let streamedAnswer = ""
  const activityState = new Map()
  const openActivityKeys = new Set()
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
      if (controller.signal.aborted || response.destroyed) return
      if (event.event === "step_update" && event.step_update?.step_type === "agent_response") {
        if (typeof event.step_update.text_delta === "string" && event.step_update.text_delta) {
          streamedAnswer += event.step_update.text_delta
        }
        return
      }
      if (event.event !== "step_update" || event.step_update?.step_type !== "tool") return
      const step = event.step_update
      const tool = step.tool_name ?? step.tool_info?.name ?? "Tool"
      const index = Number(step.step_index)
      const fallbackKey = `${tool}:${JSON.stringify(step.tool_info?.parameters ?? {})}`
      const key = Number.isFinite(index) ? String(index) : fallbackKey
      const info = step.tool_info ?? {}
      const failed = step.state === "ERROR" || info.error !== undefined
      const activity = {
        tool,
        status: failed ? "Failed" : step.state === "ACTIVE" ? "In progress" : step.state === "DONE" ? "Completed" : "Updated",
        parameters: info.parameters ?? activityState.get(key)?.parameters ?? {},
        ...(info.output !== undefined ? { output: info.output } : {}),
        ...(info.error !== undefined ? { error: info.error } : {}),
      }
      activityState.set(key, activity)
      if (stream) {
        let update = ""
        if (!openActivityKeys.has(key)) {
          update += liveActivityStart(activity)
          openActivityKeys.add(key)
        }
        if (step.state === "DONE" || failed) {
          update += liveActivityFinish(activity)
          openActivityKeys.delete(key)
        }
        if (update) writeSse(response, id, model, created, { reasoning_content: update })
      }
    })
    if (result.status !== "SUCCESS") throw new Error(result.error || `agy finished with status ${result.status}`)
    if (result.conversation_id && conversationKey) conversations.set(conversationKey, result.conversation_id)
    const text = result.response ?? streamedAnswer
    for (const key of openActivityKeys) {
      const activity = activityState.get(key)
      if (activity) writeSse(response, id, model, created, {
        reasoning_content: liveActivityFinish({ ...activity, status: "Completed" }),
      })
    }
    openActivityKeys.clear()
    const toolCallData = activityToolCalls([...activityState.values()], body.tools)
    if (toolCallData) {
      clearInterval(heartbeat)
      sendActivityToolCalls(response, stream, model, id, created, { ...result, response: text }, toolCallData)
      return
    }
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

    if (text) writeSse(response, id, model, created, { content: text })
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
