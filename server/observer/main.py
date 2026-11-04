"""One dedicated account, one public hourly match, no player/private actions."""
import argparse,hashlib,json,logging,math,pathlib,signal,time
import requests
from public_lobby import PublicLobby,LobbyError,read_token,room_filter
from projection import PublicProjection
from transport import Spectator,public_mode,SnapshotPending
from quotes import champion_rates,sources,titles
from build_catalog import BuildCatalog
from rank_info import lobby_ranks

LOG=logging.getLogger('duma-observer')
STOP=False
def stop(*_):
    global STOP
    STOP=True

def eligible(info,minimum_rank_score=6000,exclusive=False):
    score=info.get('avgRankScore')
    return info.get('name')=='game_room' and info.get('status')==2 and info.get('isPrivate')is False and info.get('playerCount')==8 and type(info.get('round'))is int and 1<=info['round']<=2 and type(score)is int and (score>minimum_rank_score if exclusive else score>=minimum_rank_score)

def select_candidate(rooms,minimum_rank_score=6000,exclusive=False):
    by_id={}
    for r in rooms:
        identifier=r.get('roomId')
        if not isinstance(identifier,str)or not identifier:continue
        old=by_id.get(identifier)
        if old is None or r.get('round',0)>old.get('round',0):by_id[identifier]=r
    candidates=[r for r in by_id.values()if eligible(r,minimum_rank_score,exclusive)]
    return min(candidates,key=lambda r:(-r['avgRankScore'],-r.get('createdTs',0),r['roomId']))if candidates else None

def find_candidate(reader,backend):
    rooms=[]
    for game_mode in (0,3):
        listed,_=reader.list_rooms(game_mode,max_pages=4);rooms.extend(listed)
    # The backend clock owns the phase, including scans crossing :05 or the
    # next hour. Never lower the limit from the observer's local clock.
    search=backend.call('status')
    if not search['available']or search['opened']:LOG.info('Hourly selection is no longer available');return None
    minimum=search.get('minimumRankScore',6000);exclusive=search.get('minimumRankScoreExclusive',False)
    info=select_candidate(rooms,minimum,exclusive)
    if info is None:
        starts=[r for r in rooms if eligible(r,0)]
        LOG.info('No eligible newly started public match (phase=%s, minimum%s%d, scanned=%d, publicStarts=%d, highestStartAverage=%s)',search.get('searchPhase','priority'),'>'if exclusive else'>=',minimum,len(rooms),len(starts),max((r['avgRankScore']for r in starts),default=None))
    return info

class Backend:
    def __init__(self,url,key):self.url=url.rstrip('/');self.key=key;self.http=requests.Session()
    def call(self,action,timeout=(2,5),**body):
        r=self.http.post(self.url+'/ops/hourly',json={'action':action,**body},headers={'Authorization':'Bearer '+self.key},timeout=timeout,allow_redirects=False)
        if not r.ok:
            try:reason=r.json().get('error','')
            except ValueError:reason=''
            reason=reason if isinstance(reason,str)and len(reason)<=160 and not any(ord(c)<32 for c in reason)else ''
            raise SyncError(r.status_code,reason or '后台未确认同步')
        data=r.json()
        if data.get('ok')is not True:raise LobbyError('Prediction service did not confirm '+action)
        return data['data']

class SyncError(LobbyError):
    def __init__(self,status,reason):self.status=status;self.reason=reason;super().__init__('Prediction service rejected sync ('+str(status)+'): '+reason)

DISPLAY_ERRORS={'公开牌桌或战果格式无效','同轮公开牌桌冲突','同轮公开战果冲突','公开角色或仙命资料格式无效','需要完整八人角色资料'}
def upload_snapshot(backend,action,snapshot,**body):
    try:return backend.call(action,snapshot=snapshot,**body)
    except SyncError as error:
        if error.status!=400 or error.reason not in DISPLAY_ERRORS:raise
        # Rendering annotations cannot block an otherwise valid native status.
        # The backend still validates all game IDs, ranks, closure and accounting.
        core=dict(snapshot);core.pop('builds',None);core.pop('battles',None)
        LOG.warning('Public annotations withheld (%s); retrying verified game status',error.reason)
        return backend.call(action,snapshot=core,**body)

