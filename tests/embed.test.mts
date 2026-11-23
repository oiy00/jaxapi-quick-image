import assert from "node:assert/strict";
import test from "node:test";
import { groupAllowsImage, pickImageGroup } from "../lib/keys.ts";
import { sessionFromHostStorage, stripSensitiveQuery } from "../lib/session.ts";
import type { ApiGroup } from "../lib/types.ts";

test("host localStorage session is adopted without a second login", () => {
  const store = new Map<string, string>([
    ["auth_token", "access-abc"],
    ["refresh_token", "refresh-def"],
    ["token_expires_at", "2000"],
    ["auth_user", JSON.stringify({ id: 7, email: "wen@example.com", balance: 1.25 })],
  ]);
  const session = sessionFromHostStorage({ getItem: (key) => store.get(key) ?? null });
  assert.equal(session?.accessToken, "access-abc");
  assert.equal(session?.refreshToken, "refresh-def");
  assert.equal(session?.user.email, "wen@example.com");
  assert.equal(session?.user.balance, 1.25);
  assert.equal(session?.source, "host");
});

test("iframe token query is stripped and never treated as the session", () => {
  const next = stripSensitiveQuery(
    "https://jaxapi.top/image?token=secret-jwt&user_id=7&theme=dark&ui_mode=embedded",
  );
  assert.equal(next, "/image?theme=dark&ui_mode=embedded");
  assert.equal(stripSensitiveQuery("https://jaxapi.top/image?theme=dark"), null);
});

test("auto-create only picks the 媒体台 group", () => {
  const groups: ApiGroup[] = [
    { id: 1, name: "claude", platform: "anthropic", status: "active" },
    { id: 2, name: "plus", platform: "openai", status: "active", allow_image_generation: true },
    { id: 7, name: "ChatGPT 生图", platform: "openai", status: "active", allow_image_generation: true },
    { id: 8, name: "媒体台", platform: "openai", status: "active", allow_image_generation: true },
  ];
  assert.equal(groupAllowsImage(groups[0]), false);
  assert.equal(pickImageGroup(groups)?.id, 8);
  assert.equal(pickImageGroup(groups.slice(0, 3)), null);
  assert.equal(pickImageGroup([groups[0]]), null);
});
