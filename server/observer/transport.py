"""A single ordinary public spectator session; no realtime/judge/player actions."""
import base64,time,re,urllib.parse
import msgpack,websocket
from public_lobby import read_token,LobbyError

class SnapshotPending(LobbyError):pass

def delayed_request(round_number=-1):
    from public_lobby_wire import varint
    if type(round_number)is not int or round_number<-1 or round_number>100000:raise ValueError('Invalid public round')
    return base64.b64encode(b'\x08'+varint(43)+b'\x10'+varint(round_number if round_number>=0 else (1<<64)-1)).decode('ascii')

def reservation_url(reservation,room_id,endpoint):
    room=reservation.get('room')or {};process=room.get('processId');session=reservation.get('sessionId')
    if room.get('roomId')!=room_id or room.get('name')!='game_room':raise LobbyError('Reservation is not the selected public game')
    if not re.fullmatch('[a-zA-Z0-9_-]{1,64}',process or '') or not re.fullmatch('[a-zA-Z0-9_-]{1,128}',session or ''):raise LobbyError('Invalid reservation route')
    return endpoint.replace('https:','wss:',1)+'/'+process+'/'+room_id+'?'+urllib.parse.urlencode({'sessionId':session})

def public_mode(reader):
    data=reader._http('POST','https://p3.account.darksungame.com/serverConfig/fetch',headers=reader._headers(),json={'platform':4})
    value=(data.get('settings')or {}).get('enableDelayedSpectating') if isinstance(data,dict) else None
    if isinstance(value,str)and value.lower()in ('true','false'):value=value.lower()=='true'
    if type(value)is not bool:raise LobbyError('Official public spectator mode is unknown')
    return 'delayed' if value else 'ordinary'