def source_state(backend,code,game_id,state,round_number):
    if not code or not game_id:return
    try:backend.call('source',code=code,gameId=game_id,state=state,round=max(1,round_number),timeout=(1,2))
    except (LobbyError,requests.RequestException):pass

def push_frame(backend,code,snapshot,info,model):
    try:
        return upload_snapshot(backend,'sync',snapshot,code=code)if code else upload_snapshot(backend,'open',snapshot,info=info,model=model)
    except (SyncError,requests.RequestException)as error:
        # A betting backend failure is not a game websocket disconnection.
        # Keep the current observer and wait for a fresh authoritative status.
        LOG.warning('Sync pending in existing spectator session (%s)',str(error)if isinstance(error,SyncError)else type(error).__name__)
        source_state(backend,code,snapshot['id'],'verifying',snapshot.get('liveRound',snapshot['round']))
        return None

def ratings_for(roster):
    uids=[p['userInfo']['uid'] for p in roster if not p['isAI']]
    if uids:
        r=requests.get('https://elo.kaigua.vip/api/v1/ratings',params=[('uid',uid)for uid in uids],timeout=12,allow_redirects=False)
        r.raise_for_status();data=r.json()
        if not isinstance(data,dict)or set(data)-set(uids):raise LobbyError('Invalid private quote input')
    else:data={}
    result=[]
    for p in roster:
        uid=p['userInfo']['uid'];row=data.get(uid)
        if row is None:result.append({'uid':uid,'score':3000,'found':False});continue
        score=row.get('rating');sigma=row.get('sigma')
        if type(score)not in (int,float)or not math.isfinite(score)or not 0<=score<=10000 or type(sigma)not in (int,float)or not math.isfinite(sigma)or not 0<=sigma<=2000:raise LobbyError('Invalid private quote input')
        result.append({'uid':uid,'score':score,'found':True})
    return result

class SnapshotBuilder:
    def __init__(self,info,roster,model,card_names=None,build_catalog=None):
        self.info=info;self.roster=roster;self.players=[{'uid':p['userInfo']['uid'],'name':p['userInfo']['username'],'isAI':p['isAI']}for p in roster]
        by_uid={p['uid']:p for p in model}
        if len(by_uid)!=8 or set(by_uid)!={p['uid']for p in self.players}:raise LobbyError('Frozen quote model disagrees with public roster')
        self.ratings=[by_uid[p['uid']]for p in self.players];self.card_names=card_names or {};self.last_rates=[0]*64;self.game_id=None
        self.build_catalog=BuildCatalog(build_catalog)
    def build(self,p,live_round):
        states=p.public_state();game_id=p.game_id
        if not game_id or len(states)!=8:raise LobbyError('Public snapshot is not ready')
        if self.game_id not in (None,game_id):raise LobbyError('Frozen model cannot move to another game')
        self.game_id=game_id
        allocated=sources(game_id,self.players);ratings=[self.ratings[i]for i in allocated]
        quote_ready=True
        try:self.last_rates=champion_rates(ratings,states,p.round)
        except ValueError:
            # Missing final ranks never creates a quote or a fabricated result.
            quote_ready=False
        battles=[]
        life_before=lambda q:((q.get('lastRound')or{}).get('life')or None)
        for battle in p.battles.values():
            if not max(1,p.round-1)<=battle['round']<=p.round:continue
            a,z=battle['first'],battle['second'];cards=lambda q:(q.get('lastRound')or {}).get('usedCards')
            first,second=cards(a),cards(z)
            names=lambda ids:None if ids is None else [self.card_names.get(str(i),'未知牌' if i else '空位')for i in ids]
            battles.append({'round':battle['round'],'first':a['uid'],'second':z['uid'],'winner':battle['winner'],
                'firstMirror':a['isMirror'],'secondMirror':z['isMirror'],'firstCards':first,'secondCards':second,
                'firstNames':names(first),'secondNames':names(second),'firstLife':a['life'],'secondLife':z['life'],'lifeDamage':battle['lifeDamage'],'resultComplete':battle.get('resultComplete',bool(battle['winner'])),
                'firstLifeBefore':life_before(a),'secondLifeBefore':life_before(z)})
        if len(battles)>16:raise LobbyError('Public battle budget exceeded')
        elimination=[min(p.round,s['wins']+s['losses'])if s['life']<=0 else 0 for s in states]
        complete=p.ended or p.round_complete
        phase='ended'if p.ended else'verifying'if not quote_ready else'preparation'if complete and p.remaining_timer()>0 and p.closed_through<p.round else'battle'
        return {'id':game_id,'gameRoomId':self.info['roomId'],'round':p.round,'liveRound':max(p.round,live_round),'sourcePhase':phase,
            'closedThrough':p.closed_through,'open':quote_ready and not p.ended and complete and p.remaining_timer()>0 and p.closed_through<p.round and live_round<10,
            'ended':p.ended,'players':[{k:v for k,v in player.items()if k!='isAI'}for player in self.players],
            'states':[{k:v for k,v in s.items()if k!='rank'}for s in states],'ranks':[s['rank']for s in states],
            'active':[s['life']>0 for s in states],'baseRates':self.last_rates,'horseShuffle':True,
            'horseTitles':titles(game_id,self.players,self.ratings),'eliminationRounds':elimination,'roundComplete':complete,'battles':battles,
            'builds':[self.build_catalog.project(p.players[player['uid']],p.round,self.card_names)for player in self.players]}

