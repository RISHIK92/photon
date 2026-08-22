"""Code tools — thin JSON wrappers around YASML's existing retrieval
internals (app.core.embedding.embedder, app.core.graph.builder,
app.core.query_engine.*). No prose leaves this layer; the LLM composition
step lives in app.agent, not here.
"""
from __future__ import annotations

import os

import structlog

from app.core.embedding.embedder import vector_search
from app.core.graph.builder import Neo4jClient
from app.core.query_engine.retrieval import hybrid_retrieve
from app.models import QueryIntent
from app.tools.evidence import make_evidence, tool_error, tool_result

log = structlog.get_logger()


def _rank_score(index: int, total: int) -> float:
    """Chunks come back from Qdrant already ranked by relevance but without
    the raw cosine score attached (see app.core.query_engine.context_assembler,
    which drops it too) — approximate a descending score from rank order."""
    if total <= 1:
        return 1.0
    return round(1.0 - (index / total) * 0.5, 4)


def _chunk_to_evidence(chunk: dict, index: int, total: int) -> dict:
    file_path = chunk.get("file_path") or chunk.get("path") or "?"
    start = chunk.get("start_line")
    end = chunk.get("end_line")
    locator = f"{file_path}:L{start}-L{end}" if start is not None else file_path
    return make_evidence("code", locator, chunk.get("text", ""), _rank_score(index, total))


def _graph_node_to_evidence(node: dict, score: float = 0.55) -> dict:
    path = node.get("path") or node.get("id") or "?"
    snippet_bits = []
    for key in ("language", "sym_count", "top_symbols", "fan_out"):
        if key in node and node[key] not in (None, [], 0):
            snippet_bits.append(f"{key}={node[key]}")
    snippet = f"module {path}" + (f" ({', '.join(snippet_bits)})" if snippet_bits else "")
    return make_evidence("code", path, snippet, score)


async def search_code(query: str, repo_id: str | None = None, workspace_id: str | None = None, top_k: int = 8) -> dict:
    # Cross-repo mode: no specific repo named, so search every repo in the
    # workspace and let relevance ranking sort out which repo's chunks
    # actually answer the question (app.agent.loop's multi-repo
    # disambiguation — see CLAUDE.md). Chunks are tagged with workspace_id
    # at ingest time (app.tasks.ingestion); repos ingested before that
    # change have no workspace_id payload and won't be found this way.
    if not repo_id and not workspace_id:
        return tool_error("search_code", "no repo_id or workspace_id given — nothing to search")
    try:
        chunks = await vector_search(repo_id, query, top_k=top_k, workspace_id=workspace_id)
    except Exception as exc:  # noqa: BLE001 - surfaced as a typed tool error, not a 500
        log.error("tool.search_code_error", error=str(exc))
        return tool_error("search_code", f"search_code failed: {exc}")

    evidence = [_chunk_to_evidence(c, i, len(chunks)) for i, c in enumerate(chunks)]
    return tool_result("search_code", evidence, note=None if evidence else f"no code matched '{query}'")


async def trace_symbol(symbol: str, repo_id: str | None = None) -> dict:
    if not repo_id:
        # Unlike search_code/find_usages, this walks the Neo4j module graph,
        # which is per-repo — there's no cross-repo graph to fall back to.
        # The loop only leaves repo_id unset here when the planner's guess
        # didn't match a real repo in the workspace, so ask it to narrow
        # down rather than guessing which repo's graph to walk.
        return tool_error("trace_symbol", "which repository? specify one of the known repos for this workspace")
    try:
        chunks, graph_nodes = await hybrid_retrieve(
            repo_id=repo_id, question=f"what calls or is called by {symbol}", intent=QueryIntent.RELATIONAL
        )
    except Exception as exc:  # noqa: BLE001
        log.error("tool.trace_symbol_error", error=str(exc))
        return tool_error("trace_symbol", f"trace_symbol failed: {exc}")

    evidence = [_chunk_to_evidence(c, i, len(chunks)) for i, c in enumerate(chunks)]
    evidence += [_graph_node_to_evidence(n) for n in graph_nodes]
    return tool_result(
        "trace_symbol", evidence, note=None if evidence else f"no code or graph evidence for symbol '{symbol}'"
    )


async def find_usages(symbol: str, repo_id: str | None = None, workspace_id: str | None = None) -> dict:
    if not repo_id and not workspace_id:
        return tool_error("find_usages", "no repo_id or workspace_id given — nothing to search")
    try:
        chunks = await vector_search(
            repo_id, f"usages and references of {symbol}", top_k=10, workspace_id=workspace_id
        )
    except Exception as exc:  # noqa: BLE001
        log.error("tool.find_usages_error", error=str(exc))
        return tool_error("find_usages", f"find_usages failed: {exc}")

    evidence = [_chunk_to_evidence(c, i, len(chunks)) for i, c in enumerate(chunks)]
    return tool_result("find_usages", evidence, note=None if evidence else f"no usages found for '{symbol}'")


async def read_file(path: str, repo_id: str | None = None, start: int | None = None, end: int | None = None) -> dict:
    if not repo_id:
        return tool_error("read_file", "which repository? specify one of the known repos for this workspace")

    from sqlmodel import Session, create_engine

    from app.config import get_settings
    from app.models import Repo

    settings = get_settings()
    engine = create_engine(settings.sync_database_url)
    with Session(engine) as session:
        repo = session.get(Repo, repo_id)

    if not repo or not repo.local_path:
        return tool_error("read_file", f"repo {repo_id} not found or not ingested")

    full_path = os.path.join(repo.local_path, path.lstrip("/"))
    repo_root = os.path.realpath(repo.local_path)
    real = os.path.realpath(full_path)
    if not real.startswith(repo_root):
        return tool_error("read_file", "path traversal denied")
    if not os.path.isfile(full_path):
        return tool_result("read_file", [], note=f"file not found: {path}")

    with open(full_path, "r", errors="replace") as f:
        lines = f.readlines()

    start_line = start or 1
    end_line = end or len(lines)
    snippet = "".join(lines[start_line - 1 : end_line])
    locator = f"{path}:L{start_line}-L{end_line}"
    return tool_result("read_file", [make_evidence("code", locator, snippet, 1.0)])
