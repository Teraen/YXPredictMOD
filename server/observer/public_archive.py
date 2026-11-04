"""Recover public battle annotations from confirmed game records, never accounting."""
import contextlib,json,os,pathlib,re,sqlite3,subprocess,sys,zlib

class ArchivePending(ValueError):pass

def public_record(raw,code):
    if raw.get('codeId')!=code or not isinstance(raw.get('gameId'),str)or not raw['gameId']or raw.get('endTs',0)<=raw.get('beginTs',0):raise ArchivePending('Archive identity unavailable')
    result={k:raw[k]for k in ('codeId','gameId','beginTs','endTs')};result['roundStats']=[]
    if len(raw.get('roundStats',[]))>256:raise ArchivePending('Archive round budget exceeded')
    for b in raw.get('roundStats',[]):
        item={k:b[k]for k in ('round','winerId','lifeDamage')}
        for side in ('p1','p2'):
            p=b[side]['publicData'];previous=p.get('lastRoundData')
            if previous is None:raise ArchivePending('Public board unavailable')
            item[side]={'publicData':{k:p[k]for k in ('uid','characterId','life','isMirror')}}
            item[side]['publicData']['lastRoundData']={k:previous[k]for k in ('life','usedCards')}
        result['roundStats'].append(item)
    return result

def records_for(config,target):
    if not re.fullmatch(r'code:[0-9]{1,18}',target['gameId']):raise ArchivePending('Unknown game identity')
    code=int(target['gameId'][5:]);folder=pathlib.Path(config['archiveCache']);folder.mkdir(parents=True,exist_ok=True)
    records={}
    def save(index,record):
        path=folder/(str(code)+'-'+str(index)+'.json');temporary=path.with_suffix('.next')
        temporary.write_text(json.dumps(record,separators=(',',':')),encoding='utf8');temporary.chmod(0o600);temporary.replace(path)
    for index in range(8):
        path=folder/(str(code)+'-'+str(index)+'.json')
        if path.exists():records[index]=public_record(json.loads(path.read_text(encoding='utf8')),code)
    database=config.get('replayStore')
    if database and pathlib.Path(database).is_file():
        with contextlib.closing(sqlite3.connect('file:'+str(pathlib.Path(database).resolve())+'?mode=ro',uri=True,timeout=3))as db:
            db.execute('PRAGMA query_only=ON')
            for index,packed in db.execute('SELECT view_index,payload FROM link_replays WHERE code_id=?',(code,)):
                if index in records:continue
                unpacker=zlib.decompressobj();raw=unpacker.decompress(packed,16*1024*1024)
                if not unpacker.eof:raise ArchivePending('Archive size budget exceeded')
                records[index]=public_record(json.loads(raw),code)
    for index,record in records.items():save(index,record)
    if len(records)<8 and config.get('archiveBridge'):
        # The existing replay application has modules with the same names as
        # this observer. Import it in a fresh process, never in our module table.
        for index in [i for i in range(8)if i not in records][:4]:
            response=subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('archive_bridge.py'))],
                input=json.dumps({'bridge':config['archiveBridge'],'code':code,'index':index}),capture_output=True,text=True,timeout=35,
                env={**os.environ,'YX_IDENTITY_CAPTURE_REPLAYS':'0'})
            if response.returncode or len(response.stdout)>4*1024*1024:raise ArchivePending('Public record bridge unavailable')
            raw=json.loads(response.stdout)
            if raw is not None:records[index]=public_record(raw,code);save(index,records[index])
    if len(records)!=8:raise ArchivePending('Waiting for complete public records')
    return list(records.values())