def refresh_info(reader,info):
    cursor=info.get('createdTs')
    if type(cursor)is not int:raise LobbyError('Missing public room cursor')
    rows=reader._http('POST',reader.game_endpoint+'/game/fetchRooms',headers=reader._headers(),json=room_filter(info.get('gameMode',0),cursor+1),_attempts=1,_timeout=(1.5,2))
    if not isinstance(rows,list):raise LobbyError('Invalid public room refresh')
    row=next((r for r in rows if r.get('roomId')==info['roomId']),None)
    if row is None:return None
    if row.get('isPrivate')is not False or row.get('playerCount')!=8 or row.get('name')!='game_room':raise LobbyError('Room is no longer a public eight-player game')
    return row

def public_focus_targets(projection):
    # Ordinary native portraits cannot switch to an eliminated player. Stay on
    # the lowest-life live player once the previous public tables are covered,
    # so its next pushed result is captured even if that battle eliminates it.
    alive=[];missing=[]
    for entry in projection.roster:
        uid=entry['userInfo']['uid'];player=projection.players[uid]
        if player['life']<=0:continue
        alive.append(uid);completed=player['wins']+player['losses']
        observed=max((b['round']for b in projection.battles.values()if b.get('resultComplete',bool(b.get('winner')))and any(b[side]['uid']==uid and not b[side]['isMirror']and(b[side].get('lastRound')or{}).get('usedCards')is not None for side in ('first','second'))),default=0)
        if completed>observed:missing.append(uid)
    return missing or sorted(alive,key=lambda uid:projection.players[uid]['life'])[:1]

def collect_public_battles(spectator,projection):
    # Sweep missing live portraits together, rather than waiting for an entire
    # status/upload/sleep cycle between each of up to eight players.
    for target in public_focus_targets(projection):
        if STOP:break
        if target not in public_focus_targets(projection):continue
        result=spectator.focus_public(target,projection.expected,timeout=.6)
        if result:projection.ordinary_event({'type':'BattleResult','data':result})
        for event in spectator.events:projection.ordinary_event(event)
        spectator.events.clear()


