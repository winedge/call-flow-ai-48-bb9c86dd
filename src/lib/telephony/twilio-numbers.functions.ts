/**
 * List phone numbers owned by the connected Twilio account.
 * Uses TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN saved in Admin → Secrets.
 */
import { createServerFn } from "@tanstack/react-start";
import { cred } from "@/lib/config/credentials";

export type TwilioNumber = {
  sid: string;
  phone_number: string; // E.164
  friendly_name: string;
  voice: boolean;
  sms: boolean;
  mms: boolean;
};

export type TwilioNumbersResult =
  | { ok: true; numbers: TwilioNumber[] }
  | { ok: false; reason: "no_credentials" | "unauthorized" | "network" | "unknown"; message: string };

export const listTwilioNumbers = createServerFn({ method: "GET" }).handler(
  async (): Promise<TwilioNumbersResult> => {
    const sid = (await cred("TWILIO_ACCOUNT_SID"));
    const token = (await cred("TWILIO_AUTH_TOKEN"));
    if (!sid || !token) {
      return {
        ok: false,
        reason: "no_credentials",
        message:
          "Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Admin → Secrets to load your numbers.",
      };
    }
    try {
      const basic = btoa(`${sid}:${token}`);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`,
        { headers: { Authorization: `Basic ${basic}` } },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: "unauthorized",
          message: "Twilio rejected the credentials (401/403). Check SID + token.",
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: "unknown",
          message: `Twilio API returned ${res.status}.`,
        };
      }
      const json = (await res.json()) as {
        incoming_phone_numbers?: Array<{
          sid: string;
          phone_number: string;
          friendly_name?: string;
          capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
        }>;
      };
      const numbers: TwilioNumber[] = (json.incoming_phone_numbers ?? []).map((n) => ({
        sid: n.sid,
        phone_number: n.phone_number,
        friendly_name: n.friendly_name ?? n.phone_number,
        voice: n.capabilities?.voice ?? false,
        sms: n.capabilities?.sms ?? false,
        mms: n.capabilities?.mms ?? false,
      }));
      return { ok: true, numbers };
    } catch (e) {
      return {
        ok: false,
        reason: "network",
        message: e instanceof Error ? e.message : "Network error reaching Twilio.",
      };
    }
  },
);
