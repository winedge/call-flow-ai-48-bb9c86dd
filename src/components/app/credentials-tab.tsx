import { useEffect, useState } from "react";
import { Eye, EyeOff, Save, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CREDENTIAL_KEYS, type CredentialKey } from "@/lib/config/credentials";
import {
  getCredentials,
  saveCredentials,
  verifyTwilioCredentials,
  type CredentialEntry,
} from "@/lib/config/credentials.functions";

const LABELS: Record<CredentialKey, { label: string; hint: string; secret: boolean }> = {
  TWILIO_ACCOUNT_SID: { label: "Twilio Account SID", hint: "Starts with AC", secret: false },
  TWILIO_AUTH_TOKEN: { label: "Twilio Auth Token", hint: "Twilio Console → Auth Token", secret: true },
  TWILIO_FROM_NUMBER: { label: "Twilio From Number", hint: "E.164, e.g. +18623500434", secret: false },
  DEEPGRAM_API_KEY: { label: "Deepgram API Key", hint: "Speech-to-text", secret: true },
  ELEVENLABS_API_KEY: { label: "ElevenLabs API Key", hint: "Text-to-speech", secret: true },
  BRIDGE_URL: { label: "Voice Bridge URL", hint: "wss:// or https:// of your bridge service", secret: false },
  BRIDGE_SHARED_SECRET: { label: "Voice Bridge Secret", hint: "Must match the bridge service", secret: true },
  PUBLIC_APP_URL: { label: "Public App URL", hint: "Used in Twilio webhooks", secret: false },
  APP_URL: { label: "App URL", hint: "Internal base URL", secret: false },
};

const SOURCE_TEXT: Record<CredentialEntry["source"], string> = {
  database: "Saved here",
  environment: "Inherited from server environment",
  unset: "Not set",
};

export function CredentialsTab() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, CredentialEntry["source"]>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getCredentials();
      if (!res.ok) {
        setDenied(true);
        return;
      }
      const v: Record<string, string> = {};
      const s: Record<string, CredentialEntry["source"]> = {};
      for (const e of res.entries) {
        v[e.key] = e.value;
        s[e.key] = e.source;
      }
      setValues(v);
      setSources(s);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load credentials");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      const res = await saveCredentials({ data: { values } });
      if (!res.ok) {
        toast.error(res.message ?? "Save failed");
        return;
      }
      toast.success("Credentials saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    try {
      const res = await verifyTwilioCredentials();
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(false);
    }
  };

  if (denied) {
    return (
      <div className="bg-white ring-1 ring-black/5 rounded-xl p-6">
        <p className="text-sm text-neutral-600">
          Only workspace admins can view or change service credentials.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white ring-1 ring-black/5 rounded-xl p-6">
      <div className="flex items-start justify-between gap-3 mb-4 border-b border-surface-border/40 pb-3">
        <div>
          <h2 className="text-sm font-medium text-neutral-900">Service credentials</h2>
          <p className="text-xs text-neutral-500 mt-1 max-w-xl">
            Values saved here are used by the running app and take priority over server environment
            variables. Useful for self-hosted deployments.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`size-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Reload
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-neutral-500 italic">Loading…</p>
      ) : (
        <div className="space-y-4">
          {CREDENTIAL_KEYS.map((key) => {
            const meta = LABELS[key];
            const visible = !meta.secret || show[key];
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-[11px] uppercase tracking-wider text-neutral-500 font-mono">
                    {meta.label}
                  </Label>
                  <span className="text-[10px] text-neutral-400 font-mono">
                    {SOURCE_TEXT[sources[key] ?? "unset"]}
                  </span>
                </div>
                <div className="relative">
                  <Input
                    type={visible ? "text" : "password"}
                    value={values[key] ?? ""}
                    placeholder={meta.hint}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setValues((p) => ({ ...p, [key]: e.target.value }))}
                    className={meta.secret ? "pr-10 font-mono text-xs" : "font-mono text-xs"}
                  />
                  {meta.secret && (
                    <button
                      type="button"
                      onClick={() => setShow((p) => ({ ...p, [key]: !p[key] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-900"
                    >
                      {show[key] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <div className="flex justify-end gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => void onTest()} disabled={testing}>
              <ShieldCheck className={`size-3.5 mr-1 ${testing ? "animate-pulse" : ""}`} />
              {testing ? "Testing…" : "Test Twilio"}
            </Button>
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={saving}
              className="bg-brand-primary text-primary-foreground hover:bg-brand-primary hover:brightness-110"
            >
              <Save className="size-3.5 mr-1" /> {saving ? "Saving…" : "Save all"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
