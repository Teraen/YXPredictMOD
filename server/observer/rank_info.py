"""Only the native public match score and its per-player ladder/Daoxin flag."""
import base64
from public_lobby_wire import fields,signed32

def match_ranks(encoded,allowed):
    raw=base64.b64decode(encoded,validate=True)
    if len(raw)>131072:raise ValueError('Public match scores exceed budget')
    rows=[]
    for number,kind,value in fields(raw):
        if number!=1:continue
        if kind!=2 or len(rows)>=8:raise ValueError('Invalid public match scores')
        row={'uid':'','score':0,'mode':'ladder'};seen=set()
        for n,k,v in fields(value):
            if n not in (1,4,10):continue
            if n in seen:raise ValueError('Duplicate public match score field')
            seen.add(n)
            if n==1:
                if k!=2 or not 1<=len(v)<=128:raise ValueError('Invalid public match score identity')
                row['uid']=v.decode('utf8')
            elif n==4:
                if k!=0 or not 0<=signed32(v)<=1000000:raise ValueError('Invalid public native score')
                row['score']=signed32(v)
            else:
                if k!=0 or v not in (0,1):raise ValueError('Invalid public native score mode')
                row['mode']='daoxin'if v else'ladder'
        rows.append(row)
    if len(rows)!=8 or len({r['uid']for r in rows})!=8 or {r['uid']for r in rows}!=set(allowed):raise ValueError('Public match score roster mismatch')
    return rows

def lobby_ranks(roster):
    # LobbyUserInfo.rankScore is the ordinary ladder score. Do not infer
    # isDaoXinRank from room.gameMode (RankMode includes both kinds of players).
    return [{'uid':p['userInfo']['uid'],'mode':'ladder','score':p['userInfo'].get('rankScore')if type(p['userInfo'].get('rankScore'))is int and 0<=p['userInfo']['rankScore']<=1000000 else None}for p in roster]
