#!/usr/bin/env node
/**
 * Test fixture emulating `cursor-agent --print --output-format stream-json`.
 *
 * Emits a system event (carrying a session_id) and an assistant event, then
 * stays alive so request cancellation is observable: the runner's `done`
 * event can only fire once this process is killed by a {cancel} control
 * message (it never exits on its own while the keep-alive interval runs).
 *
 * A safety-net timer bounds the lifetime of any orphaned instance so a
 * failed test cannot leak processes indefinitely.
 */
process.stdin.resume();
process.stdin.on("data", () => {});

process.stdout.write(JSON.stringify({ type: "system", session_id: "mock-chat-1" }) + "\n");
process.stdout.write(
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "partial..." }] },
  }) + "\n",
);

// Keep the process alive until killed. Safety net: exit if never cancelled.
// 60s (unref'd) gives slow CI headroom so the net does not fire before the
// test cancels the request; the interval keeps the loop alive regardless.
setInterval(() => {}, 60_000);
setTimeout(() => process.exit(2), 60_000).unref();