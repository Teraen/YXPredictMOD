"""Refresh factual ID/name labels from the existing public guide card catalog."""
import argparse,json,pathlib
import requests

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--local-config');args=parser.parse_args();path=pathlib.Path(args.output)
    names=json.loads(path.read_text(encoding='utf8'))if path.exists()else {}
    response=requests.get('https://auth.kaigua.vip/guides/cards/index.json',timeout=20,allow_redirects=False);response.raise_for_status()
    if len(response.content)>5*1024*1024:raise ValueError('Card catalog exceeded budget')
    data=response.json();cards=data['cards']
    if not isinstance(cards,list)or not 100<=len(cards)<=10000:raise ValueError('Invalid card catalog')
    for card in cards:
        identifier,name,level=card['id'],card['name'],card['level']
        if type(identifier)is not int or identifier<=0 or not isinstance(name,str)or not 1<=len(name)<=60 or level not in (1,2,3)or any(ord(c)<32 for c in name):raise ValueError('Invalid public card label')
        names[str(identifier)]=name+'·'+('一','二','三')[level-1]+'级'
    if args.local_config:
        # Optional factual names from the operator's existing local config export.
        # Only missing ID/name labels are retained, never effects or game code.
        for identifier,row in json.loads(pathlib.Path(args.local_config).read_text(encoding='utf8'))['card'].items():
            name=row.get('n')
            if identifier.isdigit()and isinstance(name,str)and 1<=len(name)<=60 and not any(ord(c)<32 for c in name):names.setdefault(identifier,name)
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(names,ensure_ascii=False),encoding='utf8');temp.chmod(0o600);temp.replace(path)
    print('Public card labels:',len(names))

if __name__=='__main__':main()
