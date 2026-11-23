"""Job access control and durable job state.

Access: a job is visible only to its creator, teammates it was shared with, or
the whole organisation when shared org-wide -- never to another organisation.

Durability: job files, progress, the event log and cancel live in the
database, and the pipeline runs as a durable job -- so a request that lands on
another server (simulated here by wiping this process's JOBS_DIR cache) still
sees the files and the run, and cancel reaches the worker.

Runs the real routes and the real job handler against SQLite, with a fake
platform: user / org from X-User / X-Org headers, and a durable-job service
that runs the handler in its own task with a fresh session, as the worker does.

    PYTHONPATH=<palette_sdk dir>:<aiosqlite+pytest dir> python -m pytest backend/tests
"""

import asyncio
import io
import json
import shutil
import sys
import time
import uuid
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, Request
from PIL import Image
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
import main  # noqa: E402
from palette_sdk import PluginContext  # noqa: E402
from palette_sdk.db import PluginBase  # noqa: E402
from palette_sdk.jobs import JobExecution, JobsClient  # noqa: E402
from techpack_models import JobRun  # noqa: E402

BASE = "/api/v1/plugins/techpack"
MEMBERS = {
    1: [{"user_id": "alice", "name": "Alice"}, {"user_id": "bob", "name": "Bob"},
        {"user_id": "carol", "name": "Carol"}],
    2: [{"user_id": "mallory", "name": "Mallory"}],
}
PERMS = ["resources:read", "resources:write", "members:read"]


class FakeMembers:
    def __init__(self, org: int):
        self.org = org

    async def list_members(self):
        return MEMBERS[self.org]


class FakeJobs:
    """The platform's durable job service. run=False only records the enqueue
    (a worker that hasn't picked the job up yet)."""

    def __init__(self, harness):
        self.h = harness
        self.run = False
        self.records: dict[str, dict] = {}
        self.tasks: list[asyncio.Task] = []

    def bind(self, user: str, org: int):
        jobs = self

        class Bound:
            async def enqueue(self, name, payload, *, idempotency_key=None):
                job_id = uuid.uuid4().hex
                rec = {"id": job_id, "cancel": False, "user": user, "org": org, "status": "queued"}
                jobs.records[job_id] = rec
                if jobs.run:
                    jobs.tasks.append(asyncio.create_task(jobs._execute(rec, name, payload)))
                return {"job_id": job_id, "status": "queued"}

            async def get(self, job_id):
                return jobs.records[job_id]

            async def cancel(self, job_id):
                jobs.records[job_id]["cancel"] = True
                return jobs.records[job_id]

        return Bound()

    async def _execute(self, rec, name, payload):
        assert name == main.RUN_HANDLER

        class Adapter:
            async def progress(self, percent, message=None):
                pass

            async def heartbeat(self):
                pass

            async def cancelled(self):
                return rec["cancel"]

        async with self.h.Session() as session:
            ctx = PluginContext(db=session, user_id=rec["user"], organization_id=rec["org"],
                                permissions=PERMS, jobs=JobsClient(self.bind(rec["user"], rec["org"])))
            execution = JobExecution(Adapter(), job_id=rec["id"], attempt=1)
            rec["result"] = await main.run_pipeline(ctx, execution, payload)
            rec["status"] = "completed"

    async def drain(self):
        while self.tasks:
            await self.tasks.pop(0)


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(buf, "PNG")
    return buf.getvalue()


class Harness:
    def __init__(self, tmp: Path):
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{tmp / 'db.sqlite3'}")
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        self.jobs = FakeJobs(self)
        app = FastAPI()

        @app.middleware("http")
        async def fake_platform(request: Request, call_next):
            user = request.headers.get("x-user", "alice")
            org = int(request.headers.get("x-org", "1"))
            async with self.Session() as session:
                request.state.db = session
                request.state.user = SimpleNamespace(id=user, name=user, organization_id=org)
                request.state.data_partition_id = org
                request.state.plugin_permissions = PERMS
                request.state.org_members = FakeMembers(org)
                request.state.plugin_jobs = self.jobs.bind(user, org)
                return await call_next(request)

        app.include_router(main.router, prefix=BASE)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")

    async def setup(self):
        async with self.engine.begin() as conn:
            await conn.run_sync(PluginBase.metadata.create_all)

    async def close(self):
        await self.jobs.drain()
        await self.client.aclose()
        await self.engine.dispose()

    def req(self, method, path, user="alice", org=1, **kw):
        return self.client.request(method, BASE + path, headers={"x-user": user, "x-org": str(org)}, **kw)

    async def new_job(self, user="alice", org=1) -> str:
        r = await self.req("POST", "/jobs/new-with-sketch", user, org,
                           files={"sketch": ("s.png", png_bytes(), "image/png")})
        assert r.status_code == 200, r.text
        return r.json()["job_id"]

    async def listed(self, user, org=1) -> set[str]:
        r = await self.req("GET", "/jobs/list", user, org)
        assert r.status_code == 200, r.text
        return {j["job_id"] for j in r.json()["jobs"]}

    async def wait_run(self, job_id, stage, user="alice", timeout=20.0) -> dict:
        """Poll the run like the page does until it ends; returns status + all events."""
        after, events, deadline = 0, [], time.monotonic() + timeout
        q = f"&stage={stage}" if stage else ""
        while time.monotonic() < deadline:
            r = await self.req("GET", f"/jobs/{job_id}/run?after={after}{q}", user)
            assert r.status_code == 200, r.text
            body = r.json()
            events += body["events"]
            after = body["total"]
            if body["status"] not in ("queued", "running"):
                return {"status": body["status"], "events": events, "error": body["error"]}
            await asyncio.sleep(0.1)
        raise AssertionError("run did not finish")