class Spectator:
    def __init__(self,reader,info,mode='delayed'):
        if mode not in ('delayed','ordinary'):raise ValueError('Invalid public spectator mode')
        self.reader=reader;self.info=info;self.mode=mode;self.ws=None;self.next_ping=0;self.events=[];self.match_rank_data=None
    def own_session(self,require_empty=True,bounded=False):
        _,uid=read_token(self.reader.token_cache)
        if bounded:
            response=self.reader.http.get(self.reader.game_endpoint+'/getUserSessionData',headers=self.reader._headers(),timeout=4,allow_redirects=False)
            response.raise_for_status();body=response.json()
            if body.get('code')!=1:raise LobbyError('Could not verify account cleanup')
            data=body.get('data')
        else:data=self.reader._http('GET',self.reader.game_endpoint+'/getUserSessionData',headers=self.reader._headers())
        if not isinstance(data,dict) or data.get('uid')!=uid or set(data)-{'uid','roomId','groupId'}:raise LobbyError('Account session identity cannot be verified')
        if require_empty and (data.get('roomId')or data.get('groupId')):raise LobbyError('Existing account is occupied; no session will be interrupted')
        return data
    def join(self):
        self.reader.close();self.own_session()
        info=self.info
        if info.get('isPrivate')is not False or info.get('name')!='game_room' or info.get('status')!=2:raise LobbyError('Only an ongoing public game can be observed')
        self.reader._rate();headers=self.reader._headers()
        # A reservation mutates only this spectator session. Never retry it blindly.
        response=self.reader.http.post(self.reader.game_endpoint+'/matchmake/joinById/'+info['roomId'],headers=headers,json={},timeout=12,allow_redirects=False)
        if response.status_code!=200:raise LobbyError('Public spectator reservation was rejected')
        self.ws=websocket.create_connection(reservation_url(response.json(),info['roomId'],self.reader.game_endpoint),header=headers,timeout=3,suppress_origin=True)
        first=self.ws.recv()
        if not isinstance(first,bytes)or not first or first[0]!=10 or len(first)>1048576:raise LobbyError('Public spectator handshake failed')
        self.ws.send_binary(bytes([10]));self.next_ping=time.monotonic()+20;self.ws.settimeout(1)
        if self._receive(None,3,state=True)is not True:raise LobbyError('Initial room state did not arrive')
        self._send(1);over=self._receive('QueryGameOverResp',10)
        if over is None:raise LobbyError('Could not verify public game status')
        from public_lobby_wire import fields
        if any(n==1 and k==0 and bool(v) for n,k,v in fields(base64.b64decode(over,validate=True))):raise LobbyError('Public game ended before spectating began')
    def _send(self,kind,param=None):
        payload=bytes([8,kind]) if param is None else base64.b64decode(delayed_request(param))
        packet=bytes([13])+msgpack.packb('data',use_bin_type=True)+msgpack.packb({'type':'SimpleClientPact','data':base64.b64encode(payload).decode('ascii')},use_bin_type=True)
        self.ws.send_binary(packet)
    def read(self,round_number=-1,timeout=12):
        if self.ws is None:raise LobbyError('No public spectator connection')
        self._send(43,round_number)if self.mode=='delayed'else self._send(3)
        value=self._receive('DelayedSpectatingData' if self.mode=='delayed' else 'GameStatus',timeout)
        if value is None:raise SnapshotPending('Public spectator snapshot is not available yet')
        return value
    def ranks(self,allowed,timeout=2):
        from rank_info import match_ranks
        value=self.match_rank_data
        if value is None:
            # Native SimpleClientPactType.MatchPlayerInfosReq: public read only.
            self._send(101);value=self._receive('MatchPlayerInfosResp',timeout)
        return None if value is None else match_ranks(value,allowed)
    def focus_public(self,uid,allowed,timeout=1.5):
        if self.mode!='ordinary':return None
        if uid not in allowed or not re.fullmatch('[a-zA-Z0-9_-]{1,128}',uid):raise LobbyError('Target is not in the verified public roster')
        from public_lobby_wire import string_field
        # Ordinary spectator portrait selection; no realtime/friend/judge request.
        packet=bytes([13])+msgpack.packb('data',use_bin_type=True)+msgpack.packb({'type':'SpectateReq','data':base64.b64encode(string_field(1,uid)).decode('ascii')},use_bin_type=True)
        self.ws.send_binary(packet)
        self._receive('GameStatus',timeout)
        self._send(12)
        return self._receive('BattleResult',timeout)
    def _receive(self,expected,timeout,state=False):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if time.monotonic()>=self.next_ping:self.ws.ping(b'public-spectator');self.next_ping=time.monotonic()+20
            try:raw=self.ws.recv()
            except websocket.WebSocketTimeoutException:continue
            if not raw:raise LobbyError('Public spectator connection closed')
            if not isinstance(raw,bytes):continue
            if len(raw)>2097152:raise LobbyError('Public spectator packet exceeded its budget')
            if raw[0]in (11,12):raise LobbyError('Public spectator connection rejected or closed')
            if state and raw[0]==14:return True
            if raw[0]!=13:continue
            unpacker=msgpack.Unpacker(raw=False,strict_map_key=False,max_buffer_size=2097152);unpacker.feed(raw[1:]);values=list(unpacker)
            if len(values)!=2 or values[0]!='data' or not isinstance(values[1],dict):continue
            message=values[1];kind=message.get('type')
            if kind=='MatchPlayerInfosResp':self.match_rank_data=message.get('data')
            if kind==expected:return message['data']
            if self.mode=='ordinary'and kind in ('BattleResult','AllBattleResults'):
                if len(self.events)>=64:raise LobbyError('Public event buffer exceeded its budget')
                self.events.append(message)
        return None
    def close(self):
        socket,self.ws=self.ws,None
        if socket is not None:
            try:socket.send_binary(bytes([12]))
            except Exception:pass
            try:socket.close(timeout=2)
            except Exception:pass
        self.reader.close()
        for _ in range(3):
            try:self.own_session(bounded=True);return True
            except Exception:time.sleep(1.45)
        raise LobbyError('Public spectator cleanup could not be verified; operator review required')
