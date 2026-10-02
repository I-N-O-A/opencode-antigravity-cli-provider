import { existsSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { spawn } from "node:child_process"

const providerID = "agy-cli"
const MODEL_LINE = /^([a-z0-9][a-z0-9._-]*)\s+(.+?)\s*$/i
const MONITOR_URL = "http://127.0.0.1:47381/monitor"
const MODEL_CACHE_KEY = "catalog/models"
const MODEL_LIMITS: Record<string, { context: number; output: number }> = {
  "claude-opus-4-6-thinking": { context: 200_000, output: 65_536 },
  "claude-sonnet-4-6": { context: 200_000, output: 65_536 },
  "gemini-3.1-pro-high": { context: 1_000_000, output: 65_536 },
  "gemini-3.1-pro-low": { context: 1_000_000, output: 65_536 },
  "gemini-3.6-flash-high": { context: 1_000_000, output: 65_536 },
  "gemini-3.6-flash-medium": { context: 1_000_000, output: 65_536 },
  "gemini-3.6-flash-low": { context: 1_000_000, output: 65_536 },
  "gemini-3.7-flash-high": { context: 1_000_000, output: 65_536 },
  "gemini-3.7-flash-medium": { context: 1_000_000, output: 65_536 },
  "gemini-3.7-flash-low": { context: 1_000_000, output: 65_536 },
  "gemini-3.8-flash-high": { context: 1_000_000, output: 65_536 },
  "gemini-3.8-flash-medium": { context: 1_000_000, output: 65_536 },
  "gemini-3.8-flash-low": { context: 1_000_000, output: 65_536 },
  "gpt-oss-120b-medium": { context: 128_000, output: 65_536 },
}

type DiscoveredModel = { id: string; name: string }

function modelDefinitions(models: DiscoveredModel[], template?: any) {
  return models.map(({ id, name }) => {
    const defaults = template
      ? JSON.parse(JSON.stringify(template))
        : {
          id,
          modelID: id,
          providerID,
          name,
          api: { id, type: "aisdk", package: "@opencode/ai/providers/openai-compatible" },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        }
    const limit = MODEL_LIMITS[id]
    return {
      ...defaults,
      id,
      modelID: id,
      providerID,
      name,
      api: { ...defaults.api, id },
      capabilities: { ...defaults.capabilities, tools: true, input: ["text", "image"], output: ["text"] },
      limit: limit ?? { context: 200_000, output: 32_000 },
    }
  })
}

function openMonitor() {
  let command: string
  let args: string[]
  if (process.platform === "win32") {
    command = "rundll32.exe"
    args = ["url.dll,FileProtocolHandler", MONITOR_URL]
  } else if (process.platform === "darwin") {
    command = "open"
    args = [MONITOR_URL]
  } else {
    command = "xdg-open"
    args = [MONITOR_URL]
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
  child.once("error", (error) => console.warn("[agy-model-provider] Could not open monitor URL:", error))
  child.unref()
}

async function controlMonitor(enabled: boolean) {
  const baseURL = "http://127.0.0.1:47381"
  const response = await fetch(`${baseURL}/monitor/control/${enabled ? "on" : "off"}`, {
    method: "POST",
    headers: {
      origin: baseURL,
      "sec-fetch-site": "same-origin",
    },
    signal: AbortSignal.timeout(3_000),
  })
  const result = await response.json().catch(() => ({})) as { enabled?: boolean; error?: { message?: string } }
  if (!response.ok || result.enabled !== enabled) {
    throw new Error(result.error?.message ?? `Monitor control failed with HTTP ${response.status}; restart OpenCode to load the current bridge.`)
  }
}

function agyCommand() {
  const local = process.env.LOCALAPPDATA
  if (local) {
    const installed = join(local, "agy", "bin", "agy.exe")
    if (existsSync(installed)) return installed
  }
  return process.platform === "win32" ? "agy.exe" : "agy"
}

function runAgyModels(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["models"], { windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("agy models timed out after 30 seconds"))
    }, 30_000)

    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`agy models exited with code ${code}: ${stderr.trim()}`))
        return
      }
      resolve(`${stdout}\n${stderr}`)
    })
  })
}