def wipe_cache():
    """Another server: same database, empty JOBS_DIR."""
    for p in main.JOBS_DIR.iterdir():
        shutil.rmtree(p)


@pytest.fixture
def h(tmp_path, monkeypatch):
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    monkeypatch.setattr(main, "JOBS_DIR", jobs)
    harness = Harness(tmp_path)
    asyncio.run(harness.setup())
    yield harness
    asyncio.run(harness.close())


def fake_steps(monkeypatch, script: str, out_name: str = "parts.svg"):
    """Replace the real pipeline (paid model calls) with a small python step."""
    def build(job_id, spec):
        paths = main.job_paths(job_id)
        cmd = [sys.executable, "-c", script, str(paths["dir"] / out_name)]
        return [("stage 4", cmd)], lambda: {"event": "stage_done", "stage": 4,
                                            "file": main._url(job_id, out_name)}
    monkeypatch.setattr(main, "build_steps", build)


async def access_codes(h: Harness, job_id: str, user: str, org: int = 1) -> dict[str, int]:
    """Status of the read / follow / cancel routes for this caller, with a queued run present."""
    h.jobs.run = False
    r = await h.req("POST", f"/jobs/{job_id}/stage4", "alice")  # owner queues a run (no worker)
    assert r.status_code in (200, 404), r.text
    return {
        "file": (await h.req("GET", f"/jobs/{job_id}/file/flat_sketch.png", user, org)).status_code,
        "thumb": (await h.req("GET", f"/jobs/{job_id}/thumb/flat_sketch.png", user, org)).status_code,
        "run": (await h.req("GET", f"/jobs/{job_id}/run?stage=stage4", user, org)).status_code,
        "cancel": (await h.req("POST", f"/jobs/{job_id}/cancel?stage=stage4", user, org)).status_code,
    }


ALLOWED = {"file": 200, "thumb": 200, "run": 200, "cancel": 200}
DENIED = {"file": 404, "thumb": 404, "run": 404, "cancel": 404}


# ---------------------------------------------------------------- access

def test_private_to_creator(h):
    async def go():
        job = await h.new_job("alice")
        assert job in await h.listed("alice")
        assert await access_codes(h, job, "bob") == DENIED  # same org, not shared
        assert await access_codes(h, job, "mallory", 2) == DENIED  # another org
        assert job not in await h.listed("bob")
        assert job not in await h.listed("mallory", 2)
        for user, org in (("bob", 1), ("mallory", 2)):
            assert (await h.req("DELETE", f"/jobs/{job}", user, org)).status_code == 404
        assert await access_codes(h, job, "alice") == ALLOWED
    asyncio.run(go())


def test_share_with_teammate_then_unshare(h):
    async def go():
        job = await h.new_job("alice")
        r = await h.req("PUT", f"/jobs/{job}/share", "alice", json={"users": ["bob"], "org": False})
        assert r.status_code == 200 and r.json() == {"org": False, "users": ["bob"]}
        assert job in await h.listed("bob")
        assert await access_codes(h, job, "bob") == ALLOWED
        assert (await h.req("DELETE", f"/jobs/{job}", "bob")).status_code == 404
        assert (await h.req("PUT", f"/jobs/{job}/share", "bob", json={"users": ["carol"]})).status_code == 404
        assert (await h.req("GET", f"/jobs/{job}/share", "bob")).status_code == 404
        assert await access_codes(h, job, "carol") == DENIED
        bob_entry = next(j for j in (await h.req("GET", "/jobs/list", "bob")).json()["jobs"] if j["job_id"] == job)
        assert bob_entry["owner"] is False and bob_entry["shared"] is None
        r = await h.req("PUT", f"/jobs/{job}/share", "alice", json={"users": [], "org": False})
        assert r.status_code == 200
        assert job not in await h.listed("bob")
        assert await access_codes(h, job, "bob") == DENIED
    asyncio.run(go())


