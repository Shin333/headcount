import { z } from "zod";
export declare const TierSchema: z.ZodEnum<["exec", "director", "manager", "associate", "intern", "bot"]>;
export type Tier = z.infer<typeof TierSchema>;
export declare const ModelTierSchema: z.ZodEnum<["sonnet", "haiku", "opus"]>;
export type ModelTier = z.infer<typeof ModelTierSchema>;
export declare const Big5Schema: z.ZodObject<{
    openness: z.ZodNumber;
    conscientiousness: z.ZodNumber;
    extraversion: z.ZodNumber;
    agreeableness: z.ZodNumber;
    neuroticism: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
}, {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
}>;
export type Big5 = z.infer<typeof Big5Schema>;
export declare const PersonalitySchema: z.ZodObject<{
    big5: z.ZodObject<{
        openness: z.ZodNumber;
        conscientiousness: z.ZodNumber;
        extraversion: z.ZodNumber;
        agreeableness: z.ZodNumber;
        neuroticism: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        openness: number;
        conscientiousness: number;
        extraversion: number;
        agreeableness: number;
        neuroticism: number;
    }, {
        openness: number;
        conscientiousness: number;
        extraversion: number;
        agreeableness: number;
        neuroticism: number;
    }>;
    archetype: z.ZodString;
    quirks: z.ZodArray<z.ZodString, "many">;
    voiceExamples: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    big5: {
        openness: number;
        conscientiousness: number;
        extraversion: number;
        agreeableness: number;
        neuroticism: number;
    };
    archetype: string;
    quirks: string[];
    voiceExamples: string[];
}, {
    big5: {
        openness: number;
        conscientiousness: number;
        extraversion: number;
        agreeableness: number;
        neuroticism: number;
    };
    archetype: string;
    quirks: string[];
    voiceExamples: string[];
}>;
export type Personality = z.infer<typeof PersonalitySchema>;
export declare const AgentSchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    name: z.ZodString;
    role: z.ZodString;
    department: z.ZodNullable<z.ZodString>;
    tier: z.ZodEnum<["exec", "director", "manager", "associate", "intern", "bot"]>;
    manager_id: z.ZodNullable<z.ZodString>;
    reports_to_ceo: z.ZodBoolean;
    personality: z.ZodObject<{
        big5: z.ZodObject<{
            openness: z.ZodNumber;
            conscientiousness: z.ZodNumber;
            extraversion: z.ZodNumber;
            agreeableness: z.ZodNumber;
            neuroticism: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            openness: number;
            conscientiousness: number;
            extraversion: number;
            agreeableness: number;
            neuroticism: number;
        }, {
            openness: number;
            conscientiousness: number;
            extraversion: number;
            agreeableness: number;
            neuroticism: number;
        }>;
        archetype: z.ZodString;
        quirks: z.ZodArray<z.ZodString, "many">;
        voiceExamples: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        big5: {
            openness: number;
            conscientiousness: number;
            extraversion: number;
            agreeableness: number;
            neuroticism: number;
        };
        archetype: string;
        quirks: string[];
        voiceExamples: string[];
    }, {
        big5: {
            openness: number;
            conscientiousness: number;
            extraversion: number;
            agreeableness: number;
            neuroticism: number;
        };
        archetype: string;
        quirks: string[];
        voiceExamples: string[];
    }>;
    background: z.ZodNullable<z.ZodString>;
    frozen_core: z.ZodString;
    manager_overlay: z.ZodString;
    learned_addendum: z.ZodString;
    allowed_tools: z.ZodArray<z.ZodString, "many">;
    model_tier: z.ZodEnum<["sonnet", "haiku", "opus"]>;
    status: z.ZodEnum<["active", "paused", "terminated"]>;
    daily_token_budget: z.ZodNumber;
    tokens_used_today: z.ZodNumber;
    addendum_loop_active: z.ZodDefault<z.ZodBoolean>;
    chatter_posts_today: z.ZodDefault<z.ZodNumber>;
    last_reset_company_date: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    last_reflection_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tool_access: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    always_on: z.ZodDefault<z.ZodBoolean>;
    in_standup: z.ZodDefault<z.ZodBoolean>;
    is_human: z.ZodDefault<z.ZodBoolean>;
    tic: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "active" | "paused" | "terminated";
    id: string;
    tenant_id: string;
    name: string;
    role: string;
    department: string | null;
    tier: "exec" | "director" | "manager" | "associate" | "intern" | "bot";
    manager_id: string | null;
    reports_to_ceo: boolean;
    personality: {
        big5: {
            openness: number;
            conscientiousness: number;
            extraversion: number;
            agreeableness: number;
            neuroticism: number;
        };
        archetype: string;
        quirks: string[];
        voiceExamples: string[];
    };
    background: string | null;
    frozen_core: string;
    manager_overlay: string;
    learned_addendum: string;
    allowed_tools: string[];
    model_tier: "sonnet" | "haiku" | "opus";
    daily_token_budget: number;
    tokens_used_today: number;
    addendum_loop_active: boolean;
    chatter_posts_today: number;
    last_reset_company_date: string | null;
    last_reflection_at: string | null;
    tool_access: string[];
    always_on: boolean;
    in_standup: boolean;
    is_human: boolean;
    tic: string | null;
    created_at: string;
    updated_at: string;
}, {
    status: "active" | "paused" | "terminated";
    id: string;
    tenant_id: string;
    name: string;
    role: string;
    department: string | null;
    tier: "exec" | "director" | "manager" | "associate" | "intern" | "bot";
    manager_id: string | null;
    reports_to_ceo: boolean;
    personality: {
        big5: {
            openness: number;
            conscientiousness: number;
            extraversion: number;
            agreeableness: number;
            neuroticism: number;
        };
        archetype: string;
        quirks: string[];
        voiceExamples: string[];
    };
    background: string | null;
    frozen_core: string;
    manager_overlay: string;
    learned_addendum: string;
    allowed_tools: string[];
    model_tier: "sonnet" | "haiku" | "opus";
    daily_token_budget: number;
    tokens_used_today: number;
    created_at: string;
    updated_at: string;
    addendum_loop_active?: boolean | undefined;
    chatter_posts_today?: number | undefined;
    last_reset_company_date?: string | null | undefined;
    last_reflection_at?: string | null | undefined;
    tool_access?: string[] | undefined;
    always_on?: boolean | undefined;
    in_standup?: boolean | undefined;
    is_human?: boolean | undefined;
    tic?: string | null | undefined;
}>;
export type Agent = z.infer<typeof AgentSchema>;
export declare const ForumPostSchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    channel: z.ZodString;
    author_id: z.ZodString;
    parent_id: z.ZodNullable<z.ZodString>;
    body: z.ZodString;
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    tenant_id: string;
    created_at: string;
    channel: string;
    author_id: string;
    parent_id: string | null;
    body: string;
    metadata: Record<string, unknown>;
}, {
    id: string;
    tenant_id: string;
    created_at: string;
    channel: string;
    author_id: string;
    parent_id: string | null;
    body: string;
    metadata: Record<string, unknown>;
}>;
export type ForumPost = z.infer<typeof ForumPostSchema>;
export declare const DmSchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    from_id: z.ZodString;
    to_id: z.ZodString;
    body: z.ZodString;
    read_at: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    tenant_id: string;
    created_at: string;
    body: string;
    from_id: string;
    to_id: string;
    read_at: string | null;
}, {
    id: string;
    tenant_id: string;
    created_at: string;
    body: string;
    from_id: string;
    to_id: string;
    read_at: string | null;
}>;
export type Dm = z.infer<typeof DmSchema>;
export declare const ProposalStatusSchema: z.ZodEnum<["pending", "approved", "rejected", "applied"]>;
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export declare const PromptEvolutionEntrySchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    agent_id: z.ZodString;
    old_value: z.ZodNullable<z.ZodString>;
    new_value: z.ZodNullable<z.ZodString>;
    reason: z.ZodNullable<z.ZodString>;
    proposed_by: z.ZodString;
    status: z.ZodEnum<["pending", "approved", "rejected", "applied"]>;
    reviewed_by_ceo_at: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "pending" | "approved" | "rejected" | "applied";
    id: string;
    tenant_id: string;
    created_at: string;
    agent_id: string;
    old_value: string | null;
    new_value: string | null;
    reason: string | null;
    proposed_by: string;
    reviewed_by_ceo_at: string | null;
}, {
    status: "pending" | "approved" | "rejected" | "applied";
    id: string;
    tenant_id: string;
    created_at: string;
    agent_id: string;
    old_value: string | null;
    new_value: string | null;
    reason: string | null;
    proposed_by: string;
    reviewed_by_ceo_at: string | null;
}>;
export type PromptEvolutionEntry = z.infer<typeof PromptEvolutionEntrySchema>;
export declare const Channels: {
    readonly ANNOUNCEMENTS: "announcements";
    readonly GENERAL: "general";
    readonly WATERCOOLER: "watercooler";
    readonly STANDUP: "standup";
    readonly CEO_BRIEF: "ceo-brief";
};
export type Channel = (typeof Channels)[keyof typeof Channels];
export declare const COST_PER_M_TOKENS: {
    readonly sonnet: {
        readonly input_fresh: 3;
        readonly input_cached: 0.3;
        readonly output: 15;
    };
    readonly haiku: {
        readonly input_fresh: 1;
        readonly input_cached: 0.1;
        readonly output: 5;
    };
    readonly opus: {
        readonly input_fresh: 5;
        readonly input_cached: 0.5;
        readonly output: 25;
    };
};
export declare const ReportSchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    ritual_name: z.ZodString;
    agent_id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    company_date: z.ZodString;
    metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    tenant_id: string;
    created_at: string;
    body: string;
    metadata: Record<string, unknown>;
    agent_id: string;
    ritual_name: string;
    title: string;
    company_date: string;
}, {
    id: string;
    tenant_id: string;
    created_at: string;
    body: string;
    agent_id: string;
    ritual_name: string;
    title: string;
    company_date: string;
    metadata?: Record<string, unknown> | undefined;
}>;
export type Report = z.infer<typeof ReportSchema>;
export declare const ReportRunSchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    ritual_name: z.ZodString;
    last_run_at: z.ZodNullable<z.ZodString>;
    last_run_company_date: z.ZodNullable<z.ZodString>;
    next_run_at: z.ZodString;
    metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    tenant_id: string;
    created_at: string;
    updated_at: string;
    metadata: Record<string, unknown>;
    ritual_name: string;
    last_run_at: string | null;
    last_run_company_date: string | null;
    next_run_at: string;
}, {
    id: string;
    tenant_id: string;
    created_at: string;
    updated_at: string;
    ritual_name: string;
    last_run_at: string | null;
    last_run_company_date: string | null;
    next_run_at: string;
    metadata?: Record<string, unknown> | undefined;
}>;
export type ReportRun = z.infer<typeof ReportRunSchema>;
export declare const DepartmentSchema: z.ZodObject<{
    id: z.ZodString;
    tenant_id: z.ZodString;
    slug: z.ZodString;
    display_name: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    display_order: z.ZodNumber;
    head_agent_id: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    tenant_id: string;
    created_at: string;
    slug: string;
    display_name: string;
    description: string | null;
    display_order: number;
    head_agent_id: string | null;
}, {
    id: string;
    tenant_id: string;
    created_at: string;
    slug: string;
    display_name: string;
    description: string | null;
    display_order: number;
    head_agent_id: string | null;
}>;
export type Department = z.infer<typeof DepartmentSchema>;
