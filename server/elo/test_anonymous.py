import copy
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
from anonymous import AnonymousBoard
from legacy import Lookup,pseudonym

A='a'*24;B='b'*24;C='c'*24;D='d'*24;KEY=b'anonymous-board-synthetic-test-key'
def row(score,last=200,games=40):return {'name':'MustNeverReachBrowser','rating':score,'sigma':200,'last':last,'games':games,'dx':3}
def primary():return {'players':{A:row(4000),B:row(4300,100,10),C:row(4100)},'meta':{'sourceAt':1000}}
def old():return {'players':{pseudonym(A,KEY):row(4500,100),pseudonym(B,KEY):row(4700),pseudonym(D,KEY):row(4600)},'meta':{'source':'legacy-hmac','dataAt':300}}


class AnonymousTests(unittest.TestCase):
 def test_original_conservative_order_keeps_displayed_technical_score(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'new.json';data=primary()
   data['players']={A:{**row(5000),'sigma':400,'cons':4200.25},B:{**row(4700),'sigma':50,'cons':4600.5},C:{**row(4800),'sigma':200,'cons':4400.25}}
   p.write_text(json.dumps(data));result=AnonymousBoard(Snapshot(p)).page();self.assertEqual(result['scores'],[4700,4800,5000])
   self.assertEqual(result['rows'],[{'conservative':4600.5,'uncertainty':50,'technical':4700},{'conservative':4400.25,'uncertainty':200,'technical':4800},{'conservative':4200.25,'uncertainty':400,'technical':5000}])
   for item in data['players'].values():item.pop('cons')
   p.write_text(json.dumps(data));self.assertEqual(AnonymousBoard(Snapshot(p)).page()['scores'],[4700,4800,5000])
 def test_top_100_limit_is_enforced_before_page_slicing(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'new.json';data={'players':{format(i,'024x'):row(5000-i) for i in range(150)},'meta':{'sourceAt':1000}}
   p.write_text(json.dumps(data));board=AnonymousBoard(Snapshot(p))
   self.assertEqual(board.page()['scores'],list(range(5000,4900,-1)));self.assertEqual(board.page()['total'],100)
   self.assertEqual(board.page(99,100)['scores'],[4901]);self.assertEqual(board.page(100,100)['scores'],[])
   self.assertEqual(board.page(120,100)['scores'],[])
   self.assertEqual(board.page(100,100)['rows'],[])
 def test_dedup_newest_scores_only_and_stable_pagination(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'new.json';p.write_text(json.dumps(primary()))
   legacy=pathlib.Path(directory)/'old.json';legacy.write_text(json.dumps(old()))
   board=AnonymousBoard(Snapshot(p),Lookup(Snapshot(legacy),KEY))
   first=board.page(0,2);second=board.page(2,2)
   self.assertEqual(first['scores'],[4700,4600]);self.assertEqual(second['scores'],[4100,4000]);self.assertEqual(first['total'],4)
   self.assertEqual(set(first),{'rows','scores','offset','limit','total','updatedAt','minGames','activeDays'})
   self.assertEqual(first['rows'][0],{'conservative':4300,'uncertainty':200,'technical':4700})
   public=json.dumps([first,second]);self.assertNotIn(A,public);self.assertNotIn('MustNeverReachBrowser',public);self.assertNotIn(pseudonym(A,KEY),public)
   original=copy.deepcopy(primary());self.assertEqual(json.loads(p.read_text()),original)
   newer=primary();newer['players'][A]['rating']=4900
   replacement=p.with_suffix('.next');replacement.write_text(json.dumps(newer));replacement.replace(p)
   self.assertEqual(board.page()['scores'][0],4900)
 def test_eligibility_uses_30_games_30_days_and_drops_invalid_scores(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'new.json';data=primary();data['meta']['sourceAt']=40*86400000
   data['players']={A:row(4000,39*86400000,29),B:row(4100,9*86400000),C:row(4200,39*86400000),D:row(float('nan'),39*86400000)}
   p.write_text(json.dumps(data));self.assertEqual(AnonymousBoard(Snapshot(p)).page()['scores'],[4200])
 def test_frontend_http_and_network_contract_is_anonymous(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'new.json';p.write_text(json.dumps(primary()))
   server=ThreadingHTTPServer(('127.0.0.1',0),handler(Snapshot(p)));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base='http://127.0.0.1:'+str(server.server_port)
   try:
    def get(path):return urllib.request.urlopen(base+path)
    with get('/api/v1/leaderboard') as response:
     raw=response.read().decode();result=json.loads(raw)
     self.assertNotIn('MustNeverReachBrowser',raw);self.assertNotIn(A,raw);self.assertEqual(result['scores'],[4100,4000])
     self.assertTrue(all(set(row)=={'conservative','uncertainty','technical'} for row in result['rows']))
    for path in ['/data/elo/names.json','/data/elo/top.json','/api/v1/leaderboard?uid='+A,'/api/v1/leaderboard?limit=101','/api/v1/leaderboard?offset=-1']:
     self.assertRaises(urllib.error.HTTPError,get,path)
    for path in ['/','/index.html','/elo.js','/elo.css']:
     with get(path) as response:
      self.assertEqual(response.status,200);self.assertNotIn('Set-Cookie',response.headers)
      source=response.read().decode();self.assertNotIn('MustNeverReachBrowser',source);self.assertNotIn(A,source)
      self.assertNotIn('names.json',source);self.assertNotIn('/api/v1/ratings',source)
    self.assertIn(A,json.load(get('/api/v1/ratings?uid='+A)))
   finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
