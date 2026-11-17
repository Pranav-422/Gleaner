import { createClient } from "@supabase/supabase-js";

// Both values are public by design (the anon key only works within the row level security rules).
// Set at build time in web/.env.local, or in the hosting dashboard.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const cloud = url && key ? createClient(url, key) : null;
