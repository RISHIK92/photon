"use client";

import { useEffect, useState } from "react";

const BRAIN_API_URL = process.env.NEXT_PUBLIC_BRAIN_API_URL || "http://localhost:8000";

type AccountEvidence = { id: string; locator: string; snippet: string };

export default function AccountSummary() {
  const [accounts, setAccounts] = useState<AccountEvidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BRAIN_API_URL}/api/tools/list_accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    })
      .then((r) => r.json())
      .then((d) => setAccounts(d.evidence || []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
        Known accounts — idle
      </h3>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!accounts && !error && <p className="text-neutral-600 text-sm">Loading…</p>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {accounts?.map((a) => (
          <div key={a.id} className="border border-neutral-800 bg-neutral-900 rounded-lg p-3">
            <div className="text-xs font-mono text-neutral-500 mb-1">{a.locator}</div>
            <div className="text-sm text-neutral-300">{a.snippet}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-neutral-600 mt-3">
        Ask about any of these — e.g. &quot;why does Calico get a different Bangalore rate?&quot;
      </p>
    </div>
  );
}
