"""Offline projection of native delayed spectator snapshots; no network or joins.

The list order is not an anonymous replay player number. This module never
assigns record-player-N, publishes scores, or changes production identities.
"""
import base64
import re

from public_lobby_wire import fields, read_varint, signed32


def _unique(seen, number):
    if number in seen:
        raise ValueError('duplicate identity field')
    seen.add(number)

def _append_ids(target,kind,value,limit=32):
    if kind==0:items=[signed32(value)]
    elif kind==2:
        items=[];offset=0
        while offset<len(value):
            item,offset=read_varint(value,offset);items.append(signed32(item))
            if len(items)>limit:raise ValueError('Oversized public selection list')
    else:raise ValueError('Invalid public selection list')
    if any(i<=0 for i in items)or len(target)+len(items)>limit:raise ValueError('Invalid public selection IDs')
    target.extend(items)

def _resonance_selected(data):
    selected=0
    for number,kind,value in fields(data):
        if number==1 and kind==2:
            for n,k,v in fields(value):
                if n==3 and k==0:selected=signed32(v)
                # Pending candidates and refresh data are not retained.
    if selected<0:raise ValueError('Invalid public resonance selection')
    return selected


def _board(data):
    # Only the previous round's played board is retained, never hands or offers.
    result = dict(life=0, extraMaxHp=0, exp=0, level=0, unlockGrids=0, usedCards=[],talents=[],baijia=[],fates=[],resonanceId=0)
    scalar = {1: 'life', 2: 'extraMaxHp', 3: 'exp', 4: 'level', 10: 'unlockGrids'}
    seen = set()
    for number, kind, value in fields(data):
        if number in scalar:
            _unique(seen, number)
            if kind != 0:
                raise ValueError('invalid board scalar')
            result[scalar[number]] = signed32(value)
        elif number in (5,16,17):
            _append_ids(result[{5:'talents',16:'fates',17:'baijia'}[number]],kind,value)
        elif number==13:
            _unique(seen,number)
            if kind!=2:raise ValueError('Invalid public resonance data')
            result['resonanceId']=_resonance_selected(value)
        elif number == 6:
            if kind != 2:
                raise ValueError('invalid packed board')
            offset = 0
            while offset < len(value):
                card, offset = read_varint(value, offset)
                result['usedCards'].append(signed32(card))
                if len(result['usedCards']) > 8:
                    raise ValueError('oversized played board')
    return result


def _player(data):
    result = dict(uid='', name='', life=0, characterId=0, career=0,sect=0,level=0,talents=[], rank=0,wins=0,losses=0,
                  isAI=False, isMirror=False, settled=False, lastRound=None)
    text = {1: 'uid', 2: 'name'}
    scalar = {3: 'life',6:'level',7:'sect',8: 'career', 12: 'characterId', 15: 'rank',19:'wins',20:'losses'}
    flags = {11: 'isMirror', 16: 'isAI', 1001: 'settled'}
    seen = set()
    for number, kind, value in fields(data):
        if number==13:
            _append_ids(result['talents'],kind,value);continue
        if number not in text and number not in scalar and number not in flags and number != 200:
            continue
        _unique(seen, number)
        if number in text:
            if kind != 2 or len(value) > (96 if number == 1 else 1024):
                raise ValueError('invalid player text')
            result[text[number]] = value.decode('utf-8')
        elif number in scalar:
            if kind != 0:
                raise ValueError('invalid player scalar')
            result[scalar[number]] = signed32(value)
        elif number in flags:
            if kind != 0 or value not in (0, 1):
                raise ValueError('invalid player flag')
            result[flags[number]] = bool(value)
        else:
            if kind != 2:
                raise ValueError('invalid previous round')
            result['lastRound'] = _board(value)
    uid = result['uid']
    native_bot = len(uid) < 10 and 'ai' in uid
    result['reportedIsAI'] = result['isAI']
    result['isAI'] = result['isAI'] or native_bot
    result['identityKind'] = ('bot' if result['isAI'] else
                              'human' if re.fullmatch('[0-9a-f]{24}', uid) else 'unknown')
    if not uid or uid.startswith('record-player-') or result['characterId'] <= 0:
        raise ValueError('missing or anonymous live identity')
    return result


def _snapshot(data):
    result = dict(index=0, timestamp=0, round=0,timer=0, players=[])
    scalars = {1: 'index', 2: 'timestamp', 3: 'round',4:'timer'}
    seen = set()
    for number, kind, value in fields(data):
        if number in scalars:
            _unique(seen, number)
            if kind != 0 or (number == 2 and value > (1 << 63) - 1):
                raise ValueError('invalid snapshot scalar')
            result[scalars[number]] = value if number == 2 else signed32(value)
        elif number == 100:
            if kind != 2 or len(result['players']) >= 8:
                raise ValueError('invalid snapshot players')
            public, public_seen = None, False
            for n, k, v in fields(value):
                if n == 1:
                    if public_seen or k != 2:
                        raise ValueError('invalid public player')
                    public_seen, public = True, _player(v)
                # PlayerData.privateData is deliberately not parsed or retained.
            if public is None:
                raise ValueError('missing public player')
            result['players'].append(public)
    if len({p['uid'] for p in result['players']}) != len(result['players']):
        raise ValueError('duplicate snapshot UID')
    return result


