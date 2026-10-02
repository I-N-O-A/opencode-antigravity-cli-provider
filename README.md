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

The agent installs the files and merges only the provider settings into your global V2 config. Models are discovered at startup; your existing settings and default model must be preserved.

## Copy-paste prompt

```text
Install the latest AGY Bridge from https://github.com/I-N-O-A/opencode-antigravity-cli-provider globally for OpenCode V2, so it works from every working directory. Read and follow its AGENT-PROMPT.md. Install the plugins and bridge, then merge only providers.agy-cli settings into my global OpenCode config yourself; do not add model IDs or modify my default model. Preserve all unrelated settings; do not leave a manual merge for me. Keep persistent per-session AGY processes, live activity/status disclosures, native display-only activity cards, monitor commands, and verify with a real request outside the repository.
```

## Manual installation

Install and authenticate `agy` first. From a clone of this repository, run `sh install.sh` or, on Windows, `powershell -ExecutionPolicy Bypass -File .\install.ps1`. These scripts copy the plugins, bridge, and merge-ready V2 config example; they do not edit your OpenCode config. For all workspaces, install globally. Project-only installation: add `--project <directory>` (PowerShell: `-Project <directory>`). Do not install both scopes.

## Behavior

One long-running `stream-json` AGY process is reused per OpenCode session/model/mode. The provider forwards OpenCode's active agent name to the local bridge: Plan starts AGY with `--mode=plan`, while Build keeps AGY's configured default execution mode and permission rules. Switching modes starts an AGY process and seeds it with available conversation history. Actual AGY tool activity streams as expandable status disclosures and final side-effect-free OpenCode tool cards; the final answer is returned without rerunning AGY. This displays emitted activity, not hidden chain-of-thought. Attachments are temporary. Idle processes no longer expire automatically; processes stop on cancellation, project changes, or service shutdown.

### Persistent conversation identity

The bridge saves an atomic mapping of OpenCode session/model/mode/project/CLI to the exact AGY conversation UUID in `~/.local/state/opencode/agy-bridge/conversations/` (override: `AGY_BRIDGE_STATE_DIR`). This stores identity metadata, not prompts or credentials. After process or service restart, only that UUID is passed through `--conversation`; `--continue` and global "last conversation" selection are never used. Successful results update the mapping. A mapping marked interrupted, absent, corrupt, or from a different owner is not resumed; a fresh process receives only the history supplied for the current OpenCode session. History entries are explicitly labelled as context, not executable actions or approvals.

The CLI can silently create a different conversation when the requested ID no longer exists. The bridge rejects mismatched emitted IDs. It permits one fresh-history fallback only before observed tool activity and never on cancellation or ordinary transport/authentication failures, avoiding automatic action replay. Auxiliary compaction/title/generate requests do not persist mappings. Existing sessions without a saved mapping initially rely on their supplied OpenCode history; missing historical context cannot be reconstructed magically. Process crashes during active actions still require care: the next request falls back to available history rather than automatically rerunning the interrupted request.

The bridge listens only on `127.0.0.1`. The optional in-memory monitor is at `http://127.0.0.1:47381/monitor`; use the native plugin commands `/agy-monitor-on` and `/agy-monitor-off` or the monitor page's **Turn monitoring on/off** button to enable or disable capture without invoking an agent or adding a chat message. `/agy-monitor-on` opens the monitor in your default browser so its URL and live status are visible. Turning monitoring off stops collecting events and clears the in-memory event buffer; it does not stop the local bridge server or close the browser tab. Monitored prompts and outputs may be sensitive; do not expose the port.

### Tool failures and compaction

