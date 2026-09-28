# TODO

- Add automated tests using a mock `agy` process for model propagation, image/PDF staging, byte-for-byte event forwarding, session-header propagation, conversation resume without transcript replay, keepalives, malformed requests, failure, timeout and cancellation.
- Consider persisting OpenCode-session-to-AGY-conversation IDs across service restarts without storing credentials or conversation content.
- Native activity cards use synthetic OpenAI tool-call events solely to invoke dedicated, side-effect-free OpenCode display tools. Live reasoning deltas now keep one expandable disclosure per AGY step and append its final status/output before the native card is emitted. Multi-action smoke tests verified three live disclosures, three native cards, and a separate four-card session round trip; add automated regression coverage for live deltas and follow-up behavior.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
