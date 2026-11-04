"""Publish the anonymous top 100 before requests arrive, outside the API process."""
import argparse
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
from anonymous import AnonymousBoard


def publish(data, destination, lookup_db=None):
    # The production snapshot already merges the original and recovered history.
    # Do not silently publish a partial leaderboard from an unmerged input.
    if data.get('meta', {}).get('historyMerged') is not True:
        raise ValueError('Public export requires the complete merged snapshot')
    snapshot = SimpleNamespace(get=lambda: data, stamp=0)
    board = AnonymousBoard(snapshot).page()
    raw = json.dumps(board, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    if len(raw) > 32000:
        raise ValueError('Public leaderboard exceeds its size budget')
    if lookup_db is not None:
        from query_store import publish as publish_index
        publish_index(data, board, lookup_db)
    destination = Path(destination)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as f:
        temporary = Path(f.name)
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    try:
        temporary.chmod(0o644)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return board


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--lookup-db', type=Path)
    args = parser.parse_args()
    board = publish(json.loads(args.snapshot.read_text(encoding='utf-8')), args.output, args.lookup_db)
    print(json.dumps({'published': board['total'], 'updatedAt': board['updatedAt']}))
