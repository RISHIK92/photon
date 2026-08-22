"""Which sources a workspace can actually use, and which tools each unlocks.

Two consumers, one definition:
  - the console, to render connection cards and their toggles;
  - the agent loop, to hide tools the workspace cannot use from the planner.

Hiding is not cosmetic. A planner offered `search_jira` for a workspace
with no Jira will sometimes call it, waste a round-trip, get nothing, and
occasionally conclude "there is no ticket for this" — which is a wrong
answer, not a missing one. Fewer, real tools produce better plans.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import (
    ConnectorProvider,
    CustomDoc,
    ExternalConnection,
    JiraConnection,
    Repo,
    RepoStatus,
    SlackInstallation,
)


@dataclass
class SourceGroup:
    key: str
    label: str
    tools: list[str]
    # Default-on sources are the ones every workspace has from day one and
    # that no one has to think about. Everything else appears only once it
    # is genuinely connected.
    default_enabled: bool = False
    available: bool = False
    detail: str = ""
    coming_soon: bool = False


# The demo corpus tools are grouped separately and NOT default-enabled for a
# real workspace: they answer from the fictional Meridian fixture, which is
# right for a rehearsal and wrong for a customer.
SEED_TOOLS = ["search_docs", "search_tickets", "get_account", "list_accounts",
              "get_account_logs", "get_incidents", "check_conflict"]


def _groups() -> list[SourceGroup]:
    return [
        SourceGroup("github", "GitHub", ["search_code", "trace_symbol", "find_usages", "read_file", "explain_why"], default_enabled=True),
        SourceGroup("custom_docs", "Custom docs", ["search_custom_docs"], default_enabled=True),
        SourceGroup("slack", "Slack", ["search_slack"]),
        SourceGroup("jira", "Jira", ["search_jira"]),
        SourceGroup("notion", "Notion", ["search_notion"]),
        SourceGroup("linear", "Linear", ["search_linear"]),
        SourceGroup("datadog", "Datadog", ["search_datadog"]),
        SourceGroup("outlook", "Outlook", [], coming_soon=True),
    ]


async def source_groups(session: AsyncSession, workspace_id: str) -> list[SourceGroup]:
    groups = {g.key: g for g in _groups()}

    ready_repos = (await session.execute(
        select(Repo).where(Repo.workspace_id == workspace_id, Repo.status == RepoStatus.READY)
    )).scalars().all()
    groups["github"].available = bool(ready_repos)
    groups["github"].detail = (
        f"{len(ready_repos)} repo{'s' if len(ready_repos) != 1 else ''} indexed"
        if ready_repos else "no repositories indexed yet"
    )

    docs = (await session.execute(
        select(CustomDoc).where(CustomDoc.workspace_id == workspace_id)
    )).scalars().all()
    groups["custom_docs"].available = bool(docs)
    groups["custom_docs"].detail = (
        f"{len(docs)} document{'s' if len(docs) != 1 else ''}" if docs else "nothing uploaded yet"
    )

    slack = (await session.execute(
        select(SlackInstallation).where(SlackInstallation.workspace_id == workspace_id)
    )).scalars().first()
    groups["slack"].available = slack is not None
    groups["slack"].detail = slack.team_name if slack else "not connected"

    jira = (await session.execute(
        select(JiraConnection).where(JiraConnection.workspace_id == workspace_id)
    )).scalars().first()
    groups["jira"].available = jira is not None
    groups["jira"].detail = jira.site_url if jira else "not connected"

    external = (await session.execute(
        select(ExternalConnection).where(ExternalConnection.workspace_id == workspace_id)
    )).scalars().all()
    by_provider = {c.provider: c for c in external}
    for provider, key in (
        (ConnectorProvider.NOTION, "notion"),
        (ConnectorProvider.LINEAR, "linear"),
        (ConnectorProvider.DATADOG, "datadog"),
    ):
        conn = by_provider.get(provider)
        groups[key].available = conn is not None
        groups[key].detail = (conn.display_name or "connected") if conn else "not connected"

    return list(groups.values())


def default_enabled_keys(groups: list[SourceGroup]) -> list[str]:
    """What a new call starts with: the default-on sources, but only where
    they actually have data — offering a toggle for an empty source is a
    promise the agent cannot keep."""
    return [g.key for g in groups if g.default_enabled and g.available]


def tools_for(groups: list[SourceGroup], enabled_keys: list[str], include_seed: bool = True) -> list[str]:
    """Tool names the planner may see for this call."""
    enabled = set(enabled_keys)
    names: list[str] = []
    for group in groups:
        if group.key in enabled and group.available:
            names.extend(group.tools)
    if include_seed:
        names.extend(SEED_TOOLS)
    return sorted(set(names))