def test_share_with_whole_org_stays_in_org(h):
    async def go():
        job = await h.new_job("alice")
        r = await h.req("PUT", f"/jobs/{job}/share", "alice", json={"users": [], "org": True})
        assert r.status_code == 200
        for teammate in ("bob", "carol"):
            assert job in await h.listed(teammate)
            assert await access_codes(h, job, teammate) == ALLOWED
        assert job not in await h.listed("mallory", 2)
        assert await access_codes(h, job, "mallory", 2) == DENIED
    asyncio.run(go())


def test_cannot_share_outside_org(h):
    async def go():
        job = await h.new_job("alice")
        r = await h.req("PUT", f"/jobs/{job}/share", "alice", json={"users": ["mallory"]})
        assert r.status_code == 400
        assert await access_codes(h, job, "mallory", 2) == DENIED
    asyncio.run(go())


def test_owner_delete_removes_job_everywhere(h):
    async def go():
        job = await h.new_job("alice")
        assert (await h.req("DELETE", f"/jobs/{job}", "alice")).status_code == 200
        assert not (main.JOBS_DIR / job).exists()
        assert job not in await h.listed("alice")
        assert (await h.req("GET", f"/jobs/{job}/file/flat_sketch.png", "alice")).status_code == 404
    asyncio.run(go())


def test_legacy_folder_without_row_is_hidden_but_kept(h):
    async def go():
        legacy = "abcdef012345"
        (main.JOBS_DIR / legacy).mkdir()
        (main.JOBS_DIR / legacy / "flat_sketch.png").write_bytes(png_bytes())
        assert legacy not in await h.listed("alice")
        assert (await h.req("GET", f"/jobs/{legacy}/file/flat_sketch.png", "alice")).status_code == 404
        assert (await h.req("GET", f"/jobs/{legacy}/run", "alice")).status_code == 404
        assert (await h.req("DELETE", f"/jobs/{legacy}", "alice")).status_code == 404
        assert (main.JOBS_DIR / legacy / "flat_sketch.png").is_file()
    asyncio.run(go())


def test_bad_job_ids_and_paths_rejected(h):
    async def go():
        for bad in ("..", "ABCDEF012345", "abc", "abcdef0123456"):
            assert (await h.req("GET", f"/jobs/{bad}/file/flat_sketch.png", "alice")).status_code == 404, bad
        job = await h.new_job("alice")
        r = await h.req("GET", f"/jobs/{job}/file/..%2F..%2Fdb.sqlite3", "alice")
        assert r.status_code == 404
    asyncio.run(go())


def test_members_excludes_self(h):
    async def go():
        body = (await h.req("GET", "/members", "alice")).json()
        assert body["available"] is True
        assert [m["id"] for m in body["members"]] == ["bob", "carol"]
        assert "mallory" not in json.dumps(body)
    asyncio.run(go())


# ---------------------------------------------------------------- durability

def test_files_survive_without_local_cache(h):
    async def go():
        job = await h.new_job("alice")
        wipe_cache()
        r = await h.req("GET", f"/jobs/{job}/file/flat_sketch.png", "alice")
        assert r.status_code == 200 and r.content == png_bytes()
        wipe_cache()
        assert job in await h.listed("alice")
        assert (await h.req("GET", f"/jobs/{job}/thumb/flat_sketch.png", "alice")).status_code == 200
    asyncio.run(go())


def test_run_progress_and_output_from_any_server(h, monkeypatch):
    fake_steps(monkeypatch, "import sys; print('tracing parts'); open(sys.argv[1], 'w').write('<svg/>')")

    async def go():
        job = await h.new_job("alice")
        h.jobs.run = True
        assert (await h.req("POST", f"/jobs/{job}/stage4", "alice")).status_code == 200
        await h.jobs.drain()
        wipe_cache()  # the worker's server is gone; this one has never seen the job
        result = await h.wait_run(job, "stage4")
        assert result["status"] == "done", result
        assert "[stage 4] tracing parts" in result["events"]
        kinds = [json.loads(e)["event"] for e in result["events"] if e.startswith("{")]
        assert kinds[0] == "stage_progress" and kinds[-2:] == ["stage_done", "done"]
        r = await h.req("GET", f"/jobs/{job}/file/parts.svg", "alice")
        assert r.status_code == 200 and r.text == "<svg/>"
        entry = next(j for j in (await h.req("GET", "/jobs/list", "alice")).json()["jobs"] if j["job_id"] == job)
        assert entry["outputs"]["parts_svg"].startswith(f"/api/v1/plugins/techpack/jobs/{job}/file/parts.svg?v=")
        # polling from a later offset returns only the new events (none now)
        r = await h.req("GET", f"/jobs/{job}/run?stage=stage4&after={len(result['events'])}", "alice")
        assert r.json()["events"] == []
    asyncio.run(go())


