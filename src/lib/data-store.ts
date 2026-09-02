/**
 * Client-side data cache backed by Supabase.
 *
 * The store hydrates from Supabase on auth (see src/lib/sync.ts) and every
 * mutation below fires a write-through to the corresponding table. The
 * zustand persist middleware keeps a per-browser cache for instant paints.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { supabase } from "@/integrations/supabase/client";

// Fire-and-forget DB write. Errors log to console - UI stays responsive.
function dbWrite(p: PromiseLike<unknown>) {
  Promise.resolve(p).then((r) => {
    const err = (r as { error?: { message?: string } })?.error;
    if (err) console.error("[data-store] write failed:", err);
  });
}

const CONTACT_IMPORT_BATCH_SIZE = 500;



export type UUID = string;
export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2) + Date.now().toString(36)) as UUID;

export type AppRole = "owner" | "admin" | "member";

export type User = {
  id: UUID;
  email: string;
  full_name: string;
  avatar_url?: string;
  created_at: string;
};

export type Organization = {
  id: UUID;
  name: string;
  slug: string;
  created_by: UUID;
  created_at: string;
};

export type OrgMember = {
  org_id: UUID;
  user_id: UUID;
  role: AppRole;
  joined_at: string;
};

export type ContactList = {
  id: UUID;
  org_id: UUID;
  name: string;
  description: string;
  created_at: string;
};

export type Contact = {
  id: UUID;
  org_id: UUID;
  list_id: UUID | null;
  name: string;
  company: string;
  phone: string;
  email: string;
  custom_vars: Record<string, string>;
  tags: string[];
  notes: string;
  status: "new" | "called" | "completed" | "dnc";
  created_at: string;
};

type ContactDraft = Omit<Contact, "id" | "org_id" | "created_at">;

export type ContactImportResult = {
  listId: UUID;
  inserted: number;
  duplicates: number;
  failed: number;
  errors: string[];
};

function toContactFromDb(r: Record<string, unknown>): Contact {
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

function toListFromDb(r: Record<string, unknown>): ContactList {
  return {
    id: r.id as UUID,
    org_id: r.user_id as UUID,
    name: (r.name as string) ?? "",
    description: (r.description as string) ?? "",
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  };
}

async function requireCurrentUserId(setState: (state: Partial<DBState>) => void, getState: () => DBState) {
  const existing = getState().currentOrgId || getState().currentUserId;
  if (existing) return existing;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Sign in before saving contacts.");
  setState({ currentUserId: data.user.id, currentOrgId: data.user.id });
  return data.user.id;
}

export type DataFieldType = "text" | "email" | "phone" | "number" | "date" | "boolean";

export type DataField = {
  key: string;
  label: string;
  type: DataFieldType;
  required: boolean;
};

export type AIAgent = {
  id: UUID;
  org_id: UUID;
  name: string;
  /** TTS engine key - resolved via src/lib/voice/tts/registry.ts. */
  tts_engine: "kokoro" | "elevenlabs";
  voice_id: string;
  voice_name: string;
  language: string;
  greeting: string;
  system_prompt: string;
  prompt: string;
  business_knowledge: string;
  personality: string;
  temperature: number;
  objective: string;
  qualification_questions: string[];
  transfer_number: string;
  voicemail_handling: "leave_message" | "hangup" | "retry";
  voicemail_message: string;
  end_call_conditions: string[];
  max_retries: number;
  retry_delay_minutes: number;
  data_fields: DataField[];
  /** ElevenLabs voice tuning - falls back to sensible defaults when null. */
  voice_stability?: number | null;
  voice_similarity_boost?: number | null;
  voice_style?: number | null;
  voice_speaker_boost?: boolean | null;
  /** If false, the agent waits for the caller to speak first instead of greeting. */
  speak_first?: boolean;
  /** Auto-updated playbook of learnings from past calls. Injected into every future call's system prompt. */
  playbook?: string | null;
  playbook_calls_analyzed?: number;
  playbook_updated_at?: string | null;
  created_at: string;
};

