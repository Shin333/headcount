// Day 1 stub. Day 2 wires this to memories table + pgvector.
// We export the same surface so the runner doesn't need to change later.

export interface MemoryRecord {
  type: "observation" | "reflection" | "identity";
  content: string;
  importance: number;
}

export async function retrieveMemories(
  _agentId: string,
  _query: string,
  _opts: { topK?: number } = {}
): Promise<MemoryRecord[]> {
  // Day 1: agents have no memory yet. They wake up fresh every day.
  return [];
}

export async function recordObservation(
  _agentId: string,
  _content: string,
  _importance: number = 5
): Promise<void> {
  // Day 1: no-op. Day 2: insert into memories table.
}
