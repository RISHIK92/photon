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

/** ngrok's free tier answers browser-shaped requests with an HTML
 *  interstitial ("You are about to visit...") instead of the API response,
 *  which turns every fetch into a JSON parse error rather than an obvious
 *  failure. This header opts out of it. Harmless against any other host,
 *  so it is set unconditionally rather than by sniffing the URL — a check
 *  for "ngrok" in the hostname would silently stop working the day the
 *  tunnel moves to a custom domain. */
function applyTunnelHeader(headers: Headers) {
  headers.set("ngrok-skip-browser-warning", "1");
}

const TOKEN_KEY = "photon.token";
const WORKSPACE_KEY = "photon.workspace";

export type Workspace = {
  id: string;
  name: string;
  kind?: "individual" | "team";
  /** What the agent is called here. Null means the product default. */
  agent_name?: string | null;
  is_personal: boolean;
  role: string;
  created_at: string;
};
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
  /** Fictional "Adventa" content from the dashboard's Mock button, never a
   * real connection — see server/app/routers/mock.py. */
  is_mock?: boolean;
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
  applyTunnelHeader(headers);
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "ngrok-skip-browser-warning": "1",
    },
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
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
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
export const createWorkspace = (name: string, kind: "individual" | "team") =>
  api<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name, kind }) });
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
  bot_types: string[];
  language_mode: string;
  enabled_sources: string[] | null;
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
  /** True when `available` comes from the dashboard's Mock button, not a
   * real connection — see server/app/services/tool_availability.py. */
  is_mock: boolean;
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

export type CustomDoc = {
  id: string;
  title: string;
  filename: string | null;
  size_bytes: number;
  chunk_count: number;
  created_at: string;
};

export const listCustomDocs = () => api<CustomDoc[]>("/api/custom-docs");

export const deleteCustomDoc = (docId: string) =>
  api<void>(`/api/custom-docs/${docId}`, { method: "DELETE" });


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


/** Rename the workspace, or name its agent. The agent's name is what it
 * calls itself in answers, announces on joining, and answers to as the wake
 * word — so it is a real setting, not decoration. */
export const updateWorkspace = (patch: { name?: string; agent_name?: string }) =>
  api<Workspace>("/api/workspaces/settings", { method: "PATCH", body: JSON.stringify(patch) });

// ── Workspace invites, join requests, members ──────────────────────────────
// A code proves someone was pointed at the workspace; an owner's approval is
// what actually grants access. See server/app/routers/workspaces.py — this
// is the client half of that flow, which had no UI at all before.

export type WorkspaceRole = "viewer" | "member" | "owner";

export const getWorkspaceInvite = () =>
  api<{ code: string | null }>("/api/workspaces/invite");

export const rotateWorkspaceInvite = () =>
  api<{ code: string }>("/api/workspaces/invite", { method: "POST" });

export const revokeWorkspaceInvite = () =>
  api<void>("/api/workspaces/invite", { method: "DELETE" });

export const joinWorkspace = (code: string) =>
  api<{ status: "already_member" | "pending"; workspace: { id: string; name: string } }>(
    "/api/workspaces/join",
    { method: "POST", body: JSON.stringify({ code }) }
  );

export type JoinRequest = {
  id: string;
  user_id: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
};

export const listJoinRequests = () => api<JoinRequest[]>("/api/workspaces/requests");

export const decideJoinRequest = (requestId: string, approve: boolean, role: WorkspaceRole = "member") =>
  api<{ status: string }>(`/api/workspaces/requests/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ approve, role }),
  });

export type WorkspaceMember = {
  user_id: string;
  email: string;
  role: WorkspaceRole;
  joined_at: string;
};

export const listWorkspaceMembers = () => api<WorkspaceMember[]>("/api/workspaces/members");

export const changeMemberRole = (userId: string, role: WorkspaceRole) =>
  api<{ user_id: string; role: WorkspaceRole }>(`/api/workspaces/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });

export const removeMember = (userId: string) =>
  api<void>(`/api/workspaces/members/${userId}`, { method: "DELETE" });

// ── Mock sources ────────────────────────────────────────────────────────
// One click per provider to give a real, empty workspace something to
// answer from — fictional "Adventa" data, clearly labeled [MOCK]
// everywhere it surfaces, never mistaken for a real connection. See
// server/app/routers/mock.py.

export type MockProvider = "github" | "slack" | "jira" | "linear" | "notion" | "datadog";

export const getMockStatus = () =>
  api<Record<MockProvider, boolean>>("/api/mock");

export const enableMock = (provider: MockProvider) =>
  api<{ provider: string; already_enabled: boolean }>(`/api/mock/${provider}`, { method: "POST" });

export const disableMock = (provider: MockProvider) =>
  api<{ provider: string; removed: boolean }>(`/api/mock/${provider}`, { method: "DELETE" });

/** Fetch the REAL contents of a cited file range, for the code sidebar.
 *
 * The evidence a tool returns carries a `snippet`, but that snippet is the
 * embedded CHUNK, and a chunk does not reliably match the line range its
 * own locator claims — `authController.ts:L1-L39` comes back as five lines
 * of imports, and some chunks are missing lines from the middle entirely.
 * CodeSnippet numbers its lines from the locator's start, so rendering the
 * chunk would print confident, wrong line numbers — the exact failure the
 * panel exists to prevent.
 *
 * `read_file` reads the file off disk, so what it returns really is lines
 * `start..end`. Unauthenticated like the rest of /api/tools (documented
 * demo-scope decision).
 */
const readFileOnce = (repoId: string, path: string, start?: number, end?: number) =>
  fetch(`${BASE}/api/tools/read_file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
    body: JSON.stringify({ args: { repo_id: repoId, path, start, end } }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`read_file ${r.status}`))))
    .then((d) => (d?.evidence?.[0]?.snippet as string | undefined) ?? null);

/** Every evidence snippet is capped at 800 characters by make_evidence(),
 *  which is right for something being fed to the compose LLM and wrong for
 *  a sidebar: a 64-line citation arrives as its first ~35 lines with no
 *  indication the rest was cut.
 *
 *  Rather than raise that cap — it is shared with everything the agent
 *  reasons over, and re-truncating snippets has silently hidden load-
 *  bearing code here before — the sidebar just pages: read from where the
 *  last response stopped until the range is covered. Bounded, because a
 *  cited region that needs more than this many round-trips is not
 *  something anyone is reading mid-call.
 */
const MAX_PAGES = 8;

export async function readFile(
  repoId: string,
  path: string,
  start?: number,
  end?: number
): Promise<string | null> {
  const from = start ?? 1;
  if (end === undefined) return readFileOnce(repoId, path, start, end);

  const parts: string[] = [];
  let cursor = from;
  for (let page = 0; page < MAX_PAGES && cursor <= end; page++) {
    const text = await readFileOnce(repoId, path, cursor, end);
    if (!text) break;
    parts.push(text);
    const got = text.split("\n").length;
    // No forward progress means the server is not going to give us more,
    // so stop rather than spin.
    if (got < 1) break;
    cursor += got;
  }
  return parts.length ? parts.join("\n") : null;
}
