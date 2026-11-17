// Run: node --test supabase/functions/mcp/handler.test.ts   (Node 23.6+ strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, type Store, tokenMatches } from "./handler.ts";

function fakeStore() {
  const added: { kind: string; payload: Record<string, unknown> }[] = [];
  const store: Store = {
    async state() {
      return {
        seen_at: "2026-11-17T20:00:00+00:00",
        jobs: [
          { id: "1", url: "https://www.instagram.com/p/a/", status: "done", error: null, title: "A", created_at: "x" },
          { id: "2", url: "https://www.instagram.com/p/b/", status: "failed", error: "empty media", title: null, created_at: "y" },
        ],
        entries: [
          { id: 1, folder: "tools", title: "SupoClip", summary: "Clipper", score: 60, frames: ["f.jpg"], archived_at: null },
          { id: 2, folder: "hackathons", title: "CodeFest", summary: "Student hackathon", score: 90, archived_at: null },
          { id: 3, folder: "tools", title: "Old bot", summary: "", score: 99, archived_at: "2026-10-01" },
        ],
      };
    },
    async pendingActions() {
      return [{ kind: "share", status: "pending", error: null, created_at: "z" }];
    },
    async addAction(kind, payload) {
      added.push({ kind, payload });
    },
  };
  return { store, added };
}

const call = (name: string, args: object) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
const parse = (reply: any) => JSON.parse(reply.result.content[0].text);

test("initialize, notifications and tools/list", async () => {
  const { store } = fakeStore();
  const init: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, store);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, store), null);
  const tools: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, store);
  assert.deepEqual(tools.result.tools.map((t: any) => t.name), ["list_entries", "get_entry", "list_pending", "save_link", "save_entry"]);
  const unknown: any = await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, store);
  assert.equal(unknown.error.code, -32601);
});

test("reading: sorted by score, archived hidden, frames left out", async () => {
  const { store } = fakeStore();
  const listed = parse(await handle(call("list_entries", {}), store));
  assert.deepEqual(listed.map((e: any) => e.id), [2, 1]);
  assert.deepEqual(parse(await handle(call("list_entries", { search: "clip" }), store)).map((e: any) => e.id), [1]);
  const one = parse(await handle(call("get_entry", { id: 1 }), store));
  assert.equal(one.title, "SupoClip");
  assert.equal(one.frames, undefined);
  const pending = parse(await handle(call("list_pending", {}), store));
  assert.equal(pending.jobs.length, 1);
  assert.equal(pending.waiting_actions.length, 1);
});

test("saving: only Instagram links, only known folders", async () => {
  const { store, added } = fakeStore();
  const bad: any = await handle(call("save_link", { url: "https://evil.example/x" }), store);
  assert.equal(bad.result.isError, true);
  await handle(call("save_link", { url: "https://www.instagram.com/reel/Abc/?igsh=1" }), store);
  assert.deepEqual(added[0], { kind: "share", payload: { text: "https://www.instagram.com/reel/Abc/" } });
  const badFolder: any = await handle(call("save_entry", { folder: "crypto", title: "x", summary: "y", next_step: "z" }), store);
  assert.equal(badFolder.result.isError, true);
  await handle(call("save_entry", { folder: "tools", title: "T", summary: "S", next_step: "Try", evil: "drop" }), store);
  assert.equal(added[1].kind, "save_entry");
  assert.deepEqual(Object.keys((added[1].payload as any).entry).sort(), ["folder", "next_step", "summary", "title"]);
  const nothingElse: any = await handle(call("decision", { id: 1 }), store);
  assert.equal(nothingElse.result.isError, true);
});

test("errors from the store are not leaked", async () => {
  const { store } = fakeStore();
  store.state = async () => {
    throw new Error("secret connection string");
  };
  const reply: any = await handle(call("list_entries", {}), store);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, "Gleaner could not do that");
});

test("token comparison", () => {
  const secret = "a".repeat(40);
  assert.equal(tokenMatches(secret, secret), true);
  assert.equal(tokenMatches("a".repeat(39) + "b", secret), false);
  assert.equal(tokenMatches(undefined, secret), false);
  assert.equal(tokenMatches("short", "short"), false);
});
