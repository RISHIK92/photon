"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { githubLoginUrl, login, signup } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "signup" && password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await (mode === "login" ? login(email.trim(), password) : signup(email.trim(), password));
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Photon</h1>
        <p className="text-sm text-neutral-400 mt-1 mb-6">
          Your company brain, on every support call.
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
            type="password"
            required
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
          >
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

        <div className="flex items-center gap-2 my-4 text-xs text-neutral-600">
          <div className="flex-1 h-px bg-neutral-800" />
          or
          <div className="flex-1 h-px bg-neutral-800" />
        </div>

        <a
          href={githubLoginUrl()}
          className="flex items-center justify-center gap-2 border border-neutral-700 hover:border-neutral-500 rounded px-4 py-2 text-sm font-medium"
        >
          Continue with GitHub
        </a>

        <button
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
          className="text-sm text-neutral-400 hover:text-neutral-200 mt-4"
        >
          {mode === "login" ? "No account? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