export type PhoneNumber = {
  id: UUID;
  org_id: UUID;
  number: string;
  twilio_sid: string;
  type: "local" | "toll_free";
  capabilities: ("voice" | "sms")[];
  inbound_agent_id: UUID | null;
  created_at: string;
};


export type CampaignStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "stopped";

export type Campaign = {
  id: UUID;
  org_id: UUID;
  name: string;
  agent_id: UUID | null;
  list_id: UUID | null;
  phone_number_id: UUID | null;
  timezone: string;
  calling_hours: { start: string; end: string; days: number[] };
  calls_per_minute: number;
  retry_rules: { max_attempts: number; gap_minutes: number };
  voicemail_rules: { action: "leave" | "skip" | "retry" };
  status: CampaignStatus;
  created_by: UUID;
  created_at: string;
};

export type CallStatus =
  | "queued"
  | "dialing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "voicemail";

export type Call = {
  id: UUID;
  org_id: UUID;
  campaign_id: UUID | null;
  contact_id: UUID | null;
  agent_id: UUID | null;
  phone_to: string;
  phone_from: string;
  twilio_call_sid: string;
  started_at: string;
  ended_at: string | null;
  duration_sec: number;
  status: CallStatus;
  outcome: string;
  recording_url: string | null;
  transcript: { speaker: "ai" | "human"; text: string; at: number }[];
  summary: string;
  sentiment: "positive" | "neutral" | "negative" | null;
  cost_cents: number;
  ai_minutes: number;
  appointment_booked: boolean;
  end_reason: string | null;
  extracted_data: Record<string, string | number | boolean | null>;
};

export type Appointment = {
  id: UUID;
  org_id: UUID;
  call_id: UUID;
  contact_name: string;
  contact_phone: string;
  scheduled_at: string;
  status: "scheduled" | "confirmed" | "cancelled";
  notes: string;
};

export type Automation = {
  id: UUID;
  org_id: UUID;
  name: string;
  trigger: "call_completed" | "appointment_booked" | "call_failed";
  action: "send_sms" | "send_email" | "webhook" | "google_sheets";
  config: Record<string, string>;
  enabled: boolean;
};

export type OrgSettings = {
  org_id: UUID;
  time_zone: string;
  webhook_url: string;
  smtp_host: string;
  smtp_user: string;
  smtp_port: number;
  has_twilio: boolean;
  has_elevenlabs: boolean;
  has_openai: boolean;
};

// ============================================================
// Empty initial state - no demo data. Real data is loaded from
// Supabase after auth via the sync layer in src/lib/sync.ts.
// ============================================================

function buildSeed() {
  return {
    users: [] as User[],
    organizations: [] as Organization[],
    members: [] as OrgMember[],
    lists: [] as ContactList[],
    contacts: [] as Contact[],
    agents: [] as AIAgent[],
    phones: [] as PhoneNumber[],
    campaigns: [] as Campaign[],
    calls: [] as Call[],
    appointments: [] as Appointment[],
    automations: [] as Automation[],
    settings: [] as OrgSettings[],
    contactsHydrated: false,
    contactsLoading: false,
    currentUserId: "" as UUID,
    currentOrgId: "" as UUID,
    hydrated: false,
  };
}


type DBState = ReturnType<typeof buildSeed> & {
  reset: () => void;
  switchOrg: (orgId: UUID) => void;
  // mutations
  createOrg: (name: string) => Organization;
  addAgent: (agent: Omit<AIAgent, "id" | "org_id" | "created_at">) => AIAgent;
  updateAgent: (id: UUID, patch: Partial<AIAgent>) => void;
  deleteAgent: (id: UUID) => void;
  addList: (name: string, description: string) => ContactList;
  createList: (name: string, description: string) => Promise<ContactList>;
  deleteList: (id: UUID) => Promise<void>;
  addContact: (c: ContactDraft) => Contact;
  addContactsBulk: (cs: ContactDraft[]) => number;
  importContacts: (cs: ContactDraft[], listId: UUID) => Promise<ContactImportResult>;
  deleteContacts: (ids: UUID[]) => void;
  addCampaign: (c: Omit<Campaign, "id" | "org_id" | "created_by" | "created_at" | "status">) => Campaign;
  setCampaignStatus: (id: UUID, status: CampaignStatus) => void;
  updateCampaign: (id: UUID, patch: Partial<Campaign>) => void;
  duplicateCampaign: (id: UUID) => void;
  addPhone: (number: string, type: PhoneNumber["type"]) => PhoneNumber;
  deletePhone: (id: UUID) => void;
  setPhoneInboundAgent: (id: UUID, agentId: UUID | null) => void;

  saveSettings: (patch: Partial<OrgSettings>) => void;
  addAutomation: (a: Omit<Automation, "id" | "org_id">) => Automation;
  toggleAutomation: (id: UUID) => void;
  deleteAutomation: (id: UUID) => void;
};

