/**
 * Supabase ↔ zustand sync.
 *
 * On mount + auth state change:
 *  - Reads the current Supabase user, hydrates useDB.currentUserId/currentOrgId
 *    (org_id = user.id for now - single-tenant per user).
 *  - Loads the user's rows from every table into the zustand cache.
 *
 * Mutations write through to Supabase via the helpers exported below; each
 * page uses these instead of the pre-existing zustand mutation methods.
 */
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  useDB,
  type AIAgent,
  type Contact,
  type ContactList,
  type Campaign,
  type Call,
  type PhoneNumber,
  type Appointment,
  type Automation,
  type OrgSettings,
  type UUID,
} from "@/lib/data-store";

type Row = Record<string, unknown>;

function toAgent(r: Row): AIAgent {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    name: (r.name as string) ?? "",
    tts_engine: (r.tts_engine as AIAgent["tts_engine"]) ?? "kokoro",
    voice_id: (r.voice_id as string) ?? "af_bella",
    voice_name: (r.voice_name as string) ?? "",
    language: (r.language as string) ?? "en",
    greeting: (r.greeting as string) ?? "",
    system_prompt: (r.system_prompt as string) ?? "",
    prompt: (r.prompt as string) ?? "",
    business_knowledge: (r.business_knowledge as string) ?? "",
    personality: (r.personality as string) ?? "",
    temperature: Number(r.temperature ?? 0.6),
    objective: (r.objective as string) ?? "",
    qualification_questions: (r.qualification_questions as string[]) ?? [],
    transfer_number: (r.transfer_number as string) ?? "",
    voicemail_handling: (r.voicemail_handling as AIAgent["voicemail_handling"]) ?? "leave_message",
    voicemail_message: (r.voicemail_message as string) ?? "",
    end_call_conditions: (r.end_call_conditions as string[]) ?? [],
    max_retries: Number(r.max_retries ?? 3),
    retry_delay_minutes: Number(r.retry_delay_minutes ?? 60),
    data_fields: Array.isArray(r.data_fields) ? (r.data_fields as AIAgent["data_fields"]) : [],
    speak_first: (r as { speak_first?: boolean }).speak_first ?? true,
    playbook: (r as { playbook?: string | null }).playbook ?? null,
    playbook_calls_analyzed: Number((r as { playbook_calls_analyzed?: number }).playbook_calls_analyzed ?? 0),
    playbook_updated_at: (r as { playbook_updated_at?: string | null }).playbook_updated_at ?? null,
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  };
}

function toContact(r: Row): Contact {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    list_id: (r.list_id as UUID | null) ?? null,
    name: (r.name as string) ?? "",
    company: (r.company as string) ?? "",
    phone: (r.phone as string) ?? "",
    email: (r.email as string) ?? "",
    custom_vars: (r.custom_vars as Record<string, string>) ?? {},
    tags: (r.tags as string[]) ?? [],
    notes: (r.notes as string) ?? "",
    status: (r.status as Contact["status"]) ?? "new",
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  };
}

function toList(r: Row): ContactList {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    name: (r.name as string) ?? "",
    description: (r.description as string) ?? "",
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  };
}

function toPhone(r: Row): PhoneNumber {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    number: (r.number as string) ?? "",
    twilio_sid: (r.twilio_sid as string) ?? "",
    type: (r.type as PhoneNumber["type"]) ?? "local",
    capabilities: (r.capabilities as PhoneNumber["capabilities"]) ?? ["voice"],
    inbound_agent_id: (r.inbound_agent_id as UUID | null) ?? null,
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  };
}


function toCampaign(r: Row): Campaign {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    name: (r.name as string) ?? "",
    agent_id: (r.agent_id as UUID | null) ?? null,
    list_id: (r.list_id as UUID | null) ?? null,
    phone_number_id: (r.phone_number_id as UUID | null) ?? null,
    timezone: (r.timezone as string) ?? "UTC",
    calling_hours: (r.calling_hours as Campaign["calling_hours"]) ?? {
      start: "09:00",
      end: "18:00",
      days: [1, 2, 3, 4, 5],
    },
    calls_per_minute: Number(r.calls_per_minute ?? 6),
    retry_rules: (r.retry_rules as Campaign["retry_rules"]) ?? {
      max_attempts: 3,
      gap_minutes: 60,
    },
    voicemail_rules: (r.voicemail_rules as Campaign["voicemail_rules"]) ?? { action: "leave" },
    status: (r.status as Campaign["status"]) ?? "draft",
    created_by: r.user_id as UUID,
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  };
}

