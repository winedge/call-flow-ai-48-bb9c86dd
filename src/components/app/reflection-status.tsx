/**
 * Reflection-status UI shared by the dashboard and the agent editor.
 *
 * Reads `call_reflections` directly through the RLS-scoped browser
 * Supabase client, so every user only sees their own reflections.
 * Polls every 20s so status transitions (pending → success/failed) show
 * up without needing realtime channels.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Brain, CheckCircle2, Clock, MinusCircle, RefreshCw } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type Status = "pending" | "success" | "failed" | "skipped";

type ReflectionRow = {
  id: string;
  call_id: string;
  agent_id: string;
  status: Status;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  success_score: number | null;
  success_label: string | null;
  key_learnings: unknown;
  created_at: string;
  updated_at: string;
};

function learningsOf(row: ReflectionRow): string[] {
  if (!Array.isArray(row.key_learnings)) return [];
  return row.key_learnings.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** Most recent, de-duplicated learnings across successful reflections. */
function topLearnings(rows: ReflectionRow[] | null, max = 4): string[] {
  if (!rows) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r.status !== "success") continue;
    for (const l of learningsOf(r)) {
      const k = l.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
      if (out.length >= max) return out;
    }
  }
  return out;
}

const POLL_MS = 20_000;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    success: { label: "Success", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", Icon: CheckCircle2 },
    pending: { label: "Pending", cls: "bg-amber-50 text-amber-700 ring-amber-600/20", Icon: Clock },
    failed: { label: "Failed", cls: "bg-rose-50 text-rose-700 ring-rose-600/20", Icon: AlertCircle },
    skipped: { label: "Skipped", cls: "bg-neutral-100 text-neutral-600 ring-black/5", Icon: MinusCircle },
  };
  const { label, cls, Icon } = map[status] ?? map.pending;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full ring-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest", cls)}>
      <Icon className="size-3" strokeWidth={2} /> {label}
    </span>
  );
}

function shortTime(iso: string) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

