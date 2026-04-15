// ----------------------------------------------------------------------------
// tools/calendar-read.ts - Google Calendar read-only access for Evie (Day 9b)
// ----------------------------------------------------------------------------
// Reads events from Shin's primary Google Calendar via the Calendar v3 API.
// Uses OAuth credentials stored in agent_credentials, refreshing the access
// token automatically when expired.
//
// This is the FIRST real-world API tool. Every call writes a row to
// real_action_audit so we have a complete log of what Evie has done.
//
// Read-only by design. Day 9b ships no write access. Day 9c+ may add
// calendar_create_event or calendar_update_event behind a draft-and-approve
// flow.
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import type { Tool, ToolResult } from "./types.js";
import { getValidAccessToken } from "../auth/google-oauth.js";

// ----------------------------------------------------------------------------
// Types matching Google Calendar v3 events list response
// ----------------------------------------------------------------------------

interface GoogleEventTime {
  date?: string; // YYYY-MM-DD for all-day events
  dateTime?: string; // ISO 8601 with timezone for timed events
  timeZone?: string;
}

interface GoogleEventAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
}

interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: GoogleEventAttendee[];
  organizer?: { email?: string; displayName?: string };
  htmlLink?: string;
}

interface GoogleEventsListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
}

// ----------------------------------------------------------------------------
// Formatter: Google response → compact structure for the agent
// ----------------------------------------------------------------------------

interface FormattedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  attendees: string[];
  organizer: string | null;
}

function formatEvent(ev: GoogleCalendarEvent): FormattedEvent {
  const startTime = ev.start?.dateTime ?? ev.start?.date ?? "";
  const endTime = ev.end?.dateTime ?? ev.end?.date ?? "";
  const allDay = !ev.start?.dateTime && !!ev.start?.date;

  const attendees = (ev.attendees ?? [])
    .map((a) => a.displayName || a.email || "")
    .filter((s) => s.length > 0);

  const organizer = ev.organizer?.displayName ?? ev.organizer?.email ?? null;

  return {
    id: ev.id,
    title: ev.summary ?? "(no title)",
    start: startTime,
    end: endTime,
    all_day: allDay,
    location: ev.location ?? null,
    description: ev.description ? ev.description.slice(0, 500) : null,
    attendees,
    organizer,
  };
}

// ----------------------------------------------------------------------------
// API call
// ----------------------------------------------------------------------------

async function callCalendarApi(args: {
  accessToken: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
  query: string | null;
}): Promise<{ events: FormattedEvent[]; total: number }> {
  const params = new URLSearchParams({
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    maxResults: String(args.maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (args.query) {
    params.set("q", args.query);
  }

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google Calendar API error: ${res.status} ${errBody}`);
  }

  const data = (await res.json()) as GoogleEventsListResponse;
  const items = data.items ?? [];
  const events = items.map(formatEvent);

  return { events, total: events.length };
}

// ----------------------------------------------------------------------------
// Audit logging
// ----------------------------------------------------------------------------

async function writeAudit(args: {
  agentId: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  resultFull: Record<string, unknown> | null;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
}): Promise<void> {
  await db.from("real_action_audit").insert({
    tenant_id: config.tenantId,
    agent_id: args.agentId,
    tool_name: "calendar_read",
    arguments_json: args.arguments,
    result_summary: args.resultSummary,
    result_full_json: args.resultFull,
    success: args.success,
    error_message: args.errorMessage,
    duration_ms: args.durationMs,
    triggered_by_dm_id: null,
  });
}

// ----------------------------------------------------------------------------
// The tool
// ----------------------------------------------------------------------------

export const calendarReadTool: Tool = {
  real_action: true,
  definition: {
    name: "calendar_read",
    description:
      "Read events from Shin's Google Calendar. Use when he asks about his schedule, meetings, availability, or anything time-related. Always confirm what you found before drawing conclusions. Default range is now to 7 days ahead. Returns events with title, start/end times, location, attendees, and description.",
    input_schema: {
      type: "object",
      properties: {
        time_min: {
          type: "string",
          description:
            "ISO 8601 datetime for the start of the range (e.g. '2026-04-08T00:00:00+08:00'). Default: now.",
        },
        time_max: {
          type: "string",
          description:
            "ISO 8601 datetime for the end of the range. Default: 7 days from time_min.",
        },
        max_results: {
          type: "integer",
          description: "Max events to return. Default: 25, max: 100.",
        },
        query: {
          type: "string",
          description: "Optional free-text search across event titles and descriptions.",
        },
      },
      required: [],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const start = Date.now();

    if (!context) {
      return {
        toolName: "calendar_read",
        content: "Error: calendar_read requires execution context.",
        isError: true,
      };
    }

    // Parse args with defaults
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const timeMin =
      typeof input.time_min === "string" && input.time_min.length > 0
        ? input.time_min
        : now.toISOString();
    const timeMax =
      typeof input.time_max === "string" && input.time_max.length > 0
        ? input.time_max
        : sevenDaysFromNow.toISOString();
    const maxResults =
      typeof input.max_results === "number"
        ? Math.min(Math.max(1, input.max_results), 100)
        : 25;
    const query = typeof input.query === "string" && input.query.length > 0 ? input.query : null;

    const argsForAudit = { time_min: timeMin, time_max: timeMax, max_results: maxResults, query };

    // Look up access token
    const accessToken = await getValidAccessToken({
      agentId: context.agentId,
      provider: "google",
      scope: "calendar.readonly",
    });

    if (!accessToken) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        arguments: argsForAudit,
        resultSummary: "no credentials",
        resultFull: null,
        success: false,
        errorMessage: "No google/calendar.readonly credential found for this agent",
        durationMs,
      });
      return {
        toolName: "calendar_read",
        content:
          "Error: I don't have calendar access yet. Ask Shin to run the grant-evie-calendar.ts script to authorize me.",
        isError: true,
      };
    }

    // Call the API
    let apiResult: { events: FormattedEvent[]; total: number };
    try {
      apiResult = await callCalendarApi({
        accessToken,
        timeMin,
        timeMax,
        maxResults,
        query,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeAudit({
        agentId: context.agentId,
        arguments: argsForAudit,
        resultSummary: "api error",
        resultFull: null,
        success: false,
        errorMessage: errMsg,
        durationMs,
      });
      return {
        toolName: "calendar_read",
        content: `Error calling Google Calendar API: ${errMsg}`,
        isError: true,
      };
    }

    const durationMs = Date.now() - start;
    const summary = `${apiResult.total} event(s) between ${timeMin.slice(0, 10)} and ${timeMax.slice(0, 10)}`;

    await writeAudit({
      agentId: context.agentId,
      arguments: argsForAudit,
      resultSummary: summary,
      resultFull: { events: apiResult.events as unknown as Record<string, unknown> } as Record<string, unknown>,
      success: true,
      errorMessage: null,
      durationMs,
    });

    // Return a structured payload the agent can read directly
    const payload = {
      events: apiResult.events,
      total: apiResult.total,
      time_range: { from: timeMin, to: timeMax },
      query: query ?? null,
    };

    return {
      toolName: "calendar_read",
      content: JSON.stringify(payload, null, 2),
      isError: false,
      structuredPayload: payload as unknown as Record<string, unknown>,
    };
  },
};
