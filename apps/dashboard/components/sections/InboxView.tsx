// ============================================================================
// components/sections/InboxView.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Inbox view for the CEO. Three sections:
//   1. Messages TO the CEO (filtered DMs where to_id = CEO sentinel)
//   2. New DM composer (button per agent, opens compose form)
//   3. Sent items (recent CEO outbound DMs)
//
// Day 9b: parses artifact references out of DM bodies and renders them as
// ArtifactCard components below the DM text.
//
// Includes ComposeForm and SentDmList as co-located private components
// since they are only used by InboxView.
// ============================================================================

"use client";

import { useState } from "react";
import type { Dm, Agent } from "../lib/types";
import { formatTime } from "../lib/formatTime";
import { parseArtifactsBlock } from "../lib/parseArtifactsBlock";
import { ArtifactCard } from "../primitives/ArtifactCard";

export function InboxView({
  inboxDms,
  allDms,
  agents,
  agentList,
  ceoSentinelId,
  onSendDm,
}: {
  inboxDms: Dm[];
  allDms: Dm[];
  agents: Map<string, Agent>;
  agentList: Agent[];
  ceoSentinelId: string;
  onSendDm: (toId: string, body: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [composeOpenFor, setComposeOpenFor] = useState<string | null>(null);
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Agents we can DM (everyone except the CEO sentinel itself)
  const dmableAgents = agentList.filter((a) => a.id !== ceoSentinelId);

  async function handleSend(toId: string) {
    if (!composeText.trim()) return;
    setSending(true);
    setStatusMessage(null);
    const result = await onSendDm(toId, composeText.trim());
    setSending(false);
    if (result.ok) {
      const recipient = agents.get(toId);
      setStatusMessage({
        ok: true,
        text: `Sent to ${recipient?.name ?? "agent"}. They will see it on their next ritual cycle.`,
      });
      setComposeText("");
      setComposeOpenFor(null);
      setTimeout(() => setStatusMessage(null), 4000);
    } else {
      setStatusMessage({ ok: false, text: result.error ?? "Send failed" });
    }
  }

  function openCompose(agentId: string) {
    setComposeOpenFor(agentId);
    setComposeText("");
    setStatusMessage(null);
  }

  function cancelCompose() {
    setComposeOpenFor(null);
    setComposeText("");
  }

  return (
    <div className="space-y-6">
      {statusMessage && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            statusMessage.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 text-red-800"
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Section 1: Messages TO the CEO */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-400">
          // messages to you ({inboxDms.length})
        </h2>
        {inboxDms.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-200 bg-white p-6 text-center">
            <p className="font-mono text-sm text-ink-400">Your inbox is empty.</p>
            <p className="mt-2 text-xs text-ink-400">
              Agents will DM you when they need direction. Eleanor's CEO Brief surfaces requests that need your attention.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {inboxDms.map((dm) => {
              const sender = agents.get(dm.from_id);
              const isComposeOpen = composeOpenFor === dm.from_id;
              const parsed = parseArtifactsBlock(dm.body);
              return (
                <li key={dm.id} className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-ink-900">{sender?.name ?? "Unknown"}</span>
                    <span className="text-xs text-ink-400">{sender?.role}</span>
                    <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(dm.created_at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{parsed.text}</p>
                  {parsed.artifacts.map((a) => (
                    <ArtifactCard key={a.id} artifact={a} />
                  ))}
                  <div className="mt-3">
                    {!isComposeOpen ? (
                      <button
                        onClick={() => openCompose(dm.from_id)}
                        className="rounded border border-ink-200 bg-white px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-ink-800 transition hover:border-ink-400 hover:bg-ink-100"
                      >
                        reply
                      </button>
                    ) : (
                      <ComposeForm
                        sending={sending}
                        composeText={composeText}
                        setComposeText={setComposeText}
                        onSend={() => handleSend(dm.from_id)}
                        onCancel={cancelCompose}
                        recipientName={sender?.name ?? "agent"}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Section 2: Send a new DM to anyone */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-400">
          // send a new direct message
        </h2>
        <div className="rounded-lg border border-ink-200 bg-white p-3">
          <div className="flex flex-wrap gap-2">
            {dmableAgents.map((a) => {
              const isComposeOpen = composeOpenFor === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => (isComposeOpen ? cancelCompose() : openCompose(a.id))}
                  className={`rounded border px-3 py-1.5 font-mono text-xs transition ${
                    isComposeOpen
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-200 bg-white text-ink-800 hover:border-ink-400 hover:bg-ink-100"
                  }`}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
          {composeOpenFor && !inboxDms.find((d) => d.from_id === composeOpenFor) && (
            <div className="mt-4">
              <ComposeForm
                sending={sending}
                composeText={composeText}
                setComposeText={setComposeText}
                onSend={() => handleSend(composeOpenFor)}
                onCancel={cancelCompose}
                recipientName={agents.get(composeOpenFor)?.name ?? "agent"}
              />
            </div>
          )}
          <p className="mt-3 text-[10px] text-ink-400">
            DMs are delivered when the recipient&apos;s next ritual fires (chatter, standup, or brief). At 60x speed that is roughly 1 wall minute.
          </p>
        </div>
      </section>

      {/* Section 3: Recent outbound from CEO (sent items) */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-400">
          // sent
        </h2>
        <SentDmList dms={allDms.filter((d) => d.from_id === ceoSentinelId).slice(0, 10)} agents={agents} />
      </section>
    </div>
  );
}

// ----------------------------------------------------------------------------
// ComposeForm - reply/new-DM textarea with send/cancel buttons.
// Private to InboxView - not exported from a barrel file.
// ----------------------------------------------------------------------------

function ComposeForm({
  sending,
  composeText,
  setComposeText,
  onSend,
  onCancel,
  recipientName,
}: {
  sending: boolean;
  composeText: string;
  setComposeText: (s: string) => void;
  onSend: () => void;
  onCancel: () => void;
  recipientName: string;
}) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-400">
        replying to {recipientName}
      </div>
      <textarea
        value={composeText}
        onChange={(e) => setComposeText(e.target.value)}
        placeholder="Type your message..."
        rows={4}
        className="w-full resize-none rounded border border-ink-200 bg-white p-2 text-sm text-ink-800 focus:border-ink-400 focus:outline-none"
        disabled={sending}
        autoFocus
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onSend}
          disabled={sending || !composeText.trim()}
          className="rounded bg-ink-900 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-400"
        >
          {sending ? "sending..." : "send"}
        </button>
        <button
          onClick={onCancel}
          disabled={sending}
          className="rounded border border-ink-200 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-ink-600 transition hover:bg-ink-100"
        >
          cancel
        </button>
        <span className="ml-auto font-mono text-[10px] text-ink-400">{composeText.length} chars</span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// SentDmList - read receipts for DMs the CEO sent.
// Day 5.3: shows "thinking..." for in-flight DMs (responder is mid-process).
// ----------------------------------------------------------------------------

function SentDmList({ dms, agents }: { dms: Dm[]; agents: Map<string, Agent> }) {
  if (dms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-4 text-center">
        <p className="font-mono text-xs text-ink-400">No sent messages yet.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {dms.map((dm) => {
        const recipient = agents.get(dm.to_id);
        // Day 5.3: in-flight indicator. If in_flight_since is set and the DM is unread,
        // the responder is mid-process. Show a "thinking..." badge instead of PENDING.
        const isInFlight =
          !dm.read_at && (dm as Dm & { in_flight_since?: string | null }).in_flight_since;
        return (
          <li key={dm.id} className="rounded-lg border border-ink-200 bg-white p-3">
            <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs">
              <span className="font-mono text-ink-400">to</span>
              <span className="font-medium text-ink-900">{recipient?.name ?? "?"}</span>
              {dm.read_at ? (
                <span className="font-mono text-[10px] text-emerald-600">READ</span>
              ) : isInFlight ? (
                <span className="font-mono text-[10px] text-blue-600">
                  <span className="inline-block animate-pulse">●</span> {recipient?.name?.split(" ")[0] ?? "agent"} is thinking...
                </span>
              ) : (
                <span className="font-mono text-[10px] text-amber-600">PENDING</span>
              )}
              <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(dm.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink-800">{dm.body}</p>
          </li>
        );
      })}
    </ul>
  );
}
