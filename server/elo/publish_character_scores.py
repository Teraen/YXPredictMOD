"""Publish only aggregate character scores to the Elo site's static directory."""
import argparse
import datetime as dt
import json
import math
import pathlib
import tempfile
import urllib.request

SOURCE="https://154.9.252.167:8443/api/v1/character-elo"
BJT=dt.timezone(dt.timedelta(hours=8))
CAREERS=("炼丹师","符咒师","琴师","画师","阵法师","灵植师","命理师")

def count(value):
    if type(value) is not int or value<0:
        raise ValueError("invalid aggregate count")
    return value

def cell(value):
    score=value["score"]
    if type(score) not in (int,float) or not math.isfinite(score) or not 0<=score<=10000:
        raise ValueError("invalid score")
    return dict(score=round(score,3),games=count(value["games"]),appearances=count(value["appearances"]),
                playerCount=count(value["playerCount"]))

def heroes(values,known_names):
    result=[];seen=set()
    for row in values:
        name=row["name"]
        if name not in known_names or name in seen:
            raise ValueError("unrecognized or duplicate character")
        seen.add(name)
        bands={}
        for b in ("mid","high"):
            band=row["bands"][b]
            careers={x["name"]:cell(x) for x in band["careers"]}
            if set(careers)!=set(CAREERS) or len(band["careers"])!=len(CAREERS):
                raise ValueError("unexpected career catalog")
            bands[b]={**cell(band),"careers":careers}
        result.append(dict(name=name,overall=cell(row["overall"]),bands=bands))
    if seen!=set(known_names):
        raise ValueError("incomplete character catalog")
    return result

def publish(dest,snapshot):
    # Keep the last valid publication if transport or validation fails.
    with urllib.request.urlopen(SOURCE,timeout=15) as response:
        if response.geturl()!=SOURCE:
            raise ValueError("unexpected upstream redirect")
        raw=response.read(600001)
    if len(raw)>600000:raise ValueError("oversized upstream response")
    data=json.loads(raw)
    if data["model"]!="online-elo-v2":raise ValueError("unexpected rating model")
    catalog={row["name"] for row in json.loads(snapshot.read_text(encoding="utf8"))["heroes"]}
    stamp=dt.datetime.fromtimestamp(count(data["updatedAt"])/1000,BJT)
    public=dict(kind="live",asOf=stamp.isoformat(timespec="minutes"),games=count(data["games"]),
                players=count(data["playerCount"]),heroes=heroes(data["heroes"],catalog))
    content=json.dumps(public,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode()
    if dest.exists() and dest.read_bytes()==content:return
    stream=tempfile.NamedTemporaryFile(dir=dest.parent,prefix=".character-scores-",delete=False)
    tmp=pathlib.Path(stream.name)
    try:
        with stream:stream.write(content)
        tmp.chmod(0o644);tmp.replace(dest)
    finally:tmp.unlink(missing_ok=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("directory",type=pathlib.Path)
    folder=parser.parse_args().directory
    publish(folder/"live.json",folder/"window.json")
