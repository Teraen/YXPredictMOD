import json,pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from public_snapshot import public_status
from build_catalog import BuildCatalog
from test_projection import number,blob,encoded,player

class BuildTests(unittest.TestCase):
    def metadata(self):
        selection=number(3,1001)+blob(2,b'PRIVATE-CANDIDATE')
        previous=blob(5,bytes([1,2]))+blob(6,b'')+blob(7,b'PRIVATE-HAND')+blob(13,blob(1,selection))+blob(14,b'PRIVATE-TALENT')+blob(16,bytes([21]))+number(17,1001)
        return number(6,3)+number(7,1)+number(8,2)+blob(13,bytes([1,2]))+blob(200,previous)
    def test_only_public_selected_fields_are_retained_not_hands_candidates_or_private_talent_data(self):
        raw=number(1,2)+number(2,30)+number(100,123456)+number(102,42)
        # Use a single independently encoded public player with one last-round record.
        p=player(0)
        from public_lobby_wire import fields
        public=b''.join(blob(n,v)if k==2 else number(n,v)for n,k,v in fields(p)if n not in (6,7,8,13,200))+self.metadata()
        parsed=public_status(encoded(raw+blob(5,public)))['players'][0]
        self.assertEqual((parsed['level'],parsed['sect'],parsed['career']),(3,1,2));self.assertEqual(parsed['talents'],[1,2])
        self.assertEqual(parsed['lastRound']['baijia'],[1001]);self.assertEqual(parsed['lastRound']['fates'],[21]);self.assertEqual(parsed['lastRound']['resonanceId'],1001)
        self.assertNotIn('PRIVATE',json.dumps(parsed));self.assertNotIn('pending',json.dumps(parsed))
    def test_dictionary_resolves_actual_public_ids_and_keeps_missing_catalog_labels_explicit(self):
        catalog=BuildCatalog({'characters':{'1000001':'青松'},'careers':{'2':'符师'},'talents':{'1':'明心'},'talentRealms':{'1':'筑基'},'baijia':{'1001':'百家·清风'}})
        p={'characterId':1000001,'career':2,'sect':1,'level':3,'wins':2,'losses':1,'talents':[1,99],'lastRound':{'baijia':[1001,7],'fates':[],'resonanceId':0}}
        build=catalog.project(p,4);self.assertEqual(build['characterName'],'青松');self.assertEqual(build['careerName'],'符师');self.assertEqual(build['talents'][0]['name'],'筑基 · 明心')
        self.assertEqual(build['talents'][1]['name'],'名称待同步');self.assertEqual(build['baijia'][1]['name'],'跳过本次百家仙命');self.assertEqual(build['selectionRound'],3)
    def test_empty_previous_public_data_is_waiting_not_an_invented_selection(self):
        p={'characterId':1000001,'career':0,'wins':0,'losses':0,'lastRound':None}
        build=BuildCatalog().project(p,1);self.assertFalse(build['selectionsKnown']);self.assertEqual(build['baijia'],[]);self.assertEqual(build['careerName'],'未选择副职')
        p['lastRound']={'usedCards':[]};self.assertIsNone(BuildCatalog().project(p,1)['cards'])
    def test_oversized_public_choice_list_is_rejected_before_publication(self):
        raw=number(1,1)+blob(5,player(0)+blob(13,bytes([1])*33));self.assertRaises(ValueError,public_status,encoded(raw))
    def test_board_contains_only_last_round_public_used_cards_with_its_actual_round(self):
        p={'characterId':1000001,'career':2,'wins':2,'losses':1,'lastRound':{'usedCards':[1000010,0]}}
        b=BuildCatalog().project(p,4,{'1000010':'云剑'});self.assertEqual(b['cards'],[1000010,0]);self.assertEqual(b['cardNames'],['云剑','空位']);self.assertEqual(b['selectionRound'],3)

if __name__=='__main__':unittest.main()
