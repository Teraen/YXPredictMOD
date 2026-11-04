"""Apply only public delayed snapshots/commands at their native playback time."""
import copy,json,hashlib,time
from public_snapshot import decode_delayed_identity,public_commands,public_status,public_battles

class PublicProjection:
    def __init__(self,roster,clock=time.monotonic):
        self.roster=roster;self.clock=clock;self.expected={p['userInfo']['uid'] for p in roster};self.game_id=None;self.begin=0
        self.round=0;self.timer=0;self.timer_at=clock();self.ended=False;self.players={};self.closed_through=0;self.round_complete=False;self.complete_rounds=set()
        self.anchor=None;self.anchor_at=0;self.index=None;self.pending={};self.seen={};self.applied=set();self.battles={};self.revision=0
    def validate_players(self,players,allow_mirrors=False):
        observed={p['uid']for p in players};mirrors=sum(bool(p.get('isMirror'))for p in players)
        if len(players)!=8 or observed!=self.expected or mirrors and not allow_mirrors:raise ValueError('Public roster mismatch (players=%d, missing=%d, foreign=%d, mirrors=%d)'%(len(players),len(self.expected-observed),len(observed-self.expected),mirrors))
    def accept_ordinary(self,encoded):
        # Ordinary GameStatus retains all original UIDs even when a player is
        # marked as this round's mirror opponent. Battle-result mirror copies
        # remain excluded from overwriting the original player's state below.
        status=public_status(encoded);self.validate_players(status['players'],allow_mirrors=True)
        if status['round']<1 or status['codeId']<=0 or status['beginTs']<=0:return False
        identity='code:'+str(status['codeId'])
        if self.game_id is not None and (self.game_id!=identity or self.begin!=status['beginTs']):raise ValueError('Public game identity changed')
        if status['round']<self.round:return False
        self.game_id=identity;self.begin=status['beginTs'];self.round=status['round'];self.timer=status['timer'];self.timer_at=self.clock();self.ended|=status['isEnded']
        self.players={p['uid']:copy.deepcopy(p) for p in status['players']};self.closed_through=max(self.closed_through,self.round-1)
        if self.timer<=0:self.closed_through=max(self.closed_through,self.round)
        self.round_complete=self.ended or self.timer>0 and self.closed_through<self.round or self.round in self.complete_rounds;self.revision+=1;return True
    def ordinary_event(self,message):
        battles=public_battles(message['type'],message['data'])
        for battle in battles:
            a,z=battle['first'],battle['second']
            if a['uid']not in self.expected or z['uid']not in self.expected:raise ValueError('Foreign ordinary public battle')
            key=(battle['round'],a['uid'],z['uid'],a['isMirror'],z['isMirror']);value=copy.deepcopy(battle);value['resultComplete']=message['type']=='AllBattleResults'or bool(battle['winner'])
            if not self.battles.get(key,{}).get('resultComplete')or value['resultComplete']:self.battles[key]=value
            self.closed_through=max(self.closed_through,battle['round'])
            # GameStatus is the authoritative eight-player state. A focused
            # BattleResult may still contain pre-settlement player/rank data;
            # mixing it into that state creates inconsistent elimination rounds.
        if message['type']=='AllBattleResults':self.complete_rounds.update(b['round']for b in battles)
        self.round_complete=self.ended or self.timer>0 and self.closed_through<self.round or self.round in self.complete_rounds;self.revision+=1
    def accept(self,encoded):
        decoded=decode_delayed_identity(encoded);snapshot=decoded['snapshot']
        if decoded['codeId']<=0 or decoded['beginTs']<=0:return False
        identity='code:'+str(decoded['codeId'])
        if self.game_id is not None and (self.game_id!=identity or self.begin!=decoded['beginTs']):raise ValueError('Spectator game identity changed')
        if not decoded['publicRosterComplete']:return False
        self.validate_players(snapshot['players'])
        if snapshot['round']<self.round and (self.index is None or (snapshot['round'],snapshot['index'])!=self.index):return False
        if self.index and snapshot['round']==self.index[0] and snapshot['index']<self.index[1]:return False
        self.game_id=identity;self.begin=decoded['beginTs']
        index=(snapshot['round'],snapshot['index'])
        if self.index!=index:
            self.index=index;self.anchor=snapshot['timestamp'];self.anchor_at=self.clock();self.round=snapshot['round'];self.timer=snapshot['timer'];self.timer_at=self.clock()
            self.players={p['uid']:copy.deepcopy(p) for p in snapshot['players']};self.closed_through=max(self.closed_through,self.round-1)
            self.round_complete=self.ended or self.timer>0 and self.closed_through<self.round or self.round in self.complete_rounds;self.revision+=1
        self.ended|=decoded['isEnded']
        for row in public_commands(encoded):
            key=(row['index'],row['timestamp'],row['type'],row['target']);fingerprint=hashlib.sha256(json.dumps(row,sort_keys=True).encode()).hexdigest()
            if key in self.seen and self.seen[key]!=fingerprint:raise ValueError('Conflicting public command')
            self.seen[key]=fingerprint
            if key not in self.pending and key not in self.applied:self.pending[key]=row
        if len(self.pending)>4000 or len(self.seen)>100000:raise ValueError('Spectator command budget exceeded')
        self.tick()
        return True
    def tick(self):
        if self.anchor is None:return
        public_time=self.anchor+int((self.clock()-self.anchor_at)*1000)
        for key,row in sorted(list(self.pending.items()),key=lambda item:(item[1]['timestamp'],item[1]['index'])):
            if row['timestamp']>public_time:continue
            del self.pending[key]
            if key in self.applied:continue
            self.applied.add(key)
            if row['type']=='GameStatus':
                status=row['public'];self.validate_players(status['players'])
                if status['codeId'] not in (0,int(self.game_id[5:])) or status['beginTs'] not in (0,self.begin):raise ValueError('Foreign public status')
                if status['round']<self.round:continue
                self.round=status['round'];self.timer=status['timer'];self.timer_at=self.clock()-max(0,(public_time-row['timestamp'])/1000);self.ended|=status['isEnded'];self.players={p['uid']:copy.deepcopy(p) for p in status['players']}
                self.closed_through=max(self.closed_through,self.round-1)
                if self.timer<=0:self.closed_through=max(self.closed_through,self.round)
                self.round_complete=self.ended or self.timer>0 and self.closed_through<self.round or self.round in self.complete_rounds
            else:
                for battle in row['public']:
                    a,z=battle['first'],battle['second']
                    if a['uid'] not in self.expected or z['uid'] not in self.expected:raise ValueError('Foreign public battle players')
                    bid=(battle['round'],a['uid'],z['uid'],a['isMirror'],z['isMirror'])
                    self.battles[bid]=copy.deepcopy(battle);self.closed_through=max(self.closed_through,battle['round'])
                    for p in (a,z):
                        if not p['isMirror'] and battle['round']>=self.round:self.players[p['uid']]=copy.deepcopy(p)
                if row['type']=='AllBattleResults':self.complete_rounds.update(b['round']for b in row['public'])
                self.round_complete=self.ended or self.timer>0 and self.closed_through<self.round or self.round in self.complete_rounds
            self.revision+=1
    def remaining_timer(self):return max(0,self.timer-(self.clock()-self.timer_at))
    def request_round(self):
        self.tick()
        if self.index is None:return -1
        source_round=self.index[0]
        if self.pending:return source_round
        if self.round>source_round:return self.round
        return source_round+1 if self.remaining_timer()<=0 and self.closed_through>=source_round else source_round
    def public_state(self):
        self.tick();result=[]
        final_ready=self.ended and sorted(p['rank']+1 for p in self.players.values())==list(range(1,9))
        for row in self.roster:
            p=self.players[row['userInfo']['uid']];rank=p['rank']+1 if p['life']<=0 or final_ready else 0
            result.append({'life':p['life'],'wins':p['wins'],'losses':p['losses'],'rank':rank})
        return result
