/**
 * Sync IncomingPhoneNumbers from Twilio into the user's phone_numbers table.
 * Upserts by twilio_sid, scoped to the signed-in user.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cred } from "@/lib/config/credentials";

export type SyncResult =
  | { ok: true; added: number; updated: number; total: number }
  | { ok: false; reason: "no_credentials" | "unauthorized" | "network" | "unknown"; message: string };

export const syncTwilioNumbers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncResult> => {
    const sid = (await cred("TWILIO_ACCOUNT_SID"));
    const token = (await cred("TWILIO_AUTH_TOKEN"));
    if (!sid || !token) {
      return {
        ok: false,
        reason: "no_credentials",
        message: "Twilio credentials are not configured on the server.",
      };
    }

    let json: {
      incoming_phone_numbers?: Array<{
        sid: string;
        phone_number: string;
        friendly_name?: string;
        capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
      }>;
    };
    try {
      const basic = btoa(`${sid}:${token}`);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`,
        { headers: { Authorization: `Basic ${basic}` } },
      );
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "unauthorized", message: "Twilio rejected the credentials (401/403)." };
      }
      if (!res.ok) {
        return { ok: false, reason: "unknown", message: `Twilio API returned ${res.status}.` };
      }
      json = await res.json();
    } catch (e) {
      return {
        ok: false,
        reason: "network",
        message: e instanceof Error ? e.message : "Network error reaching Twilio.",
      };
    }

    const list = json.incoming_phone_numbers ?? [];
    const { supabase, userId } = context;

    // Load existing rows for this user to detect add vs update
    const { data: existing } = await supabase
      .from("phone_numbers")
      .select("twilio_sid")
      .eq("user_id", userId);
    const existingSids = new Set((existing ?? []).map((r) => r.twilio_sid));

    let added = 0;
    let updated = 0;
    for (const n of list) {
      const caps: string[] = [];
      if (n.capabilities?.voice) caps.push("voice");
      if (n.capabilities?.sms) caps.push("sms");
      if (n.capabilities?.mms) caps.push("mms");

      const row = {
        user_id: userId,
        number: n.phone_number,
        twilio_sid: n.sid,
        type: "local",
        capabilities: caps.length ? caps : ["voice"],
      };

      const { error } = await supabase
        .from("phone_numbers")
        .upsert(row, { onConflict: "user_id,twilio_sid" });
      if (error) {
        return { ok: false, reason: "unknown", message: error.message };
      }
      if (existingSids.has(n.sid)) updated++;
      else added++;
    }

    return { ok: true, added, updated, total: list.length };
  });
