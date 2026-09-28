# TODO

- Add automated tests using a mock `agy` process for model propagation, image/PDF staging, byte-for-byte event forwarding, session-header propagation, conversation resume without transcript replay, keepalives, malformed requests, failure, timeout and cancellation.
- Publish the current bridge/plugin/docs via the previously used manual per-file GitHub edit workflow, then verify each raw file URL and record the resulting revision. Do not use the repository-wide upload page.
- Consider persisting OpenCode-session-to-AGY-conversation IDs across service restarts without storing credentials or conversation content.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
