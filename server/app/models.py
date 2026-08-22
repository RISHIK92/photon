import uuid
from datetime import datetime
from enum import Enum
from typing import List, Optional
from sqlmodel import Field, SQLModel, Column, JSON, Relationship
from sqlalchemy import String, ForeignKey, Integer


# ─── User ─────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    __tablename__ = "users"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    email: str = Field(sa_column=Column(String, unique=True, nullable=False, index=True))
    # Nullable: a user who signs up via "Continue with GitHub" has no
    # password at all. core/auth.py's password-login path must check for
    # None before calling verify_password, not pass it a None hash.
    hashed_password: Optional[str] = None
    # Set when signed up/linked via GitHub OAuth (routers/auth.py). Linking
    # rule: match on github_id first, then fall back to matching the
    # verified GitHub email against an existing User.email (so a user who
    # signed up with email/password and later clicks "Continue with
    # GitHub" gets linked to their existing account instead of a duplicate).
    github_id: Optional[str] = Field(default=None, sa_column=Column(String, unique=True, nullable=True))
    github_login: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UserCreate(SQLModel):
    email: str
    password: str


class UserRead(SQLModel):
    id: str
    email: str
    created_at: datetime


# ─── Workspace (the tenant) ───────────────────────────────────────────────────
# Everything a customer owns hangs off a workspace, not off a user: repos
# today, and Slack/email connectors, agents and transcripts next. A user is
# a login; a workspace is the thing that HAS data and can be shared. This is
# in from the start deliberately — retrofitting a tenant boundary under live
# data is far more expensive than carrying it now.


class WorkspaceRole(str, Enum):
    """Ordered least- to most-privileged; see core/workspace.py:role_at_least.

    VIEWER  — ask questions, join calls, read transcripts. Cannot change
              what the workspace knows.
    MEMBER  — plus import repos and manage what is indexed.
    OWNER   — plus connect/disconnect integrations, invite and remove people.
    """
    VIEWER = "viewer"
    MEMBER = "member"
    OWNER = "owner"


class Workspace(SQLModel, table=True):
    __tablename__ = "workspaces"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str
    # True for the workspace auto-created on signup, so the UI can label it
    # and never offer to delete a user's only home.
    is_personal: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


class WorkspaceMember(SQLModel, table=True):
    __tablename__ = "workspace_members"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    user_id: str = Field(sa_column=Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True))
    role: WorkspaceRole = WorkspaceRole.MEMBER
    created_at: datetime = Field(default_factory=datetime.utcnow)


class WorkspaceInvite(SQLModel, table=True):
    """One live invite code per workspace at a time.

    Rotating replaces rather than accumulates: an owner who suspects a code
    has leaked needs "make the old one stop working" to be one obvious
    action, not a list to audit.
    """
    __tablename__ = "workspace_invites"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    code: str = Field(sa_column=Column(String, unique=True, nullable=False, index=True))
    created_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    revoked_at: Optional[datetime] = None


class JoinRequestStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class WorkspaceJoinRequest(SQLModel, table=True):
    """A code gets you as far as asking. An owner decides.

    Holding the code is not the same as being trusted with a company's
    private source, so the code proves you were pointed at this workspace,
    and approval is what actually grants access.
    """
    __tablename__ = "workspace_join_requests"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    user_id: str = Field(sa_column=Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True))
    status: JoinRequestStatus = JoinRequestStatus.PENDING
    requested_at: datetime = Field(default_factory=datetime.utcnow)
    decided_at: Optional[datetime] = None
    decided_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    granted_role: Optional[WorkspaceRole] = None


class WorkspaceMemberRead(SQLModel):
    user_id: str
    email: str
    role: WorkspaceRole
    joined_at: datetime


class JoinRequestRead(SQLModel):
    id: str
    user_id: str
    email: str
    status: JoinRequestStatus
    requested_at: datetime


class WorkspaceCreate(SQLModel):
    name: str


class WorkspaceRead(SQLModel):
    id: str
    name: str
    is_personal: bool
    role: WorkspaceRole
    created_at: datetime


# ─── GitHub App installations ─────────────────────────────────────────────────
# One row per "org/user installed the GitHub App and granted it access to
# some repos", scoped to the workspace that installed it. Created by
# routers/github_app.py's install callback; read by the repo picker to list
# what's visible, and by tasks/ingestion.py to know which installation's
# token to mint for cloning. See app/services/github_app_auth.py.

class ConnectionScope(str, Enum):
    """Who a connected source belongs to.

    WORKSPACE — shared: every member's questions may draw on it.
    USER      — private to the person who connected it. On a call it is
                only used for turns attributed to that person (see the
                speaker-identity plumbing), never for everyone.
    """
    WORKSPACE = "workspace"
    USER = "user"


