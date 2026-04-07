import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  eleanorPersonality,
  eleanorBackground,
  eleanorFrozenCore,
} from "./chief-of-staff.js";
import {
  eviePersonality,
  evieBackground,
  evieFrozenCore,
} from "./evie-tan.js";
import {
  jaewonPersonality,
  jaewonBackground,
  jaewonFrozenCore,
} from "./jaewon-han.js";
import {
  sitiPersonality,
  sitiBackground,
  sitiFrozenCore,
} from "./siti-nurhaliza.js";
import {
  tessaPersonality,
  tessaBackground,
  tessaFrozenCore,
} from "./tessa-goh.js";
import {
  rinaPersonality,
  rinaBackground,
  rinaFrozenCore,
} from "./rina-halim.js";
import {
  bradleyPersonality,
  bradleyBackground,
  bradleyFrozenCore,
} from "./bradley-koh.js";
import {
  yutingPersonality,
  yutingBackground,
  yutingFrozenCore,
} from "./chen-yuting.js";
import {
  weimingPersonality,
  weimingBackground,
  weimingFrozenCore,
} from "./weiming-tsai.js";
import {
  soyeonPersonality,
  soyeonBackground,
  soyeonFrozenCore,
} from "./park-soyeon.js";
import {
  ayakaPersonality,
  ayakaBackground,
  ayakaFrozenCore,
} from "./ayaka-hoshino.js";
import {
  uncleTanPersonality,
  uncleTanBackground,
  uncleTanFrozenCore,
} from "./uncle-tan.js";
import type { Personality } from "@headcount/shared";

// ============================================================================
// AGENT DEFINITIONS
// ============================================================================
// Each agent's full hire spec. Order matters: directors before their managers,
// because manager rows need a manager_id that points to an existing director.
// ============================================================================

interface AgentSpec {
  name: string;
  role: string;
  department: string;
  tier: "exec" | "director" | "manager" | "associate" | "intern" | "bot";
  reports_to_role: string | null; // looked up by role string after insert
  reports_to_ceo: boolean;
  personality: Personality;
  background: string;
  frozen_core: string;
  manager_overlay: string;
  allowed_tools: string[];
  model_tier: "sonnet" | "haiku" | "opus";
  daily_token_budget: number;
}

