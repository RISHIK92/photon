from __future__ import annotations
import os
import shutil
from pathlib import Path
from typing import Optional
import structlog
import git
from app.config import get_settings

log = structlog.get_logger()
settings = get_settings()


def clone_github_repo(url: str, repo_id: str, token: Optional[str] = None) -> str:
    """Clone a GitHub repo (public or private) to local storage. Returns local path."""
    storage = Path(settings.repos_storage_path)
    storage.mkdir(parents=True, exist_ok=True)
    dest = storage / repo_id

    if dest.exists():
        shutil.rmtree(dest)

    if token:
        # Inject token into URL for private repos
        if url.startswith("https://"):
            url = url.replace("https://", f"https://{token}@")

    log.info("cloning_repo", url=url, dest=str(dest))
    git.Repo.clone_from(url, str(dest), depth=1)
    log.info("clone_complete", dest=str(dest))
    return str(dest)


def use_local_path(source_path: str, repo_id: str) -> str:
    """Symlink or copy a local path into managed storage. Returns local path."""
    storage = Path(settings.repos_storage_path)
    storage.mkdir(parents=True, exist_ok=True)
    dest = storage / repo_id

    if dest.exists():
        if dest.is_symlink():
            dest.unlink()
        else:
            shutil.rmtree(dest)

    # Prefer symlink to avoid duplication
    try:
        os.symlink(os.path.abspath(source_path), str(dest))
    except OSError:
        shutil.copytree(source_path, str(dest))

    log.info("local_mount_ready", dest=str(dest))
    return str(dest)
