import base64,json,pathlib,sys,unittest
from unittest.mock import Mock
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from public_lobby_wire import varint,string_field
from rank_info import match_ranks,lobby_ranks
from transport import Spectator
UIDS=[format(i+1,'024x')for i in range(8)]
def number(n,v):return varint(n*8)+varint(v)
def blob(n,v):return varint(n*8+2)+varint(len(v))+v
def row(i):return string_field(1,UIDS[i])+number(4,7000+i*100)+number(10,i%2)+string_field(5,'discard-name')+string_field(99,'PRIVATE')
def encoded(rows):return base64.b64encode(b''.join(blob(1,r)for r in rows)).decode()

class NativeRankTests(unittest.TestCase):
    def test_only_native_score_and_per_player_mode_are_kept_in_uid_order(self):
        rows=match_ranks(encoded([row(i)for i in reversed(range(8))]),UIDS)
        self.assertEqual(rows[0],{'uid':UIDS[7],'score':7700,'mode':'daoxin'})
        self.assertEqual(rows[-1],{'uid':UIDS[0],'score':7000,'mode':'ladder'})
        self.assertNotIn('PRIVATE',json.dumps(rows));self.assertNotIn('discard-name',json.dumps(rows))
    def test_rejects_incomplete_duplicate_foreign_modes_or_invalid_native_scores(self):
        base=[row(i)for i in range(8)]
        cases=[base[:7],base+[row(0)],base[:-1]+[row(0)],base[:-1]+[string_field(1,'foreign')],
            base[:-1]+[string_field(1,UIDS[7])+number(10,2)],base[:-1]+[string_field(1,UIDS[7])+number(4,1000001)],
            base[:-1]+[row(7)+number(4,123)]]
        for rows in cases:
            with self.assertRaises(ValueError):match_ranks(encoded(rows),UIDS)
    def test_zero_is_a_valid_native_protobuf_default_and_lobby_fallback_does_not_infer_daoxin(self):
        rows=match_ranks(encoded([string_field(1,u)for u in UIDS]),UIDS)
        self.assertTrue(all(r['score']==0 and r['mode']=='ladder'for r in rows))
        roster=[{'userInfo':{'uid':u,'rankScore':0 if i==0 else 7100}if i<7 else{'uid':u}}for i,u in enumerate(UIDS)]
        fallback=lobby_ranks(roster);self.assertEqual(fallback[0]['score'],0);self.assertIsNone(fallback[7]['score'])
        self.assertTrue(all(r['mode']=='ladder'for r in fallback))
    def test_read_only_match_info_request_and_cached_push_use_the_same_verified_decoder(self):
        s=Spectator(Mock(),{},'ordinary');s.ws=Mock();s._receive=Mock(return_value=encoded([row(i)for i in range(8)]))
        self.assertEqual(s.ranks(UIDS)[1]['mode'],'daoxin');s._receive.assert_called_once_with('MatchPlayerInfosResp',2)
        import msgpack
        packet=s.ws.send_binary.call_args.args[0];u=msgpack.Unpacker(raw=False);u.feed(packet[1:]);values=list(u)
        self.assertEqual(values[1]['type'],'SimpleClientPact');self.assertEqual(base64.b64decode(values[1]['data']),bytes([8,101]))
        s.match_rank_data=encoded([row(i)for i in range(8)]);s.ws.reset_mock();s.ranks(UIDS);s.ws.send_binary.assert_not_called()

if __name__=='__main__':unittest.main()
