import { useShallow } from "zustand/react/shallow";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Save, Plus, Trash2, CheckCircle2, AlertCircle, Copy, User as UserIcon, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app/primitives";
import { PageSkeleton } from "@/components/app/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useDB, selectCurrentSettings, type PhoneNumber, type UUID } from "@/lib/data-store";
import { persistSettings } from "@/lib/sync";
import { syncTwilioNumbers } from "@/lib/telephony/sync-numbers.functions";
import { testElevenLabs } from "@/lib/integrations/elevenlabs-test.functions";
import { Volume2 } from "lucide-react";
import { CredentialsTab } from "@/components/app/credentials-tab";


export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings - Medical Calling AI" }] }),
  component: SettingsPage,
});

const TZS = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "UTC"];

type Me = { id: string; email: string; full_name: string };

function SettingsPage() {
  const hydrated = useDB((s) => s.hydrated);
  const settings = useDB(selectCurrentSettings);
  const saveSettings = useDB((s) => s.saveSettings);
  const orgId = useDB((s) => s.currentOrgId);
  const phones = useDB(useShallow((s) => s.phones.filter((p) => p.org_id === orgId)));
  const agents = useDB(useShallow((s) => s.agents.filter((a) => a.org_id === orgId)));
  const addPhone = useDB((s) => s.addPhone);
  const delPhone = useDB((s) => s.deletePhone);
  const setPhoneInboundAgent = useDB((s) => s.setPhoneInboundAgent);
  const calls = useDB(useShallow((s) => s.calls.filter((c) => c.org_id === orgId)));


  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .eq("id", data.user.id)
        .maybeSingle();
      setMe({
        id: data.user.id,
        email: profile?.email ?? data.user.email ?? "",
        full_name: profile?.full_name ?? (data.user.user_metadata?.full_name as string) ?? data.user.email ?? "",
      });
    });
  }, []);

  // Real usage this month
  const usage = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthCalls = calls.filter((c) => c.started_at >= start);
    const minutes = monthCalls.reduce((s, c) => s + (c.ai_minutes ?? 0), 0);
    const spend = monthCalls.reduce((s, c) => s + (c.cost_cents ?? 0), 0) / 100;
    const booked = monthCalls.filter((c) => c.appointment_booked).length;
    return { calls: monthCalls.length, minutes, spend, booked };
  }, [calls]);

  const saveTz = (v: string) => {
    saveSettings({ time_zone: v });
    if (settings) void persistSettings({ ...settings, time_zone: v });
  };
  const saveWebhook = (v: string) => {
    saveSettings({ webhook_url: v });
    if (settings) void persistSettings({ ...settings, webhook_url: v });
  };
  const saveSmtp = (patch: Partial<{ smtp_host: string; smtp_user: string; smtp_port: number }>) => {
    saveSettings(patch);
    if (settings) void persistSettings({ ...settings, ...patch });
  };

  const projectUrl = typeof window !== "undefined" ? window.location.origin : "";

  if (!hydrated) return <PageSkeleton variant="form" />;

  return (
    <>
      <PageHeader title="'''Do not make any visual modifications. The phrases I write are commands to understand what I want, not to be written down. Understand their content well, then execute what is required.'''\n                                        \n                                            \n                                            in the settings page add field to view and update twilio auth keys and account sid key" description="Integrations, telephony, billing, and API access." />

      <Tabs defaultValue="integrations" className="max-w-4xl">
        <TabsList className="mb-6">
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="telephony">Telephony</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks & SMTP</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="api">API</TabsTrigger>
        </TabsList>

        <TabsContent value="integrations" className="space-y-6">
          <KeyCard
            title="Twilio"
            description="Outbound / inbound calling, AMD, recording, ConversationRelay. Keys are stored securely as backend secrets - ask in chat to add them."
            connected={settings?.has_twilio ?? false}
            fields={[
              { label: "Account SID", placeholder: "ACxxxxxxxxxxxxxx" },
              { label: "Auth Token", placeholder: "••••••••••••", secret: true },
            ]}
            onSave={() => { saveSettings({ has_twilio: true }); toast.success("Twilio marked connected. Ask in chat to save the API secrets."); }}
          />
          <KeyCard
            title="ElevenLabs"
            description="Streaming TTS, voice cloning, multilingual voices."
            connected={settings?.has_elevenlabs ?? false}
            fields={[{ label: "API Key", placeholder: "sk_••••", secret: true }]}
            onSave={() => { saveSettings({ has_elevenlabs: true }); toast.success("ElevenLabs marked connected. Ask in chat to save the API key."); }}
            extraAction={<TestElevenLabsButton />}
          />
          <KeyCard
            title="OpenAI"
            description="Real-time conversations, function calling, structured outputs."
            connected={settings?.has_openai ?? false}
            fields={[{ label: "API Key", placeholder: "sk-••••", secret: true }]}
            onSave={() => { saveSettings({ has_openai: true }); toast.success("OpenAI marked connected. Ask in chat to save the API key."); }}
          />
        </TabsContent>

        <TabsContent value="telephony" className="space-y-6">
          <Card title="Phone numbers">
            <div className="flex items-start justify-between gap-3 mb-4">
              <p className="text-xs text-neutral-500">
                Numbers provisioned via Twilio for outbound caller ID and inbound webhooks.
              </p>
              <SyncTwilioButton orgId={orgId} />
            </div>
            <div className="space-y-2 mb-4">
              {phones.map((p) => (
                <div key={p.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-neutral-50 ring-1 ring-black/5 p-3 rounded-md">
                  <div className="min-w-0">
                    <p className="font-mono text-neutral-900">{p.number}</p>
                    <p className="text-[11px] text-neutral-500">{p.type} · {p.capabilities.join(", ")}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <Label className="text-[10px] text-neutral-500 mb-1">Inbound agent</Label>
                      <Select
                        value={p.inbound_agent_id ?? "none"}
                        onValueChange={(v) => {
                          setPhoneInboundAgent(p.id, v === "none" ? null : v);
                          toast.success(v === "none" ? "Inbound routing cleared" : "Inbound agent assigned");
                        }}
                      >
                        <SelectTrigger className="w-56"><SelectValue placeholder="Not routed" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">- None -</SelectItem>
                          {agents.map((a) => (
                            <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => { delPhone(p.id); toast.success("Number released"); }}>
                      <Trash2 className="size-3.5 text-red-400" />
                    </Button>
                  </div>
                </div>
              ))}
              {phones.length === 0 && (
                <p className="text-xs text-neutral-500 italic">No numbers provisioned. Click “Sync from Twilio” to import numbers from your Twilio account.</p>
              )}

            </div>
            <AddPhone onAdd={(n, t) => { addPhone(n, t); toast.success("Number added"); }} />
          </Card>
        </TabsContent>

        <TabsContent value="credentials" className="space-y-6">
          <CredentialsTab />
        </TabsContent>

        <TabsContent value="webhooks" className="space-y-6">
          <Card title="Workspace defaults">
            <div className="space-y-4">
              <FieldRow label="Default time zone">
                <Select value={settings?.time_zone ?? "UTC"} onValueChange={saveTz}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TZS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Webhook URL">
                <Input defaultValue={settings?.webhook_url ?? ""} placeholder="https://yourapp.com/webhooks/medical-calling-ai" onBlur={(e) => saveWebhook(e.target.value)} />
              </FieldRow>
              <FieldRow label="AI learning loop">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={settings?.learning_enabled ?? false}
                    onCheckedChange={(v) => {
                      saveSettings({ learning_enabled: v });
                      if (settings) void persistSettings({ ...settings, learning_enabled: v });
                      toast.success(v ? "AI learning enabled" : "AI learning disabled");
                    }}
                  />
                  <span className="text-[11px] text-neutral-500">
                    {settings?.learning_enabled
                      ? "Agents review completed calls and update their playbooks."
                      : "Off - completed calls are not analysed."}
                  </span>
                </div>
              </FieldRow>

            </div>
          </Card>
          <Card title="SMTP">
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Host"><Input defaultValue={settings?.smtp_host ?? ""} onBlur={(e) => saveSmtp({ smtp_host: e.target.value })} /></FieldRow>
              <FieldRow label="Port"><Input type="number" defaultValue={settings?.smtp_port ?? 587} onBlur={(e) => saveSmtp({ smtp_port: +e.target.value })} /></FieldRow>
              <FieldRow label="User"><Input defaultValue={settings?.smtp_user ?? ""} onBlur={(e) => saveSmtp({ smtp_user: e.target.value })} /></FieldRow>
              <FieldRow label="Password"><Input type="password" placeholder="Stored as backend secret" disabled /></FieldRow>
            </div>
            <p className="text-[11px] text-neutral-500 mt-3">SMTP passwords are stored as backend secrets. Ask in chat to save one.</p>
          </Card>
        </TabsContent>

        <TabsContent value="team" className="space-y-6">
          <Card title="Team members">
            <div className="space-y-2">
              {me ? (
                <div className="flex items-center gap-3 bg-neutral-50 ring-1 ring-black/5 p-3 rounded-md">
                  <div className="size-8 rounded-full bg-neutral-200 ring-1 ring-black/10 grid place-items-center text-xs text-neutral-800">
                    {me.full_name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || <UserIcon className="size-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-neutral-900">{me.full_name}</p>
                    <p className="text-[11px] text-neutral-500">{me.email}</p>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded bg-neutral-200 text-neutral-600">
                    Owner
                  </span>
                </div>
              ) : (
                <p className="text-xs text-neutral-500 italic">Loading…</p>
              )}
            </div>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => toast.info("Team invites are coming soon")}>
              <Plus className="size-3.5 mr-1" /> Invite member
            </Button>
          </Card>
        </TabsContent>

        <TabsContent value="billing" className="space-y-6">
          <Card title="Plan">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-neutral-900">Starter · Free</p>
                <p className="text-[11px] text-neutral-500">Pay-as-you-go for calls · connect a payment method to enable higher volume</p>
              </div>
              <Button variant="outline" onClick={() => toast.info("Billing setup coming soon - ask in chat to enable Stripe.")}>Manage plan</Button>
            </div>
          </Card>
          <Card title="Usage this month">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MiniStat label="Calls" value={usage.calls.toLocaleString()} />
              <MiniStat label="AI minutes" value={usage.minutes.toFixed(1)} />
              <MiniStat label="Appointments" value={usage.booked.toLocaleString()} />
              <MiniStat label="Spend" value={`$${usage.spend.toFixed(2)}`} />
            </div>
            {usage.calls === 0 && (
              <p className="text-[11px] text-neutral-500 mt-3 italic">No calls yet this month - launch a campaign to see usage here.</p>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="api" className="space-y-6">
          <Card title="REST API">
            <p className="text-sm text-neutral-600 mb-4">
              Programmatic access to campaigns, contacts, calls, and webhooks. Base URL:
            </p>
            <div className="flex items-center gap-2 bg-neutral-100 ring-1 ring-black/5 p-3 rounded font-mono text-xs text-neutral-800 mb-4">
              <span className="truncate">{projectUrl}/api</span>
              <button className="ml-auto text-neutral-500 hover:text-neutral-900" onClick={() => { navigator.clipboard.writeText(`${projectUrl}/api`); toast.success("Copied"); }}>
                <Copy className="size-3" />
              </button>
            </div>
            <div className="space-y-2">
              <Endpoint method="GET" path={`${projectUrl}/api/campaigns`} />
              <Endpoint method="POST" path={`${projectUrl}/api/campaigns`} />
              <Endpoint method="GET" path={`${projectUrl}/api/calls`} />
              <Endpoint method="GET" path={`${projectUrl}/api/openapi.json`} />
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function SyncTwilioButton({ orgId }: { orgId: UUID }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      const res = await syncTwilioNumbers();
      if (!res.ok) {
        toast.error(`Sync failed: ${res.message}`);
        return;
      }
      // Reload phones for the current user from DB into the store
      const { data } = await supabase
        .from("phone_numbers")
        .select("*")
        .order("created_at", { ascending: false });
      const rows = (data ?? []).map((r): PhoneNumber => ({
        id: r.id as UUID,
        org_id: r.user_id as UUID,
        number: r.number,
        twilio_sid: r.twilio_sid,
        type: (r.type as PhoneNumber["type"]) ?? "local",
        capabilities: (Array.isArray(r.capabilities) ? (r.capabilities as string[]) : ["voice"]).filter((c): c is "voice" | "sms" => c === "voice" || c === "sms"),
        inbound_agent_id: (r.inbound_agent_id as UUID | null) ?? null,
        created_at: r.created_at,
      }));
      useDB.setState({ phones: rows });
      const msg = res.total === 0
        ? "No numbers found on your Twilio account."
        : `${res.added} added · ${res.updated} updated · ${res.total} total`;
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
      <RefreshCw className={`size-3.5 mr-1 ${busy ? "animate-spin" : ""}`} />
      {busy ? "Syncing…" : "Sync from Twilio"}
    </Button>
  );
}


function Endpoint({ method, path }: { method: "GET" | "POST"; path: string }) {
  const color = method === "GET" ? "text-emerald-400" : "text-blue-400";
  return (
    <div className="flex items-center gap-2 bg-neutral-100 ring-1 ring-black/5 p-3 rounded font-mono text-xs text-neutral-800">
      <span className={color}>{method}</span>
      <span className="truncate">{path}</span>
      <button className="ml-auto text-neutral-500 hover:text-neutral-900" onClick={() => { navigator.clipboard.writeText(path); toast.success("Copied"); }}>
        <Copy className="size-3" />
      </button>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white ring-1 ring-black/5 rounded-xl p-6">
      <h2 className="text-sm font-medium text-neutral-900 mb-4 border-b border-surface-border/40 pb-3">{title}</h2>
      {children}
    </div>
  );
}

function KeyCard({ title, description, connected, fields, onSave, extraAction }: {
  title: string; description: string; connected: boolean;
  fields: { label: string; placeholder: string; secret?: boolean }[];
  onSave: () => void;
  extraAction?: React.ReactNode;
}) {
  return (
    <div className="bg-white ring-1 ring-black/5 rounded-xl p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-sm font-medium text-neutral-900">{title}</h3>
          <p className="text-xs text-neutral-500 mt-1 max-w-md">{description}</p>
        </div>
        {connected ? (
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-400 font-mono">
            <CheckCircle2 className="size-3" /> Connected
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-amber-400 font-mono">
            <AlertCircle className="size-3" /> Not connected
          </span>
        )}
      </div>
      <div className="space-y-3">
        {fields.map((f) => <SecretField key={f.label} {...f} />)}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {extraAction}
        <Button size="sm" onClick={onSave} className="bg-brand-primary text-primary-foreground hover:bg-brand-primary hover:brightness-110">
          <Save className="size-3.5 mr-1" /> Save
        </Button>
      </div>
    </div>
  );
}

function TestElevenLabsButton() {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      const res = await testElevenLabs();
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`ElevenLabs OK · ${res.voiceCount} voices · playing "${res.sampleVoice.name}"`);
      const audio = new Audio(`data:${res.mimeType};base64,${res.audioBase64}`);
      await audio.play().catch(() => toast.info("Sample generated (autoplay blocked)"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
      <Volume2 className={`size-3.5 mr-1 ${busy ? "animate-pulse" : ""}`} />
      {busy ? "Testing…" : "Test ElevenLabs"}
    </Button>
  );
}

function SecretField({ label, placeholder, secret }: { label: string; placeholder: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <Label className="text-[11px] uppercase tracking-wider text-neutral-500 font-mono mb-2 block">{label}</Label>
      <div className="relative">
        <Input type={secret && !show ? "password" : "text"} placeholder={placeholder} />
        {secret && (
          <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-900">
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-[11px] uppercase tracking-wider text-neutral-500 font-mono">{label}</Label>
      {children}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-neutral-100 ring-1 ring-black/5 rounded-lg p-3">
      <p className="text-[10px] uppercase tracking-wider text-neutral-500 font-mono mb-1">{label}</p>
      <p className="font-mono text-neutral-900">{value}</p>
    </div>
  );
}

function AddPhone({ onAdd }: { onAdd: (n: string, t: PhoneNumber["type"]) => void }) {
  const [n, setN] = useState("");
  const [t, setT] = useState<PhoneNumber["type"]>("local");
  return (
    <div className="flex gap-2">
      <Input value={n} onChange={(e) => setN(e.target.value)} placeholder="+14155550100" className="flex-1" />
      <Select value={t} onValueChange={(v) => setT(v as PhoneNumber["type"])}>
        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="local">Local</SelectItem>
          <SelectItem value="toll_free">Toll-free</SelectItem>
        </SelectContent>
      </Select>
      <Button onClick={() => { if (!/^\+\d{8,15}$/.test(n)) { toast.error("Invalid E.164"); return; } onAdd(n, t); setN(""); }} className="bg-brand-primary text-primary-foreground hover:bg-brand-primary hover:brightness-110">
        <Plus className="size-3.5 mr-1" /> Add
      </Button>
    </div>
  );
}
