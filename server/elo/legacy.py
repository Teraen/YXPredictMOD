"""Private HMAC lookup for the original public Elo export; never a model seed."""
import argparse
import concurrent.futures
import hashlib
import hmac
import json
import math
import os
import pathlib
import re
import tempfile
import time
import urllib.request

BASE='https://raymondwrw.github.io/yxp-card-stats/data/elo/'


def load_key(path):
    key=pathlib.Path(path).read_text(encoding='utf-8').strip()
    if len(key)<32:raise ValueError('UID lookup key missing or too short')
    return key.encode('utf-8')


def pseudonym(uid,key):
    return hmac.new(key,uid.encode('utf-8'),hashlib.sha256).hexdigest()[:16]


def profile(row):
    if not isinstance(row,dict):raise ValueError('Invalid legacy profile')
    for field,maximum in [('rating',10000),('sigma',2000)]:
        value=row.get(field)
        if type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<=maximum:raise ValueError('Invalid legacy rating')
    for field in ['games','dx','last']:
        if type(row.get(field)) is not int or row[field]<0:raise ValueError('Invalid legacy statistics')
    if row['dx']>row['games'] or not isinstance(row.get('name'),str) or len(row['name'])>200:raise ValueError('Invalid legacy statistics')
    # Histories and arbitrary upstream fields never enter the live API cache.
    result={field:row[field] for field in ['name','rating','sigma','games','dx','last']}
    conservative=row.get('cons',row['rating']-2*row['sigma'])
    if type(conservative) not in (int,float) or not math.isfinite(conservative) or not -4000<=conservative<=10000:raise ValueError('Invalid legacy conservative rating')
    result['cons']=conservative
    return result


def fetch(path):
    with urllib.request.urlopen(BASE+path,timeout=30) as response:raw=response.read(4*1024*1024+1)
    if len(raw)>4*1024*1024:raise ValueError('Legacy response exceeds budget')
    return json.loads(raw)


def refresh(output,primary,key,download=fetch):
    destination=pathlib.Path(output)
    before=download('top.json')
    generated=before.get('generated')
    if type(generated) is not int or generated<=0:raise ValueError('Legacy export has no generation timestamp')
    revision=hashlib.sha256(json.dumps(before,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    previous=None
    if destination.exists():previous=json.loads(destination.read_text(encoding='utf-8'))
    if previous and previous['meta'].get('schema')==2 and previous['meta'].get('revision')==revision:
        players=previous['players']
    else:
        players={}
        def shard(suffix):return suffix,download('p/'+suffix+'.json')
        suffixes=[format(i,'02x') for i in range(256)]
        placeholders={pseudonym('record-player-'+str(i),key) for i in range(1,65)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for suffix,rows in pool.map(shard,suffixes):
                if not isinstance(rows,dict):raise ValueError('Invalid legacy shard')
                for uid,row in rows.items():
                    if uid.startswith('ai') or uid.startswith('record-player-') or uid in placeholders:continue
                    if not re.fullmatch('[0-9a-f]{16}',uid) or not uid.endswith(suffix) or uid in players:raise ValueError('Invalid legacy identity')
                    players[uid]=profile(row)
        if download('top.json')!=before:raise ValueError('Legacy generation changed during refresh')
    known=[uid for uid in primary['players'] if re.fullmatch('[0-9a-f]{24}',uid)]
    matched=sum(pseudonym(uid,key) in players for uid in known)
    if not known or matched<min(1000,len(known)):raise ValueError('Legacy key did not match known raw identities')
    result={'players':players,'meta':{'schema':2,'source':'legacy-hmac','dataAt':generated,'fetchedAt':int(time.time()*1000),
        'revision':revision,'players':len(players),'matchedKnownPlayers':matched}}
    destination.parent.mkdir(parents=True,exist_ok=True)
    name=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=destination.parent,delete=False) as stream:
            name=stream.name;os.chmod(name,0o600)
            json.dump(result,stream,ensure_ascii=False,separators=(',',':'));stream.flush();os.fsync(stream.fileno())
        os.replace(name,destination);name=None
    finally:
        if name:os.unlink(name)
    return result['meta']


class Lookup:
    def __init__(self,snapshot,key):self.snapshot=snapshot;self.key=key
    def data(self):
        try:
            data=self.snapshot.get()
            if data['meta']['source']!='legacy-hmac' or type(data['meta']['dataAt']) is not int:return None
            return data
        except (OSError,ValueError,KeyError):return None
    def resolve(self,uid,primary,data=None):
        data=self.data() if data is None else data
        old=None if data is None else data['players'].get(pseudonym(uid,self.key))
        if old is not None and (primary is None or old['last']>primary.get('last',0)):
            return {**old,'origin':'legacy-hmac','sourceAt':data['meta']['dataAt']}
        return primary
    def status(self):
        data=self.data()
        return {'legacyLookupEnabled':True,'legacyAvailable':data is not None,
            'legacyDataAt':None if data is None else data['meta']['dataAt'],
            'legacyPlayers':0 if data is None else len(data['players'])}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--primary',required=True);parser.add_argument('--uid-key-file',required=True);args=parser.parse_args()
    info=refresh(args.output,json.loads(pathlib.Path(args.primary).read_text(encoding='utf-8')),load_key(args.uid_key_file))
    print(json.dumps(info))
