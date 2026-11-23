"""Job files and run state move into the database (out of one server's disk/memory)."""

import sqlalchemy as sa
from alembic import op
from palette_sdk.db import ensure_org_rls

revision = "002_job_files_runs"
down_revision = "001_jobs"

FILES = "techpack__job_files"
RUNS = "techpack__job_runs"


def upgrade() -> None:
    op.create_table(
        FILES,
        sa.Column("id", sa.String(600), primary_key=True),
        sa.Column("organization_id", sa.BigInteger(), nullable=False),
        sa.Column("job_id", sa.String(32), nullable=False),
        sa.Column("path", sa.String(512), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(128), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("mtime", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(f"ix_{FILES}_org", FILES, ["organization_id"])
    op.create_index(f"ix_{FILES}_job_id", FILES, ["job_id"])
    ensure_org_rls(op, FILES)

    op.create_table(
        RUNS,
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.BigInteger(), nullable=False),
        sa.Column("job_id", sa.String(32), nullable=False),
        sa.Column("stage", sa.String(32), nullable=False, server_default=""),
        sa.Column("run_id", sa.String(32), nullable=False),
        sa.Column("handle_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("generating", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("events", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("events_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(f"ix_{RUNS}_org", RUNS, ["organization_id"])
    op.create_index(f"ix_{RUNS}_job_id", RUNS, ["job_id"])
    ensure_org_rls(op, RUNS)


def downgrade() -> None:
    op.drop_index(f"ix_{RUNS}_job_id", table_name=RUNS)
    op.drop_index(f"ix_{RUNS}_org", table_name=RUNS)
    op.drop_table(RUNS)
    op.drop_index(f"ix_{FILES}_job_id", table_name=FILES)
    op.drop_index(f"ix_{FILES}_org", table_name=FILES)
    op.drop_table(FILES)
