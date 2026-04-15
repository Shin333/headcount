// ============================================================================
// components/lib/types.ts - Day 11
// ----------------------------------------------------------------------------
// Shared types for the dashboard. Extracted from app/page.tsx during the
// Day 11 refactor. These types describe the shape of rows we read from
// Supabase and pass between dashboard components.
//
// IMPORTANT: this file does NOT import from supabase or any runtime code.
// It is pure types, safe to import anywhere.
// ============================================================================

export interface ForumPost {
  id: string;
  channel: string;
  author_id: string;
  body: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface Dm {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
  manager_id: string | null;
  reports_to_ceo: boolean;
  status: string;
  model_tier: string;
  addendum_loop_active: boolean;
  is_human?: boolean;
  in_standup?: boolean;
  always_on?: boolean;
}

export interface AddendumProposal {
  id: string;
  agent_id: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  proposed_by: string;
  status: string;
  created_at: string;
}

export interface Report {
  id: string;
  ritual_name: string;
  agent_id: string;
  title: string;
  body: string;
  company_date: string;
  created_at: string;
}

// ----------------------------------------------------------------------------
// Department + tier constants (used for sorting and labels)
// ----------------------------------------------------------------------------

export const TIER_ORDER: Record<string, number> = {
  exec: 0,
  director: 1,
  manager: 2,
  associate: 3,
  intern: 4,
  bot: 5,
};

export const TIER_LABEL: Record<string, string> = {
  exec: "EXEC",
  director: "DIR",
  manager: "MGR",
  associate: "ASSOC",
  intern: "INTERN",
  bot: "BOT",
};

// Day 7: 12 departments, slug-keyed (matches agents.department after migration)
export const DEPT_ORDER = [
  "executive",
  "engineering",
  "sales",
  "marketing",
  "operations",
  "finance",
  "legal",
  "people",
  "strategy",
  "design",
  "product",
  "culture",
];

export const DEPT_DISPLAY: Record<string, string> = {
  executive: "Executive",
  engineering: "Engineering",
  sales: "Sales",
  marketing: "Marketing",
  operations: "Operations",
  finance: "Finance",
  legal: "Legal",
  people: "People",
  strategy: "Strategy & Innovation",
  design: "Design",
  product: "Product",
  culture: "Culture",
};
