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

The agent is instructed to inspect your OpenCode version, rebuild the integration for your project, preserve your existing default model, and test what it can. Review the changes it proposes before using them.

## Do it manually

Install and sign in to the official Antigravity CLI, then confirm `agy models` works. Copy `agy-model-provider.ts` to `.opencode/plugins/agy-model-provider.ts` and `agy-openai-bridge.mjs` to `.opencode/runtime/agy-openai-bridge.mjs`. Merge `opencode.provider.example.jsonc` into `opencode.json`, adding one model entry for each slug you want from `agy models`. Keep your current default; the example uses `google/gemini-3.8-flash`.

Restart OpenCode and select `agy-cli/<slug>`.

## What this does

The local bridge passes the selected slug as `agy --model <slug>` and sends the prompt to the CLI over stdin. Image and file attachments are written to a temporary local folder and referenced in the prompt as `@file`; the CLI reads them through its normal workspace tools. Temporary files are deleted after the response. The bridge has no fixed request-size ceiling or upload timeout. Very large attachments still depend on OpenCode's request handling, available RAM/disk space, `agy`, and the selected model's context limits.

The bridge listens only on `127.0.0.1`, rejects browser-origin requests and unverified port collisions, and has no separate authentication. Do not expose or proxy its port; local processes running as your user can still reach it. OpenCode streaming is buffered until `agy` finishes; this is not token-by-token streaming. Model tool calls are not supported.

See [AGENT-PROMPT.md](AGENT-PROMPT.md) for the full rebuild instructions and [TODO.md](TODO.md) for follow-up work.
