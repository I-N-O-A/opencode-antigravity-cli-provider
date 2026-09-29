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
const agySessions = new Map()
const agyChildren = new Set()
const pendingActivities = new Map()
const monitorClients = new Set()
const monitorHistory = []
let monitorHistoryBytes = 0
let monitorEnabled = false
const MONITOR_HISTORY_LIMIT = 250
const MONITOR_HISTORY_BYTES = 4 * 1024 * 1024
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000

function publishMonitor(direction, payload) {
  if (!monitorEnabled) return
  const entry = { time: new Date().toISOString(), direction, payload }
  let encoded = JSON.stringify(entry)
  if (Buffer.byteLength(encoded) > MONITOR_HISTORY_BYTES) {
    entry.payload = { note: "Event too large to retain in monitor history", preview: encoded.slice(0, 64_000) }
    encoded = JSON.stringify(entry)
  }
  const bytes = Buffer.byteLength(encoded)
  monitorHistory.push({ encoded, bytes })
  monitorHistoryBytes += bytes
  while (monitorHistory.length > MONITOR_HISTORY_LIMIT || monitorHistoryBytes > MONITOR_HISTORY_BYTES) {
    monitorHistoryBytes -= monitorHistory.shift().bytes
  }
  for (const client of monitorClients) {
    if (!client.destroyed) client.write(`data: ${encoded}\n\n`)
  }
}

export function setMonitorEnabled(enabled) {
  monitorEnabled = Boolean(enabled)
  monitorHistory.length = 0
  monitorHistoryBytes = 0
  const encoded = JSON.stringify({
    time: new Date().toISOString(),
    direction: "Monitor status",
    payload: { enabled: monitorEnabled },
  })
  for (const client of monitorClients) {
    if (!client.destroyed) client.write(`data: ${encoded}\n\n`)
  }
}