function parseModels(output: string) {
  const models = new Map<string, string>()
  for (const rawLine of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = MODEL_LINE.exec(line)
    if (!match || /^(fetching|available|model id)$/i.test(match[1])) continue
    models.set(match[1], match[2])
  }
  return [...models].map(([id, name]) => ({ id, name }))
}

export async function forwardSessionContext(ctx: any, event: any) {
  // Plugin load location may differ from the session (including worktrees
  // and moved sessions). Read the current session on every request.
  let directory: unknown
  try {
    const response = await ctx.session.get({ sessionID: event.sessionID })
    const session = response?.data ?? response
    directory = session?.location?.directory ?? session?.directory
  } catch {
    // A metadata lookup failure must not prevent project-independent prompts.
    // Never substitute the plugin's load location or the service cwd.
    console.warn("[agy-model-provider] Session directory unavailable; using isolated no-project context.")
  }
  if (typeof directory === "string" && isAbsolute(directory)) {
    event.headers["x-opencode-directory"] = encodeURIComponent(directory)
  } else {
    delete event.headers["x-opencode-directory"]
  }
  event.headers["x-opencode-session"] = event.sessionID
  event.headers["x-opencode-agent"] = event.agent
  event.headers["x-opencode-kind"] = event.kind
}

export default {
  id: "agy-model-provider",
  async setup(ctx) {
    const command = agyCommand()
    const { startBridge } = await import("../runtime/agy-openai-bridge.mjs")
    await startBridge(command)
    await ctx.session.hook("model.request", (event) => forwardSessionContext(ctx, event), { providerID })
    await ctx.command.transform((editor) => {
      editor.add({
        name: "agy-monitor-on",
        description: "Enable the local live monitor without adding a chat message",
        execute: async () => {
          await controlMonitor(true)
          openMonitor()
        },
      })
      editor.add({
        name: "agy-monitor-off",
        description: "Disable AGY bridge monitoring without adding a chat message",
        execute: async () => {
          await controlMonitor(false)
        },
      })
    })
    let available: { id: string; name: string }[]
    try {
      available = parseModels(await runAgyModels(command))
      if (available.length === 0) throw new Error("agy models returned no parseable models")
    } catch (error) {
      console.warn(`[agy-model-provider] Could not discover models using ${command}:`, error)
      let cached: unknown
      try {
        cached = await ctx.storage.get(MODEL_CACHE_KEY)
      } catch (cacheError) {
        console.warn("[agy-model-provider] Could not read the saved model catalog:", cacheError)
      }
      available = Array.isArray(cached)
        ? cached.filter((model): model is DiscoveredModel =>
            typeof model === "object" && model !== null &&
            typeof (model as DiscoveredModel).id === "string" &&
            typeof (model as DiscoveredModel).name === "string")
        : []
      if (available.length === 0) {
        console.warn("[agy-model-provider] No cached AGY model catalog; OpenCode will start without AGY models.")
        return
      }
      console.warn(`[agy-model-provider] Using the last saved catalog (${available.length} models).`)
    }

    try {
      await ctx.storage.set(MODEL_CACHE_KEY, available)
    } catch (error) {
      console.warn("[agy-model-provider] Could not save the discovered model catalog:", error)
    }

    await ctx.provider.transform((editor) => {
      const existing = editor.get(providerID)
      if (existing) {
        const template = existing.models.values().next().value
        editor.models.set(providerID, modelDefinitions(available, template))
      } else {
        const info = {
          id: providerID,
          name: "Antigravity CLI (agy)",
          api: { type: "aisdk", package: "@opencode/ai/providers/openai-compatible", url: "http://127.0.0.1:47381/v1" },
          request: { headers: {}, body: { timeout: 1_800_000 } },
        }
        editor.add({ info, models: modelDefinitions(available) })
      }
    })

    console.log(`[agy-model-provider] Bridge ready; registered ${available.length} AGY models in OpenCode's runtime catalog.`)
  },
}
