# TODO

- Add automated tests using a mock `agy` process for model propagation, image/PDF staging, byte-for-byte event forwarding, session-header propagation, conversation resume without transcript replay, keepalives, malformed requests, failure, timeout and cancellation.
- Consider persisting OpenCode-session-to-AGY-conversation IDs across service restarts without storing credentials or conversation content.
- Native OpenCode tool cards are not emitted by the current OpenAI-compatible reasoning-text transport; do not synthesize executable tool calls from AGY status events. Event payloads are shown as formatted, complete JSON in the reasoning section.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
