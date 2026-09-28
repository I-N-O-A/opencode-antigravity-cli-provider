# TODO

- Add automated tests using a mock `agy` process for model propagation, image/PDF staging, live answer/tool-progress streaming, keepalives, malformed requests, failure, timeout and cancellation.
- Confirm plugin lifecycle and shutdown behavior against current OpenCode 2.x releases.
- Explore regenerating OpenCode's static model config from `agy models` without relying on undocumented plugin APIs.
- Test the documented install on Windows, macOS and Linux where the official CLI is supported.
