"""How long will ingesting these repos take?

Shown before someone imports repos, so picking 12 of them isn't a blind
commitment. Two rules:

1. **Measured, not guessed.** The seed constants below come from real
   ingests on this stack, and every completed ingest records its own
   duration (`Repo.ingest_seconds`), so the estimate re-calibrates against
   this deployment instead of drifting from a number written once.
2. **A range, not a number.** Ingest time varies with network, repo shape
   and embedding-API latency, none of which are knowable up front. A
   single figure would be precise and wrong.

Model: `seconds ≈ FIXED_OVERHEAD + PER_FILE * files`.

Seed calibration (measured on this machine, Aug 2026):
    psf/requests    83 files -> 29.5s
    httpie/cli     236 files -> 56.0s
which fits ≈ 15s fixed + 0.17s/file. The fixed part is clone + graph
setup; the per-file part is dominated by embedding calls, so it moves with
the embedding provider more than with parser speed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

# Fallback constants, used until this deployment has its own measurements.
SEED_FIXED_OVERHEAD = 15.0
SEED_PER_FILE = 0.17

# GitHub reports repo size in KB, not files. Measured against the same two
# repos, ~14 KB of checked-out source per parsed file is a workable rough
# conversion — deliberately crude, and only used when a real file count
# isn't available yet.
KB_PER_FILE = 14.0

# Enough samples to trust local data over the seed constants. Below this a
# single unusual repo would skew every future estimate.
MIN_SAMPLES_TO_CALIBRATE = 5

# Real ingests vary either side of the fit; this spread is what makes the
# answer honest rather than falsely precise.
LOWER_BOUND = 0.7
UPPER_BOUND = 1.6


@dataclass
class Estimate:
    seconds_low: int
    seconds_high: int
    repo_count: int
    file_count: int
    calibrated: bool  # True = derived from this deployment's own ingests
    sample_size: int

    @property
    def human(self) -> str:
        return f"{_human(self.seconds_low)}–{_human(self.seconds_high)}"


def _human(seconds: float) -> str:
    if seconds < 90:
        return f"{int(round(seconds / 5) * 5)}s"
    minutes = seconds / 60
    return f"{round(minutes)} min" if minutes < 10 else f"{int(round(minutes / 5) * 5)} min"


def fit(samples: Sequence[tuple[int, float]]) -> tuple[float, float, bool]:
    """Least-squares fit of (files, seconds) -> (overhead, per_file).

    Falls back to the seed constants when there is too little data, or when
    the data is degenerate (every repo the same size makes the slope
    unidentifiable) or fits nonsensically (a negative per-file cost means
    noise, not a faster parser).
    """
    usable = [(f, s) for f, s in samples if f > 0 and s > 0]
    if len(usable) < MIN_SAMPLES_TO_CALIBRATE:
        return SEED_FIXED_OVERHEAD, SEED_PER_FILE, False

    n = len(usable)
    mean_f = sum(f for f, _ in usable) / n
    mean_s = sum(s for _, s in usable) / n
    denom = sum((f - mean_f) ** 2 for f, _ in usable)
    if denom == 0:
        return SEED_FIXED_OVERHEAD, SEED_PER_FILE, False

    per_file = sum((f - mean_f) * (s - mean_s) for f, s in usable) / denom
    overhead = mean_s - per_file * mean_f
    if per_file <= 0 or overhead < 0:
        return SEED_FIXED_OVERHEAD, SEED_PER_FILE, False
    return overhead, per_file, True


def estimate(
    file_counts: Sequence[int],
    samples: Optional[Sequence[tuple[int, float]]] = None,
) -> Estimate:
    """Estimate total ingest time for repos with the given file counts."""
    overhead, per_file, calibrated = fit(samples or [])
    total = sum(overhead + per_file * max(files, 0) for files in file_counts)
    return Estimate(
        seconds_low=int(total * LOWER_BOUND),
        seconds_high=int(total * UPPER_BOUND),
        repo_count=len(file_counts),
        file_count=sum(file_counts),
        calibrated=calibrated,
        sample_size=len(samples or []),
    )


def files_from_size_kb(size_kb: int) -> int:
    """Rough file count from GitHub's repo `size` field, for repos we have
    not cloned yet. Only ever feeds an explicitly-ranged estimate."""
    return max(1, int(size_kb / KB_PER_FILE))