def _public_player_data(data):
    result=None
    for number,kind,value in fields(data):
        if number==1:
            if result is not None or kind!=2:raise ValueError('Invalid public player data')
            result=_player(value)
        # PrivateData, hand cards, shop offers and upgrade choices stay unread.
    if result is None:raise ValueError('Missing public player data')
    return result


def _battle(data):
    result={'round':0,'winner':'','first':None,'second':None,'lifeDamage':0}
    for number,kind,value in fields(data):
        if number in (1,2) and kind==2:result['first' if number==1 else 'second']=_public_player_data(value)
        elif number==7 and kind==0:result['round']=signed32(value)
        elif number==6 and kind==0:result['lifeDamage']=signed32(value)
        elif number==9 and kind==2:result['winner']=value.decode('utf-8')
    if not result['first'] or not result['second'] or result['round']<1:raise ValueError('Incomplete public battle')
    if result['winner'] not in ('',result['first']['uid'],result['second']['uid']):raise ValueError('Foreign public winner')
    return result


def _game_status(data):
    result={'round':0,'timer':0,'isEnded':False,'gameMode':0,'codeId':0,'beginTs':0,'players':[]}
    for number,kind,value in fields(data):
        if kind==0 and number in (1,2,3,4,100,102):result[{1:'round',2:'timer',3:'isEnded',4:'gameMode',100:'beginTs',102:'codeId'}[number]]=bool(value) if number==3 else value
        elif number==5 and kind==2:
            if len(result['players'])>=8:raise ValueError('Too many public players')
            result['players'].append(_player(value))
    return result


def public_status(encoded):return _game_status(base64.b64decode(encoded,validate=True))


def public_battles(kind,encoded):
    raw=base64.b64decode(encoded,validate=True)
    if kind=='BattleResult':return [_battle(raw)]
    if kind!='AllBattleResults':raise ValueError('Not an ordinary public battle event')
    result=[]
    for n,k,v in fields(raw):
        if n==1 and k==2:
            if len(result)>=8:raise ValueError('Too many public battles')
            result.append(_battle(v))
    return result


def public_commands(encoded):
    result=[];count=0
    for number,kind,value in fields(base64.b64decode(encoded,validate=True)):
        if number!=2 or kind!=2:continue
        count+=1
        if count>2000:raise ValueError('Too many spectator commands')
        row={'index':0,'timestamp':0,'type':'','target':'','data':''}
        for n,k,v in fields(value):
            if n in (1,2) and k==0:row['index' if n==1 else 'timestamp']=v
            elif n in (3,4,5) and k==2:row[{3:'target',4:'type',5:'data'}[n]]=v.decode('utf-8')
        message=row.pop('data')
        if row['type'] not in ('GameStatus','BattleResult','AllBattleResults'):continue
        raw=base64.b64decode(message,validate=True)
        if row['type']=='GameStatus':row['public']=_game_status(raw)
        elif row['type']=='BattleResult':row['public']=[_battle(raw)]
        else:
            battles=[]
            for n,k,v in fields(raw):
                if n==1 and k==2:
                    if len(battles)>=8:raise ValueError('Too many public battles')
                    battles.append(_battle(v))
            row['public']=battles
        result.append(row)
    return result


def decode_delayed_identity(encoded):
    """Return public evidence from a captured base64 DelayedSpectatingData body.

    A zero round means the server delay has not elapsed. Neither that state nor
    an incomplete/unknown roster is evidence of a complete identity mapping.
    Game mode, observer role and room/code agreement need external evidence.
    """
    if not isinstance(encoded, (str, bytes)) or len(encoded) > 1400000:
        raise ValueError('invalid captured payload')
    raw = base64.b64decode(encoded, validate=True)
    result = dict(codeId=0, beginTs=0, endTs=0, isEnded=False, snapshot=None)
    seen = set()
    for number, kind, value in fields(raw):
        if number not in (1, 3, 4, 5, 6):
            continue
        _unique(seen, number)
        if number == 1:
            if kind != 2:
                raise ValueError('invalid delayed snapshot')
            result['snapshot'] = _snapshot(value)
        else:
            if kind != 0 or value > (1 << 63) - 1 or (number == 3 and value not in (0, 1)):
                raise ValueError('invalid delayed identity scalar')
            result[{3: 'isEnded', 4: 'beginTs', 5: 'endTs', 6: 'codeId'}[number]] = bool(value) if number == 3 else value
    snapshot = result['snapshot']
    result['publicRosterComplete'] = bool(
        result['codeId'] > 0 and result['beginTs'] > 0 and snapshot and snapshot['round'] > 0
        and len(snapshot['players']) == 8
        and all(p['identityKind'] != 'unknown' and not p['isMirror'] and p['name'].strip()
                for p in snapshot['players']))
    return result
