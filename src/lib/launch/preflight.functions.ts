/**
 * Preflight checks for launching a campaign.
 * Verifies Twilio credentials + caller-ID ownership, bridge reachability,
 * and that the Lovable AI gateway is configured (needed for the agent turn loop).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { cred } from "@/lib/config/credentials";

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  id: "twilio" | "bridge" | "credits";
  status: CheckStatus;
  label: string;
  detail: string;
}

const Input = z.object({
  fromNumber: z.string().min(3),
});

async function checkTwilio(from: string): Promise<CheckResult> {
  const sid = (await cred("TWILIO_ACCOUNT_SID"));
  const token = (await cred("TWILIO_AUTH_TOKEN"));
  if (!sid || !token) {
    return {
      id: "twilio",
      status: "fail",
      label: "Twilio credentials",
      detail:
        "TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing. Add them in Admin → Secrets.",
    };
  }
  try {
    const basic = btoa(`${sid}:${token}`);
    const url = new URL(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
    );
    url.searchParams.set("PhoneNumber", from);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        id: "twilio",
        status: "fail",
        label: "Twilio credentials",
        detail: "Twilio rejected the credentials (401/403). Check SID + token.",
      };
    }
    if (!res.ok) {
      return {
        id: "twilio",
        status: "fail",
        label: "Twilio credentials",
        detail: `Twilio API returned ${res.status}.`,
      };
    }
    const json = (await res.json()) as {
      incoming_phone_numbers?: Array<{ phone_number: string; capabilities?: { voice?: boolean } }>;
    };
    const list = json.incoming_phone_numbers ?? [];
    const match = list.find((n) => n.phone_number === from);
    if (!match) {
      return {
        id: "twilio",
        status: "fail",
        label: `Caller ID ${from}`,
        detail:
          "This number isn't owned by the connected Twilio account. Purchase or port it first.",
      };
    }
    if (match.capabilities && match.capabilities.voice === false) {
      return {
        id: "twilio",
        status: "fail",
        label: `Caller ID ${from}`,
        detail: "This number doesn't have voice capability enabled.",
      };
    }
    return {
      id: "twilio",
      status: "pass",
      label: `Caller ID ${from}`,
      detail: "Verified and voice-enabled on your Twilio account.",
    };
  } catch (e) {
    return {
      id: "twilio",
      status: "fail",
      label: "Twilio credentials",
      detail: e instanceof Error ? e.message : "Network error reaching Twilio.",
    };
  }
}

async function checkBridge(): Promise<CheckResult> {
  const bridge = (await cred("BRIDGE_URL"));
  const secret = (await cred("BRIDGE_SHARED_SECRET"));
  if (!bridge) {
    return {
      id: "bridge",
      status: "fail",
      label: "Voice bridge",
      detail: "BRIDGE_URL is not set. Add the WebSocket URL in Admin → Secrets.",
    };
  }
  if (!secret) {
    return {
      id: "bridge",
      status: "fail",
      label: "Voice bridge",
      detail: "BRIDGE_SHARED_SECRET is not set - the bridge would reject calls.",
    };
  }
  // Convert wss://host[/path] → https://host[/path] for a lightweight health probe.
  const httpUrl = bridge.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(httpUrl, {
      method: "GET",
      signal: controller.signal,
    }).finally(() => clearTimeout(t));
    // Any 2xx / 4xx from the bridge host means DNS + TLS + a live server. 5xx / network = fail.
    if (res.status >= 500) {
      return {
        id: "bridge",
        status: "warn",
        label: "Voice bridge",
        detail: `Bridge responded ${res.status}. It may be starting up.`,
      };
    }
    return {
      id: "bridge",
      status: "pass",
      label: "Voice bridge",
      detail: `Reachable at ${new URL(httpUrl).host}.`,
    };
  } catch (e) {
    return {
      id: "bridge",
      status: "fail",
      label: "Voice bridge",
      detail:
        e instanceof Error && e.name === "AbortError"
          ? "Bridge didn't respond within 5s."
          : "Bridge is unreachable.",
    };
  }
}

async function checkCredits(): Promise<CheckResult> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    return {
      id: "credits",
      status: "fail",
      label: "AI gateway",
      detail:
        "LOVABLE_API_KEY missing - the agent can't reason during calls. Provision it in Admin → Secrets.",
    };
  }
  try {
    // Ping the gateway with a HEAD/OPTIONS-style GET. A 401/403 means the key is bad.
    const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        id: "credits",
        status: "fail",
        label: "AI gateway",
        detail: "Gateway rejected the API key. Rotate LOVABLE_API_KEY.",
      };
    }
    if (res.status === 402) {
      return {
        id: "credits",
        status: "fail",
        label: "AI gateway credits",
        detail: "Workspace is out of AI credits. Top up in Settings → Plans.",
      };
    }
    if (res.status === 429) {
      return {
        id: "credits",
        status: "warn",
        label: "AI gateway",
        detail: "Rate-limited right now - launch may retry a few times.",
      };
    }
    if (!res.ok) {
      return {
        id: "credits",
        status: "warn",
        label: "AI gateway",
        detail: `Gateway returned ${res.status}. Proceeding may still work.`,
      };
    }
    return {
      id: "credits",
      status: "pass",
      label: "AI gateway",
      detail: "Key valid, credits available.",
    };
  } catch (e) {
    return {
      id: "credits",
      status: "warn",
      label: "AI gateway",
      detail: e instanceof Error ? e.message : "Couldn't reach the gateway.",
    };
  }
}

export const preflightLaunch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<CheckResult[]> => {
    const [twilio, bridge, credits] = await Promise.all([
      checkTwilio(data.fromNumber),
      checkBridge(),
      checkCredits(),
    ]);
    return [twilio, bridge, credits];
  });
