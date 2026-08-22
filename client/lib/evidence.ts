export type SourceType =
  | "code"
  | "docs"
  | "ticket"
  | "slack"
  | "account"
  | "log"
  | "commit"
  | "pr"
  | "incident"
  | "screen";

export type Evidence = {
  id: string;
  source_type: SourceType;
  locator: string;
  snippet: string;
  score: number;
  retrieved_at: string;
};

export type ToolTraceEntry = {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  evidence: Evidence[];
};

export type Claim = { text: string; evidence_ids: string[] };

export type AgentAnswer = {
  answer: string;
  claims: Claim[];
  confidence: "high" | "medium" | "low";
  abstained: boolean;
  escalation: string | null;
  tool_trace: ToolTraceEntry[];
};

export const SOURCE_ICON: Record<SourceType, string> = {
  code: "💻",
  docs: "📄",
  ticket: "🎫",
  slack: "💬",
  account: "👤",
  log: "📋",
  commit: "🔀",
  pr: "🔃",
  incident: "🚨",
  screen: "🖥️",
};

export const CITATION_RE = /\[(ev_[0-9a-f]+)\]/g;

/** Flatten every tool call's evidence into one ev_id -> Evidence lookup.
 * Evidence only survives in tool_trace (the final `answer` only carries
 * [ev_xxx] markers + claims), so this is the only place the panel can get
 * locator/snippet/score/source_type back for a citation. */
export function buildEvidenceMap(toolTrace: ToolTraceEntry[]): Map<string, Evidence> {
  const map = new Map<string, Evidence>();
  for (const t of toolTrace) {
    for (const e of t.evidence || []) {
      if (!map.has(e.id)) map.set(e.id, e);
    }
  }
  return map;
}

/** The explain_why tool builds its evidence in exact hop order
 * (code -> commit -> pr -> slack...), so the provenance strip just needs
 * that one tool_trace entry's evidence, in order, unmodified. */
export function findProvenanceChain(toolTrace: ToolTraceEntry[]): Evidence[] | null {
  const hop = toolTrace.find((t) => t.tool === "explain_why" && t.evidence.length > 1);
  return hop ? hop.evidence : null;
}
