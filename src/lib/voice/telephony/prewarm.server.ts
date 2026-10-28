import { cred } from "@/lib/config/credentials";

/**
 * Ask the self-hosted voice bridge to load the agent and make its greeting
 * voice now, while the phone rings, so the greeting plays right at pickup.
 * Best-effort: never throws, never delays dialing by more than ~1.5s.
 */
export async function prewarmBridge(bridgeUrl: string, agentId: string): Promise<void> {
  try {
    const secret = await cred("BRIDGE_SHARED_SECRET");
    if (!secret) return;
    const u = new URL(bridgeUrl.replace(/^ws/, "http"));
    u.pathname = "/prewarm";
    u.search = "";
    u.searchParams.set("agent_id", agentId);
    await fetch(u.toString(), {
      method: "POST",
      headers: { "x-bridge-secret": secret },
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // ignore - the bridge falls back to making the greeting at pickup
  }
}
