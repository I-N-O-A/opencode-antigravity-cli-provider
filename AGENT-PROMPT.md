# Agent prompt

Copy this prompt into a coding agent with access to your OpenCode project:

```text
Integrate the files from this repository into my OpenCode project so I can select and use Antigravity models through the official agy CLI.

Requirements:
- Read the included README and TODO and inspect my actual OpenCode version/plugin contract before changing anything.
- Use only the official `agy` CLI for model discovery and completions. Do not add direct Antigravity API calls, custom OAuth, or stored credentials.
- Install the plugin and bridge at the documented project-relative paths; use portable CLI discovery, never hardcode my username or absolute paths.
- Merge the provider example with my existing config without replacing my default model or unrelated settings.
- Preserve `google/gemini-3.8-flash` as the default unless my config already intentionally uses a different default.
- Pass the selected slug unchanged as `agy --model <slug>`; send prompts through stdin rather than command-line arguments.
- Keep the bridge on loopback, reject browser-origin requests, validate the Host header, cap request size, and refuse unverified port collisions.
- Verify with a mock CLI and, if installed/authenticated, with a real short request through the normal OpenCode background service. Never claim a test passed unless it actually did.
- Check that no personal paths, tokens, or secrets are added. Report changed files and actual test results.
```
