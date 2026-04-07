import { createClient } from "@supabase/supabase-js";
import { env } from "./config.js";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
