import base64,json,pathlib,sys,unittest
from unittest.mock import Mock
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from public_lobby_wire import varint,string_field
from public_snapshot import public_status,public_battles
from projection import PublicProjection
from main import SnapshotBuilder,eligible
from transport import Spectator,reservation_url,delayed_request

def number(n,v):return varint(n*8)+varint(v if v>=0 else (1<<64)+v)
def blob(n,v):return varint(n*8+2)+varint(len(v))+v
def encoded(v):return base64.b64encode(v).decode()
UIDS=[format(i+1,'024x')for i in range(8)]
ROSTER=[{'userInfo':{'uid':u,'username':'道友'+str(i)},'isAI':False}for i,u in enumerate(UIDS)]
def player(i,life=100,rank=0,private=False):
    board=number(1,life)+blob(6,varint(1000010)+varint(1010010))
    raw=string_field(1,UIDS[i])+string_field(2,'道友'+str(i))+number(3,life)+number(12,1000001)+number(15,rank)+number(19,2)+number(20,1)+blob(200,board)
    return blob(1,raw)+blob(2,b'PRIVATE-HAND-SECRET')if private else raw
def status(round=1,ended=False):
    return number(1,round)+number(2,30)+number(3,int(ended))+number(100,123456)+number(102,42)+b''.join(blob(5,player(i))for i in range(8))
def delayed(round=1,index=0,commands=b''):
    snap=number(1,index)+number(2,10000)+number(3,round)+number(4,30)+b''.join(blob(100,player(i,private=True))for i in range(8))
    return encoded(blob(1,snap)+commands+number(4,123456)+number(6,42))
def cmd(index,ts,kind,data):return blob(2,number(1,index)+number(2,ts)+string_field(4,kind)+string_field(5,encoded(data)))

