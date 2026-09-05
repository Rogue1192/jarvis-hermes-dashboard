"""board.py — the mission board, read and written straight from kanban.db.

Hermes already owns a task database at %LOCALAPPDATA%/hermes/kanban.db: tasks,
comments, attachments, an event trail and run records. The dashboard used to
keep its own list in state.json instead, which never got written and would have
disagreed with Hermes the moment it did. This module reads the real one.

Two things drive the design, and both come from Casey:

1. Three verdicts, not two. Approve, reject, and REJECT WITH CHANGES -- the
   third carries a note that lands as a comment so the next run reads it. A
   plain reject sends the agent back to a blank page.

2. You cannot approve what you cannot see. Every card waiting on approval has
   to open its own output here: the image, the video, the copy, the staging
   URL. A board where a person clicks Approve without opening the file is worse
   than no board, because it launders a broken output as reviewed. So a card
   whose output cannot be shown reports that, and the approve action is refused
   rather than defaulted.
"""
import json
import os
import pathlib
import sqlite3
import time

# The five columns. `status` is free text in the schema, so these are just the
# strings the board writes; nothing here needs a migration.
COLUMNS = ["todo", "in_process", "needs_approval", "final_review", "complete"]

# Archived cards are not deleted and not a sixth column. They keep their
# comments, attachments and event history -- the record of what was approved
# and why is the only reason any of this is worth keeping -- they simply stop
# crowding the Complete column. `status` is free text, so this costs no schema
# change and nothing else in Hermes has to know about it.
ARCHIVED = "archived"

# Anything not one of ours still has to land somewhere visible -- a task Hermes
# created with its own vocabulary should not silently vanish from the board.
_ALIASES = {
    "open": "todo", "queued": "todo", "pending": "todo", "new": "todo",
    "running": "in_process", "in-progress": "in_process", "in progress": "in_process",
    "active": "in_process", "claimed": "in_process",
    "review": "needs_approval", "awaiting_approval": "needs_approval",
    "blocked": "needs_approval", "awaiting_input": "needs_approval",
    "final-review": "final_review", "qa": "final_review",
    "done": "complete", "completed": "complete", "closed": "complete",
}

PREVIEWABLE_IMAGE = ("image/",)
PREVIEWABLE_VIDEO = ("video/",)


def db_path() -> pathlib.Path:
    """Hermes' own database. Overridable for tests and odd installs."""
    env = os.environ.get("JARVIS_KANBAN_DB")
    if env:
        return pathlib.Path(env)
    local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local")
    return pathlib.Path(local) / "hermes" / "kanban.db"


def _connect():
    p = db_path()
    if not p.is_file():
        return None
    # Read-write, but never create: if the path is wrong we want to know, not
    # to quietly start a second empty database beside the real one.
    con = sqlite3.connect("file:%s?mode=rw" % p.as_posix(), uri=True, timeout=4)
    con.row_factory = sqlite3.Row
    return con


def column_for(status) -> str:
    """Which column a status belongs in, or None when it belongs in none.

    Unknown statuses fall to todo rather than vanishing: a task Hermes created
    with its own vocabulary should show up somewhere a person will see it.
    Archived is the one status that deliberately shows nowhere."""
    s = (status or "").strip().lower().replace(" ", "_")
    if s == ARCHIVED:
        return None
    if s in COLUMNS:
        return s
    return _ALIASES.get(s, "todo")


def _attachments(con, task_id):
    try:
        rows = con.execute(
            "select id, filename, content_type, size from task_attachments "
            "where task_id=? order by created_at", (task_id,)).fetchall()
    except sqlite3.Error:
        return []
    return [dict(id=r["id"], filename=r["filename"],
                 content_type=r["content_type"] or "",
                 size=r["size"]) for r in rows]


