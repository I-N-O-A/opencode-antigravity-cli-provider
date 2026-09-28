# Antigravity CLI for OpenCode


> **LOWEST-RISK APPROACH:** OpenCode calls the official `agy` CLI locally. No direct Antigravity API calls, custom OAuth, or project-stored credentials. Google receives a request made through `agy`, much like one you tpye manually in a terminal. 

## LET YOUR AGENT DO IT

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
- Do not impose an arbitrary small request/attachment-size limit. Avoid unnecessary attachment copies and document practical RAM, disk, CLI, and model-context limits honestly.
- Reject unexpected Host headers and browser Origin requests; set no permissive CORS headers. Do not add a fixed small request-size cap. On port collision, continue only if a bridge health endpoint identifies the expected bridge; otherwise fail clearly.
- Propagate request cancellation to the child CLI. Return readable CLI errors. Declare only capabilities that are actually supported; model tool calls are not supported by the reference implementation.
- Do not replace unrelated settings, permissions, plugins, or user files. Do not alter the user's default model.

## Work and verification

1. Inspect project instructions, OpenCode version, current config, and plugin APIs actually supported by that version.
2. Choose the simplest compatible implementation. Prefer the official CLI over a direct provider/API integration.
3. Implement discovery, config/model entries, bridge, and concise usage notes. Do not claim runtime model discovery updates OpenCode's selectable list unless you implement and verify that behavior.
4. Test with a mock CLI: slug forwarding, stdin prompt, image and document staging, response parsing, requests above 2 MiB, browser-origin/Host rejection, port collisions, errors, and cancellation. Run syntax/type checks.
5. If the official CLI is installed and authenticated, make a short real request through OpenCode and confirm it reaches `agy`. Otherwise state exactly which live test could not be run.
6. Check public-facing files for absolute user paths, credentials, tokens, and unrelated data.

At the end, list the changed files, install/restart steps, tests actually run, and any limitations. Do not claim that Google cannot identify the CLI client or that the integration has zero risk.
````

The agent is instructed to inspect your OpenCode version, rebuild the integration for your project, preserve your existing default model, and test what it can. Review the changes it proposes before using them.

## Do it manually

Install and sign in to the official Antigravity CLI, then confirm `agy models` works. Copy `agy-model-provider.ts` to `.opencode/plugins/agy-model-provider.ts` and `agy-openai-bridge.mjs` to `.opencode/runtime/agy-openai-bridge.mjs`. Merge `opencode.provider.example.jsonc` into `opencode.json`, adding one model entry for each slug you want from `agy models`. Keep your current default; the example uses `google/gemini-3.8-flash`.

Restart OpenCode and select `agy-cli/<slug>`.

## What this does

The local bridge passes the selected slug as `agy --model <slug>` and sends the prompt to the CLI over stdin. Image and file attachments are written to a temporary local folder and referenced in the prompt as `@file`; the CLI reads them through its normal workspace tools. Temporary files are deleted after the response. The bridge has no fixed request-size ceiling or upload timeout. Very large attachments still depend on OpenCode's request handling, available RAM/disk space, `agy`, and the selected model's context limits.

The bridge listens only on `127.0.0.1`, rejects browser-origin requests and unverified port collisions, and has no separate authentication. Do not expose or proxy its port; local processes running as your user can still reach it. OpenCode streaming is buffered until `agy` finishes; this is not token-by-token streaming. Model tool calls are not supported.

See [AGENT-PROMPT.md](AGENT-PROMPT.md) for the full rebuild instructions and [TODO.md](TODO.md) for follow-up work.
