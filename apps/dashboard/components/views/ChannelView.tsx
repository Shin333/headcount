// ============================================================================
// components/views/ChannelView.tsx - Day 17.5
// ----------------------------------------------------------------------------
// Displays a project channel ("meeting room") with real-time messages and
// a text input for the CEO to post. Lives alongside the existing MessagesView
// as a sibling tab or can be embedded within it.
// ============================================================================

"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";

interface ChannelMessage {
  id: string;
  agentId: string;
  agentName: string;
  body: string;
  messageType: string;
  createdAt: string;
}

interface Project {
  id: string;
  title: string;
  status: string;
  memberCount?: number;
}

const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

export function ChannelView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load projects
  useEffect(() => {
    async function loadProjects() {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.projects)) {
          setProjects(data.projects);
          if (data.projects.length > 0 && !selectedProjectId) {
            setSelectedProjectId(data.projects[0].id);
          }
        }
      } catch {
        // silent
      }
    }
    loadProjects();

    // Day 23: poll every 15s to catch new projects + realtime subscription
    const interval = setInterval(loadProjects, 15_000);

    const projectsChannel = supabase
      .channel("projects-list")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "projects" },
        () => loadProjects()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "projects" },
        () => loadProjects()
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(projectsChannel);
    };
  }, []);

  // Load messages when project changes
  const loadMessages = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/project/${selectedProjectId}/messages?limit=100`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.messages)) {
        // API returns newest-first, reverse for display
        setMessages(data.messages.reverse());
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Realtime subscription for new messages
  useEffect(() => {
    if (!selectedProjectId) return;

    const channel = supabase
      .channel(`channel-${selectedProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "project_messages",
          filter: `project_id=eq.${selectedProjectId}`,
        },
        () => {
          // Reload all messages to get agent names resolved
          loadMessages();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedProjectId, loadMessages]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send handler
  async function handleSend() {
    if (!selectedProjectId || !draft.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/project/${selectedProjectId}/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      if (res.ok) {
        setDraft("");
        textareaRef.current?.focus();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`Failed: ${err.error ?? res.status}`);
      }
    } catch (err) {
      alert("Failed to send message");
    } finally {
      setSending(false);
    }
  }

  // Ctrl+Enter to send
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 280px)", minHeight: "400px" }}>
      {/* Project selector */}
      {projects.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">
            project:
          </span>
          <select
            value={selectedProjectId ?? ""}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="rounded border border-ink-200 bg-white px-2 py-1 font-mono text-xs text-ink-700"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.memberCount ?? 0} members)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Channel header */}
      {selectedProject && (
        <div className="mb-3 rounded-t-lg border border-ink-200 bg-ink-50 px-4 py-2">
          <div className="flex items-baseline justify-between">
            <h3 className="font-mono text-sm font-semibold text-ink-900">
              # {selectedProject.title}
            </h3>
            <span className="font-mono text-[10px] text-ink-400">
              {messages.length} messages
            </span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto rounded border border-t-0 border-ink-200 bg-white px-4 py-3">
        {loading && (
          <div className="py-8 text-center font-mono text-xs text-ink-400">
            Loading channel...
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="py-8 text-center font-mono text-xs text-ink-400">
            No messages yet. Post something to get the conversation started.
          </div>
        )}

        {!loading &&
          messages.map((msg) => {
            const isCeo = msg.agentId === CEO_SENTINEL_ID;
            const isArtifact = msg.messageType === "artifact";
            const isSystem = msg.messageType === "system";

            return (
              <div key={msg.id} className="mb-4">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-xs font-semibold ${
                      isCeo ? "text-amber-700" : "text-ink-800"
                    }`}
                  >
                    {msg.agentName}
                  </span>
                  <span className="font-mono text-[10px] text-ink-300">
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {isArtifact && (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-blue-600">
                      ARTIFACT
                    </span>
                  )}
                  {isSystem && (
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-ink-500">
                      SYSTEM
                    </span>
                  )}
                </div>
                <div
                  className={`mt-0.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    isSystem ? "italic text-ink-400" : "text-ink-700"
                  }`}
                >
                  {msg.body}
                </div>
              </div>
            );
          })}
        <div ref={messagesEndRef} />
      </div>

      {/* Compose */}
      <div className="mt-2 flex gap-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Post to the meeting room... (Ctrl+Enter to send)"
          rows={3}
          className="flex-1 resize-none rounded border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 placeholder:text-ink-300 focus:border-ink-400 focus:outline-none"
          disabled={sending || !selectedProjectId}
        />
        <button
          onClick={handleSend}
          disabled={sending || !draft.trim() || !selectedProjectId}
          className="self-end rounded bg-ink-900 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