def recover_battles(target,records,names):
    if not re.fullmatch(r'code:[0-9]{1,18}',target['gameId']):raise ArchivePending('Unknown game identity')
    wanted=target.get('recoveryRounds',list(range(max(1,target['round']-1),target['round']+1)))
    if not isinstance(wanted,list)or not 1<=len(wanted)<=2 or any(type(r)is not int or not 1<=r<=target['round']for r in wanted):raise ArchivePending('Invalid recovery rounds')
    code=int(target['gameId'][5:]);players=target['players'];expected={p['uid']for p in players}
    if len(players)!=8 or len(expected)!=8 or len(records)!=8:raise ArchivePending('Eight-player evidence required')
    if any(r['codeId']!=code for r in records)or len({(r['gameId'],r['beginTs'])for r in records})!=1:raise ArchivePending('Conflicting game records')
    observed={}
    for record in records:
        for b in record['roundStats']:
            if type(b['round'])is not int or not 1<=b['round']<=target['round']:raise ArchivePending('Foreign public round')
            for side in ('p1','p2'):
                p=b[side]['publicData'];cards=p['lastRoundData']['usedCards']
                if type(p['isMirror'])is not bool or not isinstance(cards,list)or len(cards)>8 or any(type(i)is not int or not 0<=i<=2147483647 for i in cards):raise ArchivePending('Invalid public board')
                if p['isMirror']:continue
                value=(p['characterId'],tuple(cards));old=observed.setdefault(p['uid'],{}).setdefault(b['round'],value)
                if old!=value:raise ArchivePending('Conflicting public boards')
    if len(observed)!=8:raise ArchivePending('Missing public identities')
    candidates={}
    for alias,history in observed.items():
        if alias not in expected and not re.fullmatch(r'record-player-[1-8]',alias):raise ArchivePending('Unknown record identity')
        choices=[]
        for player in players:
            if alias in expected and alias!=player['uid']:continue
            if alias not in expected and not player['minimum']<=int(alias[-1])<=player['maximum']:continue
            overlap=[h for h in player['history']if h['round']in history]
            if len({h['round']for h in overlap})<2 or not any(any(h['cards'])for h in overlap):continue
            if all((h['characterId'],tuple(h['cards']))==history[h['round']]for h in overlap):choices.append(player['uid'])
        candidates[alias]=choices
    solutions=[];order=sorted(candidates,key=lambda a:len(candidates[a]))
    def solve(at,mapping,used):
        if len(solutions)>1:return
        if at==len(order):solutions.append(dict(mapping));return
        alias=order[at]
        for uid in candidates[alias]:
            if uid in used:continue
            mapping[alias]=uid;solve(at+1,mapping,used|{uid});del mapping[alias]
    solve(0,{},set())
    if len(solutions)!=1:raise ArchivePending('Public identity evidence is not unique')
    mapping=solutions[0];indices={p['uid']:i for i,p in enumerate(players)};battles={}
    for record in records:
        for raw in record['roundStats']:
            if raw['round']not in wanted:continue
            a,z=raw['p1']['publicData'],raw['p2']['publicData'];winner=raw['winerId']
            if a['uid']not in mapping or z['uid']not in mapping or winner not in ('',a['uid'],z['uid']):raise ArchivePending('Unknown public winner')
            b={'round':raw['round'],'first':mapping[a['uid']],'second':mapping[z['uid']],'firstMirror':a['isMirror'],'secondMirror':z['isMirror'],'winner':mapping[winner]if winner else'','lifeDamage':raw['lifeDamage'],'resultComplete':True}
            for side,p in (('first',a),('second',z)):
                cards=p['lastRoundData']['usedCards'];b[side+'Cards']=cards;b[side+'Names']=[names.get(str(i),'未知牌'if i else'空位')for i in cards];b[side+'Life']=p['life'];b[side+'LifeBefore']=p['lastRoundData']['life']
            if indices[b['first']]>indices[b['second']]or b['first']==b['second']and b['firstMirror']and not b['secondMirror']:
                for suffix in ('','Mirror','Cards','Names','Life','LifeBefore'):b['first'+suffix],b['second'+suffix]=b['second'+suffix],b['first'+suffix]
                b['lifeDamage']=-b['lifeDamage']
            key=(b['round'],b['first'],b['second'],b['firstMirror'],b['secondMirror']);old=battles.get(key)
            if old and any(old[k]!=b[k]for k in ('winner','firstCards','secondCards','lifeDamage')):raise ArchivePending('Conflicting public result')
            battles[key]=b
    if not battles or len(battles)>16:raise ArchivePending('Public battle budget exceeded')
    return list(battles.values())
