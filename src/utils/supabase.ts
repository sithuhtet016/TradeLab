import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Reads env at module load but does not throw — a missing .env would otherwise
 * crash the whole app before React renders (white screen).
 */
function readEnv() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  if (!url || !key) return null;
  return { url, key };
}

const env = readEnv();

/** `null` when env vars are missing — check before use. */
export const supabase: SupabaseClient | null = env
  ? createClient(env.url, env.key)
  : null;

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
