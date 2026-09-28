import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"

const providerID = "agy-cli"
const MODEL_LINE = /^([a-z0-9][a-z0-9._-]*)\s+(.+?)\s*$/i

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

export default {
  id: "agy-model-provider",
  "chat.headers": async (input: { sessionID: string; model: { providerID: string } }, output: { headers: Record<string, string> }) => {
    if (input.model.providerID === providerID) output.headers["x-opencode-session"] = input.sessionID
  },
  async setup(ctx) {
    const command = agyCommand()
    const { startBridge } = await import("../runtime/agy-openai-bridge.mjs")
    await startBridge(command)

    let available: { id: string; name: string }[]
    try {
      available = parseModels(await runAgyModels(command))
    } catch (error) {
      console.warn(`[agy-model-provider] Could not discover models using ${command}:`, error)
      return
    }

    if (available.length === 0) {
      console.warn("[agy-model-provider] agy models returned no models; provider was not registered.")
      return
    }

    console.log(`[agy-model-provider] Bridge ready; discovered ${available.length} agy models.`)
  },
}
