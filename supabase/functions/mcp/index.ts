// Supabase Edge Function: Gleaner as a remote MCP server for the Claude app.
// URL to give Claude:  https://<project-ref>.supabase.co/functions/v1/mcp/<MCP_TOKEN>
// Deploy: see README ("Claude connector"). Deployed with --no-verify-jwt because Claude sends no Supabase JWT;
// the long random MCP_TOKEN in the path is the key, and every query runs as the owner under row level security.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, type Store, tokenMatches } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: true },
});

async function signedIn() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInWithPassword({
    email: Deno.env.get("GLEANER_EMAIL")!,
    password: Deno.env.get("GLEANER_PASSWORD")!,
  });
  if (error) throw new Error("owner sign-in failed");
}

const store: Store = {
  async state() {
    await signedIn();
    const { data, error } = await supabase.from("state").select("jobs, entries, seen_at").maybeSingle();
    if (error) throw error;
    return data;
  },
  async pendingActions() {
    await signedIn();
    const { data, error } = await supabase.from("actions").select("kind, status, error, created_at").order("created_at");
    if (error) throw error;
    return data ?? [];
  },
  async addAction(kind, payload) {
    await signedIn();
    const { error } = await supabase.from("actions").insert({ id: crypto.randomUUID(), kind, payload });
    if (error) throw error;
  },
};

Deno.serve(async (req) => {
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  // Wrong or missing secret: look like nothing is here.
  if (!tokenMatches(token, Deno.env.get("MCP_TOKEN"))) return new Response("Not found", { status: 404 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  try {
    const result = await handle(body, store);
    return result === null ? new Response(null, { status: 202 }) : Response.json(result);
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, { status: 500 });
  }
});
