/** Browser-side API client for the brain-api.
 *
 * Auth is a JWT bearer token in localStorage, attached to every request,
 * plus the selected workspace id as X-Workspace-Id (the server falls back
 * to the caller's personal workspace when it is absent).
 *
 * Trade-off, stated plainly: localStorage is readable by any script on the
 * page, so an XSS bug leaks the token. The hardened version is an httpOnly
 * cookie set by a Next route handler that proxies the API. This build talks
 * to the brain-api directly from the browser (the call page already does),
 * so the token has to be reachable from JS. Worth revisiting before real
 * customer data lands.
 */
const BASE = process.env.NEXT_PUBLIC_BRAIN_API_URL || "http://localhost:8000";

const TOKEN_KEY = "photon.token";
const WORKSPACE_KEY = "photon.workspace";

export type Workspace = { id: string; name: string; is_personal: boolean; role: string; created_at: string };
export type Repo = {
  id: string;
  name: string;
  source_type: string;
  source_url: string | null;
  status: string;
  file_count: number;
  function_count: number;
  error_message: string | null;
  ingest_seconds: number | null;
  created_at: string;
};

// localStorage throws in some privacy modes; never let that break a render.
function read(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ignore — the app still works, it just won't remember */
  }
}

export const getToken = () => read(TOKEN_KEY);
export const setToken = (t: string | null) => write(TOKEN_KEY, t);
export const getWorkspaceId = () => read(WORKSPACE_KEY);
export const setWorkspaceId = (id: string | null) => write(WORKSPACE_KEY, id);

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const workspace = getWorkspaceId();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (workspace) headers.set("X-Workspace-Id", workspace);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    // The token is gone or expired — drop it so the guard sends them to
    // /login instead of the UI silently showing empty lists forever.
    setToken(null);
    throw new ApiError(401, "Your session expired — please sign in again.");
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function login(email: string, password: string) {
  // The token endpoint is OAuth2 password flow, so it wants form encoding,
  // not JSON — the one place in this client that differs.
  const body = new URLSearchParams({ username: email, password });
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail?.detail || "Incorrect email or password");
  }
  const data = await res.json();
  setToken(data.access_token);
  if (data.workspace?.id) setWorkspaceId(data.workspace.id);
  return data;
}

export async function signup(email: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail?.detail || "Could not create that account");
  }
  return login(email, password);
}

export function logout() {
  setToken(null);
  setWorkspaceId(null);
}

export const listWorkspaces = () => api<Workspace[]>("/api/workspaces");
export const createWorkspace = (name: string) =>
  api<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
export type IngestEstimate = {
  range_human: string;
  seconds_low: number;
  seconds_high: number;
  repo_count: number;
  file_count_estimated: number;
  calibrated: boolean;
  sample_size: number;
};

/** How long importing these repos will take. `size_kb` is what GitHub
 * gives us before cloning; `file_counts` is used when we already know. */
export const estimateIngest = (input: { file_counts?: number[]; size_kb?: number[] }) =>
  api<IngestEstimate>("/api/repos/estimate", {
    method: "POST",
    body: JSON.stringify({ file_counts: input.file_counts ?? [], size_kb: input.size_kb ?? [] }),
  });

export const listRepos = () => api<Repo[]>("/api/repos");
export const connectRepo = (name: string, source_url: string) =>
  api<Repo>("/api/repos", {
    method: "POST",
    body: JSON.stringify({ name, source_type: "github", source_url }),
  });
export const deleteRepo = (id: string) => api<void>(`/api/repos/${id}`, { method: "DELETE" });

// ─── GitHub — sign in and per-workspace org/repo access ────────────────────
// Two separate things sharing one GitHub App: signing in (an alternative to
// email/password) and "Connect GitHub" (installing the app on an org/user
// account to import private repos). See CLAUDE.md for why the install flow
// is a POST-then-redirect instead of a plain <a href> — it needs an
// authenticated call to bind the installation to the right workspace
// before GitHub is ever involved, and a token can't safely ride in a URL
// that's about to redirect to a third party.

