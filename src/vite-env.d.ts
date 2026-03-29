/// <reference types="vite/client" />

/** Extend Vite’s env typing — do not re-declare `ImportMeta` (avoids TS merge conflicts). */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY: string;
}
