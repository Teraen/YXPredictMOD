"""Isolated read-only bridge to an existing native replay transport."""
import json,os,pathlib,sys
from public_archive import public_record

def main():
    job=json.load(sys.stdin)
    if type(job['code'])is not int or not 0<job['code']<10**18 or type(job['index'])is not int or not 0<=job['index']<8:raise ValueError('Invalid public record')
    path=pathlib.Path(job['bridge']).resolve()
    if not path.is_dir():raise ValueError('Missing replay bridge')
    sys.path.insert(0,str(path));os.environ['YX_IDENTITY_CAPTURE_REPLAYS']='0'
    import replay_service as replay
    n=job['code']*1000+job['index'];plain=''
    while n:n,r=divmod(n,36);plain='0123456789abcdefghijklmnopqrstuvwxyz'[r]+plain
    raw=replay.upstream('/gameStat/fetchPlayerBattleInfo',{'code':plain},allow_missing=True)
    print(json.dumps(None if raw is None else public_record(raw,job['code']),separators=(',',':')))

if __name__=='__main__':main()
