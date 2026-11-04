"""One-time public Parquet recovery after a verified original model checkpoint.

Run with pyarrow on an import machine. The live service needs only the emitted JSON.
No game requests, authentication tickets or private UID key are used here.
"""
import argparse
import json
import os
import pathlib
import re
import urllib.request

REPO='www1234567890/Yi_Xian_Replay_Compressed'


def recover(info,revision,cache,download=None):
    import pyarrow.parquet as pq
    cache=pathlib.Path(cache)/revision;cache.mkdir(parents=True,exist_ok=True)
    def fetch(path):
        local=cache/path
        if not local.exists():
            local.parent.mkdir(parents=True,exist_ok=True);temporary=local.with_suffix(local.suffix+'.next')
            url='https://huggingface.co/datasets/'+REPO+'/resolve/'+revision+'/'+path
            if download:download(path,temporary)
            else:urllib.request.urlretrieve(url,temporary)
            os.replace(temporary,local)
        return local
    with urllib.request.urlopen('https://huggingface.co/api/datasets/'+REPO+'/tree/'+revision+'/manifest?limit=1000',timeout=30) as response:
        chunks=sorted(int(row['path'][10:-5]) for row in json.load(response) if re.fullmatch('manifest/c[0-9]+.json',row['path']))
    done={str(s) for s in info['done']};ordered=sorted(int(s) for s in done)
    if any(b-a!=1000 for a,b in zip(ordered,ordered[1:])):raise ValueError('Checkpoint has holes; a full manifest scan is required')
    games={};names={};used=[];duplicates=0
    for chunk in chunks:
        if chunk<ordered[-1]//50000:continue
        manifest=json.loads(fetch('manifest/c'+str(chunk)+'.json').read_text())
        todo=set(manifest['shards'])-done
        if not todo:continue
        suffix='c'+str(chunk)+'.parquet';used.append(chunk)
        headers={row['game_id']:row for row in pq.read_table(fetch('games/'+suffix),columns=['game_id','season','is_daoxin','begin_ts','end_ts','src_shard']).to_pylist() if str(row['src_shard']) in todo}
        for row in pq.read_table(fetch('players/'+suffix),columns=['game_id','uid','is_ai','battle_rank','end_ts','has_self_record']).to_pylist():
            header=headers.get(row['game_id']);uid=str(row['uid'] or '')
            if not header or not row['has_self_record'] or row['is_ai'] or uid.startswith(('ai','record-player-')):continue
            if not re.fullmatch('[0-9a-f]{16}|[0-9a-f]{24}',uid) or type(row['battle_rank']) is not int or not 0<=row['battle_rank']<=7:continue
            gid=header['game_id']
            if not re.fullmatch('[0-9a-f]{24}',gid):raise ValueError('Invalid historical game identity')
            season=header['season'];mode='daoxin' if header['is_daoxin'] else 'ladder'
            game=games.setdefault(gid,{'id':gid,'at':0,'season':season,'begin':header['begin_ts'],'players':{}})
            if game['season']!=season:raise ValueError('Conflicting historical season')
            game['at']=max(game['at'],header['end_ts'] or 0,row['end_ts'] or 0)
            player={'uid':uid,'place':row['battle_rank']+1,'mode':mode,'name':''}
            if uid in game['players']:
                if game['players'][uid]!=player:raise ValueError('Conflicting historical participant')
                duplicates+=1
            game['players'][uid]=player
        try:
            entries=pq.read_table(fetch('names/'+suffix),columns=['uid','username','last_ts','src_shard']).to_pylist()
        except urllib.error.HTTPError as error:
            if error.code!=404:raise
            entries=[]
        for row in entries:
            uid=str(row['uid'] or '')
            if str(row['src_shard']) not in todo or not re.fullmatch('[0-9a-f]{16}|[0-9a-f]{24}',uid):continue
            at=row['last_ts'] or 0
            if uid not in names or at>=names[uid]['at']:names[uid]={'name':row['username'] or '', 'at':at}
        print(json.dumps({'phase':'historical-chunk','chunk':chunk,'candidateGames':len(games)}),flush=True)
    result=[]
    for game in games.values():
        if game['at']<=0:continue
        game['players']=list(game['players'].values());result.append(game)
    return {'schema':1,'readOnly':True,'upstreamRequests':0,'seedLast':info['last'],'seedParams':info['params'],'checkpointDisjoint':True,
        'dataset':REPO,'revision':revision,'chunks':used,'games':result,'names':names,
        'duplicateRows':duplicates,'beforeSeed':sum(g['at']<=info['last'] for g in result)}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--seed-info',required=True);parser.add_argument('--revision',required=True);parser.add_argument('--cache',required=True);parser.add_argument('--out',required=True);args=parser.parse_args()
    info=json.loads(pathlib.Path(args.seed_info).read_text(encoding='utf-8'))
    result=recover(info,args.revision,args.cache)
    target=pathlib.Path(args.out);temporary=target.with_suffix('.next');temporary.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8');os.replace(temporary,target)
    print(json.dumps({'historicalGames':len(result['games']),'beforeSeed':result['beforeSeed'],'duplicateRows':result['duplicateRows'],'chunks':result['chunks']}))
