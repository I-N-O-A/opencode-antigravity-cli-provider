# Rebuild the Antigravity CLI integration in this OpenCode project

You are working in the root of the user's OpenCode project. Implement the integration yourself for this project's actual OpenCode version and plugin contract. Treat the companion files in `opencode-antigravity-cli-provider` as a reference, not as blindly compatible code. Make the changes, verify them, and report results.

Reference: https://github.com/I-N-O-A/opencode-antigravity-cli-provider. Read its README and source files if network access is available, then adapt or rebuild the integration for this project's OpenCode version. Do not require the user to clone the reference repository first.

## Required behavior

- Register Antigravity CLI models in OpenCode as `agy-cli/<slug>`.
- Use only the official `agy` executable for model discovery and every completion. Pass the selected model as `agy --model <slug>`.
- Do not call Antigravity endpoints directly, implement OAuth, or save credentials/tokens in project files.
- Keep the current OpenCode default model unchanged.
- Discover `agy` portably: official Windows install path when present, otherwise `PATH`; use `PATH` on macOS/Linux. Never hardcode a person's profile path.
- Route requests through a local bridge bound only to `127.0.0.1`. Keep prompts off process command lines; send them over stdin. Support OpenCode image/file attachments by staging them as temporary local files and referencing them in the agy prompt; clean them up after the request.
- Show each action already performed by AGY as a native OpenCode tool card, grouped under concise names such as AGY Shell, AGY Read, and AGY Grep. Use dedicated display-only OpenCode plugin tools; their executors must never re-run AGY actions. Preserve identifying arguments, status, and actual output/error in each card without numbered-step clutter. The bridge may send OpenAI-compatible tool-call events only to invoke these display-only tools, then must return the saved AGY final answer on OpenCode's follow-up request without invoking AGY again. Keep long-running SSE requests alive; do not claim to reveal hidden chain-of-thought the CLI does not emit.
- Stream AGY's actual tool-step state through OpenAI-compatible `reasoning_content`, one independently expandable escaped disclosure per step, and configure `compatibility.reasoningField` so OpenCode renders it. This is reported tool/activity state, not hidden model chain-of-thought. Keep activity visible in the global request stream as well as the final native display-only tool cards.
- Propagate OpenCode's session ID to the bridge using the hook supported by the installed OpenCode version (OpenCode V2 uses `ctx.session.hook("model.request", ...)`). Keep one `agy --input-format stream-json` process alive per OpenCode session/model and write each new user message to that process without role wrappers or transcript replay. The official stream-json mode accepts multiple user turns in one process; do not use `--conversation` for ordinary turns. If no session header exists, fall back to a fresh invocation with available user/assistant history. Close idle processes after a documented timeout and dispose them on cancellation/server shutdown.
- Do not impose an arbitrary small request/attachment-size limit. Avoid unnecessary attachment copies and document practical RAM, disk, CLI, and model-context limits honestly.
- Reject unexpected Host headers and browser Origin requests; set no permissive CORS headers. Do not impose an arbitrary small request-size limit. On port collision, continue only if a bridge health endpoint identifies the expected bridge; otherwise fail clearly.
- Propagate request cancellation to the child CLI. Return readable CLI errors. Advertise tool support only when the OpenCode display-only activity tools are registered and the bridge supports their tool-call round trip. Never advertise AGY's own execution tools as executable OpenCode tools.
- Do not replace unrelated settings, permissions, plugins, or user files. Do not alter the user's default model.

## Work and verification

1. Inspect project instructions, OpenCode version, current config, and plugin APIs actually supported by that version.
2. Choose the simplest compatible implementation. Prefer the official CLI over a direct provider/API integration.
3. Implement portable installation, config/model entries, bridge, and concise usage notes. Prefer a global OpenCode installation when the user wants AGY models and activity in all workspaces; place global plugins in `~/.config/opencode/plugins/` and the bridge runtime in `~/.config/opencode/runtime/`. On V2, configure `providers` (plural), `package`, and `settings`; do not use V1 `provider`/`npm`/`options` fields. Preserve unrelated config and the user's default model. Do not claim runtime model discovery updates OpenCode's selectable list unless you implement and verify that behavior.
4. Test with a mock CLI: slug forwarding, stdin prompt, image and document staging, exact live NDJSON event forwarding, session-header propagation, conversation resume without replaying history, keepalives, readable errors, response parsing, requests above 2 MiB, browser-origin/Host rejection, port collisions, and cancellation. Run syntax/type checks.
5. If the official CLI is installed and authenticated, make a short real request through OpenCode and confirm it reaches `agy`. Otherwise state exactly which live test could not be run.
6. Check public-facing files for absolute user paths, credentials, tokens, and unrelated data.

At the end, list the changed files, install/restart steps, tests actually run, and any limitations. Do not claim that Google cannot identify the CLI client or that the integration has zero risk.
