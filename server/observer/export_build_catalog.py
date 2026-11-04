"""Export display labels only. Game resources and generated dictionaries stay outside Git."""
import argparse,hashlib,json,pathlib,re,struct,warnings
from public_lobby_wire import fields

PREFIXES={'CharacterName':'characters','Career':'careers','Sect':'sects','Level':'realms','Talent':'talents','ResonanceTalent':'resonances','FateStrategyName':'fates','XianMoStrategyName':'baijia'}
PATTERN=re.compile(rb'(CharacterName|Career|Sect|Level|Talent|ResonanceTalent|FateStrategyName|XianMoStrategyName)_(\d+|Skip)')

def labels(raw):
    result={kind:{}for kind in PREFIXES.values()}
    for match in PATTERN.finditer(raw):
        at=match.start();key=match.group()
        if at<4 or struct.unpack_from('<I',raw,at-4)[0]!=len(key):continue
        offset=(match.end()+3)//4*4
        if offset+12>len(raw):continue
        term_type,count,size=struct.unpack_from('<III',raw,offset)
        if term_type!=0 or not 1<=count<=16 or not 0<size<=512 or offset+12+size>len(raw):continue
        try:name=raw[offset+12:offset+12+size].decode('utf8')
        except UnicodeDecodeError:continue
        name=re.sub('<[^>]*>','',name).strip()
        if not name or len(name)>80 or any(ord(c)<32 for c in name):continue
        identifier=match[2].decode();kind=PREFIXES[match[1].decode()]
        if identifier=='Skip':result['baijiaSkip']=name
        else:result[kind][identifier]=name
    if len(result['characters'])<20 or len(result['talents'])<100 or len(result['baijia'])<100:raise ValueError('Incomplete public label dictionary')
    return result

def main():
    parser=argparse.ArgumentParser();source=parser.add_mutually_exclusive_group(required=True);source.add_argument('--bundles');source.add_argument('--localization');parser.add_argument('--talent-config');parser.add_argument('--output',required=True);args=parser.parse_args()
    if args.localization:raw=pathlib.Path(args.localization).read_bytes()
    else:
        warnings.filterwarnings('ignore');import UnityPy
        UnityPy.config.FALLBACK_UNITY_VERSION='2020.3.49f1';raw=None
        for path in sorted(pathlib.Path(args.bundles).glob('*.bundle'),key=lambda p:p.stat().st_size):
            if not 300000<=path.stat().st_size<=30000000:continue
            env=UnityPy.load(str(path))
            for obj in env.objects:
                if obj.type.name!='MonoBehaviour':continue
                data=obj.get_raw_data()
                if b'TalentDesc_10005'in data and b'XianMoStrategyName_1001'in data:raw=data;break
            if raw is not None:break
        if raw is None:raise ValueError('Current localization asset not found')
    result=labels(raw);result['sourceHash']=hashlib.sha256(raw).hexdigest()
    if args.talent_config:
        result['talentRealms']={}
        for n,k,v in fields(pathlib.Path(args.talent_config).read_bytes()):
            if n!=2 or k!=2:continue
            row={f:value for f,kind,value in fields(v)if kind==0};identifier=row.get(1,0);family=row.get(2,0)
            name=result['talents'].get(str(family))
            if identifier>0 and name:result['talents'][str(identifier)]=name
            if identifier>0:result['talentRealms'][str(identifier)]=result['realms'].get(str(row.get(6,0)),'')
    pathlib.Path(args.output).write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf8')
    print(json.dumps({kind:len(result[kind])for kind in PREFIXES.values()}))

if __name__=='__main__':main()
