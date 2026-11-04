import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from api import handler
from legacy import pseudonym
from public_snapshot import publish
from query_store import RatingStore

A='a'*24
B='b'*24
KEY=b'synthetic-query-key'


class QueryStoreTests(unittest.TestCase):
    def data(self,score=4100):
        row=dict(name='Private name',rating=score,sigma=100,cons=score-200,games=50,last=1000,dx=4)
        return dict(players={A:row},hashedPlayers={pseudonym(B,KEY):{**row,'rating':4200}},
                    meta=dict(sourceAt=1100,historyMerged=True))

    def test_raw_and_private_hash_parity_and_atomic_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);db=p/'ratings.sqlite3'
            data=self.data();publish(data,p/'board.json',db)
            store=RatingStore(db,KEY)
            with store.open() as old:
                self.assertEqual(old.ratings([A,B,'c'*24]),{A:data['players'][A],B:data['hashedPlayers'][pseudonym(B,KEY)]})
                self.assertEqual(old.shard('aa'),data['players'])
                self.assertEqual(old.board(100,100)['rows'],[])
                with self.assertRaises(sqlite3.OperationalError):old.connection.execute('DELETE FROM players')
                # POSIX production keeps an already-open generation valid on rename.
                import os
                if os.name!='nt':
                    publish(self.data(4500),p/'board.json',db)
                    self.assertEqual(old.ratings([A])[A]['rating'],4100)
            publish(self.data(4500),p/'board.json',db)
            with store.open() as latest:self.assertEqual(latest.ratings([A])[A]['rating'],4500)

    def test_http_never_opens_full_snapshot_and_preserves_api_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);publish(self.data(),p/'board.json',p/'ratings.sqlite3')
            server=ThreadingHTTPServer(('127.0.0.1',0),handler(None,store=RatingStore(p/'ratings.sqlite3',KEY)))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base='http://127.0.0.1:'+str(server.server_port)
            try:
                def get(path):
                    with urllib.request.urlopen(base+path) as r:return json.load(r)
                self.assertEqual(set(get('/api/v1/ratings?uid='+A+'&uid='+B)),{A,B})
                self.assertEqual(get('/data/elo/p/aa.json'),self.data()['players'])
                self.assertTrue(get('/api/v1/status')['uidLookupEnabled'])
                public=get('/api/v1/leaderboard')
                self.assertNotIn('Private',json.dumps(public));self.assertNotIn(A,json.dumps(public))
                self.assertEqual(get('/elo/public/leaderboard.json'),public)
                with self.assertRaises(urllib.error.HTTPError):get('/api/v1/ratings?uid=bad')
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