export const useDB = create<DBState>()(
  persist(
    (set, get) => ({
      ...buildSeed(),
      reset: () => set(buildSeed()),
      switchOrg: (orgId) => set({ currentOrgId: orgId }),

      createOrg: (name) => {
        const org: Organization = {
          id: uid(),
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          created_by: get().currentUserId,
          created_at: new Date().toISOString(),
        };
        set((s) => ({
          organizations: [...s.organizations, org],
          members: [
            ...s.members,
            { org_id: org.id, user_id: s.currentUserId, role: "owner", joined_at: org.created_at },
          ],
          settings: [
            ...s.settings,
            {
              org_id: org.id,
              time_zone: "America/Los_Angeles",
              webhook_url: "",
              smtp_host: "",
              smtp_user: "",
              smtp_port: 587,
              has_twilio: false,
              has_elevenlabs: false,
              has_openai: false,
            },
          ],
          currentOrgId: org.id,
        }));
        return org;
      },

      addAgent: (a) => {
        const agent: AIAgent = {
          ...a,
          id: uid(),
          org_id: get().currentOrgId,
          created_at: new Date().toISOString(),
        };
        set((s) => ({ agents: [...s.agents, agent] }));
        dbWrite(
          supabase.from("agents").insert({
            id: agent.id,
            user_id: agent.org_id,
            name: agent.name,
            tts_engine: agent.tts_engine,
            voice_id: agent.voice_id,
            voice_name: agent.voice_name,
            language: agent.language,
            greeting: agent.greeting,
            system_prompt: agent.system_prompt,
            prompt: agent.prompt,
            business_knowledge: agent.business_knowledge,
            personality: agent.personality,
            temperature: agent.temperature,
            objective: agent.objective,
            qualification_questions: agent.qualification_questions,
            transfer_number: agent.transfer_number,
            voicemail_handling: agent.voicemail_handling,
            voicemail_message: agent.voicemail_message,
            end_call_conditions: agent.end_call_conditions,
            max_retries: agent.max_retries,
            retry_delay_minutes: agent.retry_delay_minutes,
            data_fields: agent.data_fields,
            voice_stability: agent.voice_stability ?? null,
            voice_similarity_boost: agent.voice_similarity_boost ?? null,
            voice_style: agent.voice_style ?? null,
            voice_speaker_boost: agent.voice_speaker_boost ?? null,
            speak_first: agent.speak_first ?? true,
          } as never),
        );
        return agent;
      },
      updateAgent: (id, patch) => {
        set((s) => ({
          agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        }));
        const dbPatch: Record<string, unknown> = { ...patch };
        delete dbPatch.id;
        delete dbPatch.org_id;
        delete dbPatch.created_at;
        dbWrite(supabase.from("agents").update(dbPatch as never).eq("id", id));
      },
      deleteAgent: (id) => {
        set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }));
        dbWrite(supabase.from("agents").delete().eq("id", id));
      },

      addList: (name, description) => {
        const list: ContactList = {
          id: uid(),
          org_id: get().currentOrgId,
          name,
          description,
          created_at: new Date().toISOString(),
        };
        set((s) => ({ lists: [...s.lists, list] }));
        dbWrite(
          supabase.from("contact_lists").insert({
            id: list.id,
            user_id: list.org_id,
            name: list.name,
            description: list.description,
          }),
        );
        return list;
      },
      createList: async (name, description) => {
        const orgId = await requireCurrentUserId(set, get);
        const id = uid();
        const { data, error } = await supabase
          .from("contact_lists")
          .insert({
            id,
            user_id: orgId,
            name,
            description,
          })
          .select("id,user_id,name,description,created_at")
          .single();
        if (error) throw new Error(error.message);
        const list = toListFromDb(data as Record<string, unknown>);
        set((s) => ({
          lists: s.lists.some((l) => l.id === list.id) ? s.lists : [...s.lists, list],
        }));
        return list;
      },
      addContact: (c) => {
        const contact: Contact = {
          ...c,
          id: uid(),
          org_id: get().currentOrgId,
          created_at: new Date().toISOString(),
        };
        set((s) => ({ contacts: [...s.contacts, contact] }));
        dbWrite(
          supabase.from("contacts").insert({
            id: contact.id,
            user_id: contact.org_id,
            list_id: contact.list_id,
            name: contact.name,
            company: contact.company,
            phone: contact.phone,
            email: contact.email,
            custom_vars: contact.custom_vars,
            tags: contact.tags,
            notes: contact.notes,
            status: contact.status,
          }),
        );
        return contact;
      },
      addContactsBulk: (cs) => {
        const orgId = get().currentOrgId;
        const existingPhones = new Set(
          get()
            .contacts.filter((c) => c.org_id === orgId)
            .map((c) => c.phone),
        );
        const fresh = cs.filter((c) => !existingPhones.has(c.phone));
        const now = new Date().toISOString();
        const made: Contact[] = fresh.map((c) => ({
          ...c,
          id: uid(),
          org_id: orgId,
          created_at: now,
        }));
        set((s) => ({ contacts: [...s.contacts, ...made] }));
        if (made.length > 0) {
          dbWrite(
            supabase.from("contacts").insert(
              made.map((m) => ({
                id: m.id,
                user_id: m.org_id,
                list_id: m.list_id,
                name: m.name,
                company: m.company,
                phone: m.phone,
                email: m.email,
                custom_vars: m.custom_vars,
                tags: m.tags,
                notes: m.notes,
                status: m.status,
              })),
            ),
          );
        }
        return made.length;
      },
      importContacts: async (cs, listId) => {
        const orgId = await requireCurrentUserId(set, get);
        if (!listId) throw new Error("Choose a contact list before importing.");

        const { data: existingRows, error: existingError } = await supabase
          .from("contacts")
          .select("phone")
          .eq("user_id", orgId)
          .eq("list_id", listId);
        if (existingError) throw new Error(existingError.message);

        const existingPhones = new Set(
          (existingRows ?? [])
            .map((r) => (r.phone as string | null)?.trim())
            .filter(Boolean) as string[],
        );
        const seenPhones = new Set(existingPhones);
        const fresh: ContactDraft[] = [];
        let duplicates = 0;

        for (const c of cs) {
          const phone = c.phone.trim();
          if (seenPhones.has(phone)) {
            duplicates += 1;
            continue;
          }
          seenPhones.add(phone);
          fresh.push({ ...c, phone, list_id: listId });
        }

        const insertedContacts: Contact[] = [];
        const errors: string[] = [];
        let failed = 0;

        for (let i = 0; i < fresh.length; i += CONTACT_IMPORT_BATCH_SIZE) {
          const batch = fresh.slice(i, i + CONTACT_IMPORT_BATCH_SIZE);
          const { data, error } = await supabase
            .from("contacts")
            .insert(
              batch.map((m) => ({
                id: uid(),
                user_id: orgId,
                list_id: listId,
                name: m.name,
                company: m.company,
                phone: m.phone,
                email: m.email,
                custom_vars: m.custom_vars,
                tags: m.tags,
                notes: m.notes,
                status: m.status,
              })),
            )
            .select("id,user_id,list_id,name,company,phone,email,custom_vars,tags,notes,status,created_at");

          if (error) {
            failed += batch.length;
            errors.push(error.message);
            continue;
          }
          insertedContacts.push(
            ...((data ?? []) as Record<string, unknown>[]).map(toContactFromDb),
          );
        }

        if (insertedContacts.length > 0) {
          set((s) => {
            const existingIds = new Set(s.contacts.map((c) => c.id));
            const next = insertedContacts.filter((c) => !existingIds.has(c.id));
            return { contacts: [...s.contacts, ...next] };
          });
        }

        return {
          listId,
          inserted: insertedContacts.length,
          duplicates,
          failed,
          errors,
        };
      },
      deleteList: async (id) => {
        // Detach campaigns pointing at this list, drop its contacts, then the list.
        await supabase.from("campaigns").update({ list_id: null } as never).eq("list_id", id);
        const { error: contactsErr } = await supabase.from("contacts").delete().eq("list_id", id);
        if (contactsErr) throw new Error(contactsErr.message);
        const { error } = await supabase.from("contact_lists").delete().eq("id", id);
        if (error) throw new Error(error.message);
        set((s) => ({
          lists: s.lists.filter((l) => l.id !== id),
          contacts: s.contacts.filter((c) => c.list_id !== id),
          campaigns: s.campaigns.map((c) => (c.list_id === id ? { ...c, list_id: "" } : c)),
        }));
      },
      deleteContacts: (ids) => {
        const set2 = new Set(ids);
        set((s) => ({ contacts: s.contacts.filter((c) => !set2.has(c.id)) }));
        if (ids.length > 0) {
          dbWrite(supabase.from("contacts").delete().in("id", ids));
        }
      },

      addCampaign: (c) => {
        const campaign: Campaign = {
          ...c,
          id: uid(),
          org_id: get().currentOrgId,
          created_by: get().currentUserId,
          created_at: new Date().toISOString(),
          status: "draft",
        };
        set((s) => ({ campaigns: [...s.campaigns, campaign] }));
        dbWrite(
          supabase.from("campaigns").insert({
            id: campaign.id,
            user_id: campaign.org_id,
            name: campaign.name,
            agent_id: campaign.agent_id,
            list_id: campaign.list_id,
            phone_number_id: campaign.phone_number_id,
            timezone: campaign.timezone,
            calling_hours: campaign.calling_hours,
            calls_per_minute: campaign.calls_per_minute,
            retry_rules: campaign.retry_rules,
            voicemail_rules: campaign.voicemail_rules,
            status: campaign.status,
          }),
        );
        return campaign;
      },
      setCampaignStatus: (id, status) => {
        set((s) => ({
          campaigns: s.campaigns.map((c) => (c.id === id ? { ...c, status } : c)),
        }));
        dbWrite(supabase.from("campaigns").update({ status }).eq("id", id));
      },
      updateCampaign: (id, patch) => {
        set((s) => ({
          campaigns: s.campaigns.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        }));
        const dbPatch: Record<string, unknown> = { ...patch };
        delete dbPatch.id;
        delete dbPatch.org_id;
        delete dbPatch.created_by;
        delete dbPatch.created_at;
        dbWrite(supabase.from("campaigns").update(dbPatch as never).eq("id", id));
      },
      duplicateCampaign: (id) => {
        const orig = get().campaigns.find((c) => c.id === id);
        if (!orig) return;
        const copy: Campaign = {
          ...orig,
          id: uid(),
          name: orig.name + " (Copy)",
          status: "draft",
          created_at: new Date().toISOString(),
        };
        set((s) => ({ campaigns: [...s.campaigns, copy] }));
        dbWrite(
          supabase.from("campaigns").insert({
            id: copy.id,
            user_id: copy.org_id,
            name: copy.name,
            agent_id: copy.agent_id,
            list_id: copy.list_id,
            phone_number_id: copy.phone_number_id,
            timezone: copy.timezone,
            calling_hours: copy.calling_hours,
            calls_per_minute: copy.calls_per_minute,
            retry_rules: copy.retry_rules,
            voicemail_rules: copy.voicemail_rules,
            status: copy.status,
          }),
        );
      },

      addPhone: (number, type) => {
        const phone: PhoneNumber = {
          id: uid(),
          org_id: get().currentOrgId,
          number,
          twilio_sid: "PN" + uid().replace(/-/g, "").slice(0, 30),
          type,
          capabilities: ["voice", "sms"],
          inbound_agent_id: null,
          created_at: new Date().toISOString(),
        };
        set((s) => ({ phones: [...s.phones, phone] }));
        dbWrite(
          supabase.from("phone_numbers").insert({
            id: phone.id,
            user_id: phone.org_id,
            number: phone.number,
            twilio_sid: phone.twilio_sid,
            type: phone.type,
            capabilities: phone.capabilities,
          }),
        );
        return phone;
      },
      deletePhone: (id) => {
        set((s) => ({ phones: s.phones.filter((p) => p.id !== id) }));
        dbWrite(supabase.from("phone_numbers").delete().eq("id", id));
      },
      setPhoneInboundAgent: (id, agentId) => {
        set((s) => ({
          phones: s.phones.map((p) =>
            p.id === id ? { ...p, inbound_agent_id: agentId } : p,
          ),
        }));
        dbWrite(
          supabase
            .from("phone_numbers")
            .update({ inbound_agent_id: agentId } as never)
            .eq("id", id),
        );
      },


      saveSettings: (patch) => {
        set((s) => ({
          settings: s.settings.map((x) =>
            x.org_id === s.currentOrgId ? { ...x, ...patch } : x,
          ),
        }));
        const uid_ = get().currentUserId;
        const dbPatch: Record<string, unknown> = { ...patch };
        delete dbPatch.org_id;

        if (uid_) {
          dbWrite(
            supabase.from("org_settings").upsert({ user_id: uid_, ...dbPatch } as never),
          );
        }
      },

      addAutomation: (a) => {
        const auto: Automation = { ...a, id: uid(), org_id: get().currentOrgId };
        set((s) => ({ automations: [...s.automations, auto] }));
        dbWrite(
          supabase.from("automations").insert({
            id: auto.id,
            user_id: auto.org_id,
            name: auto.name,
            trigger: auto.trigger,
            action: auto.action,
            config: auto.config,
            enabled: auto.enabled,
          }),
        );
        return auto;
      },
      toggleAutomation: (id) => {
        const cur = get().automations.find((a) => a.id === id);
        const next = !cur?.enabled;
        set((s) => ({
          automations: s.automations.map((a) =>
            a.id === id ? { ...a, enabled: next } : a,
          ),
        }));
        dbWrite(supabase.from("automations").update({ enabled: next }).eq("id", id));
      },
      deleteAutomation: (id) => {
        set((s) => ({ automations: s.automations.filter((a) => a.id !== id) }));
        dbWrite(supabase.from("automations").delete().eq("id", id));
      },

    }),
    {
      name: "medical-calling-ai-db-v2",
      // Only persist lightweight session/preference state. Server-hydrated
      // collections (contacts, calls, campaigns, ...) can be tens of MB and
      // will blow past the ~5MB localStorage quota, throwing on every write
      // and blocking the main thread on JSON.stringify.
      partialize: (s) => ({
        currentUserId: s.currentUserId,
        currentOrgId: s.currentOrgId,
        users: s.users,
        organizations: s.organizations,
        members: s.members,
      }),
    },
  ),
);

// ============================================================
// Selectors
// ============================================================

export function selectCurrentOrg(s: DBState) {
  return s.organizations.find((o) => o.id === s.currentOrgId) ?? null;
}
export function selectCurrentUser(s: DBState) {
  return s.users.find((u) => u.id === s.currentUserId) ?? null;
}
export function selectCurrentSettings(s: DBState) {
  return s.settings.find((x) => x.org_id === s.currentOrgId) ?? null;
}
export function scopeOrg<T extends { org_id: UUID }>(rows: T[], orgId: UUID) {
  return rows.filter((r) => r.org_id === orgId);
}
