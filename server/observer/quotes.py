"""The existing MOD champion quote and stable horse allocation, without Elo output."""
import math

def sources(game_id,players):
    result=list(range(8));humans=sorted((i for i,p in enumerate(players) if not p['isAI']),key=lambda i:players[i]['uid'])
    if len(humans)<2:return result
    seed=17
    for char in game_id+':horse-shuffle-v1'+''.join(players[i]['uid'] for i in humans):seed=(seed*131+ord(char))%2147483647
    seed=(seed*48271+1)%2147483647;chosen=min(len(humans),2+seed%2)
    for i in range(len(humans)-1,0,-1):
        seed=(seed*48271+1)%2147483647;at=seed%(i+1);humans[i],humans[at]=humans[at],humans[i]
    for i in range(chosen):result[humans[i]]=humans[(i+1)%chosen]
    return result

def titles(game_id,players,ratings):
    allocated=sources(game_id,players);scores=[ratings[allocated[i]] for i in range(8)]
    known=[scores[i]['score'] for i,p in enumerate(players) if not p['isAI'] and scores[i]['found']]
    result=[]
    for i,p in enumerate(players):
        if p['isAI']:
            value=17
            for char in game_id+':'+p['uid']:value=(value*31+ord(char))%1000003
            result.append(['电子马·地狱','电子马·极难','电子马·困难','电子马·中等','电子马·简单'][value%5]);continue
        if not scores[i]['found']:result.append('未定马');continue
        score=scores[i]['score'];higher=sum(x>score for x in known);label='中等马'
        if len(known)>=2 and max(known)>min(known):
            label='特等马' if higher==0 else '上等马' if higher==1 else '中等马'
            if score==min(known):label='海马' if min(x for x in known if x>score)-score>=400 else '牛马'
        result.append(label)
    return result

def champion_rates(ratings,states,round_number):
    if len(ratings)!=8 or len(states)!=8:raise ValueError('Eight-player state required')
    dead=[i for i,s in enumerate(states) if s['life']<=0];alive=[i for i in range(8) if i not in dead]
    if len(alive)<2:raise ValueError('Awaiting final settlement')
    if sorted(states[i]['rank'] for i in dead)!=list(range(len(alive)+1,9)):raise ValueError('Incomplete eliminated ranks')
    mean=sum(states[i]['life'] for i in alive)/len(alive)
    strength={i:ratings[i]['score']+max(-800,min(800,(states[i]['life']-mean)*8))+max(-350,min(350,(states[i]['wins']-states[i]['losses'])*35)) for i in alive}
    maximum=max(strength.values());weights={i:math.exp(max(-12,(strength[i]-maximum)/600)) for i in alive}
    probability=[[0.0]*8 for _ in range(8)];mask0=sum(1<<i for i in dead)
    for i in dead:probability[i][states[i]['rank']-1]=1.0
    reached=[0.0]*256;reached[mask0]=1.0
    for mask in range(mask0,255):
        if mask&mask0!=mask0:continue
        remaining=sum(weights.get(i,0.0) for i in range(8) if not mask&(1<<i))
        if remaining<=0:continue
        rank=mask.bit_count()-len(dead)
        for i in range(8):
            if mask&(1<<i):continue
            value=reached[mask]*weights.get(i,0.0)/remaining
            probability[i][rank]+=value;reached[mask|(1<<i)]+=value
    bonus=(5-min(5,max(1,round_number)))*200;result=[0]*64
    for i,row in enumerate(probability):
        for rank in range(8):
            q=row[0]+row[1]*0.25+row[2]*0.10 if rank==0 else row[rank]+row[rank-1]*0.25+(row[rank+1]*0.25 if rank<7 else 0)
            if q<=0:continue
            basis=math.floor(max(1.01,min(50,0.90/q))*10000+0.000001)
            result[i*8+rank]=min(500000,10000+(basis-10000)*(10000+bonus)//10000)
    return result