Tool failures remain visible as failed activity cards; they do not become provider errors by themselves. For a primary Build request with tool activity and an empty answer or a non-success AGY result, the bridge makes up to three continuation attempts in the same AGY process before returning the cards. Continuation instructions forbid repeating completed work or retrying/circumventing permission denials. A display acknowledgement only returns the saved answer and never repeats actions. Empty result text falls back to AGY's streamed answer, not a fabricated success message. If recovery produces no answer, the bridge reports that completion is unconfirmed. Authentication, process exits, cancellation, and other transport failures remain actual errors; indefinite continuation is not guaranteed.

Plan requests are never automatically continued by this recovery mechanism. The provider forwards OpenCode's request `kind`; compaction, title, and generate requests use isolated one-shot processes and do not emit display tool calls or contaminate the primary chat process. No keyword matching is used to infer compaction from ordinary user text.

Compaction must return a non-empty context checkpoint. Null, whitespace, non-text responses and literal null/undefined placeholders are rejected; valid streamed summary text can replace an empty result field. Up to three isolated attempts summarize the same supplied transcript with explicit summary-only instructions. Unexpected tool execution is stopped without replay. If summarization fails, the bridge builds a bounded local recovery checkpoint from this request's supplied history: system constraints, earlier user goals, recent dialogue and tool results/blockers. This is not an error-only placeholder, task-completion claim, or execution approval. Long excerpts are visibly shortened; missing facts must not be invented. Both JSON and streaming requests receive a valid checkpoint so OpenCode can continue the pending prompt rather than stopping on the summarization failure. Intentional cancellation/disconnection and invalid project/request validation are not overridden. The bridge does not directly edit OpenCode's transcript or guarantee lossless semantic recovery from an incomplete history.

After updating, run `opencode service restart` to replace old in-memory bridge code. `/healthz` reports bridge version `8`; an older listener is rejected instead of silently reused. Regression tests: `node --test test/bridge.test.mjs`.

### Plan / Build transitions

Only the selected OpenCode agent header determines Plan mode. Mentions of `/plan` in user text, checkpoints, or quotations cannot override Build. Primary requests carry an explicit current-mode reminder so old Plan restrictions in conversation history are not treated as the current mode. Plan remains planning-only; entering Build does not itself approve unrelated work or unapproved plans. On a mode switch the old-mode process is stopped, and the target process receives the current session transcript, including when it resumes an older mode-specific conversation after a restart. This updates execution context without changing AGY permission settings or automatically approving tools.

### Session project directory

On every model request the provider reads the current OpenCode session's `location.directory`, not the plugin's load location or the service working directory. It also accepts wrapped API responses and legacy session `directory` fields. When available, it forwards this path as a URI-encoded `x-opencode-directory` header. The bridge validates and resolves an existing absolute directory, starts AGY with that `cwd`, and adds it explicitly with `--add-dir` alongside the temporary attachment directory. Moving a session stops its previous AGY process before starting one in the new directory. Display acknowledgements cannot cross session, model, or directory boundaries.

A project directory is optional. Missing metadata, an absent header, a relative path, or a deleted/non-directory project path uses the AGY process's own isolated temporary scratch directory, never the service cwd or another session's project. The prompt explicitly marks this as supported no-project context: do not guess/search for a project, continue project-independent work, and ask once if a task truly needs an unspecified project/relative path. No-project conversation mappings remain session/model/mode scoped across restarts. Malformed/control-character headers and actual access-denied filesystem errors are still rejected rather than bypassed.

This binds AGY's working directory and workspace context; it is **not a filesystem sandbox**. Existing AGY permissions remain unchanged, including any permission to access files outside the project.

## Dynamic model catalog

At each OpenCode startup, the plugin runs `agy models`, parses its IDs and display names, and registers them through OpenCode V2's in-memory provider registry. It never writes the catalog to `opencode.json`; leave the provider's configured `models` map empty. The last successfully discovered ID/name list is retained in plugin storage and used if a later startup cannot reach AGY. Known model limits are retained; newly introduced models receive OpenCode's documented fallback limits rather than guessed AGY-specific values. OpenCode must be restarted to discover changes made by AGY after startup.