def observe(config,backend,status):
    import fcntl
    reader=PublicLobby(config['tokenCache'],gap=1.4,timeout=12);spectator=None;lock=None
    active=status['active'];code=active['code']if active else None;game_id=active['gameId']if active else None;live_round=1;finished=False
    _,uid=read_token(reader.token_cache)
    lockpath=pathlib.Path(config['lockDirectory'])/('public-observer-'+hashlib.sha256(uid.encode()).hexdigest()[:20]+'.lock')
    # Shared with the existing short-code collector; never displace its session.
    lock=lockpath.open('r');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    try:
        info=active['info']if active else None
        if info is None:
            info=find_candidate(reader,backend)
            if info is None:return
        else:reader.public_ids.add(info['roomId'])
        roster=reader.roster(info['roomId'])['players']
        if len(roster)!=8 or len({p['userInfo']['uid']for p in roster})!=8 or any(p['identityKind']=='unknown'for p in roster)or uid in {p['userInfo']['uid']for p in roster}:raise LobbyError('Public eight-player roster unavailable')
        model=active['model']if active else ratings_for(roster)
        if not model:raise LobbyError('Frozen quote model is missing; operator review required')
        card_names=json.loads(pathlib.Path(config['cardNames']).read_text(encoding='utf8'))if config.get('cardNames')else {}
        build_catalog=json.loads(pathlib.Path(config['buildCatalog']).read_text(encoding='utf8'))if config.get('buildCatalog')else {}
        builder=SnapshotBuilder(info,roster,model,card_names,build_catalog);projection=PublicProjection(roster)
        mode=public_mode(reader);spectator=Spectator(reader,info,mode);spectator.join()
        if not active:
            try:native_ranks=spectator.ranks({p['userInfo']['uid']for p in roster})
            except ValueError:
                native_ranks=None;LOG.warning('Native public match scores did not match the verified roster; using public lobby ladder scores')
            info={**info,'nativeRanks':native_ranks if native_ranks is not None else lobby_ranks(roster)}
        code=active['code']if active else None;live_round=info['round'];last_meta=0;meta_ready=False;started=time.monotonic();last_status=started;settled_at=None
        LOG.info('Public spectator connected (%s; %s)',mode,'recovering'if code else'candidate')
        while not STOP:
            if time.monotonic()-last_meta>=4:
                try:meta=refresh_info(reader,info)
                except (LobbyError,requests.RequestException)as error:meta=None;LOG.warning('Public lobby refresh pending; keeping spectator (%s)',type(error).__name__)
                last_meta=time.monotonic()
                meta_ready=meta is not None
                if meta:live_round=max(live_round,meta['round'])
                elif not code:raise LobbyError('Candidate is no longer listed')
            try:raw=spectator.read(projection.request_round()if mode=='delayed'else -1,timeout=4)
            except SnapshotPending:
                source_state(backend,code,game_id,'verifying',live_round)
                if time.monotonic()-last_status>45:raise LobbyError('Public spectator state unavailable for 45 seconds; reconnecting')
                time.sleep(1);continue
            last_status=time.monotonic()
            ready=projection.accept(raw)if mode=='delayed'else projection.accept_ordinary(raw)
            for event in spectator.events:projection.ordinary_event(event)
            spectator.events.clear();projection.tick()
            if not ready and not projection.game_id:
                if time.monotonic()-started>90:raise LobbyError('Waiting for public spectator data exceeded budget')
                time.sleep(2);continue
            snapshot=builder.build(projection,live_round)
            if not meta_ready:snapshot['open']=False;snapshot['sourcePhase']='waiting-lobby'
            if active and snapshot['id']!=active['gameId']:raise LobbyError('Recovered game identity disagrees')
            game_id=snapshot['id']
            if code is None:
                # Fresh metadata + observed round must both still satisfy opening rules.
                if live_round>2 or projection.round>2:LOG.info('Candidate passed opening window');return
            view=push_frame(backend,code,snapshot,info,model)
            if view is not None:
                if code is None:code=view['code'];LOG.info('Hourly market opened')
                if view.get('settled'):
                    if view.get('reportReady'):finished=True;LOG.info('Hourly market and complete public report settled');return
                    if settled_at is None:settled_at=time.monotonic()
                    if time.monotonic()-settled_at>120:finished=True;LOG.warning('Wallet settled; incomplete public report remains queued');return
            # Upload the authoritative frame before optional portrait/board reads.
            if mode=='ordinary'and ready:
                collect_public_battles(spectator,projection)
            if time.monotonic()-started>3*3600:raise LobbyError('Public match watch budget exceeded; positions retained')
            time.sleep(2)
    finally:
        try:
            if code and not finished:source_state(backend,code,game_id,'reconnecting',max(1,live_round))
            if spectator:spectator.close()
            else:reader.close()
        finally:
            if lock:lock.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--once',action='store_true');args=parser.parse_args()
    config=json.loads(pathlib.Path(args.config).read_text(encoding='utf8'));backend=Backend(config['backend'],config['key'])
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    while not STOP:
        try:
            status=backend.call('status')
            if status['active']or status['available']and not status['opened']:observe(config,backend,status)
        except BlockingIOError:LOG.warning('Dedicated spectator account is busy; preserving existing session')
        except Exception as error:LOG.warning('Observation paused (%s); positions retained',str(error)if isinstance(error,(LobbyError,ValueError))else type(error).__name__)
        if args.once:break
        for _ in range(15):
            if STOP:break
            time.sleep(1)

if __name__=='__main__':main()
