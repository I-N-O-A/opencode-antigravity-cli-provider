# TODO

- Add automated tests using a mock `agy` process for model propagation, malformed/oversized requests, failure, timeout and cancellation.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
- Investigate whether `agy` exposes a stable true token-streaming mode; current bridge emits accumulated output in SSE chunks after completion.
