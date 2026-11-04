"""Validate the tested ZIP, source manifest and manager catalog before publishing."""
import hashlib
import json
import os
from pathlib import Path
import re
import zipfile
from urllib.parse import quote


MOD_ID = "local.yxp.predictionpoints"
PACKAGE_NAME = "天机赌马"
RACING_NAME = "天机赛马"
ICONS = ("特等马", "上等马", "中等马", "牛马", "海马", "黑马", "机械马")
ASSETS = ICONS + ("圆形遮罩",)

def package_name(version):
    return RACING_NAME if tuple(map(int, version.split('.'))) >= (0, 8, 3) else PACKAGE_NAME

def asset_name_for(version):
    prefix = 'tianji-saima-' if tuple(map(int, version.split('.'))) >= (0, 8, 3) else 'tianji-duma-'
    return prefix + version + '.zip'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def checked_file(root, relative):
    require(isinstance(relative, str) and not any(c in relative for c in "\r\n\\:"), "Invalid release path")
    path = Path(relative)
    require(not path.is_absolute() and ".." not in path.parts, "Release path escapes repository")
    target = (root / path).resolve()
    require(target.is_relative_to(root.resolve()) and target.is_file(), "Missing release file: " + relative)
    return target


def verify(root, repository="Teraen/YXPredictMOD"):
    root = Path(root)
    meta = read_json(root / ".github/releases/latest.json")
    version = meta["version"]
    require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version), "Invalid release version")
    require(meta["tag"] == "v" + version, "Tag/version mismatch")
    require(re.fullmatch(r"[0-9a-f]{64}", meta["sha256"]), "Invalid package checksum")
    title = meta["title"]
    require(isinstance(title, str) and 0 < len(title) <= 200 and not any(c in title for c in "\r\n"), "Invalid release title")
    artifact = checked_file(root, meta["artifact"])
    checked_file(root, meta["notes"])
    expected_artifact = "dist/" + package_name(version) + "-" + version + ".zip"
    legacy_artifact = "dist/" + MOD_ID + "-" + version + ".zip"
    legacy_version = tuple(map(int, version.split("."))) <= (0, 7, 9)
    require(meta["artifact"] == expected_artifact or (legacy_version and meta["artifact"] == legacy_artifact), "Unexpected package path")
    asset_name = meta.get("assetName", artifact.name)
    # GitHub strips Chinese from uploaded filenames; keep the local ZIP Chinese
    # and publish an ASCII transport alias with the Chinese name as its label.
    expected_asset = asset_name_for(version)
    require(asset_name == expected_asset or (legacy_version and asset_name == artifact.name and asset_name.isascii()), "Unexpected release asset name")
    require(hashlib.sha256(artifact.read_bytes()).hexdigest() == meta["sha256"], "Package checksum mismatch")
    manifest = read_json(root / "mod/manifest.json")
    require(manifest["id"] == MOD_ID and manifest["version"] == version, "Manifest/version mismatch")
    require(manifest["updateUrl"] == "https://github.com/" + repository, "Wrong update repository")
    prefix = MOD_ID + "/"
    files = {"manifest.json", "plugins/PredictionPoints.dll", "README.md", "assets/horse/NOTICE.md"}
    files.update("assets/horse/" + name + ".png" for name in ASSETS)
    expected = {prefix + name for name in files}
    with zipfile.ZipFile(artifact) as archive:
        names = archive.namelist()
        require(len(names) == len(expected) and set(names) == expected, "Unexpected or duplicate ZIP contents")
        packed = json.loads(archive.read(prefix + "manifest.json").decode("utf-8-sig"))
        require(packed == manifest, "Source and packaged manifests differ")
        require(archive.read(prefix + "plugins/PredictionPoints.dll").startswith(b"MZ"), "Missing MOD assembly")
        for name in files - {"manifest.json", "plugins/PredictionPoints.dll"}:
            packaged = archive.read(prefix + name)
            source = (root / "mod" / name).read_bytes()
            if name.endswith(".md"):
                # Git checks text out as LF on Linux; the tested Windows ZIP may contain CRLF.
                packaged = packaged.decode("utf-8-sig").replace("\r\n", "\n")
                source = source.decode("utf-8-sig").replace("\r\n", "\n")
            require(packaged == source, "Stale packaged file: " + name)
    catalog = read_json(root / "mods.json")
    require(catalog["schema"] == 1 and len(catalog["mods"]) == 1, "Invalid manager catalog")
    entry = catalog["mods"][0]
    for key in ("id", "name", "version", "author", "description", "sdkVersion"):
        require(entry.get(key) == manifest.get(key), "Catalog/manifest mismatch: " + key)
    require(entry["repo"] == manifest["updateUrl"], "Wrong catalog repository")
    expected_url = manifest["updateUrl"] + "/releases/download/" + meta["tag"] + "/" + quote(asset_name)
    require(entry["download"] == expected_url, "Wrong catalog download")
    require(entry["sha256"] == meta["sha256"], "Catalog/package checksum mismatch")
    return dict(meta, name=artifact.name, assetName=asset_name)


if __name__ == "__main__":
    data = verify(Path(__file__).resolve().parent.parent, os.environ.get("GITHUB_REPOSITORY", "Teraen/YXPredictMOD"))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            for key in ("version", "tag", "artifact", "notes", "sha256", "title", "name", "assetName"):
                output.write(key + "=" + data[key] + "\n")
    print("RELEASE CHECK PASS: " + data["tag"] + "; 12 files; ZIP/source/catalog checksums verified")
