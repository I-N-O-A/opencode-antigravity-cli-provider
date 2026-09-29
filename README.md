# Antigravity CLI for OpenCode



> **LOWEST-RISK APPROACH:** OpenCode calls the official `agy` CLI locally. No direct Antigravity API calls, custom OAuth, or project-stored credentials. Google receives a request made through `agy`, much like one you start manually in your terminal.

## Let your agent install it

Run from the root of the OpenCode project you want to update:

**macOS / Linux**

```sh
opencode run --agent build "$(curl -fsSL https://raw.githubusercontent.com/I-N-O-A/opencode-antigravity-cli-provider/main/AGENT-PROMPT.md)"
```

**Windows PowerShell**

```powershell
opencode run --agent build (Invoke-RestMethod https://raw.githubusercontent.com/I-N-O-A/opencode-antigravity-cli-provider/main/AGENT-PROMPT.md)
```

For agent-assisted setup, give OpenCode the contents of [AGENT-PROMPT.md](AGENT-PROMPT.md). It instructs the agent to inspect the installed V2 API, use the current V2 hooks, preserve unrelated settings, and install globally when you want AGY available in every workspace. The instructions are kept in one canonical file so this README cannot drift from them.

## Install globally (recommended)

Install and sign in to the official Antigravity CLI first, then confirm `agy models` works.

```sh
git clone https://github.com/I-N-O-A/opencode-antigravity-cli-provider.git
cd opencode-antigravity-cli-provider
sh install.sh
```

On Windows PowerShell, run `git clone https://github.com/I-N-O-A/opencode-antigravity-cli-provider.git`, then `cd opencode-antigravity-cli-provider; powershell -ExecutionPolicy Bypass -File .\install.ps1`. The execution-policy bypass applies only to that installer process; it does not change the system policy.

The installer copies the two plugins into `~/.config/opencode/plugins/`, the bridge into `~/.config/opencode/runtime/`, and a merge-ready provider example beside your config. OpenCode discovers those global plugin files in every workspace. On Windows, `~` means the user's home directory (for example, `C:\Users\you`). The installer does not edit or replace the OpenCode config.

Merge the `providers.agy-cli` object from [`opencode.provider.example.jsonc`](opencode.provider.example.jsonc) into the existing **V2** config at `~/.config/opencode/opencode.json` (or `.jsonc`). Preserve all other config, especially `model` and existing providers. Add a model entry for each ID reported by `agy models`; the example includes the current catalog and can be refreshed when AGY adds models. Do not replace V2's `providers` with the old V1 `provider`/`npm`/`options` form. Keep `capabilities.tools: true` and `compatibility.reasoningField: "reasoning_content"`: the former enables the display-only AGY activity-card round trip, and the latter lets OpenCode render AGY's live activity/thought-state updates.

Restart OpenCode and select `agy-cli/<slug>`. The global setup also installs `/agy-monitor-on` and `/agy-monitor-off`. Open `http://127.0.0.1:47381/monitor` to inspect traffic.

## Install in one project only

From the cloned repository, run `sh install.sh --project <project-directory>` (or `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Project <project-directory>` in PowerShell), merge the same V2 provider object into that project's `opencode.json`/`opencode.jsonc`, then restart OpenCode. This installs under `<project>/.opencode/` and does not affect other workspaces. Choose either global or project scope; do not install both for the same user, as OpenCode would load the plugins twice.

To update an installation from a newer commit, pull the repository and rerun the installer with the same scope. It replaces only the three AGY runtime source files and its merge-ready example; it does not alter OpenCode configuration, the selected default, or other plugins.

## What this does

The local bridge passes the selected slug as `agy --model <slug>` and writes each user's current text, unchanged and without role labels or replayed history, to the CLI over stdin. It keeps one `agy` stream-json process per OpenCode session/model, so successive messages continue the same live AGY chat. The session hook forwards OpenCode's session ID to the bridge; without that header, it uses a fresh process with the available conversation history. File attachments are staged temporarily with their filenames preserved where possible and referenced as `@file`; those files are removed after that turn. Idle chat processes expire after two hours and in-memory conversations do not survive an OpenCode service restart. The bridge has no fixed request-size ceiling or upload timeout. Very large attachments still depend on OpenCode's request handling, available RAM/disk space, `agy`, and the selected model's context limits.

The bridge listens only on `127.0.0.1`, rejects browser-origin requests and unverified port collisions, and has no separate authentication. Do not expose or proxy its port; local processes running as your user can still reach it. While AGY is working, each tool step streams immediately as one compact, independently expandable activity disclosure in OpenCode's activity/reasoning area; its summary identifies the command or file path, and the same disclosure receives the completion status and output. This is separate from the global request spinner. AGY-provided values are HTML-escaped. When AGY finishes, each action is also shown as an independent native OpenCode tool card (for example, AGY Shell, AGY Read, or AGY Grep), grouped by action type with no numbered-step list. The cards preserve the actual identifying arguments, final status, output, and errors. Their plugin executors only render the recorded data; they never repeat AGY's commands or file operations. After OpenCode renders the cards, the bridge returns the saved AGY answer on OpenCode's follow-up request without sending another turn to AGY. Tool capabilities must remain enabled on configured AGY models for this display-only round trip. The OpenCode session ID is used only for local process lookup, not included in the text prompt. The CLI does not provide private hidden chain-of-thought unless such content is actually present in an event.

Use `/agy-monitor-on` and `/agy-monitor-off` to toggle the local in-memory traffic monitor; it does not save monitored content to disk. The OpenCode session ID is only used for local session lookup, never added to the prompt.

See [AGENT-PROMPT.md](AGENT-PROMPT.md) for agent-assisted installation and [TODO.md](TODO.md) for follow-up work.
