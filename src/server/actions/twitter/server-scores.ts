'use server'

export interface ServerScoredUser {
  handle: string
  score: number
  role: string
  reason: string
}

// This standalone build has no DB. Stubs return empty / ok so the page
// keeps working — the IDB cache handles cross-session storage on its
// own. Wire these to real DB calls if you fork and add Postgres.

export async function loadServerScores(
  _criteriaHash: string,
  _handles: string[],
): Promise<ServerScoredUser[]> {
  return []
}

export async function saveServerScores(
  _criteriaHash: string,
  _scores: ServerScoredUser[],
): Promise<{ ok: boolean; error?: string; written?: number }> {
  return { ok: true, written: 0 }
}
