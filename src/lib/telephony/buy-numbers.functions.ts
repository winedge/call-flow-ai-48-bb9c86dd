/**
 * Search Twilio's available-number inventory and purchase a number.
 * Purchased numbers are saved to the signed-in user's phone_numbers table.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { creds } from "@/lib/config/credentials";

export type AvailableNumber = {
  phone_number: string;
  friendly_name: string;
  locality: string;
  region: string;
  voice: boolean;
  sms: boolean;
};

const SearchInput = z.object({
  country: z.string().regex(/^[A-Z]{2}$/).default("US"),
  type: z.enum(["Local", "TollFree", "Mobile"]).default("Local"),
  areaCode: z.string().regex(/^\d{0,4}$/).optional(),
  contains: z.string().regex(/^[\d*]{0,10}$/).optional(),
});

async function twilioAuth() {
  const c = await creds("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "PUBLIC_APP_URL");
  if (!c.TWILIO_ACCOUNT_SID || !c.TWILIO_AUTH_TOKEN) return null;
  return {
    sid: c.TWILIO_ACCOUNT_SID,
    basic: btoa(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`),
    publicUrl: (c.PUBLIC_APP_URL ?? "").replace(/\/$/, ""),
  };
}

export const searchAvailableNumbers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SearchInput.parse(d))
  .handler(async ({ data }): Promise<{ ok: true; numbers: AvailableNumber[] } | { ok: false; message: string }> => {
    const auth = await twilioAuth();
    if (!auth) return { ok: false, message: "Twilio credentials are not configured." };
    const qs = new URLSearchParams({ PageSize: "20", VoiceEnabled: "true" });
    if (data.areaCode) qs.set("AreaCode", data.areaCode);
    if (data.contains) qs.set("Contains", data.contains);
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${auth.sid}/AvailablePhoneNumbers/${data.country}/${data.type}.json?${qs}`,
        { headers: { Authorization: `Basic ${auth.basic}` } },
      );
      const json = (await res.json()) as {
        message?: string;
        available_phone_numbers?: Array<{
          phone_number: string;
          friendly_name?: string;
          locality?: string;
          region?: string;
          capabilities?: { voice?: boolean; SMS?: boolean; sms?: boolean };
        }>;
      };
      if (!res.ok) return { ok: false, message: json.message ?? `Twilio returned ${res.status}.` };
      return {
        ok: true,
        numbers: (json.available_phone_numbers ?? []).map((n) => ({
          phone_number: n.phone_number,
          friendly_name: n.friendly_name ?? n.phone_number,
          locality: n.locality ?? "",
          region: n.region ?? "",
          voice: n.capabilities?.voice ?? true,
          sms: n.capabilities?.SMS ?? n.capabilities?.sms ?? false,
        })),
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Network error." };
    }
  });

const BuyInput = z.object({
  phoneNumber: z.string().regex(/^\+\d{6,16}$/),
  type: z.enum(["Local", "TollFree", "Mobile"]).default("Local"),
});

export const buyTwilioNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => BuyInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: boolean; message: string }> => {
    const auth = await twilioAuth();
    if (!auth) return { ok: false, message: "Twilio credentials are not configured." };
    const body = new URLSearchParams({ PhoneNumber: data.phoneNumber });
    if (auth.publicUrl) {
      body.set("VoiceUrl", `${auth.publicUrl}/api/public/twilio/voice`);
      body.set("VoiceMethod", "POST");
    }
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${auth.sid}/IncomingPhoneNumbers.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth.basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      const json = (await res.json()) as {
        message?: string;
        sid?: string;
        phone_number?: string;
        capabilities?: { voice?: boolean; sms?: boolean; SMS?: boolean };
      };
      if (!res.ok || !json.sid) {
        return { ok: false, message: json.message ?? `Twilio returned ${res.status}.` };
      }
      const caps: string[] = [];
      if (json.capabilities?.voice ?? true) caps.push("voice");
      if (json.capabilities?.sms || json.capabilities?.SMS) caps.push("sms");
      const { error } = await context.supabase.from("phone_numbers").upsert(
        {
          user_id: context.userId,
          number: json.phone_number ?? data.phoneNumber,
          twilio_sid: json.sid,
          type: data.type === "TollFree" ? "toll_free" : data.type === "Mobile" ? "mobile" : "local",
          capabilities: caps,
        },
        { onConflict: "user_id,twilio_sid" },
      );
      if (error) return { ok: false, message: `Bought on Twilio but saving failed: ${error.message}` };
      return { ok: true, message: `Purchased ${json.phone_number ?? data.phoneNumber}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Network error." };
    }
  });
