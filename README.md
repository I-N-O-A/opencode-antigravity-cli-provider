# Antigravity CLI for OpenCode

> **LET YOUR LLM DO IT. LET YOUR AGENT DO IT.**
>
> **LOWEST-RISK APPROACH:** OpenCode calls the official `agy` CLI locally. No direct Antigravity API calls, custom OAuth, or project-stored credentials. Google receives a request made through `agy`, much like one you start yourself in a terminal. Google may still identify the client; this is not a promise of invisibility or zero risk.

## Let your agent install it

Run from the root of the OpenCode project you want to update:

**macOS / Linux**

```sh
opencode run --agent build "$(curl -fsSL https://raw.githubusercontent.com/kamueone/opencode-antigravity-cli-provider/main/AGENT-PROMPT.md)"
```

**Windows PowerShell**

```powershell
opencode run --agent build (Invoke-RestMethod https://raw.githubusercontent.com/kamueone/opencode-antigravity-cli-provider/main/AGENT-PROMPT.md)
```

Or paste this prompt into a Chat Session of OpenCode:

````text
# Rebuild the Antigravity CLI integration in this OpenCode project

You are working in the root of the user's OpenCode project. Implement the integration yourself for this project's actual OpenCode version and plugin contract. Treat the companion files in `opencode-antigravity-cli-provider` as a reference, not as blindly compatible code. Make the changes, verify them, and report results.

Reference: https://github.com/kamueone/opencode-antigravity-cli-provider. Read its README and source files if network access is available, then adapt or rebuild the integration in the current project. Do not require the user to clone the reference repository first.

## Required behavior

- Register Antigravity CLI models in OpenCode as `agy-cli/<slug>`.
- Use only the official `agy` executable for model discovery and every completion. Pass the selected model as `agy --model <slug>`.
- Do not call Antigravity endpoints directly, implement OAuth, or save credentials/tokens in project files.
- Keep the current OpenCode default model unchanged.
- Discover `agy` portably: official Windows install path when present, otherwise `PATH`; use `PATH` on macOS/Linux. Never hardcode a person's profile path.
- Route requests through a local bridge bound only to `127.0.0.1`. Keep prompts off process command lines; send them over stdin. Support OpenCode image/file attachments by staging them as temporary local files and referencing them in the agy prompt; clean them up after the request.
- Show a concise activity view with one English `<details>/<summary>` disclosure per AGY tool step, collapsed by default. Put the key identifying argument directly in each summary (for example, the full shell command or file path); show all live action/arguments inside it, then append completion status and actual output/error to that same disclosure. Omit protocol wrappers, session IDs, token accounting, and per-token answer events. Escape all AGY-supplied values before rendering HTML and do not truncate displayed paths/commands/outputs. OpenCode keeps the disclosures inside its single Thought part, but each step can be expanded independently. Keep long-running SSE requests alive; do not claim to reveal hidden chain-of-thought the CLI does not emit.
- Forward OpenCode's session ID in `x-opencode-session`. Continue that session with the `agy`-provided conversation ID and send only the new user turn to the existing AGY conversation, rather than replaying all prior messages as a new prompt. If no session header is present, preserve correctness by sending the available full message history to a fresh AGY invocation.
- Do not impose an arbitrary small request/attachment-size limit. Avoid unnecessary attachment copies and document practical RAM, disk, CLI, and model-context limits honestly.
- Reject unexpected Host headers and browser Origin requests; set no permissive CORS headers. Do not impose an arbitrary small request-size limit. On port collision, continue only if a bridge health endpoint identifies the expected bridge; otherwise fail clearly.
- Propagate request cancellation to the child CLI. Return readable CLI errors. Declare only capabilities that are actually supported; model tool calls are not supported by the reference implementation.
- Do not replace unrelated settings, permissions, plugins, or user files. Do not alter the user's default model.

## Work and verification

1. Inspect project instructions, OpenCode version, current config, and plugin APIs actually supported by that version.
2. Choose the simplest compatible implementation. Prefer the official CLI over a direct provider/API integration.
3. Implement discovery, config/model entries, bridge, and concise usage notes. Do not claim runtime model discovery updates OpenCode's selectable list unless you implement and verify that behavior.
4. Test with a mock CLI: slug forwarding, stdin prompt, image and document staging, exact live NDJSON event forwarding, OpenCode session-header propagation, conversation resume without replaying history, keepalives, readable errors, response parsing, requests above 2 MiB, browser-origin/Host rejection, port collisions, and cancellation. Run syntax/type checks.
5. If the official CLI is installed and authenticated, make a short real request through OpenCode and confirm it reaches `agy`. Otherwise state exactly which live test could not be run.
6. Check public-facing files for absolute user paths, credentials, tokens, and unrelated data.

At the end, list the changed files, install/restart steps, tests actually run, and any limitations. Do not claim that Google cannot identify the CLI client or that the integration has zero risk.
````

The agent is instructed to inspect your OpenCode version, rebuild the integration for your project, preserve your existing default model, and test what it can. Review the changes it proposes before using them.

## Do it manually

Install and sign in to the official Antigravity CLI, then confirm `agy models` works. Copy `agy-model-provider.ts` and `agy-activity-tools.ts` to `.opencode/plugins/`, and `agy-openai-bridge.mjs` to `.opencode/runtime/`. Merge `opencode.provider.example.jsonc` into `opencode.json`, adding one model entry for each slug you want from `agy models`. Keep your current default; the example uses `google/gemini-3.8-flash`.

Restart OpenCode and select `agy-cli/<slug>`.

## What this does

The local bridge passes the selected slug as `agy --model <slug>` and writes each user's current text, unchanged and without role labels or replayed history, to the CLI over stdin. It keeps one `agy` stream-json process per OpenCode session/model, so successive messages continue the same live AGY chat. File attachments are staged temporarily with their filenames preserved where possible and referenced as `@file`; those files are removed after that turn. Idle chat processes expire after two hours and in-memory conversations do not survive an OpenCode service restart. The bridge has no fixed request-size ceiling or upload timeout. Very large attachments still depend on OpenCode's request handling, available RAM/disk space, `agy`, and the selected model's context limits.

The bridge listens only on `127.0.0.1`, rejects browser-origin requests and unverified port collisions, and has no separate authentication. Do not expose or proxy its port; local processes running as your user can still reach it. While AGY is working, each tool step streams immediately as one compact, independently expandable activity disclosure in OpenCode's activity/reasoning area; its summary identifies the command or file path, and the same disclosure receives the completion status and output. This is separate from the global request spinner. AGY-provided values are HTML-escaped. When AGY finishes, each action is also shown as an independent native OpenCode tool card (for example, AGY Shell, AGY Read, or AGY Grep), grouped by action type with no numbered-step list. The cards preserve the actual identifying arguments, final status, output, and errors. Their plugin executors only render the recorded data; they never repeat AGY's commands or file operations. After OpenCode renders the cards, the bridge returns the saved AGY answer on OpenCode's follow-up request without sending another turn to AGY. Tool capabilities must remain enabled on configured AGY models for this display-only round trip. The OpenCode session ID is used only for local process lookup, not included in the text prompt. The CLI does not provide private hidden chain-of-thought unless such content is actually present in an event.

See [AGENT-PROMPT.md](AGENT-PROMPT.md) for the full rebuild instructions and [TODO.md](TODO.md) for follow-up work.
