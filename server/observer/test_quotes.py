import json,pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from quotes import sources,titles,champion_rates

class QuoteTests(unittest.TestCase):
 def test_shuffled_titles_and_all_initial_base_odds_move_as_one_pair(self):
  players=[{'uid':format(i+1,'024x'),'isAI':False}for i in range(8)]
  ratings=[{'score':4400-i*100,'found':True}for i in range(8)]
  states=[{'life':100,'wins':0,'losses':0,'rank':0}for _ in range(8)]
  base=champion_rates(ratings,states,1);labels=['特等马','上等马']+['中等马']*5+['牛马']
  for game in range(40):
   identity='paired-swap-'+str(game);allocation=sources(identity,players)
   quoted=champion_rates([ratings[i]for i in allocation],states,1);named=titles(identity,players,ratings)
   for i,j in enumerate(allocation):
    self.assertEqual(named[i],labels[j]);self.assertEqual(quoted[i*8:i*8+8],base[j*8:j*8+8])
 def test_all_native_mod_reference_vectors(self):
  rows=json.loads((pathlib.Path(__file__).parent/'fixtures/quotes.json').read_text(encoding='utf-8'))
  self.assertEqual(len(rows),24)
  for row in rows:
   with self.subTest(game=row['id']):
    p=row['players'];ratings=[{'score':r['score'],'found':r['found']} for r in p]
    chosen=sources(row['id'],p)
    self.assertEqual(chosen,row['sources']);self.assertEqual(titles(row['id'],p,ratings),row['titles'])
    self.assertEqual(champion_rates([ratings[i] for i in chosen],row['states'],row['round']),row['rates'])
 def test_shuffle_is_stable_by_uid_and_only_changes_two_or_three_humans(self):
  p=[{'uid':format(i,'024x'),'isAI':i==7} for i in range(8)]
  chosen=sources('code:123',p);self.assertIn(sum(i!=j for i,j in enumerate(chosen)),(2,3));self.assertEqual(chosen[7],7)
  allocation={p[i]['uid']:p[j]['uid'] for i,j in enumerate(chosen)};p.reverse();self.assertEqual({p[i]['uid']:p[j]['uid'] for i,j in enumerate(sources('code:123',p))},allocation)
 def test_unconfirmed_eliminations_and_final_state_do_not_invent_a_quote(self):
  r=[{'score':3000,'found':True}]*8;s=[{'life':100,'wins':0,'losses':0,'rank':0} for _ in range(8)]
  s[0]['life']=0
  self.assertRaises(ValueError,champion_rates,r,s,1)
  for i,p in enumerate(s):p.update(life=100 if i==0 else 0,rank=i+1)
  self.assertRaises(ValueError,champion_rates,r,s,10)

if __name__=='__main__':unittest.main()
