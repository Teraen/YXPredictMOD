"""Offline display-asset exporter. Generated game art/configs are runtime data, never Git inputs."""
import argparse,base64,collections,gc,json,pathlib,re,warnings
from public_lobby_wire import fields,read_varint,signed32

SPRITE_PATTERN=re.compile(r'^(?:Card_\d+|Icon_Talent_\w+|Icon_XianMoStrategy_\w+|Icon_FateStrategy_\w+|Icon_ResonanceTalent_\w+|CharAvatar_\d+_0|CardUI_\w+_[012])$')
INDEX_POLICY=2

def rows(raw):return [v for n,k,v in fields(raw)if n==2 and k==2]
def row(raw):
    result=collections.defaultdict(list)
    for n,k,v in fields(raw):result[n].append((k,v))
    return result
def number(r,n):return signed32(r[n][0][1])if r.get(n)else 0
def string(r,n):return r[n][0][1].decode('utf8')if r.get(n)else ''
def numbers(r,n):
    result=[]
    for k,v in r.get(n,[]):
        if k==0:result.append(signed32(v));continue
        at=0
        while at<len(v):i,at=read_varint(v,at);result.append(signed32(i))
    return result

def select_sprite_index(index,configs):
    # Native strategies may override their icon with any named sprite, including career icons.
    override_paths=set()
    for kind in ('XianMoStrategyConfig','FateStrategyConfig'):
        for raw in rows(configs[kind]):
            name=string(row(raw),15)
            if name:override_paths.add(name)
    missing=override_paths-set(index)
    if missing:raise ValueError('Missing native override sprites: '+', '.join(sorted(missing)))
    return {name:value for name,value in index.items()if SPRITE_PATTERN.fullmatch(name)or name in override_paths}

def export_skip_icon(images,out):
    source=images.get('Icon_XianMoStrategy_Skip')
    if source is None:raise ValueError('Missing native baijia skip sprite')
    target=out/'baijia'/'skip.png';source.save(target)
    return target

