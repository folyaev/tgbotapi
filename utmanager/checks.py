"""Utility commands for quick consistency checks."""

from __future__ import annotations

from typing import Dict, List, Tuple

from utmanager.db import db, topic_tags


def _topics_index() -> List[Tuple[int, int, str, str]]:
    return db(
        "SELECT id,chat_id,bucket,name FROM topics WHERE archived=0 ORDER BY bucket,name,chat_id"
    ).fetchall()


def verify_topic_tag_sync() -> bool:
    """
    Ensure that topics sharing the same bucket/name also share tag metadata.
    Returns True when everything looks consistent.
    """
    registry: Dict[Tuple[str, str], List[str]] = {}
    missing: List[Tuple[int, int, str, str, List[str]]] = []

    for topic_id, chat_id, bucket, name in _topics_index():
        key = (bucket or "", name)
        tags = [tag for _, tag in topic_tags(topic_id)]
        if tags and key not in registry:
            registry[key] = tags
        elif not tags and key in registry and registry[key]:
            missing.append((topic_id, chat_id, bucket or "", name, registry[key]))

    if missing:
        print("Found topics without tags that exist on their siblings:")
        for topic_id, chat_id, bucket, name, expected in missing:
            print(
                f"- topic_id={topic_id} chat_id={chat_id} bucket={bucket or '-'} "
                f"name={name!r} should have tags: {', '.join(expected)}"
            )
        return False

    print("Topic/tag metadata looks consistent across buckets.")
    return True


def main() -> None:
    if not verify_topic_tag_sync():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
