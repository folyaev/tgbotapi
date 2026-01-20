# utmanager/topics.py
from __future__ import annotations

from pathlib import Path
from typing import List, Set, Tuple

from .config import bucket_root
from .db import topics_all, topic_delete, topic_upsert

EXCLUDED_TOPIC_DIRS = {"UNSORTED", ".DS_Store", "__MACOSX"}

def fs_topics_for(bucket: str) -> List[str]:
    root = bucket_root(bucket)
    if not root.exists():
        return []
    topics: List[str] = []
    for e in root.iterdir():
        if e.is_dir() and e.name not in EXCLUDED_TOPIC_DIRS and not e.name.startswith("."):
            topics.append(e.name)
    return topics

def topics_ordered(chat_id: int, bucket: str) -> List[Tuple[int, str]]:
    rows = topics_all(chat_id, bucket)
    def sort_key(row: Tuple[int, str]) -> Tuple[float, int]:
        topic_id, name = row
        path = bucket_root(bucket) / name
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (mtime, topic_id)
    return sorted(rows, key=sort_key, reverse=True)

def sync_topics_from_fs(chat_id: int, bucket: str) -> int:
    names = set(fs_topics_for(bucket))
    existing: List[Tuple[int, str]] = topics_all(chat_id, bucket)
    existing_names: Set[str] = {name for _, name in existing}

    for topic_id, name in existing:
        if name not in names:
            topic_delete(chat_id, bucket, topic_id)

    added = 0
    for name in names:
        if name not in existing_names:
            added += 1
        topic_upsert(chat_id, bucket, name)

    return added