async function fetchReflections(opts: { agentId?: string; limit: number }): Promise<ReflectionRow[]> {
  let q = supabase
    .from("call_reflections")
    .select("id, call_id, agent_id, status, attempts, last_error, next_attempt_at, success_score, success_label, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(opts.limit);
  if (opts.agentId) q = q.eq("agent_id", opts.agentId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ReflectionRow[];
}

function usePolledReflections(opts: { agentId?: string; limit: number }) {
  const [rows, setRows] = useState<ReflectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await fetchReflections(opts);
        if (alive) {
          setRows(data);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load reflections");
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [opts.agentId, opts.limit]);

  return { rows, error };
}

// ---------------------------------------------------------------------------
// Agent-editor panel
// ---------------------------------------------------------------------------

export function ReflectionsPanel({ agentId }: { agentId: string }) {
  const { rows, error } = usePolledReflections({ agentId, limit: 15 });

  const counts = rows
    ? rows.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        },
        { success: 0, pending: 0, failed: 0, skipped: 0 } as Record<Status, number>,
      )
    : null;

  return (
    <div className="bg-white ring-1 ring-black/5 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-neutral-900 flex items-center gap-2">
          <Brain className="size-3.5 text-brand-primary" /> Reflection health
        </h2>
        {counts && (
          <div className="flex items-center gap-3 text-[11px] font-mono text-neutral-500">
            <span className="text-emerald-700">{counts.success} ok</span>
            <span className="text-amber-700">{counts.pending} pending</span>
            <span className="text-rose-700">{counts.failed} failed</span>
            <span>{counts.skipped} skipped</span>
          </div>
        )}
      </div>
      <p className="text-[11px] text-neutral-500 mb-3">
        Every completed call is analyzed to update this agent's playbook. Failed jobs retry automatically with backoff.
      </p>

      {error && (
        <div className="rounded-lg bg-rose-50 ring-1 ring-rose-600/20 p-3 text-[11px] text-rose-700 mb-3">
          Failed to load reflections: {error}
        </div>
      )}

      {rows === null ? (
        <div className="text-[11px] text-neutral-500 italic">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg bg-neutral-50 ring-1 ring-black/5 p-4 text-[11px] text-neutral-500 italic">
          No calls analyzed yet. Complete a test call — a reflection row will appear here.
        </div>
      ) : (
        <div className="divide-y divide-neutral-100 ring-1 ring-black/5 rounded-lg overflow-hidden">
          {rows.map((r) => (
            <ReflectionRowView key={r.id} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReflectionRowView({ row }: { row: ReflectionRow }) {
  return (
    <div className="px-3 py-2.5 flex items-start gap-3">
      <div className="pt-0.5">
        <StatusChip status={row.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] font-mono text-neutral-500">
          <Link
            to="/calls/$id"
            params={{ id: row.call_id }}
            className="text-neutral-800 hover:text-brand-primary truncate max-w-[180px]"
            title={row.call_id}
          >
            {row.call_id.slice(0, 8)}
          </Link>
          <span>·</span>
          <span>{shortTime(row.updated_at)}</span>
          {row.attempts > 0 && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <RefreshCw className="size-2.5" /> {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
              </span>
            </>
          )}
          {row.success_score !== null && (
            <>
              <span>·</span>
              <span className="tabular-nums">score {row.success_score}</span>
            </>
          )}
        </div>
        {row.status === "failed" && row.last_error && (
          <p className="mt-1 text-[11px] text-rose-700 line-clamp-2">
            {row.last_error}
          </p>
        )}
        {row.status === "failed" && row.next_attempt_at && (
          <p className="mt-0.5 text-[10px] font-mono text-neutral-500">
            next retry {new Date(row.next_attempt_at).toLocaleTimeString()}
          </p>
        )}
        {row.status === "skipped" && row.last_error && (
          <p className="mt-1 text-[11px] text-neutral-500 italic">{row.last_error}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

export function ReflectionHealthWidget() {
  const { rows, error } = usePolledReflections({ limit: 100 });

  const counts = rows
    ? rows.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        },
        { success: 0, pending: 0, failed: 0, skipped: 0 } as Record<Status, number>,
      )
    : { success: 0, pending: 0, failed: 0, skipped: 0 };

  const recentFailed = (rows ?? []).filter((r) => r.status === "failed").slice(0, 4);

  return (
    <div className="rounded-xl border border-black/5 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-neutral-200/70 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-brand-primary" strokeWidth={1.75} />
          <h2 className="text-sm font-medium text-neutral-900">Learning loop</h2>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">
          last 100 calls
        </span>
      </div>

      <div className="grid grid-cols-4 divide-x divide-neutral-200/70">
        <Stat label="Ok" value={counts.success} tone="emerald" />
        <Stat label="Pending" value={counts.pending} tone="amber" />
        <Stat label="Failed" value={counts.failed} tone="rose" />
        <Stat label="Skipped" value={counts.skipped} tone="neutral" />
      </div>

      <div className="border-t border-neutral-200/70 px-5 py-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">
            Recent failures
          </span>
        </div>
        {error && (
          <div className="rounded-lg bg-rose-50 ring-1 ring-rose-600/20 p-2 text-[11px] text-rose-700">
            {error}
          </div>
        )}
        {rows === null && !error ? (
          <p className="text-[11px] text-neutral-500 italic">Loading…</p>
        ) : recentFailed.length === 0 ? (
          <p className="text-[11px] text-neutral-500 italic">
            No failed reflections. Retries and idempotency are keeping the learning loop clean.
          </p>
        ) : (
          <ul className="space-y-2">
            {recentFailed.map((r) => (
              <li key={r.id} className="flex items-start gap-2 text-[11px]">
                <StatusChip status="failed" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-neutral-500">
                    <Link
                      to="/calls/$id"
                      params={{ id: r.call_id }}
                      className="text-neutral-800 hover:text-brand-primary"
                    >
                      {r.call_id.slice(0, 8)}
                    </Link>
                    <span>·</span>
                    <span>{shortTime(r.updated_at)}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <RefreshCw className="size-2.5" /> {r.attempts}
                    </span>
                  </div>
                  {r.last_error && (
                    <p className="mt-0.5 text-rose-700 line-clamp-2">{r.last_error}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "amber" | "rose" | "neutral";
}) {
  const toneCls = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
    neutral: "text-neutral-800",
  }[tone];
  return (
    <div className="p-4 text-center">
      <p className={cn("text-2xl font-mono font-medium tabular-nums", toneCls)}>
        {value}
      </p>
      <p className="mt-1 text-[10px] font-mono uppercase tracking-widest text-neutral-500">
        {label}
      </p>
    </div>
  );
}
