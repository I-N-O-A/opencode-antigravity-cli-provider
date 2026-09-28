# TODO

- Add automated tests using a mock `agy` process for model propagation, image/PDF staging, byte-for-byte event forwarding, session-header propagation, conversation resume without transcript replay, keepalives, malformed requests, failure, timeout and cancellation.
- Consider persisting OpenCode-session-to-AGY-conversation IDs across service restarts without storing credentials or conversation content.
- The current OpenAI-compatible reasoning-text transport cannot emit independent native OpenCode message parts or tool cards; do not synthesize executable tool calls from AGY status events. The bridge uses independently expandable HTML disclosures per AGY step inside the single Thought part, with the identifying argument shown in each summary. Verify this presentation against supported OpenCode renderers/versions.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
