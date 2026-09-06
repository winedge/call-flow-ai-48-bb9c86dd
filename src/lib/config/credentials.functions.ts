/**
 * Admin-only read/write of runtime service credentials.
 * Values live in public.app_credentials; the process environment is used as a
 * read-only fallback so existing deployments keep working unchanged.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CREDENTIAL_KEYS, type CredentialKey } from "@/lib/config/credentials";

export type CredentialEntry = {
  key: CredentialKey;
  value: string;
  source: "database" | "environment" | "unset";
};

export type CredentialsResult =
  | { ok: true; entries: CredentialEntry[] }
  | { ok: false; message: string };

async function assertAdmin(context: {
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown }> };
  userId: string;
}): Promise<boolean> {
  const { data } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  return data === true;
}

export const getCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CredentialsResult> => {
    if (!(await assertAdmin(context as never))) {
      return { ok: false, message: "Admin access required." };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("app_credentials").select("key, value");
    if (error) return { ok: false, message: error.message };

    const dbMap = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ key: string; value: string }>) {
      if ((row.value ?? "").trim()) dbMap.set(row.key, row.value.trim());
    }

    const entries: CredentialEntry[] = CREDENTIAL_KEYS.map((key) => {
      const fromDb = dbMap.get(key);
      if (fromDb) return { key, value: fromDb, source: "database" as const };
      const fromEnv = (process.env[key] ?? "").trim();
      if (fromEnv) return { key, value: fromEnv, source: "environment" as const };
      return { key, value: "", source: "unset" as const };
    });

    return { ok: true, entries };
  });

const SaveInput = z.object({
  values: z.record(z.string(), z.string()),
});

export const saveCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: boolean; message?: string; saved?: number }> => {
    if (!(await assertAdmin(context as never))) {
      return { ok: false, message: "Admin access required." };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { invalidateCredentialCache } = await import("@/lib/config/credentials");

    const rows = Object.entries(data.values)
      .filter(([key]) => (CREDENTIAL_KEYS as readonly string[]).includes(key))
      .map(([key, value]) => ({
        key,
        value: value.trim(),
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      }));

    if (rows.length === 0) return { ok: true, saved: 0 };

    const { error } = await supabaseAdmin
      .from("app_credentials")
      .upsert(rows, { onConflict: "key" });
    if (error) return { ok: false, message: error.message };

    invalidateCredentialCache();
    return { ok: true, saved: rows.length };
  });

/** Validate the stored/inherited Twilio credentials against Twilio's API. */
export const verifyTwilioCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ok: boolean; message: string }> => {
    if (!(await assertAdmin(context as never))) {
      return { ok: false, message: "Admin access required." };
    }
    const { creds } = await import("@/lib/config/credentials");
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = await creds(
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
    );
    if (!sid || !token) return { ok: false, message: "Account SID or Auth Token is empty." };
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: "Twilio rejected these credentials (401)." };
      }
      if (!res.ok) return { ok: false, message: `Twilio returned ${res.status}.` };
      const json = (await res.json()) as { friendly_name?: string; status?: string };
      return {
        ok: true,
        message: `Connected to Twilio account "${json.friendly_name ?? sid}" (${json.status ?? "active"}).`,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Network error." };
    }
  });