def export_card_levels(cards, directory):
    # Combination art is built after individual sprites. The native rarity
    # digits change the card level, while its illustration uses the base ID.
    for key,card in cards.items():
        identifier=int(key)
        base=str(identifier-(identifier//10000%100)*10000)
        if key==base or base not in cards or card['art']!=cards[base]['art']:continue
        target=directory/(key+'.png')
        source=directory/(base+'.png')
        if not target.exists() and source.is_file():target.write_bytes(source.read_bytes())

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--game',required=True);ap.add_argument('--out',required=True);args=ap.parse_args()
    warnings.filterwarnings('ignore');import UnityPy
    from PIL import Image
    UnityPy.config.FALLBACK_UNITY_VERSION='2020.3.49f1'
    bundles=pathlib.Path(args.game)/'YiXianPai_Data/StreamingAssets/aa/StandaloneWindows64';out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
    index={};configs={};wanted_configs={'CardConfig','CardCombineConfig','TalentConfig','XianMoStrategyConfig','FateStrategyConfig','TalentResonanceConfig'}
    cache=out/'.source-index.json'
    paths=list(bundles.glob('*.bundle'));stamp=[(p.name,p.stat().st_size,p.stat().st_mtime_ns)for p in paths]
    stored=json.loads(cache.read_text())if cache.exists()else None
    if stored and stored.get('policy')==INDEX_POLICY and stored['stamp']==[list(p)for p in stamp]and wanted_configs.issubset(stored['configs']):
        index=stored['index'];configs={k:base64.b64decode(v)for k,v in stored['configs'].items()};paths=[]
    for i,path in enumerate(paths):
        env=UnityPy.load(str(path))
        for obj in env.objects:
            if obj.type.name not in ('Sprite','TextAsset'):continue
            name=obj.peek_name()
            if obj.type.name=='Sprite'and name:index[name]=(path.name,obj.path_id)
            elif name in wanted_configs:
                value=obj.read().m_Script;configs[name]=value.encode('utf8','surrogateescape')if isinstance(value,str)else value
        del env;gc.collect()
        if i%30==0:print('Indexed bundles:',i,'sprites:',len(index),flush=True)
    if not wanted_configs.issubset(configs):raise ValueError('Missing current native display config')
    index=select_sprite_index(index,configs)
    cache.write_text(json.dumps({'policy':INDEX_POLICY,'stamp':stamp,'index':index,'configs':{k:base64.b64encode(v).decode()for k,v in configs.items()}}))
    for d in ('sprites','cards','talents','baijia','fates','resonances','characters','frames'):(out/d).mkdir(exist_ok=True)
    grouped=collections.defaultdict(list)
    for name,(bundle,pid)in index.items():grouped[bundle].append((name,pid))
    images={}
    for bundle,items in grouped.items():
        if all((out/'sprites'/(name+'.png')).exists()for name,pid in items):
            for name,pid in items:images[name]=Image.open(out/'sprites'/(name+'.png')).convert('RGBA')
            continue
        env=UnityPy.load(str(bundles/bundle));objects={obj.path_id:obj for obj in env.objects}
        for name,pid in items:
            image=objects[pid].read().image.convert('RGBA');image.thumbnail((384,512)if name.startswith('CardUI_')else(240,288)if name.startswith('Card_')else(128,128));images[name]=image;image.save(out/'sprites'/(name+'.png'))
        del env;gc.collect()
    cards={};talents={};baijia={}
    for raw in rows(configs['CardConfig']):
        r=row(raw);identifier=number(r,1);rarity=number(r,19)
        if identifier>=0:cards[str(identifier)]={'name':string(r,2),'overrides':numbers(r,24),'realm':number(r,6),'level':rarity+1,'dream':number(r,104)==14}
    for identifier,c in cards.items():
        n=int(identifier);basis=n-n//10000%100*10000;overrides=cards.get(str(basis),{}).get('overrides',[]);source=overrides[0]if overrides and overrides[0]else basis;c['art']=0 if source==286 else source
    for raw in rows(configs['TalentConfig']):
        r=row(raw);talents[str(number(r,1))]=number(r,2)
    def save(kind,identifier,source):
        if source not in images:return False
        images[source].save(out/kind/(str(identifier)+'.png'));return True
    export_skip_icon(images,out)
    for identifier,c in cards.items():
        n=int(identifier);basis=n-n//10000%100*10000;overrides=cards.get(str(basis),{}).get('overrides',[])
        if len(overrides)>=2 and all('Card_'+str(i)in images for i in overrides[:2]):
            left=images['Card_'+str(overrides[0])].resize((180,216));right=images['Card_'+str(overrides[1])].resize((180,216));image=Image.new('RGBA',(180,216));image.paste(left.crop((0,0,90,216)),(0,0));image.paste(right.crop((90,0,180,216)),(90,0));image.save(out/'cards'/(identifier+'.png'))
        else:save('cards',identifier,'Card_'+str(c['art']))
    combinations=[row(raw)for raw in rows(configs['CardCombineConfig'])]
    for _ in range(8):
        changed=False
        for r in combinations:
            target=out/'cards'/(str(number(r,3))+'.png');left=out/'cards'/(str(number(r,1))+'.png');right=out/'cards'/(str(number(r,2))+'.png')
            if target.exists()or not left.exists()or not right.exists():continue
            image=Image.new('RGBA',(180,216));image.paste(Image.open(left).convert('RGBA').resize((180,216)).crop((0,0,90,216)),(0,0));image.paste(Image.open(right).convert('RGBA').resize((180,216)).crop((90,0,180,216)),(90,0));image.save(target);changed=True
        if not changed:break
    export_card_levels(cards,out/'cards')
    for identifier,c in cards.items():
        target=out/'cards'/(identifier+'.png')
        if c['dream']and target.exists():Image.open(target).transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(target)
    for identifier,family in talents.items():save('talents',identifier,'Icon_Talent_'+str(family))
    for name in images:
        if name.startswith('CharAvatar_'):save('characters',name.split('_')[1],name)
        if name.startswith('CardUI_'):save('frames',name[len('CardUI_'):],name)
    def selection(kind,raw):
        r=row(raw);identifier=number(r,1);category=number(r,17);params=numbers(r,9);source=string(r,15)
        if not source:
            if category in (3,7)and len(params)>=2:
                left=images.get('Card_'+str(cards.get(str(params[0]),{}).get('art',params[0])));right=images.get('Card_'+str(cards.get(str(params[1]),{}).get('art',params[1])))
                if left is not None and right is not None:
                    icon=Image.new('RGBA',(128,128));icon.paste(left.resize((128,128)).crop((0,0,64,128)),(0,0));icon.paste(right.resize((128,128)).crop((64,0,128,128)),(64,0));icon.save(out/kind/(str(identifier)+'.png'));return
            if category==4 and params:source='Icon_Talent_'+str(params[0])
            elif category in (5,6,8,13,14,15)and params:
                cid=params[-1]if category==14 else params[0];card_image=out/'cards'/(str(cid)+'.png')
                if card_image.exists():
                    image=Image.open(card_image).convert('RGBA');image.thumbnail((128,128));image.save(out/kind/(str(identifier)+'.png'));return
                source='Card_'+str(cards.get(str(cid),{}).get('art',cid))
            elif category==16 and numbers(r,7):source='CharAvatar_'+str(numbers(r,7)[0])+'_0'
            else:source=('Icon_XianMoStrategy_'if kind=='baijia'else'Icon_FateStrategy_')+('Skip'if 0<identifier<1000 else str(identifier))
        save(kind,identifier,source)
    for raw in rows(configs['XianMoStrategyConfig']):selection('baijia',raw)
    for raw in rows(configs['FateStrategyConfig']):selection('fates',raw)
    for name in images:
        if name.startswith('Icon_ResonanceTalent_'):save('resonances',name[len('Icon_ResonanceTalent_'):],name)
    for raw in rows(configs['TalentResonanceConfig']):
        r=row(raw);save('resonances',number(r,1),'Icon_Talent_'+str(number(r,7)))
    (out/'cards.json').write_text(json.dumps(cards,ensure_ascii=False),encoding='utf8')
    print(json.dumps({kind:len(list((out/kind).glob('*.png')))for kind in ('cards','talents','baijia','fates','resonances','characters','frames')}),flush=True)

if __name__=='__main__':main()