const MONITOR_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AGY Bridge Monitor</title>
<style>
  :root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;background:#111827;color:#e5e7eb}
  body{margin:0;padding:24px 24px 100px}h1{font-size:22px;margin:0 0 4px}.note{color:#fbbf24;margin:0 0 18px}
  #state{color:#9ca3af;margin-bottom:16px}.event{border:1px solid #374151;border-radius:8px;margin:10px 0;padding:12px;background:#1f2937}
  .head{display:flex;gap:12px;justify-content:space-between;color:#93c5fd;font-weight:600}.time{color:#9ca3af;font-weight:400}
   pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;color:#d1d5db}.wire{margin-top:10px;color:#9ca3af}.wire summary{cursor:pointer}
  #dock{position:fixed;z-index:10;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;padding:12px 24px;background:#030712;border-top:1px solid #374151;box-shadow:0 -8px 24px #0008}
  button,select{padding:8px 12px;background:#1f2937;color:#e5e7eb;border:1px solid #4b5563;border-radius:6px}
</style>
<body><h1>AGY Bridge Monitor</h1>
<p class="note">Local-only live data. Enable with <code>/agy-monitor-on</code> in OpenCode. AGY stdin shows the readable prompt; expand Raw stream-json stdin line for the exact CLI input. Prompts, files, arguments, and outputs may contain sensitive information; nothing is saved to disk.</p>
<div id="state">Connecting…</div><main id="events"></main>
<footer id="dock"><button id="pause">Pause scrolling</button><label for="filter">Filter:</label><select id="filter"><option value="all">All directions</option><option>OpenCode → Bridge HTTP</option><option>Bridge → AGY stdin</option><option>AGY stdout → Bridge</option><option>Bridge → OpenCode SSE</option><option>Monitor status</option></select><span>Pause/filter controls stay fixed here.</span></footer>
<script>
const list=document.getElementById("events"),state=document.getElementById("state"),button=document.getElementById("pause"),filter=document.getElementById("filter");
let paused=false;button.onclick=()=>{paused=!paused;button.textContent=paused?"Resume scrolling":"Pause scrolling"};
filter.onchange=()=>{for(const card of list.children)card.hidden=filter.value!=="all"&&card.dataset.direction!==filter.value};
const source=new EventSource("/monitor/events");
source.onopen=()=>state.textContent="Connected · monitoring is controlled by the OpenCode commands";
source.onerror=()=>state.textContent="Disconnected · reconnecting…";
source.onmessage=(message)=>{let item;try{item=JSON.parse(message.data)}catch{return}
  if(item.direction==="Monitor status"){
    if(!item.payload.enabled)list.replaceChildren();
    state.textContent=item.payload.enabled?"Connected · MONITORING ON":"Connected · MONITORING OFF · use /agy-monitor-on in OpenCode";
    if(!item.payload.enabled)return;
  }
  const card=document.createElement("section"),head=document.createElement("div"),direction=document.createElement("span"),time=document.createElement("span"),body=document.createElement("pre");
  card.className="event";card.dataset.direction=item.direction;card.hidden=filter.value!=="all"&&filter.value!==item.direction;
  head.className="head";time.className="time";direction.textContent=item.direction;time.textContent=item.time;
  let wireLine;
  if(item.direction==="Bridge → AGY stdin"&&typeof item.payload.line==="string"){
    wireLine=item.payload.line;
    try{const input=JSON.parse(wireLine);body.textContent=typeof input.message?.content==="string"?input.message.content:wireLine}
    catch{body.textContent=wireLine}
  }else body.textContent=item.direction==="AGY stdout → Bridge"&&typeof item.payload.line==="string"
    ?item.payload.line
    :JSON.stringify(item.payload,null,2);
  head.append(direction,time);card.append(head,body);
  if(wireLine){const details=document.createElement("details"),summary=document.createElement("summary"),raw=document.createElement("pre");details.className="wire";summary.textContent="Raw stream-json stdin line";raw.textContent=wireLine;details.append(summary,raw);card.append(details)}
  list.append(card);while(list.children.length>250)list.firstChild.remove();if(!paused)window.scrollTo(0,document.body.scrollHeight);
};
</script></body></html>`

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
  const originalName = String(part.filename ?? part.name ?? "").split(/[\\/]/).pop() ?? ""
  const safeName = originalName.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/\s+/g, "_").trim()
  const extension = MIME_EXTENSIONS.get(mime) ?? extname(safeName)
  const fileName = safeName
    ? (extname(safeName) ? safeName : `${safeName}${extension || ".bin"}`)
    : `${randomUUID()}${extension || ".bin"}`
  let filePath = join(directory, fileName)
  let file
  try {
    file = await open(filePath, "wx")
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    filePath = join(directory, `${randomUUID()}-${fileName}`)
    file = await open(filePath, "wx")
  }
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

async function promptFrom(messages = [], attachmentDir, includeHistory = false) {
  const message = [...messages].reverse().find((item) => item.role === "user")
  if (!message) throw new Error("OpenCode request did not contain a user message")

  const turns = includeHistory ? messages.filter((item) => item.role === "user" || item.role === "assistant") : [message]
  const transcript = []
  for (const turn of turns) {
    const text = []
    const attachments = []
    if (typeof turn.content === "string") text.push(turn.content)
    else if (Array.isArray(turn.content)) {
      for (const part of turn.content) {
        if (typeof part.text === "string") text.push(part.text)
        else if (["image_url", "image", "input_image", "file", "input_file"].includes(part.type)) {
          const attachment = await saveAttachment(part, attachmentDir)
          if (attachment) attachments.push(`@${attachment.filePath}`)
          else {
            const url = attachmentUrl(part)
            if (url) attachments.push(url)
          }
        }
      }
    }

    const prompt = text.join("")
    const content = !attachments.length ? prompt : prompt ? `${prompt}\n\n${attachments.join("\n")}` : attachments.join("\n")
    if (includeHistory) transcript.push(`${turn.role === "assistant" ? "Assistant" : "User"}: ${content}`)
    else return content
  }
  return transcript.join("\n\n")
}

function createAgySession(command, model, key, attachmentDir, includeHistory, seedHistory = false, mode = "default") {
  const args = [
    "--model", model,
    "--add-dir", attachmentDir,
    ...(mode === "plan" ? ["--mode=plan"] : []),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  ]
  const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  agyChildren.add(child)

  const session = {
    key,
    model,
    child,
    attachmentDir,
    stdout: "",
    stderr: "",
    activeTurn: undefined,
    queue: Promise.resolve(),
    busy: 0,
    idleTimer: undefined,
    closed: false,
    seedHistory,
  }

  const removeSession = () => {
    if (agySessions.get(key) === session) agySessions.delete(key)
  }
  const cleanupDirectory = () => { void rm(attachmentDir, { recursive: true, force: true }).catch(() => {}) }
  const rejectActive = (error) => {
    const turn = session.activeTurn
    if (!turn) return
    session.activeTurn = undefined
    turn.signal?.removeEventListener("abort", turn.abort)
    turn.reject(error)
  }
  const dispose = (error = new Error("AGY session closed")) => {
    if (session.closed) return
    session.closed = true
    clearTimeout(session.idleTimer)
    removeSession()
    rejectActive(error)
    if (child.exitCode === null && !child.killed) child.kill()
    cleanupDirectory()
  }
  const scheduleIdleExpiry = () => {
    clearTimeout(session.idleTimer)
    if (session.closed || session.busy) return
    session.idleTimer = setTimeout(() => {
      if (!session.busy) dispose(new Error("AGY chat process expired after two hours idle; start a new chat turn"))
    }, SESSION_IDLE_TIMEOUT_MS)
    session.idleTimer.unref?.()
  }

  const handleLine = (line, wireLine) => {
    if (!line.trim()) return
    publishMonitor("AGY stdout → Bridge", { line: wireLine })
    let event
    try { event = JSON.parse(line) } catch { return }
    const turn = session.activeTurn
    if (!turn) return
    try { turn.onEvent(event) } catch (error) {
      dispose(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (event.event === "result") {
      session.activeTurn = undefined
      turn.signal?.removeEventListener("abort", turn.abort)
      turn.resolve(event.result)
      if (includeHistory) child.stdin.end()
    }
  }

  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    session.stdout += chunk
    let newline
    while ((newline = session.stdout.indexOf("\n")) !== -1) {
      const wireLine = session.stdout.slice(0, newline + 1)
      handleLine(wireLine.slice(0, -1).replace(/\r$/, ""), wireLine)
      session.stdout = session.stdout.slice(newline + 1)
    }
  })
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    session.stderr = (session.stderr + chunk).slice(-16_384)
  })
  child.stdin.on("error", (error) => dispose(error))
  child.once("error", (error) => dispose(error))
  child.once("close", (code) => {
    agyChildren.delete(child)
    const error = new Error(session.stderr.trim() || `agy chat process exited with code ${code}`)
    if (!session.closed) {
      session.closed = true
      clearTimeout(session.idleTimer)
      removeSession()
      rejectActive(error)
      cleanupDirectory()
    }
  })

  session.dispose = dispose
  session.runTurn = (messages, onEvent = () => {}, signal) => {
    session.busy++
    clearTimeout(session.idleTimer)
    const turn = session.queue.then(async () => {
      if (session.closed) throw new Error("AGY chat process is no longer available; start a new chat turn")
      if (signal?.aborted) throw signal.reason ?? new Error("Request aborted")
      const turnAttachmentDir = await mkdtemp(join(attachmentDir, "turn-"))
      try {
        const prompt = await promptFrom(messages, turnAttachmentDir, includeHistory || session.seedHistory)
        session.seedHistory = false
        const result = await new Promise((resolve, reject) => {
          if (session.closed) {
            reject(new Error("AGY chat process is no longer available"))
            return
          }
          const active = { resolve, reject, onEvent, signal }
          active.abort = () => dispose(signal.reason ?? new Error("Request aborted"))
          session.activeTurn = active
          signal?.addEventListener("abort", active.abort, { once: true })
          const line = JSON.stringify({ event: "user", message: { content: prompt } })
          publishMonitor("Bridge → AGY stdin", { line: line + "\n" })
          child.stdin.write(line + "\n", (error) => {
            if (error) dispose(error)
          })
        })
        if (result?.status !== "SUCCESS") throw new Error(result?.error || `agy finished with status ${result?.status ?? "unknown"}`)
        return result
      } finally {
        await rm(turnAttachmentDir, { recursive: true, force: true })
      }
    })
    session.queue = turn.catch(() => {})
    return turn.finally(() => {
      session.busy--
      if (!session.closed) scheduleIdleExpiry()
    })
  }
  scheduleIdleExpiry()
  return session
}

async function getAgySession(command, model, key, includeHistory, mode = "default") {
  const existing = agySessions.get(key)
  if (existing) {
    const session = await existing
    if (!session.closed) return session
  }

  let seedHistory = false
  const sessionPrefix = `${key.slice(0, key.lastIndexOf(":"))}:`
  for (const [otherKey, value] of agySessions) {
    if (otherKey === key || !otherKey.startsWith(sessionPrefix)) continue
    const previous = await value
    if (!previous.closed) {
      seedHistory = true
      if (previous.busy === 0) previous.dispose(new Error("AGY execution mode changed; starting a session with the new mode"))
    }
  }

  const creating = mkdtemp(join(tmpdir(), "agy-session-attachments-")).then((attachmentDir) =>
    createAgySession(command, model, key, attachmentDir, includeHistory, seedHistory, mode),
  )
  agySessions.set(key, creating)
  try {
    const session = await creating
    if (agySessions.get(key) === creating) agySessions.set(key, session)
    return session
  } catch (error) {
    if (agySessions.get(key) === creating) agySessions.delete(key)
    throw error
  }
}

process.once("exit", () => {
  for (const child of agyChildren) child.kill()
})

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
  const outgoing = chunk(id, model, created, delta, finishReason)
  publishMonitor("Bridge → OpenCode SSE", outgoing)
  response.write(`data: ${JSON.stringify(outgoing)}\n\n`)
}

function openCodeMode(headers = {}) {
  const agent = String(headers["x-opencode-agent"] ?? "").trim().toLowerCase()
  return agent === "plan" ? "plan" : "default"
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
  // Keep the API closed to browsers; only the exact same-origin monitor page
  // may open its read-only event stream. The listener itself is loopback-only.
  const monitorRoute = request.url === "/monitor" || request.url === "/monitor/" || request.url === "/monitor/events"
  const monitorOrigin = monitorRoute
    && request.headers["sec-fetch-site"] === "same-origin"
    && (!request.headers.origin || request.headers.origin === `http://${HOST}:${PORT}`)
  const monitorNavigation = request.method === "GET"
    && (request.url === "/monitor" || request.url === "/monitor/")
    && !request.headers.origin
    && (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "none")
  if ((request.headers.origin && !monitorOrigin) || (monitorRoute && !monitorOrigin && !monitorNavigation) || request.headers.host !== `${HOST}:${PORT}`) {
    sendJson(response, 403, { error: { message: "Forbidden" } })
    return
  }
  if (request.method === "GET" && (request.url === "/monitor" || request.url === "/monitor/")) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    })
    response.end(MONITOR_PAGE)
    return
  }
  if (request.method === "GET" && request.url === "/monitor/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    })
    response.flushHeaders()
    response.write(`data: ${JSON.stringify({ time: new Date().toISOString(), direction: "Monitor status", payload: { enabled: monitorEnabled } })}\n\n`)
    for (const item of monitorHistory) response.write(`data: ${item.encoded}\n\n`)
    monitorClients.add(response)
    response.once("close", () => monitorClients.delete(response))
    return
  }
  if (request.method === "POST" && (request.url === "/monitor/control/on" || request.url === "/monitor/control/off")) {
    const enabled = request.url.endsWith("/on")
    setMonitorEnabled(enabled)
    sendJson(response, 200, { enabled: monitorEnabled })
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
  publishMonitor("OpenCode → Bridge HTTP", { raw })

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

  const sessionId = request.headers["x-opencode-session"]
  const persistent = typeof sessionId === "string" && sessionId.length > 0
  const mode = openCodeMode(request.headers)
  const sessionKey = persistent ? `${sessionId}:${model}:${mode}` : randomUUID()
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableEnded) controller.abort()
  })

  let heartbeat
  let streamedAnswer = ""
  let session
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
    session = await getAgySession(command, model, sessionKey, !persistent, mode)
    const result = await session.runTurn(body.messages, (event) => {
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
    }, controller.signal)
    if (result.status !== "SUCCESS") throw new Error(result.error || `agy finished with status ${result.status}`)
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
    if (!persistent) session?.dispose(new Error("One-shot AGY request completed"))
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
