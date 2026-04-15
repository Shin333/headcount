// ============================================================================
// components/views/ProjectsView.tsx - Day 22
// ----------------------------------------------------------------------------
// Shows active projects with members, commitments, artifacts, and activity.
// Polls /api/projects/detail every 30s for fresh data.
// ============================================================================

"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface ProjectMember {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
}

interface Commitment {
  id: string;
  description: string;
  agent_id: string;
  agentName: string;
  status: string;
  deadline_at: string | null;
  nudge_count: number;
}

interface Artifact {
  id: string;
  title: string;
  file_path: string;
  created_by: string;
  createdByName: string;
  created_at: string;
}

interface Project {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  members: ProjectMember[];
  commitments: {
    pending: number;
    overdue: number;
    stalled: number;
    resolved: number;
    items: Commitment[];
  };
  artifacts: Artifact[];
  messageCount: number;
  pinnedCount: number;
}

export function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const res = await fetch("/api/projects/detail");
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && Array.isArray(data?.projects)) {
          setProjects(data.projects);
          // Auto-expand first project
          if (data.projects.length > 0 && !expandedProject) {
            setExpandedProject(data.projects[0].id);
          }
        }
      } catch {
        // silent
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    // Day 23: tighter polling + realtime for new projects
    const interval = setInterval(load, 10_000);

    const projectsChannel = supabase
      .channel("projects-list-detail")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "projects" },
        () => load()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "projects" },
        () => load()
      )
      .subscribe();

    return () => {
      mounted = false;
      clearInterval(interval);
      supabase.removeChannel(projectsChannel);
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
        Loading projects...
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-12 text-center">
        <p className="font-mono text-sm text-ink-400">// no active projects</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {projects.map((project) => {
        const isExpanded = expandedProject === project.id;
        return (
          <div
            key={project.id}
            className="rounded-lg border border-ink-200 bg-white overflow-hidden max-w-full"
          >
            {/* Project header */}
            <button
              onClick={() => setExpandedProject(isExpanded ? null : project.id)}
              className="w-full flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-left hover:bg-ink-50 transition"
            >
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-ink-900 truncate">
                  {project.title}
                </h3>
                {project.description && (
                  <p className="text-xs text-ink-400 mt-0.5 line-clamp-1">
                    {project.description}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <StatBadge label="members" value={project.members.length} />
                <StatBadge
                  label="pending"
                  value={project.commitments.pending}
                  warn={project.commitments.overdue > 0}
                />
                <StatBadge label="artifacts" value={project.artifacts.length} />
                <StatBadge label="msgs/24h" value={project.messageCount} />
                <span className="text-ink-300 text-xs">
                  {isExpanded ? "▼" : "▶"}
                </span>
              </div>
            </button>

            {/* Expanded details */}
            {isExpanded && (
              <div className="border-t border-ink-100 px-5 py-4 space-y-5">
                {/* Members grid */}
                <Section title="Team">
                  <div className="flex flex-wrap gap-2">
                    {project.members.map((m) => (
                      <span
                        key={m.id}
                        className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs"
                      >
                        <span className="font-medium text-ink-800">
                          {m.name}
                        </span>
                        <span className="text-ink-400">{m.role}</span>
                      </span>
                    ))}
                  </div>
                </Section>

                {/* Commitments */}
                <Section
                  title={`Commitments (${project.commitments.pending} pending, ${project.commitments.overdue} overdue, ${project.commitments.stalled} stalled, ${project.commitments.resolved} resolved)`}
                >
                  {project.commitments.items.length === 0 ? (
                    <p className="text-xs text-ink-400">No commitments</p>
                  ) : (
                    <div className="space-y-1.5">
                      {project.commitments.items.map((c) => (
                        <div
                          key={c.id}
                          className={`flex items-start gap-2 rounded px-2.5 py-1.5 text-xs ${
                            c.status === "stalled"
                              ? "bg-red-50"
                              : c.status === "resolved"
                              ? "bg-emerald-50"
                              : c.deadline_at &&
                                new Date(c.deadline_at) < new Date()
                              ? "bg-amber-50"
                              : "bg-ink-50"
                          }`}
                        >
                          <StatusDot status={c.status} deadline={c.deadline_at} />
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <span className="font-medium text-ink-700">
                              {c.agentName}
                            </span>
                            <span className="text-ink-400">
                              {" "}— {c.description.length > 100 ? c.description.slice(0, 100) + "…" : c.description}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-ink-400 uppercase">
                            {c.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Artifacts */}
                <Section title={`Recent Artifacts (${project.artifacts.length})`}>
                  {project.artifacts.length === 0 ? (
                    <p className="text-xs text-ink-400">No artifacts yet</p>
                  ) : (
                    <div className="space-y-1">
                      {project.artifacts.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center gap-2 text-xs"
                        >
                          <span className="text-ink-300">📄</span>
                          <span className="font-medium text-ink-700 truncate">
                            {a.title}
                          </span>
                          <span className="text-ink-400 shrink-0">
                            by {a.createdByName}
                          </span>
                          <span className="font-mono text-[10px] text-ink-300 shrink-0">
                            {new Date(a.created_at).toLocaleTimeString("en-US", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Quick stats + Complete button */}
                <div className="flex items-center justify-between pt-2 border-t border-ink-100">
                  <div className="flex items-center gap-4 text-[10px] font-mono text-ink-400 uppercase tracking-wider">
                    <span>{project.messageCount} messages (24h)</span>
                    <span>{project.pinnedCount} pinned</span>
                    <span>
                      created{" "}
                      {new Date(project.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm(`Mark "${project.title}" as complete? This resolves all pending commitments and stops heartbeat nudges.`)) return;
                      try {
                        const res = await fetch(`/api/project/${project.id}/complete`, { method: "POST" });
                        if (res.ok) {
                          setProjects((prev) => prev.filter((p) => p.id !== project.id));
                        }
                      } catch { /* silent */ }
                    }}
                    className="rounded bg-emerald-50 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-emerald-700 hover:bg-emerald-100 transition border border-emerald-200"
                  >
                    Complete Project
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">
        {title}
      </h4>
      {children}
    </div>
  );
}

function StatBadge({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded px-2 py-1 ${
        warn ? "bg-amber-50" : "bg-ink-50"
      }`}
    >
      <span
        className={`font-mono text-sm font-semibold ${
          warn ? "text-amber-700" : "text-ink-700"
        }`}
      >
        {value}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-ink-400">
        {label}
      </span>
    </div>
  );
}

function StatusDot({
  status,
  deadline,
}: {
  status: string;
  deadline: string | null;
}) {
  const isOverdue = deadline && new Date(deadline) < new Date();
  const color =
    status === "resolved"
      ? "bg-emerald-400"
      : status === "stalled"
      ? "bg-red-400"
      : isOverdue
      ? "bg-amber-400"
      : "bg-blue-400";

  return <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}
