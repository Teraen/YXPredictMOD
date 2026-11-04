import copy
import json
import pathlib
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from ratings import build
from api import Snapshot,handler
from export import export

A='a'*24;B='b'*24;G='c'*24
def seed():return {'last':1000,'players':{A:{'mu':25,'sigma':25/3,'games':10,'dx':2,'last':1000,'name':'甲','season':10,'seasons':{}}}}
def source():return {'schema':1,'readOnly':True,'upstreamRequests':0,'generatedAt':3000,'games':[{'id':G,'code':1,'begin':1001,'at':2000,'players':[{'uid':A,'place':1,'mode':'ladder','name':'甲'},{'uid':B,'place':3,'mode':'daoxin','name':'乙'}]}]}
class EloTests(unittest.TestCase):
 def test_known_season_model_matches_original_reference_vectors(self):
  vector=json.loads((pathlib.Path(__file__).parent/'fixtures/original-model-parity.json').read_text(encoding='utf-8'))
  result=build(vector['seed'],vector['source'])
  for uid,expected in vector['expected'].items():
   for field in ['rating','sigma','games','dx']:self.assertEqual(result['players'][uid][field],expected[field])
   self.assertAlmostEqual(result['players'][uid]['cons'],expected['cons'],places=9)
  self.assertEqual(result['meta']['ratedThroughAt'],max(g['at'] for g in vector['source']['games']))
 def test_ranking_dedup_and_repeat_rebuild(self):
  s=seed();v=source();r=build(s,v);self.assertGreater(r['players'][A]['rating'],3000);self.assertLess(r['players'][B]['rating'],3000)
  self.assertEqual(r['players'][A]['games'],11);self.assertEqual(r['players'][B]['dx'],1);self.assertEqual(s,seed())
  v['games']*=2;self.assertEqual(build(s,v)['players'],r['players']);self.assertEqual(build(s,source()),r)
  self.assertEqual(build(seed(),source(),copy_seed=False),r)
 def test_backfill_and_revised_facts_rebuild_without_double_count(self):
  original=source();r=build(seed(),original);v=source();v['games'][0]['players'][0]['place']=4
  corrected=build(seed(),v);self.assertNotEqual(corrected['players'][A]['rating'],r['players'][A]['rating']);self.assertEqual(corrected['players'][A]['games'],11)
  v['games'].append(copy.deepcopy(original['games'][0]));self.assertRaises(ValueError,build,seed(),v)
 def test_missing_hash_and_invalid_source_never_become_players(self):
  v=source();v['games'][0]['players'][0]['uid']='a'*16;self.assertRaises(ValueError,build,seed(),v)
  v=source();v['upstreamRequests']=1;self.assertRaises(ValueError,build,seed(),v)
  v=source();v['games'][0]['at']=999;self.assertEqual(build(seed(),v)['meta']['updatedGames'],0)
 def test_api_batch_unknowns_compatibility_and_atomic_reload(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'snapshot.json';p.write_text(json.dumps(build(seed(),source())),encoding='utf-8')
   server=ThreadingHTTPServer(('127.0.0.1',0),handler(Snapshot(p)));t=threading.Thread(target=server.serve_forever,daemon=True);t.start();base='http://127.0.0.1:'+str(server.server_port)
   try:
    def get(path):return json.load(urllib.request.urlopen(base+path))
    self.assertEqual(set(get('/api/v1/ratings?uid='+A+'&uid='+'d'*24)),{A})
    self.assertIn(A,get('/data/elo/p/aa.json'));self.assertEqual(get('/api/v1/status')['mode'],'anonymous-web-and-api')
    self.assertRaises(urllib.error.HTTPError,get,'/api/v1/ratings?uid='+'f'*16)
    self.assertIn(b'<!doctype html>',urllib.request.urlopen(base+'/index.html').read())
    v=source();v['games']=[];p.write_text(json.dumps(build(seed(),v)),encoding='utf-8');self.assertEqual(get('/api/v1/ratings?uid='+A)[A]['games'],10)
   finally:server.shutdown();server.server_close();t.join()
 def test_export_uses_readonly_consistent_saved_proofs_and_rejects_conflicts(self):
  with tempfile.TemporaryDirectory() as d:
   p=str(pathlib.Path(d)/'source.db');db=sqlite3.connect(p)
   db.executescript('''CREATE TABLE link_replays(code_id,game_id,begin_ts,end_ts);CREATE TABLE link_rooms(key,code_id,status);
    CREATE TABLE link_reports(room_key,code_id,payload);CREATE TABLE link_conflicts(code_id);CREATE TABLE link_people(room_key,alias,uid,name,proof);
    CREATE TABLE link_scores(room_key,code_id,uid,mode,before,delta,after);''')
   db.execute('INSERT INTO link_replays VALUES (1,?,1001,2000)',(G,));db.execute("INSERT INTO link_rooms VALUES ('room',1,'verified')")
   rows=[{'uid':u,'anonymousUid':'record-player-'+str(i),'status':'verified'} for u,i in [(A,1),(B,3)]]
   scores=[{**r,'mode':'ladder','before':1000,'delta':10,'after':1010} for r in rows]
   report={'game':[G,1,1001],'conflicts':[],'mapping':rows,'scores':scores}
   db.execute('INSERT INTO link_reports VALUES (?,?,?)',('room',1,json.dumps(report)))
   for r in rows:
    db.execute('INSERT INTO link_people VALUES (?,?,?,?,?)',('room',r['anonymousUid'],r['uid'],'名字',json.dumps(r)))
    db.execute("INSERT INTO link_scores VALUES ('room',1,?,'ladder',1000,10,1010)",(r['uid'],))
   db.commit();before=pathlib.Path(p).read_bytes();facts=export(p);self.assertEqual(len(facts['games']),1);self.assertEqual(facts['upstreamRequests'],0);self.assertEqual(pathlib.Path(p).read_bytes(),before)
   db.execute('INSERT INTO link_conflicts VALUES (1)');db.commit();self.assertEqual(export(p)['games'],[]);db.close()
if __name__=='__main__':unittest.main()