function normalizeTranscript(v: unknown): Call["transcript"] {
  if (!Array.isArray(v)) return [];
  const out: Call["transcript"] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text : typeof r.content === "string" ? r.content : "";
    if (!text) continue;
    const roleOrSpeaker = (r.speaker ?? r.role) as string | undefined;
    const speaker: "ai" | "human" =
      roleOrSpeaker === "ai" || roleOrSpeaker === "assistant" ? "ai" : "human";
    const at = typeof r.at === "number" ? r.at : Date.now();
    out.push({ speaker, text, at });
  }
  return out;
}

function toCall(r: Row): Call {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    campaign_id: (r.campaign_id as UUID | null) ?? null,
    contact_id: (r.contact_id as UUID | null) ?? null,
    agent_id: (r.agent_id as UUID | null) ?? null,
    phone_to: (r.phone_to as string) ?? "",
    phone_from: (r.phone_from as string) ?? "",
    twilio_call_sid: (r.twilio_call_sid as string) ?? "",
    started_at: (r.started_at as string) ?? new Date().toISOString(),
    ended_at: (r.ended_at as string | null) ?? null,
    duration_sec: Number(r.duration_sec ?? 0),
    status: (r.status as Call["status"]) ?? "queued",
    outcome: (r.outcome as string) ?? "",
    recording_url: (r.recording_url as string | null) ?? null,
    transcript: normalizeTranscript(r.transcript),
    summary: (r.summary as string) ?? "",
    sentiment: (r.sentiment as Call["sentiment"]) ?? null,
    cost_cents: Number(r.cost_cents ?? 0),
    ai_minutes: Number(r.ai_minutes ?? 0),
    appointment_booked: Boolean(r.appointment_booked),
    end_reason: (r.end_reason as string | null) ?? null,
    extracted_data:
      r.extracted_data && typeof r.extracted_data === "object" && !Array.isArray(r.extracted_data)
        ? (r.extracted_data as Call["extracted_data"])
        : {},
  };
}

function toAppointment(r: Row): Appointment {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    call_id: r.call_id as UUID,
    contact_name: (r.contact_name as string) ?? "",
    contact_phone: (r.contact_phone as string) ?? "",
    scheduled_at: (r.scheduled_at as string) ?? new Date().toISOString(),
    status: (r.status as Appointment["status"]) ?? "scheduled",
    notes: (r.notes as string) ?? "",
  };
}

function toAutomation(r: Row): Automation {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    name: (r.name as string) ?? "",
    trigger: (r.trigger as Automation["trigger"]) ?? "call_completed",
    action: (r.action as Automation["action"]) ?? "webhook",
    config: (r.config as Record<string, string>) ?? {},
    enabled: Boolean(r.enabled),
  };
}

