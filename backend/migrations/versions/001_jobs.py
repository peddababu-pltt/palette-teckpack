"""Job ownership table: owner, organisation (RLS) and who it is shared with."""

import sqlalchemy as sa
from alembic import op
from palette_sdk.db import ensure_org_rls

revision = "001_jobs"
down_revision = None

TABLE = "techpack__jobs"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("organization_id", sa.BigInteger(), nullable=False),
        sa.Column("owner_user_id", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("shared_org", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("shared_user_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(f"ix_{TABLE}_org", TABLE, ["organization_id"])
    op.create_index(f"ix_{TABLE}_owner_user_id", TABLE, ["owner_user_id"])
    ensure_org_rls(op, TABLE)


def downgrade() -> None:
    op.drop_index(f"ix_{TABLE}_owner_user_id", table_name=TABLE)
    op.drop_index(f"ix_{TABLE}_org", table_name=TABLE)
    op.drop_table(TABLE)
