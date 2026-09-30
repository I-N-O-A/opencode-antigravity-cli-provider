# AGY Bridge for OpenCode

Uses the official `agy` CLI. No direct API calls or project-stored credentials.

## Recommended: let OpenCode install it globally

Run from any directory:

**macOS/Linux**
```sh
opencode run --agent build "$(curl -fsSL https://raw.githubusercontent.com/I-N-O-A/opencode-antigravity-cli-provider/main/AGENT-PROMPT.md)"
```

**Windows PowerShell**
```powershell
opencode run --agent build (Invoke-RestMethod https://raw.githubusercontent.com/I-N-O-A/opencode-antigravity-cli-provider/main/AGENT-PROMPT.md)
```

The agent installs the files and merges the models into your global V2 config. It must preserve your existing settings and default model; no manual merge.

## Copy-paste prompt

```text
Install the latest AGY Bridge from https://github.com/I-N-O-A/opencode-antigravity-cli-provider globally for OpenCode V2, so it works from every working directory. Read and follow its AGENT-PROMPT.md. Install the plugins and bridge, then merge providers.agy-cli and all models from `agy models` into my global OpenCode config yourself. Preserve my default model and all unrelated settings; do not leave a manual merge for me. Keep persistent per-session AGY processes, live activity/status disclosures, native display-only activity cards, monitor commands, and verify with a real request outside the repository.
```

## Manual installation

Install and authenticate `agy` first. From a clone of this repository, run `sh install.sh` or, on Windows, `powershell -ExecutionPolicy Bypass -File .\install.ps1`. These scripts copy the plugins, bridge, and merge-ready V2 config example; they do not edit your OpenCode config. For all workspaces, install globally. Project-only installation: add `--project <directory>` (PowerShell: `-Project <directory>`). Do not install both scopes.

## Behavior

One long-running `stream-json` AGY process is reused per OpenCode session/model/mode. The provider forwards OpenCode's active agent name to the local bridge: Plan starts AGY with `--mode=plan`, while Build keeps AGY's configured default execution mode and permission rules. Switching modes starts a fresh AGY process and seeds it with available conversation history. Actual AGY tool activity streams as expandable status disclosures and final side-effect-free OpenCode tool cards; the final answer is returned without rerunning AGY. This displays emitted activity, not hidden chain-of-thought. Attachments are temporary; idle processes expire after two hours and do not survive an OpenCode service restart.

The bridge listens only on `127.0.0.1`. The optional in-memory monitor is at `http://127.0.0.1:47381/monitor`; use the native plugin commands `/agy-monitor-on` and `/agy-monitor-off` to toggle it locally without invoking an agent or adding a chat message. Monitored prompts and outputs may be sensitive; do not expose the port.
