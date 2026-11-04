"""Export a small native UI skin from a local game installation.

Generated images, bundle indices and manifests are deployment data. Keep the
output outside source control, as with export_public_art.py. No game is started.
"""
import argparse
import collections
import gc
import json
import pathlib
import warnings


# These are the same native ScoreboardPanel / preparation controls harvested by
# sdk-extensions/NativePanelTheme.cs, rather than an independently drawn skin.
SPRITES = {
    'window': 'Panel_选择框_(2)',
    'banner': 'TitleBar_01',
    'close': 'Btn_关闭',
    'primary': 'Btn_03_0',
    'secondary': 'Btn_28_(1)',
    'card-scroll': 'Btn_28_(2)',
    'inset': 'Contentbar_小提示框',
    'self-flag': 'ContentBar_32',
    'line': 'Panel_道心排行_(2)',
    'spectate': 'Btn_观战',
}


def export(game, out, *, cached_index=None):
    import UnityPy

    warnings.filterwarnings('ignore')
    UnityPy.config.FALLBACK_UNITY_VERSION = '2020.3.49f1'
    bundles = pathlib.Path(game) / 'YiXianPai_Data/StreamingAssets/aa/StandaloneWindows64'
    paths = sorted(bundles.glob('*.bundle'))
    if not paths:
        raise ValueError('No local Steam game asset bundles found')
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = [[p.name, p.stat().st_size, p.stat().st_mtime_ns] for p in paths]
    cache = out / '.native-ui-index.json'
    stored = json.loads(cache.read_text(encoding='utf8')) if cache.exists() else None
    if cached_index is not None:
        index = cached_index
    elif stored and stored.get('stamp') == stamp:
        index = stored['index']
    else:
        index = {}
        wanted = set(SPRITES.values())
        for i, path in enumerate(paths):
            env = UnityPy.load(str(path))
            for obj in env.objects:
                if obj.type.name != 'Sprite':
                    continue
                name = obj.peek_name()
                if name in wanted:
                    index[name] = [path.name, obj.path_id]
            del env
            gc.collect()
            if i % 40 == 0:
                print('Indexed native UI bundles:', i, flush=True)
    missing = set(SPRITES.values()) - set(index)
    if missing:
        raise ValueError('Native UI sprites missing: ' + ', '.join(sorted(missing)))
    index = {name: index[name] for name in SPRITES.values()}
    cache.write_text(json.dumps({'stamp': stamp, 'index': index}), encoding='utf8')
    grouped = collections.defaultdict(list)
    for output, name in SPRITES.items():
        bundle, identifier = index[name]
        grouped[bundle].append((output, name, identifier))
    manifest = {}
    for bundle, items in grouped.items():
        env = UnityPy.load(str(bundles / bundle))
        objects = {obj.path_id: obj for obj in env.objects}
        for output, name, identifier in items:
            sprite = objects[identifier].read()
            image = sprite.image.convert('RGBA')
            destination = out / (output + '.png')
            image.save(destination)
            border = sprite.m_Border
            manifest[output] = {
                'sprite': name,
                'bundle': bundle,
                'size': list(image.size),
                # CSS border-image order is top, right, bottom, left.
                'slice': [border.w, border.z, border.y, border.x],
                'bytes': destination.stat().st_size,
            }
        del env
        gc.collect()
    (out / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', required=True)
    parser.add_argument('--out', required=True)
    arguments = parser.parse_args()
    manifest = export(arguments.game, arguments.out)
    print('Exported native UI PNGs:', len(manifest))


if __name__ == '__main__':
    main()
