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

function runAgy(command, model, prompt, attachmentDir, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      "--model", model,
      "--add-dir", attachmentDir,
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
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableEnded) controller.abort()
  })

  try {
    const prompt = await promptFrom(body.messages, attachmentDir)
    const result = await runAgy(command, model, prompt, attachmentDir, controller.signal)
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
  } finally {
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
