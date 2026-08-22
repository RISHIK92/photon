"""Docs / tickets / slack search — reads from the kb_docs / kb_tickets /
kb_slack Qdrant collections populated by app.seed.loader.embed_knowledge_base.
Kept as separate collections deliberately (see the build plan, Phase 2) so
the evidence panel can distinguish source types without relying on a payload
field alone.
"""
from __future__ import annotations

import structlog
from qdrant_client.models import FieldCondition, Filter, MatchValue

from app.seed.loader import kb_search
from app.tools.evidence import make_evidence, tool_error, tool_result

log = structlog.get_logger()


def _doc_to_evidence(hit: dict) -> dict:
    p = hit["payload"]
    return make_evidence("docs", p.get("path", p.get("doc_id", "?")), p.get("text", ""), hit["score"])


def _ticket_to_evidence(hit: dict) -> dict:
    p = hit["payload"]
    return make_evidence("ticket", f"ticket:{p.get('ticket_id', '?')}", p.get("text", ""), hit["score"])


def _slack_to_evidence(hit: dict) -> dict:
    p = hit["payload"]
    locator = f"slack:#{p.get('channel', '?')}:{p.get('ts', '?')}"
    return make_evidence("slack", locator, p.get("text", ""), hit["score"])


async def search_docs(query: str, top_k: int = 6) -> dict:
    try:
        hits = await kb_search("docs", query, top_k=top_k)
    except Exception as exc:  # noqa: BLE001
        log.error("tool.search_docs_error", error=str(exc))
        return tool_error("search_docs", f"search_docs failed: {exc}")
    evidence = [_doc_to_evidence(h) for h in hits]
    return tool_result("search_docs", evidence, note=None if evidence else f"no docs matched '{query}'")


async def search_tickets(query: str, account_id: str | None = None, top_k: int = 6) -> dict:
    query_filter = None
    if account_id:
        query_filter = Filter(must=[FieldCondition(key="account_id", match=MatchValue(value=account_id))])
    try:
        hits = await kb_search("tickets", query, top_k=top_k, query_filter=query_filter)
    except Exception as exc:  # noqa: BLE001
        log.error("tool.search_tickets_error", error=str(exc))
        return tool_error("search_tickets", f"search_tickets failed: {exc}")
    evidence = [_ticket_to_evidence(h) for h in hits]
    return tool_result("search_tickets", evidence, note=None if evidence else f"no tickets matched '{query}'")


async def search_slack(query: str, channel: str | None = None, top_k: int = 8) -> dict:
    query_filter = None
    if channel:
        query_filter = Filter(must=[FieldCondition(key="channel", match=MatchValue(value=channel))])
    try:
        hits = await kb_search("slack", query, top_k=top_k, query_filter=query_filter)
    except Exception as exc:  # noqa: BLE001
        log.error("tool.search_slack_error", error=str(exc))
        return tool_error("search_slack", f"search_slack failed: {exc}")
    evidence = [_slack_to_evidence(h) for h in hits]
    return tool_result("search_slack", evidence, note=None if evidence else f"no Slack messages matched '{query}'")