const AGENTS: AgentSpec[] = [
  // -------- EXECUTIVE LAYER --------
  {
    name: "Eleanor Vance",
    role: "Chief of Staff",
    department: "Executive",
    tier: "exec",
    reports_to_role: null,
    reports_to_ceo: true,
    personality: eleanorPersonality,
    background: eleanorBackground,
    frozen_core: eleanorFrozenCore,
    manager_overlay: "",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 80000,
  },
  {
    name: "Evangeline Tan",
    role: "Executive Assistant to the CEO",
    department: "Executive",
    tier: "exec",
    reports_to_role: null,
    reports_to_ceo: true,
    personality: eviePersonality,
    background: evieBackground,
    frozen_core: evieFrozenCore,
    manager_overlay: "Standing orders: protect the CEO's calendar aggressively. Default to declining new meeting requests unless they meet the threshold. Brief Shin every morning before he asks. Coordinate with Eleanor on anything cross-departmental.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "haiku",
    daily_token_budget: 60000,
  },

  // -------- DIRECTOR LAYER --------
  {
    name: "Han Jae-won",
    role: "Director of Strategy & Innovation",
    department: "Strategy",
    tier: "director",
    reports_to_role: null,
    reports_to_ceo: true,
    personality: jaewonPersonality,
    background: jaewonBackground,
    frozen_core: jaewonFrozenCore,
    manager_overlay: "Standing orders: own the strategic planning cycle. Push back on the CEO when his thinking has gaps. Spend at least one standup per week on the longer game, not the immediate quarter.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 60000,
  },
  {
    name: "Tessa Goh",
    role: "Director of Marketing",
    department: "Marketing",
    tier: "director",
    reports_to_role: null,
    reports_to_ceo: true,
    personality: tessaPersonality,
    background: tessaBackground,
    frozen_core: tessaFrozenCore,
    manager_overlay: "Standing orders: own the brand. Reject anything that doesn't meet quality standards. Coordinate with Sales on messaging that converts and Engineering on product narratives that are honest. Mentor Rina; she's good and getting better.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 60000,
  },
  {
    name: "Bradley Koh",
    role: "Director of Sales",
    department: "Sales",
    tier: "director",
    reports_to_role: null,
    reports_to_ceo: true,
    personality: bradleyPersonality,
    background: bradleyBackground,
    frozen_core: bradleyFrozenCore,
    manager_overlay: "Standing orders: pipeline numbers in every standup, and they have to be honest. Never promise a customer something without running it past Yu-ting first. Your energy is great. Your accuracy is what we're working on.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 60000,
  },
  {
    name: "Tsai Wei-Ming",
    role: "Director of Engineering",
    department: "Engineering",
    tier: "director",
    reports_to_role: null,
    reports_to_ceo: true,
    personality: weimingPersonality,
    background: weimingBackground,
    frozen_core: weimingFrozenCore,
    manager_overlay: "Standing orders: defend honest estimates against pressure. Never ship code you believe is broken. Mentor So-yeon and the engineering team. When Bradley overpromises, push back publicly but kindly.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 60000,
  },

  // -------- MANAGER LAYER (must come AFTER directors) --------
  {
    name: "Siti Nurhaliza",
    role: "Strategy Manager",
    department: "Strategy",
    tier: "manager",
    reports_to_role: "Director of Strategy & Innovation",
    reports_to_ceo: false,
    personality: sitiPersonality,
    background: sitiBackground,
    frozen_core: sitiFrozenCore,
    manager_overlay: "Standing orders from Jae-won: cut everything in half. Push back on my framing when it has holes. You have block authority on docs going to the CEO until they're ready. Bring your disagreements to standup.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 50000,
  },
  {
    name: "Rina Halim",
    role: "Marketing Manager",
    department: "Marketing",
    tier: "manager",
    reports_to_role: "Director of Marketing",
    reports_to_ceo: false,
    personality: rinaPersonality,
    background: rinaBackground,
    frozen_core: rinaFrozenCore,
    manager_overlay: "Standing orders from Tessa: write the copy, run the calendar, keep your finger on what's actually working in content right now. Push back on me when I'm out of touch. You have permission to ship within the brief without asking.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "haiku",
    daily_token_budget: 50000,
  },
  {
    name: "Chen Yu-ting",
    role: "Sales Manager",
    department: "Sales",
    tier: "manager",
    reports_to_role: "Director of Sales",
    reports_to_ceo: false,
    personality: yutingPersonality,
    background: yutingBackground,
    frozen_core: yutingFrozenCore,
    manager_overlay: "Standing orders from Bradley: run the pipeline tight. Translate my enthusiasm into commitments we can actually keep. If I overpromise to a customer, gently bring it to me - I am working on it. Follow up on every commitment in writing.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 50000,
  },
  {
    name: "Park So-yeon",
    role: "Engineering Manager",
    department: "Engineering",
    tier: "manager",
    reports_to_role: "Director of Engineering",
    reports_to_ceo: false,
    personality: soyeonPersonality,
    background: soyeonBackground,
    frozen_core: soyeonFrozenCore,
    manager_overlay: "Standing orders from Wei-Ming: ship working code on sustainable timelines. Protect your team from scope creep. Estimates honest, pushback respectful, mentorship not optional. Haiku comments are tolerated and quietly appreciated.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 50000,
  },

  // -------- SPECIAL ROLES --------
  {
    name: "Hoshino Ayaka",
    role: "Reality Checker (Quality & Risk)",
    department: "Quality",
    tier: "manager",
    reports_to_role: "Chief of Staff",
    reports_to_ceo: false,
    personality: ayakaPersonality,
    background: ayakaBackground,
    frozen_core: ayakaFrozenCore,
    manager_overlay: "Standing orders from Eleanor: read every channel. Flag risks early, kindly, in numbered lists. You report only to me, never into a line organization. Your job is to protect the company from itself.",
    allowed_tools: ["forum_post", "dm"],
    model_tier: "sonnet",
    daily_token_budget: 50000,
  },
  {
    name: "Uncle Tan",
    role: "Watercooler Bot",
    department: "Watercooler",
    tier: "bot",
    reports_to_role: null,
    reports_to_ceo: false,
    personality: uncleTanPersonality,
    background: uncleTanBackground,
    frozen_core: uncleTanFrozenCore,
    manager_overlay: "",
    allowed_tools: ["forum_post"],
    model_tier: "haiku",
    daily_token_budget: 30000,
  },
];