def _preview_for(task, atts):
    """What this card opens when someone clicks it.

    Returns a dict the UI renders, or a `blocked` reason. The reason matters as
    much as the preview: a card that cannot be shown must say why, because the
    approve button is refused on it and the reviewer deserves to know that is
    deliberate rather than broken.
    """
    for a in atts:
        ct = (a["content_type"] or "").lower()
        if ct.startswith(PREVIEWABLE_IMAGE):
            return dict(kind="image", attachment_id=a["id"], label=a["filename"])
        if ct.startswith(PREVIEWABLE_VIDEO):
            return dict(kind="video", attachment_id=a["id"], label=a["filename"])

    # A build has no file -- it has somewhere to look. Convention: the task's
    # `result` holds a URL, or JSON carrying one.
    result = (task["result"] or "").strip()
    if result:
        url = None
        if result.startswith("http://") or result.startswith("https://"):
            url = result.split()[0]
        else:
            try:
                blob = json.loads(result)
                if isinstance(blob, dict):
                    for k in ("staging_url", "url", "preview_url", "link"):
                        v = blob.get(k)
                        if isinstance(v, str) and v.startswith("http"):
                            url = v
                            break
            except (ValueError, TypeError):
                pass
        if url:
            return dict(kind="url", url=url, label=url)

    body = (task["body"] or "").strip()
    if body:
        return dict(kind="text", text=body)

    return dict(kind="none",
                blocked="Nothing to review on this card — no file, no link, no copy. "
                        "Approving it would sign off on something nobody can see.")


def snapshot():
    """Every card, bucketed into the five columns."""
    con = _connect()
    if con is None:
        return dict(ok=False,
                    error="kanban.db not found at %s" % db_path(),
                    columns={c: [] for c in COLUMNS})
    try:
        rows = con.execute(
            "select id, title, body, assignee, status, priority, tenant, "
            "project_id, skills, result, created_at, completed_at "
            "from tasks order by coalesce(created_at, 0) desc").fetchall()
    except sqlite3.Error as e:
        con.close()
        return dict(ok=False, error="kanban.db unreadable: %s" % e,
                    columns={c: [] for c in COLUMNS})

    out = {c: [] for c in COLUMNS}
    for r in rows:
        col = column_for(r["status"])
        if col is None:
            continue
        atts = _attachments(con, r["id"])
        skills = r["skills"]
        try:
            skills = json.loads(skills) if skills else []
        except (ValueError, TypeError):
            skills = [str(skills)]
        card = dict(
            id=r["id"],
            title=r["title"] or "(untitled)",
            client=r["tenant"] or r["project_id"] or None,
            agent=(skills[0] if skills else None) or r["assignee"] or None,
            priority=r["priority"],
            status=r["status"],
            attachments=len(atts),
            preview=_preview_for(r, atts),
            created_at=r["created_at"],
        )
        out[col].append(card)
    archived = con.execute(
        "select count(*) from tasks where lower(coalesce(status,''))=?",
        (ARCHIVED,)).fetchone()[0]
    con.close()
    return dict(ok=True, columns=out,
                counts={c: len(v) for c, v in out.items()},
                archived=archived)


def _event(con, task_id, kind, payload):
    try:
        con.execute(
            "insert into task_events (task_id, kind, payload, created_at) values (?,?,?,?)",
            (task_id, kind, json.dumps(payload), int(time.time())))
    except sqlite3.Error:
        # An event row failing must not lose the decision itself.
        pass


VERDICTS = {"approve", "reject", "reject_with_changes"}


def decide(task_id, verdict, note=None, author="casey"):
    """Record a verdict against a card.

    reject_with_changes is the one that keeps work moving, so its note is
    required: a rejection with no direction is just a rejection wearing a
    friendlier label, and the next run learns nothing from it.
    """
    if verdict not in VERDICTS:
        return dict(ok=False, error="unknown verdict %r" % verdict)
    if verdict == "reject_with_changes" and not (note or "").strip():
        return dict(ok=False,
                    error="Reject with changes needs the changes. Say what to fix.")

    con = _connect()
    if con is None:
        return dict(ok=False, error="kanban.db not found at %s" % db_path())

    row = con.execute("select id, status, body, result from tasks where id=?",
                      (task_id,)).fetchone()
    if row is None:
        con.close()
        return dict(ok=False, error="no task %s" % task_id)

    # Refuse to approve something with nothing to look at. The whole reason this
    # board exists is that agent pipelines report success on broken output.
    if verdict == "approve":
        prev = _preview_for(row, _attachments(con, task_id))
        if prev.get("blocked"):
            con.close()
            return dict(ok=False, error=prev["blocked"])

    status = {"approve": "final_review",
              "reject": "todo",
              "reject_with_changes": "todo"}[verdict]

    try:
        con.execute("update tasks set status=? where id=?", (status, task_id))
        if (note or "").strip():
            con.execute(
                "insert into task_comments (task_id, author, body, created_at) "
                "values (?,?,?,?)",
                (task_id, author, note.strip(), int(time.time())))
        _event(con, task_id, "verdict",
               dict(verdict=verdict, note=(note or "").strip() or None, by=author))
        con.commit()
    except sqlite3.Error as e:
        con.close()
        return dict(ok=False, error="could not record the verdict: %s" % e)
    con.close()
    return dict(ok=True, task_id=task_id, verdict=verdict, status=status)


