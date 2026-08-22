import uuid
from datetime import datetime
from enum import Enum
from typing import List, Optional
from sqlmodel import Field, SQLModel, Column, JSON, Relationship
from sqlalchemy import String, ForeignKey


# ─── User ─────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    __tablename__ = "users"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    email: str = Field(sa_column=Column(String, unique=True, nullable=False, index=True))
    hashed_password: str
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
    OWNER = "owner"
    MEMBER = "member"


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


class WorkspaceCreate(SQLModel):
    name: str


class WorkspaceRead(SQLModel):
    id: str
    name: str
    is_personal: bool
    role: WorkspaceRole
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


class Repo(RepoBase, table=True):
    __tablename__ = "repos"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    # owner_id stays as provenance ("who connected this"); workspace_id is
    # what authorisation is actually checked against.
    owner_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    workspace_id: Optional[str] = Field(default=None, sa_column=Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True))
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