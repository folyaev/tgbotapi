# utmanager/db.py

from __future__ import annotations



import sqlite3

from pathlib import Path

from typing import Optional, List, Tuple, Any, Iterable, Dict, cast

from datetime import datetime, UTC



from .config import BASE_ROOT



DB_PATH = BASE_ROOT / "state.sqlite"

DB_PATH.parent.mkdir(parents=True, exist_ok=True)



conn = sqlite3.connect(DB_PATH)

conn.execute("PRAGMA journal_mode=WAL;")



# ----- schema -----

conn.execute("""

CREATE TABLE IF NOT EXISTS topics(

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  chat_id INTEGER NOT NULL,

  bucket TEXT NOT NULL,

  name TEXT NOT NULL,

  created_at TEXT NOT NULL

)""")

try:

    conn.execute("SELECT bucket FROM topics LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE topics ADD COLUMN bucket TEXT NOT NULL DEFAULT ''")

conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_unique ON topics(chat_id,bucket,name)")
try:
    conn.execute("SELECT archived FROM topics LIMIT 1")
except Exception:
    conn.execute("ALTER TABLE topics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
conn.execute("CREATE INDEX IF NOT EXISTS idx_topics_visible ON topics(chat_id,bucket,archived,id)")



conn.execute("""

CREATE TABLE IF NOT EXISTS pending_newtopic(

  chat_id INTEGER NOT NULL,

  user_id INTEGER NOT NULL,

  progress_msg_id INTEGER NOT NULL,

  source_message_id INTEGER NOT NULL DEFAULT 0,

  bucket TEXT NOT NULL DEFAULT '',

  instruction_message_id INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY(chat_id, user_id, progress_msg_id)

)""")

try:

    conn.execute("SELECT source_message_id FROM pending_newtopic LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE pending_newtopic ADD COLUMN source_message_id INTEGER NOT NULL DEFAULT 0")

try:

    conn.execute("SELECT bucket FROM pending_newtopic LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE pending_newtopic ADD COLUMN bucket TEXT NOT NULL DEFAULT ''")

try:

    conn.execute("SELECT instruction_message_id FROM pending_newtopic LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE pending_newtopic ADD COLUMN instruction_message_id INTEGER NOT NULL DEFAULT 0")



conn.execute("""

CREATE TABLE IF NOT EXISTS msg_selection(

  chat_id INTEGER NOT NULL,

  progress_msg_id INTEGER NOT NULL,

  topic_id INTEGER NOT NULL,

  PRIMARY KEY(chat_id, progress_msg_id)

)""")

conn.execute("""

CREATE TABLE IF NOT EXISTS last_topic_selection(

  chat_id INTEGER NOT NULL,

  bucket TEXT NOT NULL,

  topic_id INTEGER NOT NULL,

  updated_at TEXT NOT NULL,

  PRIMARY KEY(chat_id, bucket)

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS seen_files(

  file_unique_id TEXT NOT NULL,

  chat_id INTEGER NOT NULL,

  saved_path TEXT,

  created_at TEXT,

  PRIMARY KEY(file_unique_id, chat_id)

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS file_map(

  chat_id INTEGER NOT NULL,

  progress_msg_id INTEGER NOT NULL,

  abs_path TEXT NOT NULL,

  bucket TEXT NOT NULL,

  category TEXT NOT NULL,

  files_count INTEGER DEFAULT 0,

  origin_message_id INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY(chat_id, progress_msg_id)

)""")

try:

    conn.execute("SELECT origin_message_id FROM file_map LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE file_map ADD COLUMN origin_message_id INTEGER NOT NULL DEFAULT 0")



def _has_column(table: str, column: str) -> bool:

    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()

    return any(col[1] == column for col in cols)





def _has_table(table: str) -> bool:

    row = conn.execute(

        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",

        (table,),

    ).fetchone()

    return row is not None





FILE_MAP_HAS_ORIGIN = _has_column("file_map", "origin_message_id")



FILE_MAP_ENTRIES_DDL = """

CREATE TABLE IF NOT EXISTS file_map_entries(

  chat_id INTEGER NOT NULL,

  progress_msg_id INTEGER NOT NULL,

  origin_message_id INTEGER NOT NULL,

  abs_path TEXT NOT NULL,

  bucket TEXT NOT NULL,

  category TEXT NOT NULL,

  PRIMARY KEY(chat_id, progress_msg_id, origin_message_id)

)

"""



conn.execute(FILE_MAP_ENTRIES_DDL)

FILE_MAP_HAS_ENTRIES = _has_table("file_map_entries")



conn.execute("""

CREATE TABLE IF NOT EXISTS ui_state(

  chat_id INTEGER NOT NULL,

  progress_msg_id INTEGER NOT NULL,

  page INTEGER NOT NULL,

  PRIMARY KEY(chat_id, progress_msg_id)

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS items(

  chat_id    INTEGER NOT NULL,

  message_id INTEGER NOT NULL,

  topic_id   INTEGER NOT NULL,

  kind       TEXT    NOT NULL,

  title      TEXT,

  link       TEXT,

  created_at TEXT    NOT NULL,

  author     TEXT    NOT NULL DEFAULT 'Noname',

  bucket     TEXT    NOT NULL DEFAULT '',

  tags_cache TEXT    NOT NULL DEFAULT '',
  file_id    TEXT,
  file_unique_id TEXT,
  file_name  TEXT,

  PRIMARY KEY(chat_id, message_id)

)""")

conn.execute("""

CREATE INDEX IF NOT EXISTS idx_items_topic ON items(topic_id, created_at DESC)

""")

for column, ddl in (

    ("author", "ALTER TABLE items ADD COLUMN author TEXT NOT NULL DEFAULT 'Noname'"),

    ("bucket", "ALTER TABLE items ADD COLUMN bucket TEXT NOT NULL DEFAULT ''"),

    ("tags_cache", "ALTER TABLE items ADD COLUMN tags_cache TEXT NOT NULL DEFAULT ''"),
    ("file_id", "ALTER TABLE items ADD COLUMN file_id TEXT"),
    ("file_unique_id", "ALTER TABLE items ADD COLUMN file_unique_id TEXT"),
    ("file_name", "ALTER TABLE items ADD COLUMN file_name TEXT"),

):

    try:

        conn.execute(f"SELECT {column} FROM items LIMIT 1")

    except Exception:

        conn.execute(ddl)



conn.execute("""

CREATE TABLE IF NOT EXISTS tags(

  id   INTEGER PRIMARY KEY AUTOINCREMENT,

  name TEXT NOT NULL UNIQUE

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS item_tags(

  item_chat_id    INTEGER NOT NULL,

  item_message_id INTEGER NOT NULL,

  tag_id          INTEGER NOT NULL,

  PRIMARY KEY(item_chat_id, item_message_id, tag_id)

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS topic_tags(

  topic_id INTEGER NOT NULL,

  tag_id   INTEGER NOT NULL,

  PRIMARY KEY(topic_id, tag_id)

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS pending_tags(

  chat_id INTEGER NOT NULL,

  user_id INTEGER NOT NULL,

  topic_id INTEGER NOT NULL,

  message_id INTEGER NOT NULL,

  prompt_message_id INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY(chat_id, user_id, topic_id)

)""")

try:

    conn.execute("SELECT prompt_message_id FROM pending_tags LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE pending_tags ADD COLUMN prompt_message_id INTEGER NOT NULL DEFAULT 0")



conn.execute("""

CREATE TABLE IF NOT EXISTS pending_item_edit(

  chat_id INTEGER NOT NULL,

  user_id INTEGER NOT NULL,

  item_chat_id INTEGER NOT NULL,

  item_message_id INTEGER NOT NULL,

  field TEXT NOT NULL,

  prompt_message_id INTEGER NOT NULL DEFAULT 0,

  context_message_id INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY(chat_id, user_id, item_chat_id, item_message_id)

)""")

try:

    conn.execute("SELECT context_message_id FROM pending_item_edit LIMIT 1")

except Exception:

    conn.execute("ALTER TABLE pending_item_edit ADD COLUMN context_message_id INTEGER NOT NULL DEFAULT 0")



conn.execute("""
CREATE TABLE IF NOT EXISTS browse_state(
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  filter_type TEXT NOT NULL,
  filter_value TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, message_id)
)""")

conn.execute("""
CREATE TABLE IF NOT EXISTS thread_topics(
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(chat_id, thread_id)
)""")

conn.execute("""
CREATE TABLE IF NOT EXISTS reuse_state(
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  item_chat_id INTEGER NOT NULL,
  item_message_id INTEGER NOT NULL,

  bucket TEXT NOT NULL,

  PRIMARY KEY(chat_id, message_id)

)""")



conn.execute("""

CREATE TABLE IF NOT EXISTS pending_reuse_topic(

  chat_id INTEGER NOT NULL,

  user_id INTEGER NOT NULL,

  target_message_id INTEGER NOT NULL,

  item_chat_id INTEGER NOT NULL,

  item_message_id INTEGER NOT NULL,

  bucket TEXT NOT NULL,

  prompt_message_id INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY(chat_id, user_id)

)""")

conn.commit()



# ----- pending newtopic helpers -----
def pending_newtopic_set(
    chat_id: int,
    user_id: int,
    progress_msg_id: int,
    source_message_id: int,
    bucket: str,
    instruction_message_id: int,
) -> None:
    with conn:
        db(
            "INSERT OR REPLACE INTO pending_newtopic(chat_id,user_id,progress_msg_id,source_message_id,bucket,instruction_message_id) "
            "VALUES(?,?,?,?,?,?)",
            chat_id,
            user_id,
            progress_msg_id,
            source_message_id,
            bucket,
            instruction_message_id,
        )


def pending_newtopic_get(chat_id: int, user_id: int) -> Optional[Tuple[int, int, str, int]]:
    row = db(
        "SELECT progress_msg_id,source_message_id,bucket,instruction_message_id FROM pending_newtopic WHERE chat_id=? AND user_id=?",
        chat_id,
        user_id,
    ).fetchone()
    if not row:
        return None
    return int(row[0]), int(row[1]), row[2], int(row[3])


def pending_newtopic_clear(chat_id: int, user_id: int) -> None:
    with conn:
        db("DELETE FROM pending_newtopic WHERE chat_id=? AND user_id=?", chat_id, user_id)


def db(q: str, *args: Any) -> sqlite3.Cursor:

    with conn:

        return conn.execute(q, args)



# ----- topics -----

def topics_count(chat_id: int, bucket: str) -> int:

    return db("SELECT COUNT(*) FROM topics WHERE chat_id=? AND bucket=? AND archived=0", chat_id, bucket).fetchone()[0]



def topics_page(chat_id: int, bucket: str, page: int, per_page: int = 6) -> List[tuple]:

    return db(

        "SELECT id,name FROM topics WHERE chat_id=? AND bucket=? AND archived=0 "

        "ORDER BY id DESC LIMIT ? OFFSET ?",

        chat_id, bucket, per_page, per_page * page

    ).fetchall()



def topics_all(chat_id: int, bucket: str, *, include_archived: bool = False) -> List[Tuple[int, str]]:

    if include_archived:

        rows = db(

            "SELECT id,name FROM topics WHERE chat_id=? AND bucket=? ORDER BY id DESC",

            chat_id,

            bucket,

        ).fetchall()

    else:

        rows = db(

            "SELECT id,name FROM topics WHERE chat_id=? AND bucket=? AND archived=0 ORDER BY id DESC",

            chat_id,

            bucket,

        ).fetchall()

    return [(int(row[0]), row[1]) for row in rows]



def topic_get(topic_id: int) -> Optional[Tuple[int, str, str]]:

    row = db("SELECT chat_id,bucket,name FROM topics WHERE id=?", topic_id).fetchone()

    if not row:

        return None

    return int(row[0]), row[1], row[2]



def topic_create(chat_id: int, bucket: str, name: str) -> int:

    existing_row = db(

        "SELECT id FROM topics WHERE chat_id=? AND bucket=? AND name=? ORDER BY id DESC LIMIT 1",

        chat_id,

        bucket,

        name,

    ).fetchone()

    if existing_row:

        rid = int(existing_row[0])

        with conn:

            db("UPDATE topics SET archived=0 WHERE id=?", rid)

        return rid

    template_row = db(

        "SELECT id FROM topics WHERE bucket=? AND name=? AND chat_id<>? ORDER BY created_at DESC LIMIT 1",

        bucket,

        name,

        chat_id,

    ).fetchone()

    with conn:

        cur = db(

            "INSERT INTO topics(chat_id,bucket,name,created_at) VALUES(?,?,?,?)",

            chat_id,

            bucket,

            name,

            datetime.now(UTC).isoformat(timespec="seconds"),

        )

        rid = cast(int, cur.lastrowid)  # для тайпчекера

        if template_row:

            template_id = int(template_row[0])

            db(

                "INSERT OR IGNORE INTO topic_tags(topic_id,tag_id) SELECT ?, tag_id FROM topic_tags WHERE topic_id=?",

                rid,

                template_id,

            )

    return rid



def topic_upsert(chat_id: int, bucket: str, name: str) -> None:

    with conn:

        db(

            "UPDATE topics SET archived=0 WHERE chat_id=? AND bucket=? AND name=?",

            chat_id, bucket, name

        )

        db(

            "INSERT OR IGNORE INTO topics(chat_id,bucket,name,created_at,archived) VALUES(?,?,?,?,0)",

            chat_id, bucket, name, datetime.now(UTC).isoformat(timespec="seconds")

        )



def topic_set_archived(chat_id: int, bucket: str, topic_id: int, archived: bool) -> None:

    with conn:

        db(
            "UPDATE topics SET archived=? WHERE id=? AND chat_id=? AND bucket=?",
            1 if archived else 0,
            topic_id,
            chat_id,
            bucket,
        )


def topic_delete(chat_id: int, bucket: str, topic_id: int) -> None:

    with conn:

        db("DELETE FROM topic_tags WHERE topic_id=?", topic_id)

        db("DELETE FROM pending_tags WHERE topic_id=?", topic_id)

        db("DELETE FROM msg_selection WHERE chat_id=? AND topic_id=?", chat_id, topic_id)

        db("UPDATE items SET topic_id=0 WHERE chat_id=? AND topic_id=?", chat_id, topic_id)

        db("DELETE FROM topics WHERE id=? AND chat_id=? AND bucket=?", topic_id, chat_id, bucket)



# ----- selection -----

def selection_get(chat_id: int, progress_msg_id: int) -> Optional[int]:

    row = db("SELECT topic_id FROM msg_selection WHERE chat_id=? AND progress_msg_id=?",

             chat_id, progress_msg_id).fetchone()

    return row[0] if row else None



def selection_set(chat_id: int, progress_msg_id: int, topic_id: int) -> None:

    with conn:

        db(

            "INSERT INTO msg_selection(chat_id,progress_msg_id,topic_id) VALUES(?,?,?) "

            "ON CONFLICT(chat_id,progress_msg_id) DO UPDATE SET topic_id=excluded.topic_id",

            chat_id, progress_msg_id, topic_id

        )


def last_topic_get(chat_id: int, bucket: str) -> Optional[int]:
    row = db(
        "SELECT l.topic_id FROM last_topic_selection l "
        "JOIN topics t ON t.id=l.topic_id "
        "WHERE l.chat_id=? AND l.bucket=? AND t.chat_id=? AND t.bucket=? AND t.archived=0",
        chat_id,
        bucket,
        chat_id,
        bucket,
    ).fetchone()
    return int(row[0]) if row else None


def last_topic_set(chat_id: int, bucket: str, topic_id: int) -> None:
    if not topic_id:
        return
    topic = topic_get(topic_id)
    if not topic:
        return
    topic_chat_id, topic_bucket, _ = topic
    bucket_to_store = topic_bucket or bucket
    if topic_chat_id != chat_id:
        return
    with conn:
        db(
            "INSERT INTO last_topic_selection(chat_id,bucket,topic_id,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(chat_id,bucket) DO UPDATE SET topic_id=excluded.topic_id, updated_at=excluded.updated_at",
            chat_id,
            bucket_to_store,
            topic_id,
            datetime.now(UTC).isoformat(timespec="seconds"),
        )



# ----- file_map -----

def filemap_set(

    chat_id: int,

    pmsg: int,

    path: str,

    bucket: str,

    category: str,

    *,

    inc: bool = False,

    origin_message_id: Optional[int] = None,

) -> None:

    global FILE_MAP_HAS_ORIGIN, FILE_MAP_HAS_ENTRIES

    origin_id = origin_message_id or 0

    if origin_id and not FILE_MAP_HAS_ENTRIES and _has_table("file_map_entries"):

        FILE_MAP_HAS_ENTRIES = True

    try:

        with conn:

            if FILE_MAP_HAS_ORIGIN:

                if inc:

                    db(

                        "INSERT INTO file_map(chat_id,progress_msg_id,abs_path,bucket,category,files_count,origin_message_id) "

                        "VALUES(?,?,?,?,?,1,?) "

                        "ON CONFLICT(chat_id,progress_msg_id) DO UPDATE SET "

                        "abs_path=excluded.abs_path, bucket=excluded.bucket, category=excluded.category, "

                        "files_count=file_map.files_count+1, origin_message_id=excluded.origin_message_id",

                        chat_id, pmsg, path, bucket, category, origin_id

                    )

                else:

                    db(

                        "INSERT INTO file_map(chat_id,progress_msg_id,abs_path,bucket,category,origin_message_id) "

                        "VALUES(?,?,?,?,?,?) "

                        "ON CONFLICT(chat_id,progress_msg_id) DO UPDATE SET "

                        "abs_path=excluded.abs_path, bucket=excluded.bucket, category=excluded.category, "

                        "origin_message_id=excluded.origin_message_id",

                        chat_id, pmsg, path, bucket, category, origin_id

                    )

            else:

                if inc:

                    db(

                        "INSERT INTO file_map(chat_id,progress_msg_id,abs_path,bucket,category,files_count) "

                        "VALUES(?,?,?,?,?,1) "

                        "ON CONFLICT(chat_id,progress_msg_id) DO UPDATE SET "

                        "abs_path=excluded.abs_path, bucket=excluded.bucket, category=excluded.category, "

                        "files_count=file_map.files_count+1",

                        chat_id, pmsg, path, bucket, category

                    )

                else:

                    db(

                        "INSERT INTO file_map(chat_id,progress_msg_id,abs_path,bucket,category) "

                        "VALUES(?,?,?,?,?) "

                        "ON CONFLICT(chat_id,progress_msg_id) DO UPDATE SET "

                        "abs_path=excluded.abs_path, bucket=excluded.bucket, category=excluded.category",

                        chat_id, pmsg, path, bucket, category

                    )

            if origin_id and FILE_MAP_HAS_ENTRIES:

                db(

                    "INSERT INTO file_map_entries(chat_id,progress_msg_id,origin_message_id,abs_path,bucket,category) "

                    "VALUES(?,?,?,?,?,?) "

                    "ON CONFLICT(chat_id,progress_msg_id,origin_message_id) DO UPDATE SET "

                    "abs_path=excluded.abs_path, bucket=excluded.bucket, category=excluded.category",

                    chat_id,

                    pmsg,

                    origin_id,

                    path,

                    bucket,

                    category,

                )

    except sqlite3.OperationalError as exc:

        msg = str(exc).lower()

        if "no such table" in msg and "file_map_entries" in msg:

            try:

                conn.execute(FILE_MAP_ENTRIES_DDL)

                FILE_MAP_HAS_ENTRIES = True

            except Exception:

                pass

            else:

                filemap_set(chat_id, pmsg, path, bucket, category, inc=inc, origin_message_id=origin_message_id)

                return

        if "no such column" in msg and "origin_message_id" in msg and not FILE_MAP_HAS_ORIGIN:

            try:

                conn.execute("ALTER TABLE file_map ADD COLUMN origin_message_id INTEGER NOT NULL DEFAULT 0")

                FILE_MAP_HAS_ORIGIN = True

            except Exception:

                pass

            else:

                filemap_set(chat_id, pmsg, path, bucket, category, inc=inc, origin_message_id=origin_message_id)

                return

        raise





def filemap_entries(chat_id: int, progress_msg_id: int) -> List[Tuple[int, str, str, str]]:

    global FILE_MAP_HAS_ENTRIES

    if not FILE_MAP_HAS_ENTRIES and _has_table("file_map_entries"):

        FILE_MAP_HAS_ENTRIES = True

    if not FILE_MAP_HAS_ENTRIES:

        return []

    rows = db(

        "SELECT origin_message_id,abs_path,bucket,category FROM file_map_entries "

        "WHERE chat_id=? AND progress_msg_id=? ORDER BY origin_message_id",

        chat_id,

        progress_msg_id,

    ).fetchall()

    return [(int(row[0]), row[1], row[2], row[3]) for row in rows]





def filemap_entry_get(chat_id: int, origin_message_id: int) -> Optional[Tuple[int, str, str, str]]:

    global FILE_MAP_HAS_ENTRIES

    if not FILE_MAP_HAS_ENTRIES and _has_table("file_map_entries"):

        FILE_MAP_HAS_ENTRIES = True

    if not FILE_MAP_HAS_ENTRIES:

        return None

    row = db(

        "SELECT progress_msg_id,abs_path,bucket,category FROM file_map_entries "

        "WHERE chat_id=? AND origin_message_id=?",

        chat_id,

        origin_message_id,

    ).fetchone()

    if not row:

        return None

    return int(row[0]), row[1], row[2], row[3]





def filemap_entry_delete(chat_id: int, progress_msg_id: int, origin_message_id: Optional[int] = None) -> None:

    global FILE_MAP_HAS_ENTRIES

    with conn:

        if not FILE_MAP_HAS_ENTRIES and _has_table("file_map_entries"):

            FILE_MAP_HAS_ENTRIES = True

        if not FILE_MAP_HAS_ENTRIES:

            return

        if origin_message_id is None:

            db(

                "DELETE FROM file_map_entries WHERE chat_id=? AND progress_msg_id=?",

                chat_id,

                progress_msg_id,

            )

        else:

            db(

                "DELETE FROM file_map_entries WHERE chat_id=? AND progress_msg_id=? AND origin_message_id=?",

                chat_id,

                progress_msg_id,

                origin_message_id,

            )



def filemap_get(chat_id: int, pmsg: int) -> Optional[Tuple[str, str, str, int, int]]:

    global FILE_MAP_HAS_ORIGIN

    try:

        if FILE_MAP_HAS_ORIGIN:

            row = db(

                "SELECT abs_path,bucket,category,files_count,origin_message_id FROM file_map WHERE chat_id=? AND progress_msg_id=?",

                chat_id, pmsg

            ).fetchone()

            return (row[0], row[1], row[2], row[3] or 0, row[4] or 0) if row else None

        row = db(

            "SELECT abs_path,bucket,category,files_count FROM file_map WHERE chat_id=? AND progress_msg_id=?",

            chat_id, pmsg

        ).fetchone()

        return (row[0], row[1], row[2], row[3] or 0, 0) if row else None

    except sqlite3.OperationalError as exc:

        msg = str(exc).lower()

        if "no such column" in msg and "origin_message_id" in msg:

            FILE_MAP_HAS_ORIGIN = False

            return filemap_get(chat_id, pmsg)

        raise



def filemap_by_origin(chat_id: int, origin_message_id: int) -> Optional[Tuple[int, str, str, str, int]]:

    entry = filemap_entry_get(chat_id, origin_message_id)

    if entry:

        progress_msg_id, abs_path, bucket, category = entry

        base = filemap_get(chat_id, progress_msg_id)

        files_count = base[3] if base else 0

        return progress_msg_id, abs_path, bucket, category, int(files_count or 0)

    if not FILE_MAP_HAS_ORIGIN:

        return None

    row = db(

        "SELECT progress_msg_id,abs_path,bucket,category,files_count FROM file_map WHERE chat_id=? AND origin_message_id=?",

        chat_id, origin_message_id).fetchone()

    if not row:

        return None

    return int(row[0]), row[1], row[2], row[3], int(row[4] or 0)



def filemap_update_origin(chat_id: int, pmsg: int, origin_message_id: int) -> None:

    if not FILE_MAP_HAS_ORIGIN:

        return

    with conn:

        db("UPDATE file_map SET origin_message_id=? WHERE chat_id=? AND progress_msg_id=?",

           origin_message_id, chat_id, pmsg)



def filemap_delete(chat_id: int, pmsg: int) -> None:

    with conn:

        db("DELETE FROM file_map WHERE chat_id=? AND progress_msg_id=?", chat_id, pmsg)

        db("DELETE FROM file_map_entries WHERE chat_id=? AND progress_msg_id=?", chat_id, pmsg)



# ----- items -----

def item_upsert(
    chat_id: int,
    message_id: int,
    topic_id: int,
    kind: str,
    title: Optional[str],
    link: Optional[str],
    created_at: str,
    file_id: Optional[str] = None,
    file_unique_id: Optional[str] = None,
    file_name: Optional[str] = None,
) -> None:
    with conn:
        db(
            "INSERT INTO items(chat_id,message_id,topic_id,kind,title,link,created_at,file_id,file_unique_id,file_name) "
            "VALUES(?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(chat_id,message_id) DO UPDATE SET "
            "topic_id=excluded.topic_id, kind=excluded.kind, title=excluded.title, link=excluded.link, "
            "created_at=excluded.created_at, file_id=excluded.file_id, file_unique_id=excluded.file_unique_id, "
            "file_name=excluded.file_name",
            chat_id,
            message_id,
            topic_id,
            kind,
            title,
            link,
            created_at,
            file_id,
            file_unique_id,
            file_name,
        )



def item_delete(chat_id: int, message_id: int) -> None:

    with conn:

        db("DELETE FROM items WHERE chat_id=? AND message_id=?", chat_id, message_id)



def item_get(chat_id: int, message_id: int) -> Optional[dict[str, Any]]:
    row = db(
        "SELECT chat_id,message_id,topic_id,kind,title,link,created_at,author,bucket,tags_cache,"
        "file_id,file_unique_id,file_name FROM items WHERE chat_id=? AND message_id=?",
        chat_id,
        message_id,
    ).fetchone()

    if not row:
        return None

    return {
        "chat_id": row[0],
        "message_id": row[1],
        "topic_id": row[2],
        "kind": row[3],
        "title": row[4],
        "link": row[5],
        "created_at": row[6],
        "author": row[7],
        "bucket": row[8],
        "tags_cache": row[9],
        "file_id": row[10],
        "file_unique_id": row[11],
        "file_name": row[12],
    }



def item_update_author(chat_id: int, message_id: int, author: str) -> None:

    with conn:

        db("UPDATE items SET author=? WHERE chat_id=? AND message_id=?", author, chat_id, message_id)



def item_update_title(chat_id: int, message_id: int, title: str) -> None:

    with conn:

        db("UPDATE items SET title=? WHERE chat_id=? AND message_id=?", title, chat_id, message_id)



def item_update_created_at(chat_id: int, message_id: int, created_at: str) -> None:

    with conn:

        db("UPDATE items SET created_at=? WHERE chat_id=? AND message_id=?", created_at, chat_id, message_id)



def item_update_bucket(chat_id: int, message_id: int, bucket: str) -> None:

    with conn:

        db("UPDATE items SET bucket=? WHERE chat_id=? AND message_id=?", bucket, chat_id, message_id)





def item_update_topic_id(chat_id: int, message_id: int, topic_id: int) -> None:

    with conn:

        db("UPDATE items SET topic_id=? WHERE chat_id=? AND message_id=?", topic_id, chat_id, message_id)


def seen_file_get(chat_id: int, file_unique_id: str) -> Optional[str]:

    if not file_unique_id:

        return None

    row = db(

        "SELECT saved_path FROM seen_files WHERE file_unique_id=? AND chat_id=?",

        file_unique_id,

        chat_id,

    ).fetchone()

    if not row:

        return None

    saved_path = row[0]

    return str(saved_path) if saved_path else None


def seen_file_upsert(chat_id: int, file_unique_id: str, saved_path: str) -> None:

    if not file_unique_id:

        return

    with conn:

        db(

            "INSERT INTO seen_files(file_unique_id,chat_id,saved_path,created_at) "

            "VALUES(?,?,?,datetime('now')) "

            "ON CONFLICT(file_unique_id, chat_id) DO UPDATE SET "

            "saved_path=excluded.saved_path, created_at=excluded.created_at",

            file_unique_id,

            chat_id,

            saved_path,

        )



def tag_get_or_create(name: str) -> int:

    clean = name.strip()

    if not clean:

        raise ValueError("empty tag")

    row = db("SELECT id FROM tags WHERE name=?", clean).fetchone()

    if row:

        return int(row[0])

    with conn:

        cur = db("INSERT INTO tags(name) VALUES(?)", clean)

    return int(cur.lastrowid)



def item_set_tags(chat_id: int, message_id: int, tags: List[str]) -> None:

    tags = [t.strip() for t in tags if t.strip()]

    with conn:

        db("DELETE FROM item_tags WHERE item_chat_id=? AND item_message_id=?", chat_id, message_id)

        clean: List[str] = []

        for tag_name in tags:

            tag_id = tag_get_or_create(tag_name)

            db("INSERT OR IGNORE INTO item_tags(item_chat_id,item_message_id,tag_id) VALUES(?,?,?)",

               chat_id, message_id, tag_id)

            clean.append(tag_name)

        db("UPDATE items SET tags_cache=? WHERE chat_id=? AND message_id=?",

           ", ".join(clean), chat_id, message_id)



def tags_for_item(chat_id: int, message_id: int) -> List[Tuple[int, str]]:

    rows = db(

        "SELECT t.id,t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id "

        "WHERE it.item_chat_id=? AND it.item_message_id=? ORDER BY t.name COLLATE NOCASE",

        chat_id, message_id).fetchall()

    return [(int(r[0]), r[1]) for r in rows]



def items_by_tag(tag_id: int, page: int, per_page: int = 10) -> List[dict[str, Any]]:

    rows = db(

        "SELECT i.chat_id,i.message_id,i.topic_id,i.kind,i.title,i.link,i.created_at,i.author,i.bucket,i.tags_cache "

        "FROM item_tags it JOIN items i ON i.chat_id=it.item_chat_id AND i.message_id=it.item_message_id "

        "WHERE it.tag_id=? ORDER BY i.created_at DESC LIMIT ? OFFSET ?",

        tag_id, per_page, per_page * page).fetchall()

    result: List[dict[str, Any]] = []

    for row in rows:

        result.append({

            "chat_id": row[0],

            "message_id": row[1],

            "topic_id": row[2],

            "kind": row[3],

            "title": row[4],

            "link": row[5],

            "created_at": row[6],

            "author": row[7],

            "bucket": row[8],

            "tags_cache": row[9],

        })

    return result



def tag_name(tag_id: int) -> Optional[str]:

    row = db("SELECT name FROM tags WHERE id=?", tag_id).fetchone()

    return row[0] if row else None



def items_for_topic(topic_id: int) -> List[Tuple[int, int]]:

    rows = db("SELECT chat_id,message_id FROM items WHERE topic_id=?", topic_id).fetchall()

    return [(int(r[0]), int(r[1])) for r in rows]



def topic_tags(topic_id: int) -> List[Tuple[int, str]]:

    def _fetch() -> List[Tuple[int, str]]:

        rows = db(

            "SELECT t.id,t.name FROM topic_tags tt JOIN tags t ON t.id=tt.tag_id WHERE tt.topic_id=? ORDER BY t.name COLLATE NOCASE",

            topic_id,

        ).fetchall()

        return [(int(r[0]), r[1]) for r in rows]



    rows = _fetch()

    if rows:

        return rows



    topic_info = topic_get(topic_id)

    if not topic_info:

        return []



    _, bucket, name = topic_info

    template = db(

        "SELECT id FROM topics WHERE bucket=? AND name=? AND id<>? ORDER BY created_at DESC LIMIT 1",

        bucket,

        name,

        topic_id,

    ).fetchone()

    if not template:

        return rows



    template_id = int(template[0])

    with conn:

        db(

            "INSERT OR IGNORE INTO topic_tags(topic_id,tag_id) SELECT ?, tag_id FROM topic_tags WHERE topic_id=?",

            topic_id,

            template_id,

        )

    return _fetch()



def topic_set_tags(topic_id: int, tags: List[str]) -> None:

    tags = [t.strip() for t in tags if t.strip()]

    with conn:

        db("DELETE FROM topic_tags WHERE topic_id=?", topic_id)

        for tag_name in tags:

            tag_id = tag_get_or_create(tag_name)

            db("INSERT OR IGNORE INTO topic_tags(topic_id,tag_id) VALUES(?,?)", topic_id, tag_id)

    for item_chat_id, item_message_id in items_for_topic(topic_id):

        item_apply_topic_tags(item_chat_id, item_message_id, topic_id)



def topic_add_missing_tags(topic_id: int, tags: Iterable[str]) -> None:
    clean_tags = [t.strip() for t in tags if t and t.strip()]
    if not clean_tags:
        return
    with conn:
        for tag_name in clean_tags:

            tag_id = tag_get_or_create(tag_name)

            db("INSERT OR IGNORE INTO topic_tags(topic_id,tag_id) VALUES(?,?)", topic_id, tag_id)

    for item_chat_id, item_message_id in items_for_topic(topic_id):

        existing_names = [name for _, name in tags_for_item(item_chat_id, item_message_id)]

        merged = existing_names[:]

        changed = False

        for tag_name in clean_tags:

            if tag_name not in merged:

                merged.append(tag_name)

                changed = True

        if changed:
            item_set_tags(item_chat_id, item_message_id, merged)

def item_apply_topic_tags(chat_id: int, message_id: int, topic_id: int) -> None:
    topic_tag_names = [name for _, name in topic_tags(topic_id)]
    existing = [name for _, name in tags_for_item(chat_id, message_id)]
    merged: List[str] = existing[:]
    for name in topic_tag_names:
        if name not in merged:
            merged.append(name)
    item_set_tags(chat_id, message_id, merged)


# ----- pending tags / edits -----

def pending_tags_set(chat_id: int, user_id: int, topic_id: int, message_id: int, prompt_message_id: int = 0) -> None:

    with conn:

        db(

            "INSERT OR REPLACE INTO pending_tags(chat_id,user_id,topic_id,message_id,prompt_message_id) VALUES(?,?,?,?,?)",

            chat_id,

            user_id,

            topic_id,

            message_id,

            prompt_message_id,

        )



def pending_tags_get(chat_id: int, user_id: int) -> Optional[Tuple[int, int, int]]:

    row = db(

        "SELECT topic_id,message_id,prompt_message_id FROM pending_tags WHERE chat_id=? AND user_id=?",

        chat_id,

        user_id,

    ).fetchone()

    if not row:

        return None

    return int(row[0]), int(row[1]), int(row[2] or 0)



def pending_tags_clear(chat_id: int, user_id: int) -> None:

    with conn:

        db("DELETE FROM pending_tags WHERE chat_id=? AND user_id=?", chat_id, user_id)



def pending_item_edit_set(chat_id: int, user_id: int, item_chat_id: int, item_message_id: int,

                          field: str, prompt_message_id: int, context_message_id: int) -> None:

    with conn:

        db(

            "INSERT OR REPLACE INTO pending_item_edit(chat_id,user_id,item_chat_id,item_message_id,field,prompt_message_id,context_message_id) "

            "VALUES(?,?,?,?,?,?,?)",

            chat_id, user_id, item_chat_id, item_message_id, field, prompt_message_id, context_message_id)



def pending_item_edit_get(chat_id: int, user_id: int) -> Optional[Tuple[int, int, str, int, int]]:

    row = db("SELECT item_chat_id,item_message_id,field,prompt_message_id,context_message_id FROM pending_item_edit WHERE chat_id=? AND user_id=?",

             chat_id, user_id).fetchone()

    if not row:

        return None

    return int(row[0]), int(row[1]), row[2], int(row[3]), int(row[4])



def pending_item_edit_clear(chat_id: int, user_id: int) -> None:

    with conn:

        db("DELETE FROM pending_item_edit WHERE chat_id=? AND user_id=?", chat_id, user_id)

# ----- ui state -----

def ui_get_page(chat_id: int, pmsg: int) -> int:

    row = db("SELECT page FROM ui_state WHERE chat_id=? AND progress_msg_id=?", chat_id, pmsg).fetchone()

    return row[0] if row else 0



def ui_set_page(chat_id: int, pmsg: int, page: int) -> None:

    with conn:

        db(

            "INSERT INTO ui_state(chat_id,progress_msg_id,page) VALUES(?,?,?) "

            "ON CONFLICT(chat_id,progress_msg_id) DO UPDATE SET page=excluded.page",

            chat_id, pmsg, page

        )



# ----- browse state -----

def browse_state_set(chat_id: int, message_id: int, filter_type: str, filter_value: str, page: int) -> None:

    with conn:

        db(

            "INSERT OR REPLACE INTO browse_state(chat_id,message_id,filter_type,filter_value,page) VALUES(?,?,?,?,?)",

            chat_id,

            message_id,

            filter_type,

            filter_value,

            page,

        )



def browse_state_get(chat_id: int, message_id: int) -> Optional[Tuple[str, str, int]]:

    row = db(

        "SELECT filter_type,filter_value,page FROM browse_state WHERE chat_id=? AND message_id=?",

        chat_id,

        message_id,

    ).fetchone()

    if not row:

        return None

    return row[0], row[1], int(row[2] or 0)



def browse_state_update_page(chat_id: int, message_id: int, page: int) -> None:

    with conn:

        db(

            "UPDATE browse_state SET page=? WHERE chat_id=? AND message_id=?",

            page,

            chat_id,

            message_id,

        )



def browse_state_clear(chat_id: int, message_id: int) -> None:

    with conn:

        db("DELETE FROM browse_state WHERE chat_id=? AND message_id=?", chat_id, message_id)



def browse_items(filter_type: str, chat_id: int, filter_value: str, page: int, per_page: int = 5) -> Tuple[List[Dict[str, Any]], bool]:

    page = max(0, page)

    offset = page * per_page

    limit = per_page + 1

    rows: List[Tuple[Any, ...]] = []



    if filter_type == "topic":

        try:

            topic_id = int(filter_value)

        except ValueError:

            return [], False

        rows = db(

            "SELECT i.chat_id,i.message_id,i.kind,i.title,i.topic_id,i.created_at "

            "FROM items i WHERE i.topic_id=? AND i.chat_id=? "

            "ORDER BY i.created_at DESC LIMIT ? OFFSET ?",

            topic_id,

            chat_id,

            limit,

            offset,

        ).fetchall()

    elif filter_type == "date":

        rows = db(

            "SELECT i.chat_id,i.message_id,i.kind,i.title,i.topic_id,i.created_at "

            "FROM items i WHERE i.chat_id=? AND substr(i.created_at,1,10)=? "

            "ORDER BY i.created_at DESC LIMIT ? OFFSET ?",

            chat_id,

            filter_value,

            limit,

            offset,

        ).fetchall()

    elif filter_type == "author":

        rows = db(

            "SELECT i.chat_id,i.message_id,i.kind,i.title,i.topic_id,i.created_at "

            "FROM items i WHERE i.chat_id=? AND i.author=? "

            "ORDER BY i.created_at DESC LIMIT ? OFFSET ?",

            chat_id,

            filter_value,

            limit,

            offset,

        ).fetchall()

    elif filter_type == "tag":

        try:

            tag_id = int(filter_value)

        except ValueError:

            return [], False

        rows = db(

            "SELECT i.chat_id,i.message_id,i.kind,i.title,i.topic_id,i.created_at "

            "FROM item_tags it JOIN items i ON i.chat_id=it.item_chat_id AND i.message_id=it.item_message_id "

            "WHERE it.tag_id=? AND i.chat_id=? "

            "ORDER BY i.created_at DESC LIMIT ? OFFSET ?",

            tag_id,

            chat_id,

            limit,

            offset,

        ).fetchall()

    else:

        return [], False



    has_next = len(rows) > per_page

    items: List[Dict[str, Any]] = []

    for row in rows[:per_page]:

        items.append(

            {

                "chat_id": int(row[0]),

                "message_id": int(row[1]),

                "kind": row[2],

                "title": row[3],

                "topic_id": int(row[4] or 0),

                "created_at": row[5],

            }

        )

    return items, has_next





def reuse_state_set(chat_id: int, message_id: int, item_chat_id: int, item_message_id: int, bucket: str) -> None:

    with conn:

        db(

            "INSERT OR REPLACE INTO reuse_state(chat_id,message_id,item_chat_id,item_message_id,bucket) VALUES(?,?,?,?,?)",

            chat_id,

            message_id,

            item_chat_id,

            item_message_id,

            bucket,

        )





def reuse_state_get(chat_id: int, message_id: int) -> Optional[Tuple[int, int, str]]:

    row = db(

        "SELECT item_chat_id,item_message_id,bucket FROM reuse_state WHERE chat_id=? AND message_id=?",

        chat_id,

        message_id,

    ).fetchone()

    if not row:

        return None

    return int(row[0]), int(row[1]), row[2]





def reuse_state_clear(chat_id: int, message_id: int) -> None:
    with conn:
        db("DELETE FROM reuse_state WHERE chat_id=? AND message_id=?", chat_id, message_id)


# ----- thread topics (forum subtags) -----
def thread_topic_set(chat_id: int, thread_id: int, name: str) -> None:
    with conn:
        db(
            "INSERT OR REPLACE INTO thread_topics(chat_id,thread_id,name) VALUES(?,?,?)",
            chat_id,
            thread_id,
            name.strip(),
        )


def thread_topic_get(chat_id: int, thread_id: int) -> Optional[str]:
    row = db("SELECT name FROM thread_topics WHERE chat_id=? AND thread_id=?", chat_id, thread_id).fetchone()
    return row[0] if row else None



def pending_reuse_topic_set(

    chat_id: int,

    user_id: int,

    target_message_id: int,

    item_chat_id: int,

    item_message_id: int,

    bucket: str,

    prompt_message_id: int,

) -> None:

    with conn:

        db(

            "INSERT OR REPLACE INTO pending_reuse_topic(chat_id,user_id,target_message_id,item_chat_id,item_message_id,bucket,prompt_message_id) "

            "VALUES(?,?,?,?,?,?,?)",

            chat_id,

            user_id,

            target_message_id,

            item_chat_id,

            item_message_id,

            bucket,

            prompt_message_id,

        )





def pending_reuse_topic_get(chat_id: int, user_id: int) -> Optional[Tuple[int, int, int, int, str]]:

    row = db(

        "SELECT target_message_id,item_chat_id,item_message_id,prompt_message_id,bucket FROM pending_reuse_topic WHERE chat_id=? AND user_id=?",

        chat_id,

        user_id,

    ).fetchone()

    if not row:

        return None

    return int(row[0]), int(row[1]), int(row[2]), int(row[3]), row[4]





def pending_reuse_topic_clear(chat_id: int, user_id: int) -> None:

    with conn:

        db("DELETE FROM pending_reuse_topic WHERE chat_id=? AND user_id=?", chat_id, user_id)