# ─── Slack ────────────────────────────────────────────────────────────────


class SlackInstallation(SQLModel, table=True):
    """One Slack workspace connected to one Photon workspace."""
    __tablename__ = "slack_installations"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    scope: ConnectionScope = ConnectionScope.WORKSPACE
    owner_user_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    team_id: str = Field(sa_column=Column(String, nullable=False, index=True))
    team_name: str
    # Fernet-encrypted; never returned by any endpoint. A bot token reads
    # every channel the app was added to, so it does not sit in plain text.
    bot_token_encrypted: str
    bot_user_id: Optional[str] = None
    installed_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_synced_at: Optional[datetime] = None


class SlackChannel(SQLModel, table=True):
    """A channel the workspace chose to index. Selection is explicit:
    connecting Slack must not silently ingest every channel a bot can see,
    including ones people forgot it was in."""
    __tablename__ = "slack_channels"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    installation_id: str = Field(sa_column=Column(String, ForeignKey("slack_installations.id", ondelete="CASCADE"), nullable=False, index=True))
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    channel_id: str
    name: str
    is_private: bool = False
    selected: bool = True
    message_count: int = 0
    last_synced_at: Optional[datetime] = None


class SlackInstallationRead(SQLModel):
    id: str
    team_id: str
    team_name: str
    scope: ConnectionScope
    created_at: datetime
    last_synced_at: Optional[datetime]


# ─── Jira ─────────────────────────────────────────────────────────────────


class JiraConnection(SQLModel, table=True):
    """A connected Jira site.

    Authenticated with an API token rather than OAuth 3LO, deliberately:
    Atlassian's OAuth needs a registered app with an HTTPS callback, which
    is the same wall Slack hit. An API token is created by any user from
    their own Atlassian account in under a minute and works on localhost —
    and it carries exactly that user's permissions, so it cannot see more
    of Jira than the person who created it can.
    """
    __tablename__ = "jira_connections"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    scope: ConnectionScope = ConnectionScope.WORKSPACE
    owner_user_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    # e.g. https://acme.atlassian.net
    site_url: str
    # The Atlassian account the token belongs to; also the Basic-auth user.
    account_email: str
    api_token_encrypted: str
    display_name: Optional[str] = None
    connected_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_synced_at: Optional[datetime] = None


class JiraProject(SQLModel, table=True):
    """A project chosen for indexing. Explicit, like Slack channels: a Jira
    site can hold dozens of projects that have nothing to do with support."""
    __tablename__ = "jira_projects"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    connection_id: str = Field(sa_column=Column(String, ForeignKey("jira_connections.id", ondelete="CASCADE"), nullable=False, index=True))
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    project_key: str
    name: str
    selected: bool = True
    issue_count: int = 0
    last_synced_at: Optional[datetime] = None


class JiraConnectionRead(SQLModel):
    id: str
    site_url: str
    account_email: str
    display_name: Optional[str]
    scope: ConnectionScope
    created_at: datetime
    last_synced_at: Optional[datetime]


# ─── Generic external connectors (Linear, Notion, Datadog, …) ─────────────
# Slack and Jira each got their own table because each has real structure
# worth modelling (channels with history; projects with issues). Everything
# after them shares one shape — credentials, a set of selectable resources,
# a sync cursor — so it gets one table and a per-provider adapter instead of
# a new table, router and migration per vendor.


class ConnectorProvider(str, Enum):
    LINEAR = "linear"
    NOTION = "notion"
    DATADOG = "datadog"
    # Not a vendor: documents the customer uploads directly (business flows,
    # runbooks, operations notes). Stored and searched through exactly the
    # same path as a connector, so it needs no separate retrieval code.
    CUSTOM_DOCS = "custom_docs"


class CustomDoc(SQLModel, table=True):
    """A document uploaded for context — the things that live in a Google
    Doc or someone's head rather than in a repo or a ticket."""
    __tablename__ = "custom_docs"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    title: str
    filename: Optional[str] = None
    size_bytes: int = 0
    chunk_count: int = 0
    uploaded_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CustomDocRead(SQLModel):
    id: str
    title: str
    filename: Optional[str]
    size_bytes: int
    chunk_count: int
    created_at: datetime


class ExternalConnection(SQLModel, table=True):
    __tablename__ = "external_connections"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    provider: ConnectorProvider
    scope: ConnectionScope = ConnectionScope.WORKSPACE
    owner_user_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    display_name: Optional[str] = None
    # Fernet-encrypted JSON: every provider needs a different set of secrets
    # (one key, two keys, a token plus a site), and a column per vendor
    # secret would be a migration per vendor.
    credentials_encrypted: str = ""
    # Non-secret settings (Datadog site, Notion page filters). Plain JSON so
    # it is inspectable without decrypting anything.
    config: dict = Field(default_factory=dict, sa_column=Column(JSON))
    connected_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_synced_at: Optional[datetime] = None