async function fetchAllContacts(userId: UUID): Promise<Row[]> {
  const pageSize = 1000;
  const all: Row[] = [];
  let from = 0;
  // PostgREST caps a single request at 1000 rows; page until exhausted.
  for (let i = 0; i < 1000; i++) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id,user_id,list_id,name,company,phone,email,custom_vars,tags,notes,status,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchAllCalls(userId: UUID): Promise<Row[]> {
  const pageSize = 1000;
  const all: Row[] = [];
  let from = 0;
  // Campaign reporting must include every call; a fixed 500-row cap makes
  // larger campaigns appear stuck even while calls continue in the database.
  for (let i = 0; i < 1000; i++) {
    const { data, error } = await supabase
      .from("calls")
      .select("*")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function loadAll(userId: UUID) {
  const previous = useDB.getState();
  const keepContacts = previous.currentUserId === userId;

  const [agents, lists, phones, campaigns, calls, appts, autos, settingsRow] = await Promise.all([
    supabase.from("agents").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("contact_lists").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("phone_numbers").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("campaigns").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    fetchAllCalls(userId),
    supabase.from("appointments").select("*").eq("user_id", userId).order("scheduled_at", { ascending: true }),
    supabase.from("automations").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("org_settings").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  const settings: OrgSettings = {
    org_id: userId,
    time_zone: (settingsRow.data?.time_zone as string) ?? "UTC",
    webhook_url: (settingsRow.data?.webhook_url as string) ?? "",
    smtp_host: (settingsRow.data?.smtp_host as string) ?? "",
    smtp_user: (settingsRow.data?.smtp_user as string) ?? "",
    smtp_port: Number(settingsRow.data?.smtp_port ?? 587),
    has_twilio: Boolean(settingsRow.data?.has_twilio ?? false),
    has_elevenlabs: Boolean(settingsRow.data?.has_elevenlabs ?? false),
    has_openai: Boolean(settingsRow.data?.has_openai ?? false),
    learning_enabled: Boolean(
      (settingsRow.data as { learning_enabled?: boolean } | null)?.learning_enabled ?? false,
    ),

  };

  useDB.setState({
    currentUserId: userId,
    currentOrgId: userId,
    agents: (agents.data ?? []).map(toAgent),
    lists: (lists.data ?? []).map(toList),
    contacts: keepContacts ? previous.contacts : [],
    contactsHydrated: keepContacts ? previous.contactsHydrated : false,
    contactsLoading: false,
    phones: (phones.data ?? []).map(toPhone),
    campaigns: (campaigns.data ?? []).map(toCampaign),
    calls: calls.map(toCall),
    appointments: (appts.data ?? []).map(toAppointment),
    automations: (autos.data ?? []).map(toAutomation),
    settings: [settings],
    hydrated: true,
  });
}

export async function loadContactsForCurrentUser({ force = false }: { force?: boolean } = {}) {
  const state = useDB.getState();
  let userId = state.currentUserId;

  if (!userId) {
    const { data } = await supabase.auth.getSession();
    userId = (data.session?.user?.id as UUID | undefined) ?? "";
  }

  if (!userId) return;

  const latest = useDB.getState();
  if (!force && latest.contactsHydrated) return;
  if (latest.contactsLoading) return;

  useDB.setState({ contactsLoading: true });
  try {
    const contacts = (await fetchAllContacts(userId)).map(toContact);
    useDB.setState({
      currentUserId: userId,
      currentOrgId: userId,
      contacts,
      contactsHydrated: true,
      contactsLoading: false,
    });
  } catch (error) {
    useDB.setState({ contactsLoading: false });
    throw error;
  }
}

export function useSupabaseSync() {
  useEffect(() => {
    let cancelled = false;
    let realtimeCleanup: (() => void) | null = null;

    function subscribeRealtime(userId: UUID) {
      const channel = supabase
        .channel(`db-changes-${userId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "calls", filter: `user_id=eq.${userId}` },
          (payload) => {
            useDB.setState((s) => {
              if (payload.eventType === "DELETE") {
                const id = (payload.old as { id?: string })?.id;
                return { calls: s.calls.filter((c) => c.id !== id) };
              }
              const row = toCall(payload.new as Row);
              const idx = s.calls.findIndex((c) => c.id === row.id);
              if (idx === -1) return { calls: [row, ...s.calls] };
              const next = s.calls.slice();
              next[idx] = row;
              return { calls: next };
            });
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "campaigns", filter: `user_id=eq.${userId}` },
          (payload) => {
            useDB.setState((s) => {
              if (payload.eventType === "DELETE") {
                const id = (payload.old as { id?: string })?.id;
                return { campaigns: s.campaigns.filter((c) => c.id !== id) };
              }
              const row = toCampaign(payload.new as Row);
              const idx = s.campaigns.findIndex((c) => c.id === row.id);
              if (idx === -1) return { campaigns: [row, ...s.campaigns] };
              const next = s.campaigns.slice();
              next[idx] = row;
              return { campaigns: next };
            });
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "appointments", filter: `user_id=eq.${userId}` },
          (payload) => {
            useDB.setState((s) => {
              if (payload.eventType === "DELETE") {
                const id = (payload.old as { id?: string })?.id;
                return { appointments: s.appointments.filter((a) => a.id !== id) };
              }
              const row = toAppointment(payload.new as Row);
              const idx = s.appointments.findIndex((a) => a.id === row.id);
              if (idx === -1) return { appointments: [row, ...s.appointments] };
              const next = s.appointments.slice();
              next[idx] = row;
              return { appointments: next };
            });
          },
        )
        .subscribe();
      return () => {
        void supabase.removeChannel(channel);
      };
    }

    async function hydrate() {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const user = data.session?.user;
      if (!user) return;
      await loadAll(user.id as UUID);
      if (cancelled) return;
      realtimeCleanup = subscribeRealtime(user.id as UUID);
    }
    void hydrate();
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === "SIGNED_OUT") {
        realtimeCleanup?.();
        realtimeCleanup = null;
        useDB.setState({
          currentUserId: "" as UUID,
          currentOrgId: "" as UUID,
          agents: [],
          contacts: [],
          lists: [],
          phones: [],
          campaigns: [],
          calls: [],
          appointments: [],
          automations: [],
          settings: [],
          contactsHydrated: false,
          contactsLoading: false,
          hydrated: false,
        });
        return;
      }
      if (event === "SIGNED_IN" && session?.user) {
        void loadAll(session.user.id as UUID).then(() => {
          if (!cancelled && !realtimeCleanup) {
            realtimeCleanup = subscribeRealtime(session.user.id as UUID);
          }
        });
      }
    });
    return () => {
      cancelled = true;
      realtimeCleanup?.();
      sub.subscription.unsubscribe();
    };
  }, []);
}


// -------- write-through helpers used by pages ----------

export async function persistAgent(a: AIAgent) {
  await supabase.from("agents").upsert({
    id: a.id,
    user_id: a.org_id,
    name: a.name,
    voice_id: a.voice_id,
    voice_name: a.voice_name,
    language: a.language,
    greeting: a.greeting,
    system_prompt: a.system_prompt,
    prompt: a.prompt,
    business_knowledge: a.business_knowledge,
    personality: a.personality,
    temperature: a.temperature,
    objective: a.objective,
    qualification_questions: a.qualification_questions,
    transfer_number: a.transfer_number,
    voicemail_handling: a.voicemail_handling,
    voicemail_message: a.voicemail_message,
    end_call_conditions: a.end_call_conditions,
    max_retries: a.max_retries,
    retry_delay_minutes: a.retry_delay_minutes,
    playbook: a.playbook ?? null,
  });
}

export async function deleteAgentDb(id: UUID) {
  await supabase.from("agents").delete().eq("id", id);
}

export async function persistList(l: ContactList) {
  await supabase.from("contact_lists").upsert({
    id: l.id,
    user_id: l.org_id,
    name: l.name,
    description: l.description,
  });
}

export async function persistContacts(cs: Contact[]) {
  if (cs.length === 0) return;
  await supabase.from("contacts").upsert(
    cs.map((c) => ({
      id: c.id,
      user_id: c.org_id,
      list_id: c.list_id,
      name: c.name,
      company: c.company,
      phone: c.phone,
      email: c.email,
      custom_vars: c.custom_vars,
      tags: c.tags,
      notes: c.notes,
      status: c.status,
    })),
  );
}

export async function deleteContactsDb(ids: UUID[]) {
  if (ids.length === 0) return;
  await supabase.from("contacts").delete().in("id", ids);
}

export async function persistPhone(p: PhoneNumber) {
  await supabase.from("phone_numbers").upsert({
    id: p.id,
    user_id: p.org_id,
    number: p.number,
    twilio_sid: p.twilio_sid,
    type: p.type,
    capabilities: p.capabilities,
    inbound_agent_id: p.inbound_agent_id,
  } as never);
}


export async function deletePhoneDb(id: UUID) {
  await supabase.from("phone_numbers").delete().eq("id", id);
}

export async function persistCampaign(c: Campaign) {
  await supabase.from("campaigns").upsert({
    id: c.id,
    user_id: c.org_id,
    name: c.name,
    agent_id: c.agent_id,
    list_id: c.list_id,
    phone_number_id: c.phone_number_id,
    timezone: c.timezone,
    calling_hours: c.calling_hours,
    calls_per_minute: c.calls_per_minute,
    retry_rules: c.retry_rules,
    voicemail_rules: c.voicemail_rules,
    status: c.status,
  });
}

export async function persistAutomation(a: Automation) {
  await supabase.from("automations").upsert({
    id: a.id,
    user_id: a.org_id,
    name: a.name,
    trigger: a.trigger,
    action: a.action,
    config: a.config,
    enabled: a.enabled,
  });
}

export async function deleteAutomationDb(id: UUID) {
  await supabase.from("automations").delete().eq("id", id);
}

export async function persistSettings(s: OrgSettings) {
  await supabase.from("org_settings").upsert({
    user_id: s.org_id,
    time_zone: s.time_zone,
    webhook_url: s.webhook_url,
    smtp_host: s.smtp_host,
    smtp_user: s.smtp_user,
    smtp_port: s.smtp_port,
  });
}