/** A plain top-level navigation target — no auth needed to start signing in. */
export const githubLoginUrl = () => `${BASE}/api/auth/github/login`;

export type GitHubInstallation = {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  created_at: string;
};

export const listGithubInstallations = () => api<GitHubInstallation[]>("/api/integrations/github");

/** Authenticated call that returns a URL to navigate to (window.location.href = ...),
 * not a link the user clicks directly. */
export type GithubAppInfo = {
  slug: string;
  name: string;
  owner_login: string;
  owner_type: "User" | "Organization" | string;
  permissions: Record<string, string>;
  installations_count: number;
  /** False when the App is user-owned and private — GitHub then refuses
   * installation anywhere but the owner's own account. */
  org_install_supported: boolean;
  settings_url: string;
};

export const getGithubAppInfo = () => api<GithubAppInfo>("/api/integrations/github/app");

export const startGithubInstall = () =>
  api<{ url: string }>("/api/integrations/github/connect", { method: "POST" });

export type GithubRepoOption = {
  id: number;
  full_name: string;
  private: boolean;
  clone_url: string;
  size_kb: number;
  already_imported: boolean;
};

export const listInstallationRepos = (installationId: number) =>
  api<{ installation: GitHubInstallation; repos: GithubRepoOption[] }>(
    `/api/integrations/github/${installationId}/repos`
  );

export const importGithubRepos = (installationId: number, repos: GithubRepoOption[]) =>
  api<Repo[]>(`/api/integrations/github/${installationId}/repos/import`, {
    method: "POST",
    body: JSON.stringify({
      repos: repos.map((r) => ({ id: r.id, full_name: r.full_name, clone_url: r.clone_url })),
    }),
  });


// ── Meetings ─────────────────────────────────────────────────────────────
// The slug (abcd-efgh) is the LiveKit room name AND the transcript id, so a
// share link, a room and its transcript are one identifier.
export type Meeting = {
  id: string;
  slug: string;
  title: string | null;
  workspace_id: string;
  created_at: string;
  ended_at: string | null;
};

export const createMeeting = (title?: string) =>
  api<Meeting>("/api/meetings", { method: "POST", body: JSON.stringify({ title: title ?? null }) });

export const listMeetings = () => api<Meeting[]>("/api/meetings");

export const getMeeting = (slug: string) => api<Meeting>(`/api/meetings/${slug}`);

export const transcriptUrl = (slug: string, download = false) =>
  `${BASE}/api/meetings/${slug}/transcript.md${download ? "?download=true" : ""}`;


// ── Call setup ───────────────────────────────────────────────────────────
export type BotType = { key: string; label: string; description: string; internal_caution: boolean };
export type LanguageMode = { key: string; label: string; detail: string };
export type CallSource = {
  key: string;
  label: string;
  available: boolean;
  detail: string;
  default_enabled: boolean;
  coming_soon: boolean;
  tools: string[];
};
export type CallOptions = {
  bot_types: BotType[];
  language_modes: LanguageMode[];
  sources: CallSource[];
  default_enabled: string[];
};

export const getCallOptions = () => api<CallOptions>("/api/meetings/options/catalog");

export const createConfiguredMeeting = (config: {
  title?: string | null;
  bot_types: string[];
  language_mode: string;
  enabled_sources: string[];
}) => api<Meeting>("/api/meetings", { method: "POST", body: JSON.stringify(config) });

export const updateMeetingConfig = (
  slug: string,
  config: { bot_types?: string[]; language_mode?: string; enabled_sources?: string[] }
) => api<Meeting>(`/api/meetings/${slug}/config`, { method: "PATCH", body: JSON.stringify(config) });


// ── Connecting sources ───────────────────────────────────────────────────
export type ProviderField = {
  key: string;
  label: string;
  secret?: boolean;
  config?: boolean;
  help?: string;
};
export type ProviderSpec = { fields: ProviderField[] };