class PublicTests(unittest.TestCase):
    def test_ordinary_status_retains_only_public_fields(self):
        p=PublicProjection(ROSTER);self.assertTrue(p.accept_ordinary(encoded(status())))
        self.assertEqual(p.game_id,'code:42');self.assertEqual(len(p.public_state()),8)
        self.assertNotIn('hand',json.dumps(p.players));self.assertEqual(p.players[UIDS[0]]['lastRound']['usedCards'],[1000010,1010010])
    def test_delayed_ignores_private_player_data(self):
        p=PublicProjection(ROSTER);self.assertTrue(p.accept(delayed()));self.assertNotIn('PRIVATE',json.dumps(p.players))
    def test_ordinary_full_roster_mirror_flag_does_not_pause_original_players_or_apply_ghost_battle_stats(self):
        raw=status(11).replace(blob(5,player(0)),blob(5,player(0)+number(11,1)),1)
        p=PublicProjection(ROSTER);self.assertTrue(p.accept_ordinary(encoded(raw)));self.assertEqual(p.public_state()[0]['life'],100)
        ghost=blob(1,blob(1,player(0,life=1)+number(11,1)))+blob(2,blob(1,player(1)))+number(7,11)+string_field(9,UIDS[1])
        p.ordinary_event({'type':'BattleResult','data':encoded(ghost)});self.assertEqual(p.public_state()[0]['life'],100)
        self.assertTrue(next(iter(p.battles.values()))['first']['isMirror'])
        with self.assertRaises(ValueError):p.accept_ordinary(encoded(raw.replace(UIDS[0].encode(),b'f'*24)))
    def test_native_timestamps_do_not_fast_forward_future_commands(self):
        clock=[0.0];p=PublicProjection(ROSTER,lambda:clock[0]);data=delayed(commands=cmd(1,15000,'GameStatus',status(2)))
        p.accept(data);self.assertEqual(p.round,1);clock[0]=4;p.accept(data);self.assertEqual(p.round,1)
        clock[0]=5;p.tick();self.assertEqual(p.round,2);revision=p.revision;p.accept(data);self.assertEqual(p.revision,revision)
    def test_delayed_transport_stays_on_current_snapshot_until_public_commands_are_due(self):
        clock=[0.0];p=PublicProjection(ROSTER,lambda:clock[0]);self.assertEqual(p.request_round(),-1)
        data=delayed(commands=cmd(1,15000,'GameStatus',status(2)));p.accept(data)
        self.assertEqual(p.request_round(),1);clock[0]=4;self.assertEqual(p.request_round(),1)
        clock[0]=5;self.assertEqual(p.request_round(),2);self.assertTrue(p.accept(data));self.assertEqual(p.round,2)
    def test_foreign_identity_roster_stale_snapshots_rejected(self):
        p=PublicProjection(ROSTER);p.accept(delayed(2,2));self.assertFalse(p.accept(delayed(2,1)))
        with self.assertRaises(ValueError):p.accept_ordinary(encoded(status(3).replace(UIDS[0].encode(),b'f'*24)))
        with self.assertRaises(ValueError):p.accept_ordinary(encoded(status(3)+number(102,99)))
    def test_preparation_timer_expires_and_partial_results_do_not_complete_a_cohort(self):
        clock=[0.0];p=PublicProjection(ROSTER,lambda:clock[0]);p.accept(delayed());clock[0]=31
        self.assertEqual(p.remaining_timer(),0)
        b=SnapshotBuilder({'roomId':'public'},ROSTER,[{'uid':u,'score':3000,'found':True}for u in UIDS]);self.assertFalse(b.build(p,1)['open'])
        p.accept_ordinary(encoded(status().replace(number(2,30),number(2,0),1)));self.assertFalse(p.round_complete)
        battle=blob(1,player(0,private=True))+blob(2,player(1,private=True))+number(7,1)+string_field(9,UIDS[0])
        p.ordinary_event({'type':'BattleResult','data':encoded(battle)});self.assertFalse(p.round_complete)
        p.ordinary_event({'type':'AllBattleResults','data':encoded(blob(1,battle))});self.assertTrue(p.round_complete)
    def test_public_battle_discards_private_hands_and_requires_explicit_winner(self):
        battle=blob(1,player(0,private=True))+blob(2,player(1,private=True))+number(7,1)+string_field(9,UIDS[0])
        rows=public_battles('BattleResult',encoded(battle));self.assertNotIn('PRIVATE',json.dumps(rows));self.assertEqual(rows[0]['winner'],UIDS[0])
        p=PublicProjection(ROSTER);p.accept_ordinary(encoded(status()));p.ordinary_event({'type':'AllBattleResults','data':encoded(blob(1,battle))})
        b=SnapshotBuilder({'roomId':'public'},ROSTER,[{'uid':u,'score':3000,'found':True}for u in UIDS],{'1000010':'云剑'})
        s=b.build(p,10);self.assertFalse(s['open']);self.assertEqual(s['liveRound'],10);self.assertEqual(s['battles'][0]['firstNames'],['云剑','未知牌'])
        self.assertNotIn('score',json.dumps(s));self.assertNotIn('sigma',json.dumps(s))
    def test_native_battle_damage_and_public_before_after_life_are_separate(self):
        battle=blob(1,player(0,life=80,private=True))+blob(2,player(1,life=90,private=True))+number(6,27)+number(7,1)+string_field(9,UIDS[1])
        parsed=public_battles('BattleResult',encoded(battle))[0];self.assertEqual(parsed['lifeDamage'],27)
        p=PublicProjection(ROSTER);p.accept_ordinary(encoded(status()));p.ordinary_event({'type':'BattleResult','data':encoded(battle)})
        s=SnapshotBuilder({'roomId':'public'},ROSTER,[{'uid':u,'score':3000,'found':True}for u in UIDS]).build(p,1)
        self.assertEqual(s['battles'][0]['lifeDamage'],27);self.assertEqual(s['battles'][0]['firstLife'],80)
    def test_builder_restores_frozen_model_in_uid_order_and_same_shuffle(self):
        p=PublicProjection(ROSTER);p.accept_ordinary(encoded(status()))
        model=[{'uid':u,'score':3000+i*100,'found':True}for i,u in enumerate(UIDS)]
        a=SnapshotBuilder({'roomId':'public'},ROSTER,model).build(p,1)
        b=SnapshotBuilder({'roomId':'public'},ROSTER,list(reversed(model))).build(p,1)
        self.assertEqual(a,b);self.assertTrue(a['open']);self.assertEqual(len(a['baseRates']),64)
    def test_candidate_uses_native_rank_score_strictly(self):
        i={'name':'game_room','status':2,'isPrivate':False,'playerCount':8,'round':1,'avgRankScore':6000}
        self.assertTrue(eligible(i))
        for k,v in [('round',3),('avgRankScore',5999),('playerCount',7),('isPrivate',True)]:self.assertFalse(eligible({**i,k:v}))
    def test_reservation_cannot_redirect_or_join_foreign_room(self):
        r={'room':{'name':'game_room','roomId':'pub','processId':'process','publicAddress':'evil.invalid'},'sessionId':'session'}
        self.assertTrue(reservation_url(r,'pub','https://trusted.invalid/game').startswith('wss://trusted.invalid/'))
        with self.assertRaises(Exception):reservation_url(r,'other','https://trusted.invalid/game')
        self.assertEqual(base64.b64decode(delayed_request(-1)),bytes.fromhex('082b10ffffffffffffffffff01'))
    def test_focus_uses_only_verified_public_portrait_and_no_extra_role(self):
        s=Spectator(Mock(),{},'ordinary');s.ws=Mock();s._receive=Mock(side_effect=['public-status','public-battle'])
        self.assertEqual(s.focus_public(UIDS[0],set(UIDS)),'public-battle');self.assertEqual(s.ws.send_binary.call_count,2)
        packet=s.ws.send_binary.call_args_list[0].args[0];self.assertIn(b'SpectateReq',packet);self.assertNotIn(b'Realtime',packet)
        with self.assertRaises(Exception):s.focus_public('foreign',set(UIDS))
        s.mode='delayed';self.assertIsNone(s.focus_public(UIDS[0],set(UIDS)))

if __name__=='__main__':unittest.main()
