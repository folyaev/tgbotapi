# utmanager/topics.py
from __future__ import annotations

from pathlib import Path
from typing import List, Set, Tuple

from .config import bucket_root
from .db import topic_delete, topic_set_archived, topics_all, topic_upsert

EXCLUDED_TOPIC_DIRS = {"UNSORTED", ".DS_Store", "__MACOSX", "ARCHIVE_PROJECTS", "Graphics"}
EXCLUDED_TOPIC_DIR_KEYS = {name.casefold() for name in EXCLUDED_TOPIC_DIRS}


def is_excluded_topic_name(name: str) -> bool:
    return str(name or "").strip().casefold() in EXCLUDED_TOPIC_DIR_KEYS

def fs_topics_for(bucket: str) -> List[str]:
    root = bucket_root(bucket)
    if not root.exists():
        return []
    topics: List[str] = []
    for e in root.iterdir():
        if e.is_dir() and not is_excluded_topic_name(e.name) and not e.name.startswith("."):
            topics.append(e.name)
    return topics

def topics_ordered(chat_id: int, bucket: str) -> List[Tuple[int, str]]:
    rows = [(topic_id, name) for topic_id, name in topics_all(chat_id, bucket) if not is_excluded_topic_name(name)]
    def sort_key(row: Tuple[int, str]) -> Tuple[float, int]:
        topic_id, name = row
        path = bucket_root(bucket) / name
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (mtime, topic_id)
    return sorted(rows, key=sort_key, reverse=True)

def sync_topics_from_fs(chat_id: int, bucket: str, *, prune: bool = False) -> int:
    names = set(fs_topics_for(bucket))
    existing: List[Tuple[int, str]] = topics_all(chat_id, bucket, include_archived=True)
    existing_names: Set[str] = {name for _, name in existing}

    if prune:
        for topic_id, name in existing:
            if name not in names:
                topic_delete(chat_id, bucket, topic_id)
    else:
        for topic_id, name in existing:
            if name not in names:
                topic_set_archived(chat_id, bucket, topic_id, True)

    added = 0
    for name in names:
        if name not in existing_names:
            added += 1
        topic_upsert(chat_id, bucket, name)

    return added