class ConnectorResource(SQLModel, table=True):
    """A selectable unit inside a connection — a Linear team, a Notion
    database, a Datadog monitor tag. Selection is explicit for every
    provider, same as Slack channels and Jira projects."""
    __tablename__ = "connector_resources"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    connection_id: str = Field(sa_column=Column(String, ForeignKey("external_connections.id", ondelete="CASCADE"), nullable=False, index=True))
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    resource_id: str
    name: str
    selected: bool = True
    item_count: int = 0
    last_synced_at: Optional[datetime] = None


class ExternalConnectionRead(SQLModel):
    id: str
    provider: ConnectorProvider
    scope: ConnectionScope
    display_name: Optional[str]
    created_at: datetime
    last_synced_at: Optional[datetime]


# ─── Meetings ─────────────────────────────────────────────────────────────


class Meeting(SQLModel, table=True):
    """One call. `slug` is the human-shareable identifier (abcd-efgh) and
    doubles as the LiveKit room name, so a link, a room and a transcript are
    the same thing rather than three ids to reconcile."""
    __tablename__ = "meetings"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    slug: str = Field(sa_column=Column(String, unique=True, nullable=False, index=True))
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    title: Optional[str] = None
    created_by: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    ended_at: Optional[datetime] = None

    # ── Call configuration, chosen before joining ──────────────────────
    # What the agent is FOR on this call. Multiple allowed: a call can be
    # both technical and onboarding, and the personas compose.
    bot_types: list = Field(default_factory=lambda: ["support"], sa_column=Column(JSON))
    # "english" or "multilingual" — this picks the voice stack (Deepgram vs
    # Sarvam), which is a per-call decision, not a per-deployment one.
    language_mode: str = "english"
    # Source group keys the agent may draw on for this call. Empty list is
    # meaningful (agent has nothing) and is NOT the same as null (use the
    # workspace defaults), which is why it is nullable.
    enabled_sources: Optional[list] = Field(default=None, sa_column=Column(JSON))


class TranscriptRole(str, Enum):
    HUMAN = "human"
    AGENT = "agent"


class TranscriptEntry(SQLModel, table=True):
    """One line of the shared transcript.

    Rows rather than appending to a single markdown column: several
    participants and the agent all write during a call, and concurrent
    read-modify-write on one text field silently loses lines. The markdown
    is rendered from these on demand (GET .../transcript.md), so the
    deliverable is still one common .md.
    """
    __tablename__ = "transcript_entries"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    meeting_id: str = Field(sa_column=Column(String, ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True))
    role: TranscriptRole = TranscriptRole.HUMAN
    # Display name as seen on the call ("rishik@…", "Client A", "Photon").
    speaker_name: str
    # Participant identity ("user:<uuid>" / "guest:<rand>"); null for the agent.
    speaker_identity: Optional[str] = None
    # Set only when the speaker is a signed-in user, so a transcript can be
    # tied back to a person without trusting a display name.
    speaker_user_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    text: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class MeetingRead(SQLModel):
    id: str
    slug: str
    title: Optional[str]
    workspace_id: str
    bot_types: list = []
    language_mode: str = "english"
    enabled_sources: Optional[list] = None
    created_at: datetime
    ended_at: Optional[datetime]


class TranscriptEntryCreate(SQLModel):
    role: TranscriptRole = TranscriptRole.HUMAN
    speaker_name: str
    speaker_identity: Optional[str] = None
    text: str


class GitHubInstallation(SQLModel, table=True):
    __tablename__ = "github_installations"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True))
    scope: ConnectionScope = ConnectionScope.WORKSPACE
    # Set only when scope is USER. Kept nullable rather than defaulting to
    # the connector so a workspace-scoped source has no misleading "owner".
    owner_user_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=True))
    installation_id: int = Field(sa_column=Column(Integer, unique=True, nullable=False, index=True))
    account_login: str
    account_type: str  # "User" or "Organization", as GitHub reports it
    created_at: datetime = Field(default_factory=datetime.utcnow)


class GitHubInstallationRead(SQLModel):
    id: str
    installation_id: int
    account_login: str
    account_type: str
    created_at: datetime


# ─── Enums ────────────────────────────────────────────────────────────────────

class RepoStatus(str, Enum):
    PENDING = "PENDING"
    INGESTING = "INGESTING"
    READY = "READY"
    FAILED = "FAILED"


class RepoSourceType(str, Enum):
    GITHUB = "github"
    ZIP = "zip"
    LOCAL = "local"


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"


class QueryIntent(str, Enum):
    STRUCTURAL = "structural"
    SEMANTIC = "semantic"
    RELATIONAL = "relational"
    CROSS_CUTTING = "cross_cutting"


