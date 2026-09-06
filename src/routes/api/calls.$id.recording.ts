/**
 * Authenticated proxy for Twilio call recordings.
 *
 * Twilio recording URLs (api.twilio.com/.../Recordings/RE....mp3) require
 * HTTP Basic auth with the Account SID + Auth Token. The browser can't send
 * those, so hitting the URL directly triggers a Twilio login prompt.
 *
 * This route:
 *  1. Verifies the caller's Supabase session (bearer token).
 *  2. Confirms the requested call belongs to that user.
 *  3. Fetches the .mp3 from Twilio with Basic auth server-side.
 *  4. Streams the audio back to the browser with the right headers.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { cred } from "@/lib/config/credentials";

export const Route = createFileRoute("/api/calls/$id/recording")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        }),
      GET: async ({ request, params }) => {
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (!token) return new Response("Unauthorized", { status: 401 });

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseAnon = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!supabaseUrl || !supabaseAnon) {
          return new Response("Server misconfigured", { status: 500 });
        }

        const supabase = createClient(supabaseUrl, supabaseAnon, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr || !userData.user) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { data: call, error: callErr } = await supabase
          .from("calls")
          .select("id, recording_url, user_id")
          .eq("id", params.id)
          .maybeSingle<{ id: string; recording_url: string | null; user_id: string }>();

        if (callErr || !call) {
          return new Response("Not found", { status: 404 });
        }
        if (!call.recording_url) {
          return new Response("No recording", { status: 404 });
        }

        const sid = (await cred("TWILIO_ACCOUNT_SID"));
        const authToken = (await cred("TWILIO_AUTH_TOKEN"));
        if (!sid || !authToken) {
          return new Response("Twilio not configured", { status: 500 });
        }

        const basic = btoa(`${sid}:${authToken}`);
        const range = request.headers.get("range");
        const upstream = await fetch(call.recording_url, {
          headers: {
            Authorization: `Basic ${basic}`,
            ...(range ? { Range: range } : {}),
          },
        });

        if (!upstream.ok && upstream.status !== 206) {
          const body = await upstream.text().catch(() => "");
          return new Response(`Recording fetch failed: ${upstream.status} ${body.slice(0, 200)}`, {
            status: upstream.status,
          });
        }

        const headers = new Headers();
        headers.set("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
        const len = upstream.headers.get("content-length");
        if (len) headers.set("Content-Length", len);
        const cr = upstream.headers.get("content-range");
        if (cr) headers.set("Content-Range", cr);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "private, max-age=300");
        headers.set("Access-Control-Allow-Origin", "*");

        return new Response(upstream.body, { status: upstream.status, headers });
      },
    },
  },
});
