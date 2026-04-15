// ============================================================================
// components/views/MessagesView.tsx - Day 12a.1 + Day 14 hotfix
// ----------------------------------------------------------------------------
// Slack-style messaging view. Two columns:
//   LEFT  (~280px) - conversation list grouped by partner agent
//   RIGHT (flex)   - active conversation thread + composer
//
// What this includes:
//   - Conversations grouped by partner, sorted by most recent activity
//   - Click to switch active thread
//   - Inline reply composer (textarea + send button)
//   - "+ new conversation" agent picker for starting fresh threads
//   - Auto-scroll to bottom on (a) thread switch and (b) user-sent message
//   - Artifact rendering inside message bodies (Day 9b parser reused)
//   - Empty states for "no conversations yet" and "no active thread"
//
// Day 14 hotfix:
//   - When the user clicks an agent in the + picker, that partner has no
//     existing DMs. The previous version computed activeConversation via
//     conversations.find(...) which returned undefined, so the right pane
//     fell back to "Select a conversation" - looking like nothing happened.
//     Fix: when activePartnerId is set but no conversation row exists yet,
//     synthesize an empty conversation with messages=[]. The composer
//     renders so the user can send the first message. After they send,
//     the realtime sub picks up the new DM and the conversation becomes
//     real on the next render.
//
// What this does NOT include (deferred to Phase 2/3):
//   - Group channels (multi-participant conversations)
//   - File / image / video attachments
//   - @mention autocomplete and notifications
//   - Message editing or deletion
//   - Read receipts shown explicitly (we use them internally for unread counts)
//   - Emoji reactions
//   - Rich text formatting
// ============================================================================

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dm, Agent } from "../lib/types";
import { conversationsFromDms, type Conversation } from "../lib/conversationsFromDms";
import { parseArtifactsBlock } from "../lib/parseArtifactsBlock";
import { formatTime } from "../lib/formatTime";
import { ConversationListItem } from "../primitives/ConversationListItem";
import { ArtifactCard } from "../primitives/ArtifactCard";

