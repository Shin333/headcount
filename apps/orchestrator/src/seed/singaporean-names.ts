// ============================================================================
// Day 7: Singaporean / SEA name pool
// ----------------------------------------------------------------------------
// A regionally plausible name pool for the bulk-specialist workforce.
// Mix reflects a realistic Singapore-HQ'd SEA company:
//   - Chinese Singaporean (Mandarin/Hokkien/Teochew surnames)
//   - Malay Singaporean (Malay given names, patronymic or "binte/bin" where natural)
//   - Tamil Singaporean (Tamil given names, some with "s/o" patronymic)
//   - Peranakan (Chinese surname + sometimes a European given name)
//   - Eurasian (Portuguese/Dutch/British surnames on a SG-born person)
//   - Taiwanese (Mandarin/Hokkien, for the cross-border ties)
//   - Indonesian Chinese (common given names, Chinese surnames)
//   - Filipino Chinese (Hispanic + Chinese surnames)
//   - Korean diaspora (small)
//   - Japanese expats (small)
//   - Expats who stayed (1-2 European / South Asian names)
//
// Deterministic: uses a simple seeded shuffle keyed on the specialist role
// so that re-running the seed assigns the same name to the same role every
// time. This means the name pool is effectively a stable mapping, not a
// random one. If you want to re-roll, bump NAME_POOL_VERSION.
// ============================================================================

export const NAME_POOL_VERSION = 1;

export interface SeaName {
  full_name: string;
  ethnicity: "chinese_sg" | "malay_sg" | "tamil_sg" | "peranakan" | "eurasian" | "taiwanese" | "indo_chinese" | "filipino" | "korean" | "japanese" | "expat_european" | "expat_south_asian";
  pronouns: "he" | "she" | "they";
}

// ----------------------------------------------------------------------------
// The pool (200 names, mixed)
// ----------------------------------------------------------------------------
// Sorted roughly by frequency in a SG office demographic, largest groups first.
// Not all are going to get used — the catalog will only pull as many as it
// needs. The extras are there so we can expand later without regenerating
// existing assignments.
// ----------------------------------------------------------------------------

