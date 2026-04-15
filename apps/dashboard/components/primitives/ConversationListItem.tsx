// ============================================================================
// components/primitives/ConversationListItem.tsx - Day 12a.1
// ----------------------------------------------------------------------------
// One row in the MessagesView left rail. Shows the partner's name, role,
// last message preview, relative time, and an unread indicator.
// ============================================================================

"use client";

import type { Conversation } from "../lib/conversationsFromDms";
import { formatRelativeShort, previewBody } from "../lib/conversationsFromDms";

export function ConversationListItem({
  conversation,
  isActive,
  onClick,
}: {
  conversation: Conversation;
  isActive: boolean;
  onClick: () => void;
}) {
  const { partner, lastMessage, unreadCount } = conversation;
  const hasUnread = unreadCount > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-3 transition border-l-2 ${
        isActive
          ? "border-l-ink-900 bg-ink-50"
          : hasUnread
            ? "border-l-amber-400 bg-white hover:bg-ink-50"
            : "border-l-transparent bg-white hover:bg-ink-50"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={`font-mono text-[10px] leading-none ${
            hasUnread ? "text-amber-600" : "text-ink-300"
          }`}
          aria-hidden
        >
          {hasUnread ? "●" : "○"}
        </span>
        <span
          className={`flex-1 truncate text-sm ${
            hasUnread ? "font-semibold text-ink-900" : "font-medium text-ink-800"
          }`}
        >
          {partner?.name ?? "Unknown"}
        </span>
        <span className="font-mono text-[10px] text-ink-400">
          {formatRelativeShort(lastMessage.created_at)}
        </span>
      </div>
      {partner?.role && (
        <div className="ml-4 mt-0.5 truncate text-[11px] text-ink-400">
          {partner.role}
        </div>
      )}
      <div
        className={`ml-4 mt-1 truncate text-xs ${
          hasUnread ? "text-ink-700" : "text-ink-500"
        }`}
      >
        {previewBody(lastMessage.body)}
      </div>
      {hasUnread && (
        <div className="ml-4 mt-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-amber-800">
          {unreadCount} new
        </div>
      )}
    </button>
  );
}
