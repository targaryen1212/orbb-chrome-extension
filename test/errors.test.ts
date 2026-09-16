import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage } from "../src/errors";

test("identifies Instagram folder discovery failures instead of blaming the connection", () => {
  assert.match(errorMessage(new Error("Instagram folders could not be loaded. Reopen Instagram and retry so folder memberships are preserved.")), /folder discovery failed/);
});
test("distinguishes rate limits, account authorization, and worker interruption", () => {
  assert.match(errorMessage(new Error("Instagram returned 429.")), /Too many requests/);
  assert.match(errorMessage(new Error("Orbit request failed: 401 unauthorized")), /Reconnect Orbb/);
  assert.match(errorMessage(new Error("The message port closed before a response was received.")), /stopped responding/);
});
test("does not echo unknown sensitive server errors into the panel", () => {
  assert.ok(!errorMessage(new Error("private-token=secret-value")).includes("secret-value"));
});
