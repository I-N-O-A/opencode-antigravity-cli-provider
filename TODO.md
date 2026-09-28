# TODO

- Add automated tests using a mock `agy` process for persistent multi-turn stdin, exact latest-user-text forwarding, process reuse/idle expiry, image/PDF staging, keepalives, malformed requests, failure, cancellation and shutdown.
- The persistent process passed ten real consecutive AGY turns in one OpenCode session with the same PID and retained memory; also verified a native-tool round trip followed by another turn in that same process. Add reproducible regression tests for those cases.
- Native activity cards use synthetic OpenAI tool-call events solely to invoke dedicated, side-effect-free OpenCode display tools. Live reasoning deltas keep one expandable disclosure per AGY step and append its final status/output before the native card is emitted. Multi-action smoke tests verified three live disclosures, three native cards, and a separate four-card session round trip; add automated regression coverage for live deltas and follow-up behavior.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
