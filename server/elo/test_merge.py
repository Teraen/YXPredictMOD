import copy
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from merge import merged_model
from legacy import pseudonym,Lookup
from api import Snapshot,handler
from anonymous import AnonymousBoard

A='a'*24;B='b'*24;C='c'*24;X='1'*16;KEY=b'merged-history-synthetic-key-only'
PARAMS={'beta':25/6,'tau':25/300,'seasonSigma':3.0,'daySigma':0.15,'history':1}
def player():return {'mu':25,'sigma':25/3,'games':40,'dx':0,'last':1000,'name':'private-test-name','season':10,'seasons':{}}
def seed():return {'last':1000,'players':{A:player(),B:player()}}
def entry(uid,place):return {'uid':uid,'place':place,'mode':'ladder','name':'private-test-name'}
def game(gid,at,players):return {'id':format(gid,'024x'),'at':at,'season':10,'players':players}
def history():return {'schema':1,'readOnly':True,'upstreamRequests':0,'seedLast':1000,'seedParams':PARAMS,'revision':'test',
 'games':[game(1,2000,[entry(A,1),entry(B,2)])],'names':{}}
def live():return {'schema':1,'readOnly':True,'upstreamRequests':0,'generatedAt':4000,'games':[game(2,3000,[entry(A,2),entry(B,1)])]}


class MergeTests(unittest.TestCase):
 def test_old_and_new_games_are_both_rated_once(self):
  s=seed();h=history();v=live();before=copy.deepcopy((s,h,v));result=merged_model(s,h,v,KEY)
  self.assertEqual(result['players'][A]['games'],42);self.assertEqual(result['meta']['updatedGames'],2)
  self.assertTrue(result['meta']['historyMerged']);self.assertEqual((s,h,v),before)
  v['games'].append(copy.deepcopy(h['games'][0]));same=merged_model(seed(),h,v,KEY)
  self.assertEqual(same['players'],result['players']);self.assertEqual(same['meta']['overlappingGames'],1)
  v['games'].append(copy.deepcopy(v['games'][0]));self.assertEqual(merged_model(seed(),h,v,KEY)['players'],result['players'])
 def test_raw_and_hashed_uids_join_and_missing_players_enrich_same_game(self):
  h=history();h['games'][0]['players'][0]['uid']=pseudonym(A,KEY)
  v=live();v['games']=[game(1,2000,[entry(A,1),entry(B,2),entry(C,3)])]
  r=merged_model(seed(),h,v,KEY);self.assertEqual(r['meta']['updatedGames'],1)
  self.assertEqual(r['players'][A]['games'],41);self.assertEqual(r['players'][C]['games'],1)
  self.assertEqual(len(r['players']),3);self.assertEqual(r['hashedPlayers'],{})
 def test_unknown_hashed_opponents_are_rated_and_later_resolve_to_raw_uid(self):
  h=history();h['games'][0]['players'].append(entry(pseudonym(C,KEY),3))
  r=merged_model(seed(),h,live(),KEY);self.assertIn(pseudonym(C,KEY),r['hashedPlayers'])
  v=live();v['games'].append(game(3,3500,[entry(C,1),entry(A,2)]));r=merged_model(seed(),h,v,KEY)
  self.assertIn(C,r['players']);self.assertNotIn(pseudonym(C,KEY),r['hashedPlayers']);self.assertEqual(r['players'][C]['games'],2)
 def test_alias_placeholders_are_never_shared_fake_players(self):
  h=history();h['games'][0]['players'].extend([entry('record-player-1',3),entry(pseudonym('record-player-2',KEY),4)])
  r=merged_model(seed(),h,live(),KEY);self.assertEqual(len(r['players']),2);self.assertEqual(r['hashedPlayers'],{})
 def test_conflicting_rank_and_season_abort_and_late_old_inputs_are_not_silently_lost(self):
  h=history();v=live();v['games']=[game(1,2000,[entry(A,2),entry(B,1)])]
  self.assertRaises(ValueError,merged_model,seed(),h,v,KEY)
  v=live();v['games']=[copy.deepcopy(h['games'][0])];v['games'][0]['season']=11
  self.assertRaises(ValueError,merged_model,seed(),h,v,KEY)
  h['games'][0]['at']=999;self.assertRaises(ValueError,merged_model,seed(),h,live(),KEY)
 def test_real_ties_follow_original_model(self):
  h=history();h['games'][0]['players'][1]['place']=1
  r=merged_model(seed(),h,{'schema':1,'readOnly':True,'upstreamRequests':0,'generatedAt':3000,'games':[]},KEY)
  self.assertEqual(r['players'][A]['rating'],r['players'][B]['rating'])
 def test_late_ended_games_from_proven_unprocessed_shards_are_not_lost(self):
  h=history();h['checkpointDisjoint']=True;h['games'][0]['at']=999
  r=merged_model(seed(),h,live(),KEY);self.assertEqual(r['players'][A]['games'],42)
  self.assertEqual(r['meta']['preCheckpointHistoricalGames'],1)
 def test_merged_snapshot_does_not_get_overwritten_by_a_legacy_profile(self):
  with tempfile.TemporaryDirectory() as directory:
   h=history();h['games'][0]['players'].append(entry(pseudonym(C,KEY),3))
   result=merged_model(seed(),h,live(),KEY);p=pathlib.Path(directory)/'model.json';p.write_text(json.dumps(result))
   old={'players':{pseudonym(A,KEY):{'rating':9999,'sigma':0,'games':999,'dx':0,'last':999999,'name':'must-not-replace'},pseudonym(C,KEY):{'rating':9999,'sigma':0,'games':999,'dx':0,'last':999999,'name':'must-not-replace'}},'meta':{'source':'legacy-hmac','dataAt':999999}}
   q=pathlib.Path(directory)/'legacy.json';q.write_text(json.dumps(old));lookup=Lookup(Snapshot(q),KEY)
   board=AnonymousBoard(Snapshot(p),lookup).page();self.assertNotIn(9999,board['scores'])
   server=ThreadingHTTPServer(('127.0.0.1',0),handler(Snapshot(p),lookup));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   try:
    data=json.load(urllib.request.urlopen('http://127.0.0.1:'+str(server.server_port)+'/api/v1/ratings?uid='+A+'&uid='+C))
    self.assertEqual(data[A],result['players'][A])
    self.assertEqual(data[C],result['hashedPlayers'][pseudonym(C,KEY)])
   finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
