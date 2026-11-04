"""The public board contains ordered scores only, with no stable player identifier."""
import math
import threading
from legacy import pseudonym

MIN_GAMES=30
ACTIVE_DAYS=30
MAX_SCORES=100


class AnonymousBoard:
    def __init__(self,snapshot,legacy=None):
        self.snapshot=snapshot;self.legacy=legacy;self.lock=threading.Lock();self.generation=None;self.rows=[];self.at=0
    def page(self,offset=0,limit=100):
        with self.lock:
            primary=self.snapshot.get();merged=primary['meta'].get('historyMerged',False)
            old=None if self.legacy is None or merged else self.legacy.data()
            generation=(self.snapshot.stamp,None if old is None else self.legacy.snapshot.stamp)
            if generation!=self.generation:
                at=primary['meta'].get('ratedThroughAt',primary['meta']['sourceAt'])
                if old is not None:at=max(at,old['meta']['dataAt'])
                cutoff=at-ACTIVE_DAYS*86400000;scores=[];seen=set()
                def append(row):
                    score=row.get('rating')
                    uncertainty=row.get('sigma',0)
                    if type(score) not in (int,float) or not math.isfinite(score) or type(uncertainty) not in (int,float) or not math.isfinite(uncertainty) or uncertainty<0:return
                    conservative=row.get('cons',score-2*uncertainty)
                    if row.get('games',0)>=MIN_GAMES and row.get('last',0)>=cutoff and type(conservative) in (int,float) and math.isfinite(conservative):
                        scores.append({'conservative':conservative,'uncertainty':uncertainty,'technical':score})
                for uid,row in primary['players'].items():
                    if old is not None:
                        identity=pseudonym(uid,self.legacy.key);seen.add(identity);previous=old['players'].get(identity)
                        if previous is not None and previous['last']>row.get('last',0):row=previous
                    append(row)
                if old is not None:
                    for identity,row in old['players'].items():
                        if identity not in seen:append(row)
                if merged:
                    for row in primary.get('hashedPlayers',{}).values():append(row)
                self.rows=sorted(scores,key=lambda item:item['conservative'],reverse=True)[:MAX_SCORES];self.at=at;self.generation=generation
            rows=self.rows[offset:offset+limit]
            return {'rows':rows,'scores':[int(round(row['technical'])) for row in rows],'total':len(self.rows),'offset':offset,'limit':limit,
                'updatedAt':self.at,'minGames':MIN_GAMES,'activeDays':ACTIVE_DAYS}