def attachment(attachment_id):
    """Bytes for one attachment, so the lightbox can show it."""
    con = _connect()
    if con is None:
        return None
    r = con.execute(
        "select filename, stored_path, content_type from task_attachments where id=?",
        (attachment_id,)).fetchone()
    con.close()
    if r is None:
        return None
    p = pathlib.Path(r["stored_path"] or "")
    if not p.is_file():
        return None
    return (p.read_bytes(),
            r["content_type"] or "application/octet-stream",
            r["filename"])


def archive(task_ids, author="casey"):
    """Move finished cards out of Complete without losing them.

    Only from `complete`. Archiving something still in flight would hide live
    work behind a button nobody opens, which is a worse failure than a cluttered
    column -- so a card that is not complete is refused and named, rather than
    skipped quietly.
    """
    ids = [str(t) for t in (task_ids or []) if str(t).strip()]
    if not ids:
        return dict(ok=False, error="nothing selected")

    con = _connect()
    if con is None:
        return dict(ok=False, error="kanban.db not found at %s" % db_path())

    done, refused = [], []
    for tid in ids:
        row = con.execute("select id, status from tasks where id=?", (tid,)).fetchone()
        if row is None:
            refused.append(dict(id=tid, why="no such card"))
            continue
        if column_for(row["status"]) != "complete":
            refused.append(dict(id=tid, why="not complete — it is in %s"
                                % (column_for(row["status"]) or "archived")))
            continue
        try:
            con.execute("update tasks set status=? where id=?", (ARCHIVED, tid))
            _event(con, tid, "archived", dict(by=author))
            done.append(tid)
        except sqlite3.Error as e:
            refused.append(dict(id=tid, why=str(e)))
    con.commit()
    con.close()
    return dict(ok=bool(done), archived=done, refused=refused)


def unarchive(task_ids, author="casey"):
    """Back to Complete, where it was before."""
    ids = [str(t) for t in (task_ids or []) if str(t).strip()]
    if not ids:
        return dict(ok=False, error="nothing selected")
    con = _connect()
    if con is None:
        return dict(ok=False, error="kanban.db not found at %s" % db_path())
    done = []
    for tid in ids:
        try:
            cur = con.execute(
                "update tasks set status='complete' where id=? and lower(coalesce(status,''))=?",
                (tid, ARCHIVED))
            if cur.rowcount:
                _event(con, tid, "unarchived", dict(by=author))
                done.append(tid)
        except sqlite3.Error:
            pass
    con.commit()
    con.close()
    return dict(ok=bool(done), restored=done)


def archived_cards():
    """What is in the archive, newest first."""
    con = _connect()
    if con is None:
        return dict(ok=False, error="kanban.db not found at %s" % db_path(), cards=[])
    try:
        rows = con.execute(
            "select id, title, body, assignee, status, tenant, project_id, skills, "
            "result, completed_at, created_at from tasks "
            "where lower(coalesce(status,''))=? "
            "order by coalesce(completed_at, created_at, 0) desc", (ARCHIVED,)).fetchall()
    except sqlite3.Error as e:
        con.close()
        return dict(ok=False, error=str(e), cards=[])

    cards = []
    for r in rows:
        atts = _attachments(con, r["id"])
        skills = r["skills"]
        try:
            skills = json.loads(skills) if skills else []
        except (ValueError, TypeError):
            skills = []
        cards.append(dict(
            id=r["id"], title=r["title"] or "(untitled)",
            client=r["tenant"] or r["project_id"] or None,
            agent=(skills[0] if skills else None) or r["assignee"] or None,
            preview=_preview_for(r, atts),
            completed_at=r["completed_at"] or r["created_at"]))
    con.close()
    return dict(ok=True, cards=cards)