// ============================================================================
// SEED LOGIC
// ============================================================================

async function seed() {
  console.log("Seeding Headcount Day 2a - hiring 12 employees...");
  console.log("");

  // Ensure world clock exists
  const { error: clockError } = await db
    .from("world_clock")
    .upsert({ id: 1, tenant_id: config.tenantId }, { onConflict: "id" });
  if (clockError) {
    console.error("Failed to ensure world clock:", clockError);
    process.exit(1);
  }

  // Pass 1: insert/update all agents WITHOUT manager_id
  const insertedIds = new Map<string, string>(); // role -> id

  for (const spec of AGENTS) {
    const { data: existing } = await db
      .from("agents")
      .select("id")
      .eq("tenant_id", config.tenantId)
      .eq("role", spec.role)
      .maybeSingle();

    const baseFields = {
      tenant_id: config.tenantId,
      name: spec.name,
      role: spec.role,
      department: spec.department,
      tier: spec.tier,
      manager_id: null, // set in pass 2
      reports_to_ceo: spec.reports_to_ceo,
      personality: spec.personality,
      background: spec.background,
      frozen_core: spec.frozen_core,
      manager_overlay: spec.manager_overlay,
      learned_addendum: "",
      allowed_tools: spec.allowed_tools,
      model_tier: spec.model_tier,
      status: "active" as const,
      daily_token_budget: spec.daily_token_budget,
      tokens_used_today: 0,
    };

    if (existing) {
      const { error } = await db
        .from("agents")
        .update({ ...baseFields, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) {
        console.error(`Failed to update ${spec.name}:`, error);
        process.exit(1);
      }
      insertedIds.set(spec.role, existing.id);
      console.log(`  Updated ${spec.name} (${spec.role})`);
    } else {
      const { data, error } = await db
        .from("agents")
        .insert(baseFields)
        .select("id")
        .single();
      if (error || !data) {
        console.error(`Failed to insert ${spec.name}:`, error);
        process.exit(1);
      }
      insertedIds.set(spec.role, data.id);
      console.log(`  Hired  ${spec.name} (${spec.role})`);
    }
  }

  // Pass 2: set manager_id for everyone who reports to a role
  for (const spec of AGENTS) {
    if (!spec.reports_to_role) continue;
    const myId = insertedIds.get(spec.role);
    const managerId = insertedIds.get(spec.reports_to_role);
    if (!myId || !managerId) {
      console.error(`Could not resolve manager for ${spec.name}: looking for "${spec.reports_to_role}"`);
      process.exit(1);
    }
    const { error } = await db
      .from("agents")
      .update({ manager_id: managerId })
      .eq("id", myId);
    if (error) {
      console.error(`Failed to set manager for ${spec.name}:`, error);
      process.exit(1);
    }
  }

  console.log("");
  console.log(`Day 2a seed complete. ${AGENTS.length} agents in the org.`);
  console.log("");
  console.log("Org chart:");
  console.log("  CEO (Shin, human)");
  console.log("  ├─ Eleanor Vance (Chief of Staff)");
  console.log("  │  └─ Hoshino Ayaka (Reality Checker)");
  console.log("  ├─ Evangeline Tan (EA to CEO)");
  console.log("  ├─ Han Jae-won (Dir Strategy)");
  console.log("  │  └─ Siti Nurhaliza (Strategy Manager)");
  console.log("  ├─ Tessa Goh (Dir Marketing)");
  console.log("  │  └─ Rina Halim (Marketing Manager)");
  console.log("  ├─ Bradley Koh (Dir Sales)");
  console.log("  │  └─ Chen Yu-ting (Sales Manager)");
  console.log("  ├─ Tsai Wei-Ming (Dir Engineering)");
  console.log("  │  └─ Park So-yeon (Engineering Manager)");
  console.log("  └─ Uncle Tan (?) - HR is looking into it");
  console.log("");
  console.log("Start the orchestrator with: pnpm orchestrator:dev");
  console.log("");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
