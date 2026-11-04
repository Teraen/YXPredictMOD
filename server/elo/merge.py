"""Union replay inputs, not published ratings; a game/player pair is rated once."""
import copy
import re
from legacy import pseudonym


def merged_model(seed,history,live,key,copy_seed=True):
    from ratings import build
    if history.get('seedLast')!=seed['last'] or history.get('schema')!=1 or history.get('readOnly') is not True or history.get('upstreamRequests')!=0:raise ValueError('History does not match the original checkpoint')
    if live.get('schema')!=1 or live.get('readOnly') is not True or live.get('upstreamRequests')!=0:raise ValueError('Expected verified live facts')
    expected={'beta':25/6,'tau':25/300,'seasonSigma':3.0,'daySigma':0.15,'history':1}
    if history.get('seedParams')!=expected:raise ValueError('Historical model parameters differ')
    aliases={};placeholders={pseudonym('record-player-'+str(i),key) for i in range(1,65)}
    def identity(uid):
        if not isinstance(uid,str):raise ValueError('Invalid identity')
        if uid.startswith(('ai','record-player-')) or uid in placeholders:return None
        if re.fullmatch('[0-9a-f]{24}',uid):
            hashed=pseudonym(uid,key)
            if hashed in aliases and aliases[hashed]!=uid:raise ValueError('UID hash collision')
            aliases[hashed]=uid;return hashed
        if re.fullmatch('[0-9a-f]{16}',uid):return uid
        raise ValueError('Invalid identity')
    original=copy.deepcopy(seed['players']) if copy_seed else seed['players']
    canonical={}
    for uid,player in original.items():
        player.pop('h',None);player.pop('nameTs',None)
        hashed=identity(uid)
        if hashed is None:raise ValueError('Invalid checkpoint participant')
        if hashed in canonical:raise ValueError('Duplicate checkpoint identity')
        canonical[hashed]=player
    games={};old_ids=set();new_ids=set();early_old=set();duplicates=0;excluded=0
    for source,label in [(history,'history'),(live,'live')]:
        for raw in source['games']:
            if type(raw.get('at')) is not int:raise ValueError('Missing replay end time')
            gid=raw.get('id')
            if not isinstance(gid,str) or not re.fullmatch('[0-9a-f]{24}',gid):raise ValueError('Invalid game identity')
            if raw['at']<=seed['last']:
                if label=='history':
                    if history.get('checkpointDisjoint') is not True:raise ValueError('Historical replay predates checkpoint without disjoint-shard proof')
                    early_old.add(gid)
                elif gid not in early_old:excluded+=1;continue
            game=games.setdefault(gid,{'id':gid,'at':raw['at'],'players':{}})
            game['at']=max(game['at'],raw['at'])
            season=raw.get('season')
            if season is not None:
                if game.get('season') is not None and str(game['season'])!=str(season):raise ValueError('Conflicting replay season')
                game['season']=season
            (old_ids if label=='history' else new_ids).add(gid)
            for item in raw['players']:
                uid=identity(item['uid'])
                if uid is None:continue
                place=item.get('place');mode=item.get('mode')
                if type(place) is not int or not 1<=place<=8 or mode not in ('ladder','daoxin'):raise ValueError('Invalid placement or mode')
                row={'uid':uid,'place':place,'mode':mode,'name':item.get('name') or ''}
                previous=game['players'].get(uid)
                if previous is not None:
                    if previous['place']!=place or previous['mode']!=mode:raise ValueError('Conflicting duplicate game/player pair')
                    if not row['name']:row['name']=previous['name']
                    duplicates+=1
                game['players'][uid]=row
    names={}
    for uid,value in history.get('names',{}).items():
        hashed=identity(uid)
        if hashed is not None and (hashed not in names or value['at']>=names[hashed]['at']):names[hashed]=value
    playable=[];historical=0;recent=0
    for gid,game in games.items():
        rows=list(game['players'].values())
        if len(rows)<2:continue
        if len(rows)>8:raise ValueError('Too many distinct participants after identity merge')
        for row in rows:
            if not row['name'] and row['uid'] in names:row['name']=names[row['uid']]['name']
        game['players']=rows;playable.append(game)
        historical+=int(gid in old_ids);recent+=int(gid in new_ids)
    source={'schema':1,'readOnly':True,'upstreamRequests':0,'identityMode':'hmac16','generatedAt':live['generatedAt'],
        'games':playable,'preCheckpointHistoricalIds':list(early_old),'scope':'Original checkpoint + recovered self-record history + confirmed new replay identities; incomplete observed coverage.'}
    result=build({'last':seed['last'],'players':canonical,'identityMode':'hmac16'},source,copy_seed=False)
    result['players'],canonical_result={},result['players'];unknown={}
    for hashed,profile in canonical_result.items():
        raw=aliases.get(hashed)
        if raw is None:unknown[hashed]=profile
        else:result['players'][raw]=profile
    result['hashedPlayers']=unknown
    result['meta'].update(historyMerged=True,historyRevision=history.get('revision'),historicalGames=historical,
        newSourceGames=recent,overlappingGames=len(old_ids & new_ids),duplicatePlayerRows=duplicates,preCheckpointNewGames=excluded,preCheckpointHistoricalGames=len(early_old),
        knownRawPlayers=len(result['players']),privateHashedPlayers=len(unknown),identityMode='raw24-with-private-hmac-remainder')
    return result


def current_profile(data,uid,key):
    row=data['players'].get(uid)
    if row is None and key is not None and data['meta'].get('historyMerged'):
        row=data.get('hashedPlayers',{}).get(pseudonym(uid,key))
    return row