/** Linear / Notion / Datadog share one endpoint set; their forms are
 * described by the server so a new provider needs no client change. */
export const getConnectorProviders = () =>
  api<Record<string, ProviderSpec>>("/api/integrations/connectors/providers");

export const connectConnector = (
  provider: string,
  credentials: Record<string, string>,
  config: Record<string, string>
) =>
  api<{ id: string; provider: string }>(`/api/integrations/connectors/${provider}`, {
    method: "POST",
    body: JSON.stringify({ credentials, config }),
  });

export const listConnectorResources = (connectionId: string) =>
  api<{ resources: { id: string; name: string; selected: boolean }[]; note: string | null }>(
    `/api/integrations/connectors/${connectionId}/resources`
  );

export const selectConnectorResources = (connectionId: string, resourceIds: string[]) =>
  api<{ selected: string[] }>(`/api/integrations/connectors/${connectionId}/resources`, {
    method: "POST",
    body: JSON.stringify({ resource_ids: resourceIds }),
  });

export const connectJira = (site_url: string, account_email: string, api_token: string) =>
  api<{ id: string }>("/api/integrations/jira", {
    method: "POST",
    body: JSON.stringify({ site_url, account_email, api_token }),
  });

export const startSlackInstall = () =>
  api<{ url: string }>("/api/integrations/slack/connect", { method: "POST" });

export const uploadCustomDoc = (form: FormData) =>
  api<{ id: string; title: string; chunk_count: number }>("/api/custom-docs", {
    method: "POST",
    body: form,
  });

export const listCustomDocs = () =>
  api<{ id: string; title: string; chunk_count: number }[]>("/api/custom-docs");


// ── Waiting room ─────────────────────────────────────────────────────────
export type Knock = { id: string; status: "pending" | "admitted" | "denied"; reason?: string };
export type WaitingPerson = {
  id: string;
  display_name: string;
  status: string;
  created_at: string;
  is_member: boolean;
};

/** Ask to be let into a call. Unauthenticated on purpose — external guests
 * join by link and have no account. A signed-in member is auto-admitted. */
export async function knockForCall(slug: string, displayName: string): Promise<Knock> {
  const token = getToken();
  const res = await fetch(`${BASE}/api/meetings/${slug}/knock`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail?.detail || "Could not ask to join");
  }
  return res.json();
}

export async function knockStatus(slug: string, knockId: string): Promise<Knock> {
  const res = await fetch(`${BASE}/api/meetings/${slug}/knock/${knockId}`);
  if (!res.ok) throw new ApiError(res.status, "That request is no longer valid");
  return res.json();
}

export const listWaiting = (slug: string) => api<WaitingPerson[]>(`/api/meetings/${slug}/knocks`);

export const decideKnock = (slug: string, knockId: string, admit: boolean) =>
  api<Knock>(`/api/meetings/${slug}/knocks/${knockId}`, {
    method: "POST",
    body: JSON.stringify({ admit }),
  });


// ── GitHub, as one state ─────────────────────────────────────────────────
// GitHub is two things that were previously surfaced separately: an
// IDENTITY (this account is @someone, per user) and ACCESS (the app is
// installed, per workspace, which is what can read code). Every surface
// reads this one shape so they cannot disagree about whether it is
// "connected".
export type GithubStatus = {
  identity: { linked: boolean; login: string | null };
  access: { installations: { id: number; account: string; type: string }[]; repos_indexed: number };
  state: "not_connected" | "identity_only" | "installed_no_repos" | "ready";
  app_configured: boolean;
};

export const getGithubStatus = () => api<GithubStatus>("/api/integrations/github/status");

export const GITHUB_STATE_LABEL: Record<GithubStatus["state"], string> = {
  not_connected: "connect",
  identity_only: "signed in — needs access",
  installed_no_repos: "connected — pick repos",
  ready: "connected",
};
