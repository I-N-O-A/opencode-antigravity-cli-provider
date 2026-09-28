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
- Stream every original `agy` NDJSON event line and answer delta to OpenCode immediately. Keep long-running SSE requests alive; never summarize, filter, redact, or truncate CLI events. Do not claim to reveal hidden chain-of-thought that the CLI does not emit.
- Propagate OpenCode's session ID to the bridge with a supported `chat.headers` hook. Resume the matching `agy` conversation and send only the new user turn, not the prior transcript again. If no stable OpenCode session ID is available, do not guess a conversation key or combine independent sessions; use the full request history for a fresh AGY invocation.
- Do not impose an arbitrary small request/attachment-size limit. Avoid unnecessary attachment copies and document practical RAM, disk, CLI, and model-context limits honestly.
- Reject unexpected Host headers and browser Origin requests; set no permissive CORS headers. Do not impose an arbitrary small request-size limit. On port collision, continue only if a bridge health endpoint identifies the expected bridge; otherwise fail clearly.
- Propagate request cancellation to the child CLI. Return readable CLI errors. Declare only capabilities that are actually supported; model tool calls are not supported by the reference implementation.
- Do not replace unrelated settings, permissions, plugins, or user files. Do not alter the user's default model.

## Work and verification

1. Inspect project instructions, OpenCode version, current config, and plugin APIs actually supported by that version.
2. Choose the simplest compatible implementation. Prefer the official CLI over a direct provider/API integration.
3. Implement discovery, config/model entries, bridge, and concise usage notes. Do not claim runtime model discovery updates OpenCode's selectable list unless you implement and verify that behavior.
4. Test with a mock CLI: slug forwarding, stdin prompt, image and document staging, exact live NDJSON event forwarding, session-header propagation, conversation resume without replaying history, keepalives, readable errors, response parsing, requests above 2 MiB, browser-origin/Host rejection, port collisions, and cancellation. Run syntax/type checks.
5. If the official CLI is installed and authenticated, make a short real request through OpenCode and confirm it reaches `agy`. Otherwise state exactly which live test could not be run.
6. Check public-facing files for absolute user paths, credentials, tokens, and unrelated data.

At the end, list the changed files, install/restart steps, tests actually run, and any limitations. Do not claim that Google cannot identify the CLI client or that the integration has zero risk.