# ─── Repo ─────────────────────────────────────────────────────────────────────

class RepoBase(SQLModel):
    name: str
    source_type: RepoSourceType
    source_url: Optional[str] = None
    status: RepoStatus = RepoStatus.PENDING
    local_path: Optional[str] = None
    # Summary card populated after ingestion
    file_count: int = 0
    function_count: int = 0
    language_breakdown: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # FIX: Replaced List[str] with list[str]
    top_modules: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    cluster_count: int = 0
    # FIX: Replaced List[str] with list[str]
    most_imported: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    error_message: Optional[str] = None
    # How long ingestion actually took, in seconds. Recorded so the
    # "this will take about N minutes" estimate shown before importing
    # repos is calibrated from THIS deployment's real measurements rather
    # than a number someone guessed once (see app/services/estimate.py).
    ingest_seconds: Optional[float] = None


class Repo(RepoBase, table=True):
    __tablename__ = "repos"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    # owner_id stays as provenance ("who connected this"); workspace_id is
    # what authorisation is actually checked against.
    owner_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    workspace_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True))
    # Set only for repos imported via a GitHub App installation (the repo
    # picker, routers/github_app.py) — used both to diff "already imported"
    # vs "new" repos when the picker re-opens, and to know at clone time
    # (tasks/ingestion.py) that a minted installation token should be used
    # instead of the single static github_token.
    github_repo_id: Optional[int] = Field(default=None, sa_column=Column(Integer, nullable=True, index=True))
    github_installation_id: Optional[int] = Field(default=None, sa_column=Column(Integer, nullable=True, index=True))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    jobs: List["Job"] = Relationship(back_populates="repo", sa_relationship_kwargs={"cascade": "all, delete-orphan"})
    pins: List["Pin"] = Relationship(back_populates="repo", sa_relationship_kwargs={"cascade": "all, delete-orphan"})


class RepoCreate(SQLModel):
    name: str
    source_type: RepoSourceType
    source_url: Optional[str] = None


class RepoRead(RepoBase):
    id: str
    owner_id: Optional[str]
    created_at: datetime
    updated_at: datetime


# ─── Job ──────────────────────────────────────────────────────────────────────

class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    repo_id: str = Field(sa_column=Column(String, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False))
    repo: Optional[Repo] = Relationship(back_populates="jobs")
    status: JobStatus = JobStatus.QUEUED
    celery_task_id: Optional[str] = None
    progress: int = 0          # 0-100
    phase: str = "queued"      # queued | cloning | parsing | graphing | embedding | done
    message: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
    finished_at: Optional[datetime] = None


class JobRead(SQLModel):
    id: str
    repo_id: str
    status: JobStatus
    progress: int
    phase: str
    message: str
    created_at: datetime
    finished_at: Optional[datetime]


# ─── Pin (annotation) ─────────────────────────────────────────────────────────

class Pin(SQLModel, table=True):
    __tablename__ = "pins"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    repo_id: str = Field(sa_column=Column(String, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False))
    repo: Optional[Repo] = Relationship(back_populates="pins")
    module_node_id: str          # Neo4j node id this pin is attached to
    question: str
    answer: str
    # FIX: Replaced List[dict] with list[dict]
    cited_refs: list[dict] = Field(default_factory=list, sa_column=Column(JSON))
    is_stale: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


class PinCreate(SQLModel):
    repo_id: str
    module_node_id: str
    question: str
    answer: str
    # FIX: Replaced List[dict] with list[dict]
    cited_refs: list[dict] = []


class PinRead(SQLModel):
    id: str
    repo_id: str
    module_node_id: str
    question: str
    answer: str
    # FIX: Replaced List[dict] with list[dict]
    cited_refs: list[dict]
    is_stale: bool
    created_at: datetime


# ─── Query ────────────────────────────────────────────────────────────────────

class QueryRequest(SQLModel):
    repo_id: str
    question: str
    session_id: Optional[str] = None
    file_context_path: Optional[str] = None  # Scope AI answer to a specific file


class QueryResponse(SQLModel):
    session_id: str
    intent: QueryIntent
    answer: str
    # FIX: Replaced List[dict] with list[dict]
    cited_chunks: list[dict] = []
    # FIX: Replaced List[dict] with list[dict]
    graph_nodes: list[dict] = []


# ─── Learning Path Cache ───────────────────────────────────────────────────────

class LearningPathCache(SQLModel, table=True):
    __tablename__ = "learning_path_cache"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    repo_id: str = Field(sa_column=Column(String, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False, index=True, unique=True))
    data: dict = Field(default_factory=dict, sa_column=Column(JSON))
    generated_at: datetime = Field(default_factory=datetime.utcnow)