def test_pipeline_failure_reported(h, monkeypatch):
    fake_steps(monkeypatch, "import sys; print('boom: model refused'); sys.exit(3)")

    async def go():
        job = await h.new_job("alice")
        h.jobs.run = True
        await h.req("POST", f"/jobs/{job}/stage4", "alice")
        await h.jobs.drain()
        result = await h.wait_run(job, "stage4")
        assert result["status"] == "error" and "boom: model refused" in result["error"]
    asyncio.run(go())


def test_cancel_reaches_worker(h, monkeypatch):
    fake_steps(monkeypatch, "import time\nfor i in range(300):\n    print('tick', flush=True); time.sleep(0.1)")

    async def go():
        job = await h.new_job("alice")
        h.jobs.run = True
        await h.req("POST", f"/jobs/{job}/stage4", "alice")
        for _ in range(100):  # wait until the worker is running the step
            body = (await h.req("GET", f"/jobs/{job}/run?stage=stage4", "alice")).json()
            if any("tick" in e for e in body["events"]):
                break
            await asyncio.sleep(0.05)
        started = time.monotonic()
        assert (await h.req("POST", f"/jobs/{job}/cancel?stage=stage4", "alice")).status_code == 200
        await h.jobs.drain()
        assert time.monotonic() - started < 10  # killed, not left to run 30s
        result = await h.wait_run(job, "stage4")
        assert result["status"] == "cancelled"
        assert (await h.req("POST", f"/jobs/{job}/cancel?stage=stage4", "alice")).status_code == 404
    asyncio.run(go())


def test_stale_run_does_not_block(h):
    async def go():
        job = await h.new_job("alice")
        h.jobs.run = False
        await h.req("POST", f"/jobs/{job}/stage4", "alice")
        async with h.Session() as s:  # its worker died long ago
            run = await s.get(JobRun, f"{job}:stage4")
            run.status, run.updated_at = "running", main._utcnow() - timedelta(minutes=10)
            await s.commit()
        body = (await h.req("GET", f"/jobs/{job}/run?stage=stage4", "alice")).json()
        assert body["status"] == "error" and "stopped responding" in body["error"]
        old_run_id = run.run_id
        await h.req("POST", f"/jobs/{job}/stage4", "alice")  # a rerun is allowed
        async with h.Session() as s:
            fresh = await s.get(JobRun, f"{job}:stage4")
            assert fresh.status == "queued" and fresh.run_id != old_run_id
    asyncio.run(go())


def test_generating_blocks_parts_and_pattern(h):
    async def go():
        h.jobs.run = False
        r = await h.req("POST", "/jobs/generate", "alice", files={"photo": ("p.png", png_bytes(), "image/png")})
        job = r.json()["job_id"]
        (main.JOBS_DIR / job / "flat_sketch.png").write_bytes(png_bytes())
        async with h.Session() as s:
            await main.push_files(SimpleNamespace(db=s, organization_id=1), job)
        assert (await h.req("POST", f"/jobs/{job}/stage4", "alice")).status_code == 409
        assert (await h.req("POST", f"/jobs/{job}/stage5", "alice")).status_code == 409
        entry = next(j for j in (await h.req("GET", "/jobs/list", "alice")).json()["jobs"] if j["job_id"] == job)
        assert entry["generating"] is True
    asyncio.run(go())


def test_generate_retry_with_same_request_id_makes_one_job(h):
    """A gateway 502/503/504 can come back after the job was already created;
    the browser's retry carries the same request_id and must not start a second
    techpack from the same input."""
    async def go():
        h.jobs.run = False
        rid = "a1b2c3d4e5f6"
        send = lambda user="alice": h.req("POST", "/jobs/generate", user, files={"photo": ("p.png", png_bytes(), "image/png")},
                                          data={"request_id": rid})
        first = await send()
        assert first.status_code == 200, first.text
        assert first.json()["job_id"] == rid
        again = await send()
        assert again.status_code == 200, again.text
        assert again.json()["job_id"] == rid and again.json().get("duplicate") is True
        async def owned(user):
            async with h.Session() as s:
                rows = (await s.execute(main.select(main.Job).where(main.Job.owner_user_id == user))).scalars().all()
                return [r.id for r in rows]
        assert await owned("alice") == [rid]  # one techpack, not two
        # another user's identical id never hands them alice's job
        other = await send("bob")
        assert other.status_code == 200 and other.json()["job_id"] != rid
        assert rid not in await owned("bob")
    asyncio.run(go())
