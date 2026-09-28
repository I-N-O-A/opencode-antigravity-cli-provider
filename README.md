# Antigravity CLI provider for OpenCode

Use models exposed by the official `agy` CLI in OpenCode. Model listing and every completion are performed by `agy`; this project does not call Antigravity APIs or implement OAuth.

## Requirements

- OpenCode 2.x with local project plugins enabled
- Node.js runtime provided by OpenCode
- Official Antigravity CLI (`agy`) installed and authenticated
- `agy models` succeeds in a terminal

## Install

1. Copy `agy-model-provider.ts` to `.opencode/plugins/agy-model-provider.ts` in your OpenCode project.
2. Copy `agy-openai-bridge.mjs` to `.opencode/runtime/agy-openai-bridge.mjs`.
3. Merge `opencode.provider.example.jsonc` into your `opencode.json`. Preserve your existing settings and default model.
4. Restart OpenCode. The plugin discovers the executable from `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows, then falls back to `agy` on `PATH`. macOS/Linux use `agy` on `PATH`.
5. Select a configured `agy-cli/<slug>` model. Verify the available IDs using `agy models`.

If you set `AGY_BRIDGE_PORT`, set the same port in the OpenAI-compatible provider's `baseURL`; the default is `47381`.

The example keeps `google/gemini-3.8-flash` as the default and shows one model entry. Add one OpenCode model entry for each desired ID from `agy models`; OpenCode's provider model list is configured statically, while the plugin checks the CLI inventory at startup.

## Security and data flow

OpenCode sends chat data to the local bridge on `127.0.0.1:47381`; the bridge starts the official CLI and passes the model ID as `agy --model <slug>`. The prompt goes to the CLI over stdin, not in the process argument list. The CLI owns authentication and network communication.

The bridge accepts only loopback requests with the expected Host header, rejects browser-origin requests, has a 2 MiB request limit, and refuses to treat an unrelated process on its port as a healthy bridge. It has no standalone authentication; keep it bound to loopback and do not expose or proxy the port. Local processes running as the same user can access loopback services.

This integration currently supports text input/output only. It buffers the CLI response before emitting OpenCode-compatible SSE chunks; it does not provide token-by-token generation or model tool calls.

## Troubleshooting

- **No `agy-cli` models:** run `agy models` and confirm the CLI is on `PATH` (or in the official Windows install location); restart OpenCode.
- **Port 47381 occupied:** stop the other service, then restart OpenCode. The plugin intentionally refuses an unverified listener.
- **CLI/auth/model errors:** run `agy models` and a standalone `agy --model <slug> --print "Reply OK"` check.
- **No tool use or images:** these are unsupported by this text-only adapter.

See [`AGENT-PROMPT.md`](AGENT-PROMPT.md) for a ready-to-run implementation prompt and [`TODO.md`](TODO.md) for follow-up work.
