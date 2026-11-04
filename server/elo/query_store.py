"""Read-only indexed Elo generation, replaced atomically after a completed rebuild."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from legacy import pseudonym


def publish(data, board, destination):
    if data['meta'].get('historyMerged') is not True:
        raise ValueError('Indexed ratings require merged history')
    destination=Path(destination)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as f:
        temporary=Path(f.name)
    try:
        connection=sqlite3.connect(temporary)
        try:
            connection.executescript('''
                CREATE TABLE meta(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE players(kind TEXT NOT NULL, identity TEXT NOT NULL,
                    suffix TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,identity));
                CREATE INDEX shard ON players(kind,suffix);
            ''')
            encode=lambda value:json.dumps(value,ensure_ascii=False,separators=(',', ':'),allow_nan=False)
            connection.executemany('INSERT INTO meta VALUES(?,?)',
                                   [('meta',encode(data['meta'])),('board',encode(board))])
            for kind, rows in [('raw',data['players']),('hashed',data.get('hashedPlayers',{}))]:
                connection.executemany('INSERT INTO players VALUES(?,?,?,?)',
                    ((kind,identity,identity[-2:],encode(profile)) for identity,profile in rows.items()))
            connection.commit()
            if connection.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                raise ValueError('Invalid rating index')
        finally:
            connection.close()
        temporary.chmod(0o600)
        with temporary.open('rb+') as f:os.fsync(f.fileno())
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


class Reader:
    def __init__(self,connection,key):self.connection=connection;self.key=key
    def meta(self):
        return json.loads(self.connection.execute("SELECT payload FROM meta WHERE key='meta'").fetchone()[0])
    def board(self,offset,limit):
        board=json.loads(self.connection.execute("SELECT payload FROM meta WHERE key='board'").fetchone()[0])
        return {**board,'rows':board['rows'][offset:offset+limit],
                'scores':board['scores'][offset:offset+limit],'offset':offset,'limit':limit}
    def ratings(self,uids):
        result={}
        for uid in dict.fromkeys(uids):
            row=self.connection.execute("SELECT payload FROM players WHERE kind='raw' AND identity=?",(uid,)).fetchone()
            if row is None and self.key is not None:
                row=self.connection.execute("SELECT payload FROM players WHERE kind='hashed' AND identity=?",(pseudonym(uid,self.key),)).fetchone()
            if row is not None:result[uid]=json.loads(row[0])
        return result
    def shard(self,suffix):
        return {uid:json.loads(raw) for uid,raw in self.connection.execute(
            "SELECT identity,payload FROM players WHERE kind='raw' AND suffix=?",(suffix,))}


class RatingStore:
    def __init__(self,path,key=None):self.path=Path(path);self.key=key
    @contextmanager
    def open(self):
        # One connection pins one immutable generation for the entire request.
        connection=sqlite3.connect(self.path.resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
        try:
            connection.execute('PRAGMA query_only=ON')
            yield Reader(connection,self.key)
        finally:connection.close()
