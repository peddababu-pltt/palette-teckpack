"""Database models for the techpack plugin.

Everything a job needs lives here, not on one server: any backend instance (or
the durable job worker) can serve, resume or cancel any job after a restart.

`Job` is the ownership record for a techpack job. Every job route loads the
caller's row before touching the job's files, stream or process: a job with no
row (including every job folder created before this table existed) is invisible
through the API. organization_id + row-level security come from OrgScopedTable,
so another organisation's rows never come back from a query at all.

Imported once under this unique module name (not evicted on hot reload like
main.py's other sibling modules): re-executing a mapped class would re-register
the table on PluginBase.metadata and fail with "Table already defined".
"""

from datetime import UTC, datetime

from palette_sdk.db import OrgScopedTable
from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

JOBS_TABLE = "techpack__jobs"
FILES_TABLE = "techpack__job_files"
RUNS_TABLE = "techpack__job_runs"


def _now() -> datetime:
    return datetime.now(UTC)


class Job(OrgScopedTable):
    __tablename__ = JOBS_TABLE

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    shared_org: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    shared_user_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


class JobFile(OrgScopedTable):
    """One file of a job (input photo, flats, variations, parts, pattern, GLB...).
    The source of truth for job files: each server's JOBS_DIR is only a cache
    filled from here on demand. `mtime` is the file's version -- a cached copy
    gets the same mtime, so ?v= cache-busting URLs agree across servers."""

    __tablename__ = FILES_TABLE

    id: Mapped[str] = mapped_column(String(600), primary_key=True)  # "<job_id>/<path>"
    job_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    path: Mapped[str] = mapped_column(String(512), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
    content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mtime: Mapped[float] = mapped_column(Float, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


class JobRun(OrgScopedTable):
    """The latest run of one pipeline slot of a job ("<job_id>" for the create
    pipeline, "<job_id>:<stage>" for stage4/stage5/garment3d/...). Holds
    progress, the event log the page polls, and the cancel request, so they
    survive restarts and work from whichever server a request lands on."""

    __tablename__ = RUNS_TABLE

    id: Mapped[str] = mapped_column(String(80), primary_key=True)  # slot
    job_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    run_id: Mapped[str] = mapped_column(String(32), nullable=False)  # changes on every (re)start
    handle_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # ctx.jobs id
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # queued|running|done|error|cancelled
    generating: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    events: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # newest RUN_EVENTS_KEPT
    events_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