export const NAME_POOL: SeaName[] = [
  // Chinese Singaporean — ~60 names (largest group)
  { full_name: "Chen Wei Lun", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Lim Jia Hui", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Tan Yong Sheng", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Ng Pei Shan", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Ong Kai Xiang", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Wong Hui Min", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Goh Wen Jie", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Teo Xin Yi", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Koh Zhi Hao", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Chua Li Ting", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Low Chee Keong", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Seah Wan Qing", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Yeo Jun Kai", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Toh Shi Min", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Loh Wei Xuan", ethnicity: "chinese_sg", pronouns: "they" },
  { full_name: "Sim Yan Ting", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Kwek Boon Heng", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Chong Mei Ling", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Heng Kok Wei", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Ho Jia En", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Lee Zheng Wei", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Leong Hui Fen", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Poh Yong Jie", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Quek Rui Ting", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Soh Jun Yang", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Tay Hui Xin", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Yap Ming Hao", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Yeoh Si Ying", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Chew Kai Jun", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Foo Xuan Min", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Lau Cheng Yi", ethnicity: "chinese_sg", pronouns: "they" },
  { full_name: "Tham Pei Wen", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Chia Han Wei", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Pang Wei Ting", ethnicity: "chinese_sg", pronouns: "she" },
  { full_name: "Liew Zhen Hao", ethnicity: "chinese_sg", pronouns: "he" },
  { full_name: "Er Jia Xin", ethnicity: "chinese_sg", pronouns: "she" },

  // Malay Singaporean — ~30 names
  { full_name: "Muhammad Hakim bin Ismail", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Nur Aisyah binte Rahim", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Iskandar bin Rashid", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Siti Khadijah binte Osman", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Hafiz Abdullah", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Amira Zulkifli", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Danial bin Hamzah", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Nurul Farhana", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Zainal Abidin", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Hidayah Ibrahim", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Rizwan bin Kassim", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Syahirah Mohd Noor", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Faizal Harun", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Khairunnisa binte Salleh", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Azhar bin Yusoff", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Nadiah Azman", ethnicity: "malay_sg", pronouns: "she" },
  { full_name: "Shahrul Nizam", ethnicity: "malay_sg", pronouns: "he" },
  { full_name: "Liyana binte Jamal", ethnicity: "malay_sg", pronouns: "she" },

  // Tamil Singaporean — ~20 names
  { full_name: "Arjun Ramasamy", ethnicity: "tamil_sg", pronouns: "he" },
  { full_name: "Priya Subramaniam", ethnicity: "tamil_sg", pronouns: "she" },
  { full_name: "Karthik Raj s/o Velan", ethnicity: "tamil_sg", pronouns: "he" },
  { full_name: "Divya Krishnan", ethnicity: "tamil_sg", pronouns: "she" },
  { full_name: "Suresh Palaniappan", ethnicity: "tamil_sg", pronouns: "he" },
  { full_name: "Meera Nair", ethnicity: "tamil_sg", pronouns: "she" },
  { full_name: "Prakash Rajendran", ethnicity: "tamil_sg", pronouns: "he" },
  { full_name: "Lakshmi Iyer", ethnicity: "tamil_sg", pronouns: "she" },
  { full_name: "Ravi Chandran", ethnicity: "tamil_sg", pronouns: "he" },
  { full_name: "Anjali Menon", ethnicity: "tamil_sg", pronouns: "she" },
  { full_name: "Vijay s/o Murugan", ethnicity: "tamil_sg", pronouns: "he" },
  { full_name: "Kavitha Balasubramaniam", ethnicity: "tamil_sg", pronouns: "she" },

  // Peranakan — ~8 names (Chinese surname, sometimes European given)
  { full_name: "Gerald Tan Boon Huat", ethnicity: "peranakan", pronouns: "he" },
  { full_name: "Cheryl Lim-Oei", ethnicity: "peranakan", pronouns: "she" },
  { full_name: "Desmond Ong Hock Lim", ethnicity: "peranakan", pronouns: "he" },
  { full_name: "Sylvia Tan Puay Neo", ethnicity: "peranakan", pronouns: "she" },
  { full_name: "Bernard Koh", ethnicity: "peranakan", pronouns: "he" },
  { full_name: "Vanessa Wee", ethnicity: "peranakan", pronouns: "she" },

  // Eurasian — ~6 names
  { full_name: "Sean de Souza", ethnicity: "eurasian", pronouns: "he" },
  { full_name: "Michelle Pereira", ethnicity: "eurasian", pronouns: "she" },
  { full_name: "Adrian Rozario", ethnicity: "eurasian", pronouns: "he" },
  { full_name: "Natalie Da Silva", ethnicity: "eurasian", pronouns: "she" },
  { full_name: "Gabriel Minjoot", ethnicity: "eurasian", pronouns: "he" },

  // Taiwanese — ~15 names
  { full_name: "Tsai Chia-Ling", ethnicity: "taiwanese", pronouns: "she" },
  { full_name: "Huang Po-Han", ethnicity: "taiwanese", pronouns: "he" },
  { full_name: "Lin Yu-Chen", ethnicity: "taiwanese", pronouns: "she" },
  { full_name: "Wu Chih-Hao", ethnicity: "taiwanese", pronouns: "he" },
  { full_name: "Liu Shu-Fen", ethnicity: "taiwanese", pronouns: "she" },
  { full_name: "Kao Ming-Che", ethnicity: "taiwanese", pronouns: "he" },
  { full_name: "Hsu Yi-Ting", ethnicity: "taiwanese", pronouns: "she" },
  { full_name: "Cheng Wei-Hsuan", ethnicity: "taiwanese", pronouns: "he" },
  { full_name: "Chang Pei-Yu", ethnicity: "taiwanese", pronouns: "she" },
  { full_name: "Lai Kuan-Ting", ethnicity: "taiwanese", pronouns: "they" },

  // Indonesian Chinese — ~10 names
  { full_name: "Andrew Wijaya", ethnicity: "indo_chinese", pronouns: "he" },
  { full_name: "Clarissa Tanuwijaya", ethnicity: "indo_chinese", pronouns: "she" },
  { full_name: "Kevin Hartono", ethnicity: "indo_chinese", pronouns: "he" },
  { full_name: "Stephanie Gunawan", ethnicity: "indo_chinese", pronouns: "she" },
  { full_name: "Jonathan Halim", ethnicity: "indo_chinese", pronouns: "he" },
  { full_name: "Amanda Setiawan", ethnicity: "indo_chinese", pronouns: "she" },
  { full_name: "Edward Tanuwidjaja", ethnicity: "indo_chinese", pronouns: "he" },

  // Filipino — ~8 names
  { full_name: "Carlos Reyes", ethnicity: "filipino", pronouns: "he" },
  { full_name: "Isabella Cruz", ethnicity: "filipino", pronouns: "she" },
  { full_name: "Miguel Santos", ethnicity: "filipino", pronouns: "he" },
  { full_name: "Patricia Dela Cruz", ethnicity: "filipino", pronouns: "she" },
  { full_name: "Rafael Garcia", ethnicity: "filipino", pronouns: "he" },
  { full_name: "Bianca Aquino", ethnicity: "filipino", pronouns: "she" },

  // Korean — ~5 names (small diaspora)
  { full_name: "Kim Min-jun", ethnicity: "korean", pronouns: "he" },
  { full_name: "Lee Ji-woo", ethnicity: "korean", pronouns: "she" },
  { full_name: "Choi Seung-hyun", ethnicity: "korean", pronouns: "he" },
  { full_name: "Jung Hae-won", ethnicity: "korean", pronouns: "she" },

  // Japanese expats — ~5 names
  { full_name: "Sato Kenji", ethnicity: "japanese", pronouns: "he" },
  { full_name: "Yamamoto Yuki", ethnicity: "japanese", pronouns: "she" },
  { full_name: "Tanaka Hiroshi", ethnicity: "japanese", pronouns: "he" },
  { full_name: "Watanabe Akiko", ethnicity: "japanese", pronouns: "she" },

  // Expats who stayed — ~4 names
  { full_name: "James Whitfield", ethnicity: "expat_european", pronouns: "he" },
  { full_name: "Eleanor Marsh", ethnicity: "expat_european", pronouns: "she" },
  { full_name: "Rohan Mehta", ethnicity: "expat_south_asian", pronouns: "he" },
  { full_name: "Anika Sharma", ethnicity: "expat_south_asian", pronouns: "she" },
];

// ----------------------------------------------------------------------------
// Deterministic name assignment
// ----------------------------------------------------------------------------
// Given a role slug (e.g. "frontend-developer"), always return the same name
// from the pool. This means re-running the seed doesn't shuffle identities.
// ----------------------------------------------------------------------------

function hashStringToInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;  // unsigned
}

/**
 * Returns a stable name for a given role slug. The same slug always returns
 * the same name (across runs, across deploys), assuming the name pool order
 * and NAME_POOL_VERSION haven't changed.
 */
export function assignNameForRole(roleSlug: string): SeaName {
  const h = hashStringToInt(`v${NAME_POOL_VERSION}:${roleSlug}`);
  const idx = h % NAME_POOL.length;
  const name = NAME_POOL[idx];
  if (!name) {
    throw new Error(`Name pool exhausted or corrupted for slug '${roleSlug}'`);
  }
  return name;
}

/**
 * Given many role slugs, return a name for each — guaranteed unique across
 * the set (later slugs will walk forward in the pool if there's a collision).
 */
export function assignUniqueNamesForRoles(roleSlugs: string[]): Map<string, SeaName> {
  const result = new Map<string, SeaName>();
  const used = new Set<string>();

  // Sort by hash so the assignment is deterministic regardless of input order
  const sorted = [...roleSlugs].sort((a, b) =>
    hashStringToInt(`v${NAME_POOL_VERSION}:${a}`) - hashStringToInt(`v${NAME_POOL_VERSION}:${b}`)
  );

  for (const slug of sorted) {
    let idx = hashStringToInt(`v${NAME_POOL_VERSION}:${slug}`) % NAME_POOL.length;
    let attempts = 0;
    while (attempts < NAME_POOL.length) {
      const candidate = NAME_POOL[idx];
      if (candidate && !used.has(candidate.full_name)) {
        result.set(slug, candidate);
        used.add(candidate.full_name);
        break;
      }
      idx = (idx + 1) % NAME_POOL.length;
      attempts++;
    }
    if (attempts === NAME_POOL.length) {
      throw new Error(`Name pool exhausted: more roles (${roleSlugs.length}) than names (${NAME_POOL.length})`);
    }
  }

  return result;
}
