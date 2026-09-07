/**
 * Runtime credential resolver.
 *
 * Values stored in public.app_credentials (editable in Settings → Credentials)
 * take priority; anything missing there falls back to the process environment.
 * This lets a self-hosted deployment be configured entirely from the UI without
 * baking secrets into the server environment.
 *
 * Only ever executed server-side. The admin Supabase client is imported lazily
 * so this module stays safe to import from client-reachable route/function files.
 */

export const CREDENTIAL_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "BRIDGE_URL",
  "BRIDGE_SHARED_SECRET",
  "PUBLIC_APP_URL",
  "APP_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

const TTL_MS = 15_000;

let cache: { at: number; map: Partial<Record<CredentialKey, string>> } | null = null;
let inflight: Promise<Partial<Record<CredentialKey, string>>> | null = null;

export function invalidateCredentialCache(): void {
  cache = null;
  inflight = null;
}

async function loadFromDb(): Promise<Partial<Record<CredentialKey, string>>> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("app_credentials")
      .select("key, value");
    if (error || !data) return {};
    const map: Partial<Record<CredentialKey, string>> = {};
    for (const row of data as Array<{ key: string; value: string }>) {
      const value = (row.value ?? "").trim();
      if (!value) continue;
      if ((CREDENTIAL_KEYS as readonly string[]).includes(row.key)) {
        map[row.key as CredentialKey] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function credentialMap(): Promise<Partial<Record<CredentialKey, string>>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  if (!inflight) {
    inflight = loadFromDb()
      .then((map) => {
        cache = { at: Date.now(), map };
        return map;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Resolve one credential: database value first, then process env. */
export async function cred(key: CredentialKey): Promise<string | undefined> {
  const map = await credentialMap();
  const fromDb = map[key];
  if (fromDb) return fromDb;
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

/** Resolve several credentials in one round trip. */
export async function creds<K extends CredentialKey>(
  ...keys: K[]
): Promise<Record<K, string | undefined>> {
  const map = await credentialMap();
  const out = {} as Record<K, string | undefined>;
  for (const key of keys) {
    const fromDb = map[key];
    const fromEnv = process.env[key];
    out[key] = fromDb || (fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined);
  }
  return out;
}
