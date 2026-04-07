import { db } from "../db.js";
import { config } from "../config.js";
import type { Channel } from "@headcount/shared";

export async function postToForum(args: {
  channel: Channel;
  authorId: string;
  body: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { data, error } = await db
    .from("forum_posts")
    .insert({
      tenant_id: config.tenantId,
      channel: args.channel,
      author_id: args.authorId,
      body: args.body,
      parent_id: args.parentId ?? null,
      metadata: args.metadata ?? {},
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Failed to post to forum: " + error?.message);
  }

  return { id: data.id };
}
