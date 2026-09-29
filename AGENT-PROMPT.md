# Install AGY globally for OpenCode V2

Use the latest source from https://github.com/I-N-O-A/opencode-antigravity-cli-provider. Install globally by default so AGY works from every working directory. Do not change the current project unless the user asks for project-only installation. Complete the setup yourself—do not leave a manual config merge for the user.

1. Clone the repository to a temporary directory and run its installer (`powershell -ExecutionPolicy Bypass -File install.ps1` on Windows, `sh install.sh` on macOS/Linux). Plugins go in `~/.config/opencode/plugins/`; the bridge goes in `~/.config/opencode/runtime/`.
2. Merge `providers.agy-cli` into the global V2 config (`~/.config/opencode/opencode.json` or `.jsonc`). Use the committed example and IDs from `agy models`. Preserve the default model and all unrelated settings/models. Edit JSONC in place; never replace the whole config. If no config exists, create one without setting a default model.
3. Set `capabilities.tools: true` and `compatibility.reasoningField: "reasoning_content"` for every configured model. Reuse known limits from the example; do not guess limits. Model entries are static, so add discovered IDs to config.
4. Preserve all current behavior: one persistent `agy --input-format stream-json` process per OpenCode session/model; V2 `ctx.session.hook("model.request", ...)` session forwarding; live escaped action/status disclosures; side-effect-free native activity cards; saved-answer follow-up without rerunning AGY; attachments; monitor and commands; cancellation and loopback security. These are actual AGY activity states, not hidden chain-of-thought.
5. Avoid duplicate loads. If this workspace has AGY project plugins, keep backups as `.disabled` and disable only those AGY copies; do not touch unrelated files.
6. Reload OpenCode and verify from outside this repository: models and `/agy-monitor-on` are available, bridge health succeeds, and a real AGY request shows its activity and final answer.

Use only the official `agy` CLI. Preserve user settings/defaults, do not claim model discovery is dynamic or that Google cannot identify the CLI, and report changes and tests honestly.
