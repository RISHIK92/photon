from __future__ import annotations
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.core.parser.tree_sitter_parser import ParsedFile

from app.config import get_settings

settings = get_settings()

_WORDS_PER_TOKEN = 0.75  # rough approximation


@dataclass
class Chunk:
    chunk_id: str          # "{repo_id}:{rel_path}:{index}"
    repo_id: str
    file_path: str         # relative path
    language: str
    start_line: int
    end_line: int
    text: str
    symbol_name: str = ""  # function/class name if chunk is a symbol
    metadata: dict = field(default_factory=dict)


def _token_estimate(text: str) -> int:
    return int(len(text.split()) / _WORDS_PER_TOKEN)


def chunk_file(repo_id: str, rel_path: str, parsed: "ParsedFile", repo_root: str) -> list[Chunk]:
    """
    Split a parsed file into Chunks.
    - If the file has symbols (functions/classes), each symbol becomes its own chunk.
    - If a symbol is too large it is split by lines.
    - The remaining non-symbol lines are chunked by size.
    """
    max_tokens = settings.chunk_max_tokens
    chunks: list[Chunk] = []
    idx = 0

    lines = parsed.raw_text.splitlines(keepends=True)
    total_lines = len(lines)
    covered: set[int] = set()  # 1-based line numbers already included in a symbol chunk

    # ── Per-symbol chunks ────────────────────────────────────────────────────
    for sym in getattr(parsed, "symbols", []):
        sl, el = sym.start_line, sym.end_line
        if sl < 1 or el < sl:
            continue

        sym_lines = lines[sl - 1 : el]
        sym_text = "".join(sym_lines)

        if _token_estimate(sym_text) <= max_tokens:
            chunks.append(Chunk(
                chunk_id=f"{repo_id}:{rel_path}:{idx}",
                repo_id=repo_id,
                file_path=rel_path,
                language=parsed.language,
                start_line=sl,
                end_line=el,
                text=sym_text,
                symbol_name=sym.name,
                metadata={"kind": sym.kind, "docstring": sym.docstring or ""},
            ))
            idx += 1
            covered.update(range(sl, el + 1))
        else:
            # Split large symbol into line windows
            window: list[str] = []
            window_start = sl
            for lineno in range(sl, el + 1):
                window.append(lines[lineno - 1])
                if _token_estimate("".join(window)) >= max_tokens:
                    chunks.append(Chunk(
                        chunk_id=f"{repo_id}:{rel_path}:{idx}",
                        repo_id=repo_id,
                        file_path=rel_path,
                        language=parsed.language,
                        start_line=window_start,
                        end_line=lineno,
                        text="".join(window),
                        symbol_name=sym.name,
                    ))
                    idx += 1
                    covered.update(range(window_start, lineno + 1))
                    window = []
                    window_start = lineno + 1
            if window:
                chunks.append(Chunk(
                    chunk_id=f"{repo_id}:{rel_path}:{idx}",
                    repo_id=repo_id,
                    file_path=rel_path,
                    language=parsed.language,
                    start_line=window_start,
                    end_line=el,
                    text="".join(window),
                    symbol_name=sym.name,
                ))
                idx += 1
                covered.update(range(window_start, el + 1))

    # ── Non-symbol lines (file-level code, imports, comments) ────────────────
    uncovered = [i for i in range(1, total_lines + 1) if i not in covered]
    if uncovered:
        window_lines: list[str] = []
        window_start = uncovered[0]
        for lineno in uncovered:
            window_lines.append(lines[lineno - 1])
            if _token_estimate("".join(window_lines)) >= max_tokens:
                chunks.append(Chunk(
                    chunk_id=f"{repo_id}:{rel_path}:{idx}",
                    repo_id=repo_id,
                    file_path=rel_path,
                    language=parsed.language,
                    start_line=window_start,
                    end_line=lineno,
                    text="".join(window_lines),
                ))
                idx += 1
                window_lines = []
                window_start = lineno + 1
        if window_lines:
            chunks.append(Chunk(
                chunk_id=f"{repo_id}:{rel_path}:{idx}",
                repo_id=repo_id,
                file_path=rel_path,
                language=parsed.language,
                start_line=window_start,
                end_line=uncovered[-1],
                text="".join(window_lines),
            ))

    return chunks