export function MessagesView({
  dms,
  agents,
  agentList,
  ceoSentinelId,
  onSendDm,
}: {
  dms: Dm[];
  agents: Map<string, Agent>;
  agentList: Agent[];
  ceoSentinelId: string;
  onSendDm: (toId: string, body: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [activePartnerId, setActivePartnerId] = useState<string | null>(null);
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const threadScrollRef = useRef<HTMLDivElement>(null);

  // Build conversation list from flat DMs
  const conversations = useMemo(
    () => conversationsFromDms(dms, agents, ceoSentinelId),
    [dms, agents, ceoSentinelId]
  );

  // Default active conversation = the most recent one (or null if none)
  useEffect(() => {
    if (activePartnerId === null && conversations.length > 0) {
      setActivePartnerId(conversations[0]!.partnerId);
    }
  }, [conversations, activePartnerId]);

  // Find the active conversation in the current list, OR synthesize an
  // empty one if the user just clicked a fresh agent in the picker.
  // Day 14 hotfix: without this fallback, clicking a new agent looked
  // like nothing happened because conversations.find returned undefined.
  const activeConversation: Conversation | null = useMemo(() => {
    if (!activePartnerId) return null;
    const existing = conversations.find((c) => c.partnerId === activePartnerId);
    if (existing) return existing;
    // Synthetic empty conversation - lets the composer render so the user
    // can send the first message. messages=[] means the thread renders
    // with an "no messages yet" hint instead of crashing on lastMessage.
    const partner = agents.get(activePartnerId);
    if (!partner) return null;
    return {
      partnerId: activePartnerId,
      partner,
      messages: [],
      // lastMessage is required by the Conversation type but we never
      // read it for empty conversations. Use a sentinel value that won't
      // be touched - we explicitly check messages.length === 0 below.
      lastMessage: {
        id: "synthetic-empty",
        tenant_id: "",
        from_id: ceoSentinelId,
        to_id: activePartnerId,
        body: "",
        read_at: null,
        created_at: new Date().toISOString(),
      } as Dm,
      unreadCount: 0,
    };
  }, [activePartnerId, conversations, agents, ceoSentinelId]);

  // Auto-scroll to bottom when active thread changes
  useEffect(() => {
    if (threadScrollRef.current) {
      threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
    }
    // We deliberately do not depend on the messages array - we only scroll
    // on thread switch and on user-send (handled inline in handleSend).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePartnerId]);

  // Agents we can DM (everyone except the CEO sentinel itself)
  const dmableAgents = agentList.filter((a) => a.id !== ceoSentinelId);

  // Agents we don't yet have a conversation with (for the + picker)
  const newConversationCandidates = dmableAgents.filter(
    (a) => !conversations.some((c) => c.partnerId === a.id)
  );

  async function handleSend() {
    if (!composeText.trim() || !activePartnerId) return;
    setSending(true);
    setStatusMessage(null);
    const result = await onSendDm(activePartnerId, composeText.trim());
    setSending(false);
    if (result.ok) {
      setComposeText("");
      // Auto-scroll to bottom after the user sends. The realtime sub will
      // pick up the new message and re-render; we scroll on the next tick.
      setTimeout(() => {
        if (threadScrollRef.current) {
          threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
        }
      }, 100);
    } else {
      setStatusMessage({ ok: false, text: result.error ?? "Send failed" });
    }
  }

  function handleStartNewConversation(partnerId: string) {
    setActivePartnerId(partnerId);
    setPickerOpen(false);
    setComposeText("");
  }

  // ----- Empty state: no conversations at all and picker not open -----

  if (conversations.length === 0 && !activeConversation && !pickerOpen) {
    return (
      <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-dashed border-ink-200 bg-white p-12">
        <div className="text-center">
          <p className="font-mono text-sm text-ink-400">No conversations yet</p>
          <p className="mt-2 text-xs text-ink-400">
            Start a conversation with any agent. They&apos;ll respond on their next ritual cycle.
          </p>
          <button
            onClick={() => setPickerOpen(true)}
            className="mt-4 rounded bg-ink-900 px-4 py-2 font-mono text-xs uppercase tracking-wider text-white hover:bg-ink-800"
          >
            + new conversation
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-0 overflow-hidden rounded-lg border border-ink-200 bg-white md:grid-cols-[280px_1fr]">
      {/* ============================================================ */}
      {/* LEFT RAIL - conversation list                                */}
      {/* ============================================================ */}
      <aside className="flex max-h-[700px] flex-col border-b border-ink-200 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between border-b border-ink-200 px-3 py-2">
          <h3 className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
            // conversations
          </h3>
          <button
            onClick={() => setPickerOpen((p) => !p)}
            className={`rounded px-2 py-0.5 font-mono text-xs transition ${
              pickerOpen
                ? "bg-ink-900 text-white"
                : "border border-ink-200 text-ink-600 hover:border-ink-400"
            }`}
            title="start new conversation"
          >
            +
          </button>
        </div>

        {/* Picker for starting a new conversation */}
        {pickerOpen && (
          <div className="border-b border-ink-200 bg-ink-50 p-2">
            <div className="mb-2 font-mono text-[9px] uppercase tracking-wider text-ink-500">
              new conversation with...
            </div>
            <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
              {newConversationCandidates.map((a) => (
                <button
                  key={a.id}
                  onClick={() => handleStartNewConversation(a.id)}
                  className="rounded border border-ink-200 bg-white px-2 py-1 text-[11px] text-ink-800 hover:border-ink-400 hover:bg-ink-100"
                >
                  {a.name}
                </button>
              ))}
              {newConversationCandidates.length === 0 && (
                <span className="text-[10px] text-ink-400">
                  You already have conversations with everyone.
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {conversations.map((conv) => (
            <ConversationListItem
              key={conv.partnerId}
              conversation={conv}
              isActive={conv.partnerId === activePartnerId}
              onClick={() => setActivePartnerId(conv.partnerId)}
            />
          ))}
        </div>
      </aside>

      {/* ============================================================ */}
      {/* RIGHT PANE - active thread + composer                        */}
      {/* ============================================================ */}
      <section className="flex max-h-[700px] flex-col">
        {!activeConversation ? (
          <div className="flex flex-1 items-center justify-center p-12">
            <p className="font-mono text-sm text-ink-400">
              Select a conversation
            </p>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="border-b border-ink-200 px-5 py-3">
              <div className="flex items-baseline gap-3">
                <span className="text-base font-semibold text-ink-900">
                  {activeConversation.partner?.name ?? "Unknown"}
                </span>
                {activeConversation.partner?.role && (
                  <span className="text-xs text-ink-500">
                    {activeConversation.partner.role}
                  </span>
                )}
                <span className="ml-auto font-mono text-[10px] text-ink-400">
                  {activeConversation.messages.length} message
                  {activeConversation.messages.length === 1 ? "" : "s"}
                </span>
              </div>
            </div>

            {/* Status banner */}
            {statusMessage && (
              <div
                className={`border-b px-5 py-2 text-xs ${
                  statusMessage.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-red-200 bg-red-50 text-red-800"
                }`}
              >
                {statusMessage.text}
              </div>
            )}

            {/* Message list - scrollable */}
            <div ref={threadScrollRef} className="flex-1 overflow-y-auto px-5 py-4">
              {activeConversation.messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <p className="font-mono text-xs text-ink-400">
                      No messages yet
                    </p>
                    <p className="mt-1 text-[11px] text-ink-400">
                      Send the first message to {activeConversation.partner?.name ?? "this agent"} below.
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="space-y-4">
                  {activeConversation.messages.map((dm) => {
                    const isFromCeo = dm.from_id === ceoSentinelId;
                    const sender = isFromCeo
                      ? null
                      : agents.get(dm.from_id);
                    const parsed = parseArtifactsBlock(dm.body);
                    return (
                      <li key={dm.id}>
                        <div className="mb-1 flex items-baseline gap-2">
                          <span className="text-sm font-semibold text-ink-900">
                            {isFromCeo ? "You" : sender?.name ?? "Unknown"}
                          </span>
                          <span className="font-mono text-[10px] text-ink-400">
                            {formatTime(dm.created_at)}
                          </span>
                          {!isFromCeo && !dm.read_at && (
                            <span className="font-mono text-[9px] text-amber-600">
                              UNREAD
                            </span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">
                          {parsed.text}
                        </p>
                        {parsed.artifacts.map((a) => (
                          <ArtifactCard key={a.id} artifact={a} />
                        ))}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Composer pinned to bottom */}
            <div className="border-t border-ink-200 bg-ink-50 p-3">
              <textarea
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl + Enter to send (Slack convention)
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={`Message ${activeConversation.partner?.name ?? "agent"}...`}
                rows={3}
                className="w-full resize-none rounded border border-ink-200 bg-white p-2 text-sm text-ink-800 focus:border-ink-400 focus:outline-none"
                disabled={sending}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={handleSend}
                  disabled={sending || !composeText.trim()}
                  className="rounded bg-ink-900 px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-400"
                >
                  {sending ? "sending..." : "send"}
                </button>
                <span className="font-mono text-[10px] text-ink-400">
                  ⌘/Ctrl + Enter to send
                </span>
                <span className="ml-auto font-mono text-[10px] text-ink-400">
                  {composeText.length} chars
                </span>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
