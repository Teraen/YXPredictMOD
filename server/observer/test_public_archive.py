import copy,json,os,pathlib,sys,tempfile,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from public_archive import public_record,recover_battles,records_for,ArchivePending

def sample():
    players=[{'uid':'human-'+str(i),'minimum':i+1,'maximum':i+1,'history':[{'round':r,'characterId':1000+i,'cards':[10000+i*100+r]}for r in (1,2)]}for i in range(8)]
    rows=[]
    def person(i,r):return {'publicData':{'uid':'record-player-'+str(i+1),'characterId':1000+i,'isMirror':False,'life':90,'lastRoundData':{'life':100,'usedCards':[10000+i*100+r]}},'privateData':{'hand':['PRIVATE']}}
    for r in (1,2,3):
        for i in range(0,8,2):rows.append({'round':r,'p1':person(i,r),'p2':person(i+1,r),'winerId':'record-player-'+str(i+1),'lifeDamage':20})
    raw={'codeId':123,'gameId':'archive-game','beginTs':1000,'endTs':2000,'roundStats':rows}
    records=[public_record(raw,123)for _ in range(8)]
    names={str(10000+i*100+r):'公开牌'for i in range(8)for r in (1,2,3)}
    return {'code':'123456','gameId':'code:123','gameRoomId':'native-room','round':3,'players':players},records,names

class ArchiveTests(unittest.TestCase):
    def test_record_fetching_is_bounded_and_resumes_from_filtered_local_cache(self):
        target,records,names=sample();bridge=Mock(return_value=Mock(returncode=0,stdout=json.dumps(records[0])))
        with tempfile.TemporaryDirectory()as temp,patch('public_archive.subprocess.run',bridge),patch.dict(os.environ):
            config={'archiveCache':temp,'archiveBridge':temp};self.addCleanup(lambda:sys.path.remove(temp)if temp in sys.path else None)
            self.assertRaises(ArchivePending,records_for,config,target);self.assertEqual(bridge.call_count,4)
            self.assertEqual(len(list(pathlib.Path(temp).glob('*.json'))),4)
            self.assertEqual(len(records_for(config,target)),8);self.assertEqual(bridge.call_count,8)
            self.assertEqual(len(records_for(config,target)),8);self.assertEqual(bridge.call_count,8)
            self.assertEqual(bridge.call_args.kwargs['env']['YX_IDENTITY_CAPTURE_REPLAYS'],'0');self.assertIn('archive_bridge.py',bridge.call_args.args[0][1])
    def test_bridge_imports_are_isolated_from_observer_modules_and_only_public_output_is_cached(self):
        target,records,names=sample();raw=copy.deepcopy(records[0]);raw['privateData']={'hand':['DO-NOT-CACHE']}
        with tempfile.TemporaryDirectory()as temp:
            path=pathlib.Path(temp);bridge=path/'bridge';bridge.mkdir()
            (bridge/'public_lobby_wire.py').write_text('def classify_player():return True',encoding='utf8')
            (bridge/'replay_service.py').write_text("import json,os,pathlib\nfrom public_lobby_wire import classify_player\ndef upstream(*args,**kwargs):\n assert classify_player() and os.environ['YX_IDENTITY_CAPTURE_REPLAYS']=='0'\n return json.loads(pathlib.Path(__file__).with_name('record.json').read_text())",encoding='utf8')
            (bridge/'record.json').write_text(json.dumps(raw),encoding='utf8')
            config={'archiveCache':str(path/'cache'),'archiveBridge':str(bridge)}
            self.assertRaises(ArchivePending,records_for,config,target)
            self.assertEqual(len(records_for(config,target)),8)
            self.assertTrue(all('DO-NOT-CACHE'not in f.read_text()for f in (path/'cache').glob('*.json')))

    def test_successful_fetch_is_saved_before_a_later_network_failure(self):
        target,records,names=sample();bridge=Mock(side_effect=[Mock(returncode=0,stdout=json.dumps(records[0])),RuntimeError('network')])
        with tempfile.TemporaryDirectory()as temp,patch('public_archive.subprocess.run',bridge),patch.dict(os.environ):
            self.addCleanup(lambda:sys.path.remove(temp)if temp in sys.path else None)
            self.assertRaises(RuntimeError,records_for,{'archiveCache':temp,'archiveBridge':temp},target)
            self.assertEqual(len(list(pathlib.Path(temp).glob('*.json'))),1)
    def test_unique_public_board_histories_recover_real_players_without_private_hands(self):
        target,records,names=sample();self.assertNotIn('PRIVATE',json.dumps(records))
        battles=recover_battles(target,records,names);self.assertEqual(len(battles),8)
        self.assertEqual(battles[-1]['first'],'human-6');self.assertEqual(battles[-1]['winner'],'human-6')
    def test_recovery_can_fill_earlier_missing_rounds_in_a_bounded_batch(self):
        target,records,names=sample();target['recoveryRounds']=[1]
        battles=recover_battles(target,records,names)
        self.assertEqual(len(battles),4);self.assertEqual({b['round']for b in battles},{1})
        for rounds in ([],[0],[4],[1,2,3],[True]):
            target['recoveryRounds']=rounds;self.assertRaises(ArchivePending,recover_battles,target,records,names)

    def test_same_round_elimination_interval_uses_unique_board_evidence_instead_of_rank_guessing(self):
        target,records,names=sample()
        for p in target['players'][:2]:p['minimum']=1;p['maximum']=2
        records=copy.deepcopy(records)
        for record in records:
            for b in record['roundStats']:
                for side in ('p1','p2'):
                    p=b[side]['publicData']
                    if p['uid']=='record-player-1':p['uid']='record-player-2'
                    elif p['uid']=='record-player-2':p['uid']='record-player-1'
                if b['winerId']=='record-player-1':b['winerId']='record-player-2'
        self.assertEqual(recover_battles(target,records,names)[0]['winner'],'human-0')
    def test_foreign_game_and_missing_or_contradictory_history_never_publish(self):
        target,records,names=sample();records[0]['gameId']='foreign'
        self.assertRaises(ArchivePending,recover_battles,target,records,names)
        target,records,names=sample();target['players'][0]['history'][0]['cards']=[999]
        self.assertRaises(ArchivePending,recover_battles,target,records,names)
        target,records,names=sample();target['players'][0]['history']=target['players'][0]['history'][:1]
        self.assertRaises(ArchivePending,recover_battles,target,records,names)
    def test_conflicting_public_winners_roll_back_the_recovery_candidate(self):
        target,records,names=sample();records[0]['roundStats'][-1]['winerId']='record-player-8'
        self.assertRaises(ArchivePending,recover_battles,target,records,names)

if __name__=='__main__':unittest.main()
