"""Independent OpenSkill adapter with deterministic rebuilds for late identity facts."""
import copy
import hashlib
import json
import math
import re
from openskill.models import PlackettLuce

MU=25.0
SIGMA=25.0/3
SCALE=48.0
DAY=86400000


def build(seed,source,copy_seed=True):
    if source.get('schema')!=1 or source.get('readOnly') is not True or source.get('upstreamRequests')!=0:
        raise ValueError('Expected read-only identity facts')
    players=copy.deepcopy(seed['players']) if copy_seed else seed['players']
    seed_players=len(players)
    if not copy_seed:
        for player in players.values():player.pop('h',None);player.pop('nameTs',None)
    hashed=seed.get('identityMode')=='hmac16'
    if source.get('identityMode','raw24')!=seed.get('identityMode','raw24'):raise ValueError('Model identity modes differ')
    pattern='[0-9a-f]{16}' if hashed else '[0-9a-f]{24}'
    if any(not re.fullmatch(pattern,u) for u in players):
        raise ValueError('Seed must use raw game-account UIDs')
    model=PlackettLuce(mu=MU,sigma=SIGMA,beta=25/6,tau=25/300)
    seen={};allowed_early=set(source.get('preCheckpointHistoricalIds',[])) if hashed else set()
    for game in source['games']:
        if not isinstance(game.get('at'),int) or (game['at']<=seed['last'] and game.get('id') not in allowed_early):
            continue
        gid=game.get('id')
        if not isinstance(gid,str) or not re.fullmatch('[0-9a-f]{24}',gid):raise ValueError('Invalid game identity')
        fingerprint=json.dumps(game,sort_keys=True,separators=(',',':'))
        if gid in seen and seen[gid][0]!=fingerprint:raise ValueError('Conflicting duplicate game')
        seen[gid]=(fingerprint,game)
    n=0; rated_through=seed['last']
    for _,game in sorted(seen.values(),key=lambda item:(item[1]['at'],item[1]['id'])):
        rows=sorted(game['players'],key=lambda p:p['place'])
        if not 2<=len(rows)<=8 or len({p['uid'] for p in rows})!=len(rows):
            raise ValueError('Invalid participant identities or placements')
        before=[]
        for row in rows:
            uid=row['uid'];place=row['place']
            if not re.fullmatch(pattern,uid) or type(place) is not int or not 1<=place<=8 or row.get('mode') not in ('ladder','daoxin'):
                raise ValueError('Unverified participant')
            p=players.setdefault(uid,{'mu':MU,'sigma':SIGMA,'games':0,'dx':0,'last':game['at'],'name':'','season':None,'seasons':{}})
            variance=p['sigma']**2+0.15**2*max(0,(game['at']-p['last'])/DAY)
            # Unknown season is kept unknown: do not invent a reset at a date boundary.
            season=game.get('season')
            if season is not None and p.get('season') is not None and str(season)!=str(p['season']):variance+=9
            before.append([model.rating(mu=p['mu'],sigma=min(SIGMA,math.sqrt(variance)))])
        after=model.rate(before,ranks=[p['place'] for p in rows])
        for row,[rating] in zip(rows,after):
            p=players[row['uid']];p.update(mu=rating.mu,sigma=rating.sigma,last=game['at'],name=row.get('name') or p['name'])
            p['games']+=1;p['dx']+=int(row['mode']=='daoxin')
            if game.get('season') is not None:p['season']=game['season']
        n+=1; rated_through=max(rated_through,game['at'])
    output={}
    for uid,p in players.items():
        score=3000+SCALE*(p['mu']-MU);sigma=SCALE*p['sigma']
        if not math.isfinite(score) or not 0<=score<=10000 or not math.isfinite(sigma) or not 0<=sigma<=2000:
            raise ValueError('Rating outside MOD contract')
        output[uid]={'rating':round(score,3),'sigma':round(sigma,3),'cons':score-2*sigma,'games':p['games'],'dx':p['dx'],'last':p['last'],'name':p['name'],
            'seasons':p.get('seasons',{}),'seedAt':seed['last']}
    revision=hashlib.sha256(json.dumps(source['games'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'players':output,'meta':{'schema':1,'seedAt':seed['last'],'seedPlayers':seed_players,'updatedGames':n,
        'players':len(output),'sourceAt':source['generatedAt'],'ratedThroughAt':rated_through,'sourceRevision':revision,'scope':source.get('scope'),
        'model':'OpenSkill Plackett-Luce','seasonReset':'Applied only when explicitly provided by the source','coverageComplete':False}}
