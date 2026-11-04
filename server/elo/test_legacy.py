import copy
import hashlib
import hmac
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from api import Snapshot,handler
from legacy import Lookup,load_key,profile,pseudonym,refresh

A='a'*24;B='b'*24;C='c'*24;D='d'*24
KEY=('0123456789abcdef'*4).encode()


def row(at=100):return {'name':'旧资料','rating':3456,'sigma':200,'games':20,'dx':3,'last':at}
def cache():return {'players':{pseudonym(A,KEY):row(),pseudonym(B,KEY):row(200),pseudonym(C,KEY):row(100)},'meta':{'source':'legacy-hmac','dataAt':300}}
def current():return {'players':{A:{**row(200),'rating':3500},B:{**row(100),'rating':3200},D:row(100)},'meta':{'sourceAt':300}}


class LegacyTests(unittest.TestCase):
    def test_key_is_utf8_text_and_never_hex_decoded(self):
        self.assertEqual(pseudonym(A,KEY),hmac.new(KEY,A.encode(),hashlib.sha256).hexdigest()[:16])
        self.assertNotEqual(pseudonym(A,KEY),pseudonym(A,bytes.fromhex(KEY.decode())))
        with tempfile.TemporaryDirectory() as directory:
            p=pathlib.Path(directory)/'key';p.write_text(KEY.decode()+'\n');self.assertEqual(load_key(p),KEY)
            p.write_text('short');self.assertRaises(ValueError,load_key,p)
    def test_lookup_uses_latest_last_timestamp_without_rewriting_primary(self):
        with tempfile.TemporaryDirectory() as directory:
            p=pathlib.Path(directory)/'old.json';p.write_text(json.dumps(cache()))
            lookup=Lookup(Snapshot(p),KEY);primary=current();before=copy.deepcopy(primary)
            self.assertEqual(lookup.resolve(A,primary['players'][A]),primary['players'][A])
            self.assertEqual(lookup.resolve(B,primary['players'][B])['rating'],3456)
            self.assertEqual(lookup.resolve(C,None)['origin'],'legacy-hmac')
            self.assertIsNone(lookup.resolve('e'*24,None))
            self.assertEqual(lookup.resolve(B,row(200)),row(200))
            self.assertEqual(primary,before)
    def test_batch_and_compatibility_shard_agree_and_never_expose_secret_or_hashed_id(self):
        with tempfile.TemporaryDirectory() as directory:
            p=pathlib.Path(directory)/'new.json';p.write_text(json.dumps(current()))
            old=pathlib.Path(directory)/'old.json';old.write_text(json.dumps(cache()))
            server=ThreadingHTTPServer(('127.0.0.1',0),handler(Snapshot(p),Lookup(Snapshot(old),KEY)))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base='http://127.0.0.1:'+str(server.server_port)
            try:
                def get(path):return json.load(urllib.request.urlopen(base+path))
                data=get('/api/v1/ratings?uid='+A+'&uid='+B+'&uid='+C+'&uid='+'e'*24)
                self.assertEqual(set(data),{A,B,C});self.assertEqual(data[B],get('/data/elo/p/bb.json')[B])
                self.assertEqual(data[A]['rating'],3500);self.assertEqual(data[B]['sourceAt'],300)
                status=get('/api/v1/status');self.assertTrue(status['legacyAvailable'])
                self.assertEqual(status['legacyPlayers'],3)
                public=json.dumps([data,status]);self.assertNotIn(KEY.decode(),public);self.assertNotIn(pseudonym(A,KEY),public)
                self.assertRaises(urllib.error.HTTPError,get,'/api/v1/ratings?uid='+pseudonym(A,KEY))
                old.write_text('invalid json');self.assertEqual(get('/api/v1/ratings?uid='+B)[B]['rating'],3200)
                self.assertFalse(get('/api/v1/status')['legacyAvailable'])
            finally:server.shutdown();server.server_close();thread.join()
    def test_refresh_validates_key_and_generation_before_atomic_publication(self):
        top={'generated':300,'current':[]};records=cache()['players'];calls=[]
        def download(path):
            calls.append(path)
            if path=='top.json':return top
            suffix=path[-7:-5];return {u:{**p,'h':[[1,2]],'privateExtra':'ignored'} for u,p in records.items() if u.endswith(suffix)}
        with tempfile.TemporaryDirectory() as directory:
            p=pathlib.Path(directory)/'old.json';primary={'players':{A:{},B:{},C:{}}}
            info=refresh(p,primary,KEY,download);self.assertEqual(info['matchedKnownPlayers'],3)
            value=json.loads(p.read_text(encoding='utf-8'));self.assertNotIn('h',next(iter(value['players'].values())))
            self.assertEqual(len([c for c in calls if c.startswith('p/')]),256)
            calls.clear();refresh(p,primary,KEY,download);self.assertEqual(calls,['top.json'])
            before=p.read_bytes();self.assertRaises(ValueError,refresh,p,primary,b'wrong-key'*8,download);self.assertEqual(p.read_bytes(),before)
            counter=0
            def changing(path):
                nonlocal counter
                if path=='top.json':counter+=1;return {**top,'generated':300+counter}
                return download(path)
            self.assertRaises(ValueError,refresh,p,primary,KEY,changing);self.assertEqual(p.read_bytes(),before)
            self.assertEqual(sorted(x.name for x in p.parent.iterdir()),['old.json'])
    def test_invalid_legacy_profiles_are_rejected(self):
        for field,value in [('rating',float('nan')),('sigma',-1),('games',True),('dx',21),('name',None)]:
            self.assertRaises(ValueError,profile,{**row(),field:value})
        with tempfile.TemporaryDirectory() as directory:
            p=pathlib.Path(directory)/'missing.json';lookup=Lookup(Snapshot(p),KEY)
            self.assertEqual(lookup.resolve(A,row()),row());self.assertFalse(lookup.status()['legacyAvailable'])


if __name__=='__main__':unittest.main()
