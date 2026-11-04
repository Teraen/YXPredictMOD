"""Regressions for the real release package and manager catalog contract."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import warnings
import zipfile
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("verify_release", ROOT / "scripts/verify-release.py")
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.meta = RELEASE.read_json(ROOT / ".github/releases/latest.json")
        for relative in (".github/releases/latest.json", self.meta["artifact"], self.meta["notes"]):
            self.copy(relative)
        # Main may contain an unreleased manifest/README. Build each isolated
        # sample from the published package, then mutate one contract at a time.
        files = ["manifest.json", "README.md", "assets/horse/NOTICE.md"]
        files += ["assets/horse/" + icon + ".png" for icon in RELEASE.ASSETS]
        with zipfile.ZipFile(self.root / self.meta["artifact"]) as archive:
            for relative in files:
                target = self.root / "mod" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(RELEASE.MOD_ID + "/" + relative))
        manifest = RELEASE.read_json(self.root / "mod/manifest.json")
        catalog = RELEASE.read_json(ROOT / "mods.json")
        entry = catalog["mods"][0]
        for key in ("id", "name", "version", "author", "description", "sdkVersion"):
            entry[key] = manifest[key]
        entry["repo"] = manifest["updateUrl"]
        entry["download"] = manifest["updateUrl"] + "/releases/download/" + self.meta["tag"] + "/" + quote(self.meta.get("assetName", Path(self.meta["artifact"]).name))
        entry["sha256"] = self.meta["sha256"]
        self.write_json("mods.json", catalog)

    def copy(self, relative):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)

    def write_json(self, relative, value):
        (self.root / relative).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def rewrite_archive(self, change):
        path = self.root / self.meta["artifact"]
        with zipfile.ZipFile(path) as archive:
            entries = [(name, archive.read(name)) for name in archive.namelist()]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                for name, data in change(entries):
                    archive.writestr(name, data)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.meta["sha256"] = digest
        self.write_json(".github/releases/latest.json", self.meta)
        catalog = RELEASE.read_json(self.root / "mods.json")
        catalog["mods"][0]["sha256"] = digest
        self.write_json("mods.json", catalog)

    def test_current_package_with_icons_and_circle_mask_is_accepted(self):
        result = RELEASE.verify(self.root)
        self.assertEqual(result["tag"], self.meta["tag"])
        self.assertEqual(result["title"], self.meta["title"])
        self.assertEqual(result["name"], Path(self.meta["artifact"]).name)

    def rename_package(self, filename):
        path = self.root / self.meta["artifact"]
        target = self.root / "dist" / filename
        path.rename(target)
        self.meta["artifact"] = "dist/" + filename
        self.write_json(".github/releases/latest.json", self.meta)
        catalog = RELEASE.read_json(self.root / "mods.json")
        catalog["mods"][0]["download"] = catalog["mods"][0]["repo"] + "/releases/download/" + self.meta["tag"] + "/" + quote(self.meta.get("assetName", filename))
        self.write_json("mods.json", catalog)

    def promote_version(self, version):
        manifest = RELEASE.read_json(self.root / "mod/manifest.json")
        manifest["version"] = version
        self.write_json("mod/manifest.json", manifest)
        self.meta.update(version=version, tag="v" + version, title="v" + version + " naming check", assetName=RELEASE.asset_name_for(version))
        self.write_json(".github/releases/latest.json", self.meta)
        catalog = RELEASE.read_json(self.root / "mods.json")
        catalog["mods"][0]["version"] = version
        self.write_json("mods.json", catalog)
        manifest_bytes = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        self.rewrite_archive(lambda entries: [(name, manifest_bytes if name == RELEASE.MOD_ID + "/manifest.json" else data) for name, data in entries])
        self.rename_package(RELEASE.package_name(version) + "-" + version + ".zip")

    def test_friendly_package_name_preserves_the_internal_mod_id(self):
        self.rename_package(RELEASE.package_name(self.meta["version"]) + "-" + self.meta["version"] + ".zip")
        result = RELEASE.verify(self.root)
        self.assertEqual(result["name"], RELEASE.package_name(self.meta["version"]) + "-" + self.meta["version"] + ".zip")
        with zipfile.ZipFile(self.root / self.meta["artifact"]) as archive:
            self.assertTrue(all(name.startswith(RELEASE.MOD_ID + "/") for name in archive.namelist()))

    def test_new_versions_require_the_friendly_filename(self):
        self.promote_version("0.7.10")
        self.assertEqual(RELEASE.verify(self.root)["name"], RELEASE.PACKAGE_NAME + "-0.7.10.zip")
        self.rename_package(RELEASE.MOD_ID + "-0.7.10.zip")
        with self.assertRaisesRegex(ValueError, "Unexpected package path"):
            RELEASE.verify(self.root)

    def test_racing_release_uses_the_new_name_and_alias_without_renaming_historical_releases(self):
        self.promote_version('0.8.3')
        result = RELEASE.verify(self.root)
        self.assertEqual(result['name'], '天机赛马-0.8.3.zip')
        self.assertEqual(result['assetName'], 'tianji-saima-0.8.3.zip')
        self.meta['assetName'] = 'tianji-duma-0.8.3.zip'
        self.write_json('.github/releases/latest.json', self.meta)
        with self.assertRaisesRegex(ValueError, 'Unexpected release asset name'):
            RELEASE.verify(self.root)

    def test_github_alias_keeps_the_local_chinese_name_and_matches_the_download(self):
        self.promote_version("0.7.10")
        catalog = RELEASE.read_json(self.root / "mods.json")
        result = RELEASE.verify(self.root)
        self.assertEqual(result["name"], RELEASE.PACKAGE_NAME + "-0.7.10.zip")
        self.assertEqual(result["assetName"], "tianji-duma-0.7.10.zip")
        self.assertTrue(catalog["mods"][0]["download"].endswith("/" + result["assetName"]))
        catalog["mods"][0]["download"] = catalog["mods"][0]["download"].replace(result["assetName"], quote(result["name"]))
        self.write_json("mods.json", catalog)
        with self.assertRaisesRegex(ValueError, "Wrong catalog download"):
            RELEASE.verify(self.root)

    def test_invalid_or_mismatched_asset_alias_is_rejected(self):
        self.promote_version("0.7.10")
        for asset in ("../outside.zip", "tianji-duma-0.0.0.zip", "-0.7.10.zip"):
            with self.subTest(asset=asset):
                self.meta["assetName"] = asset
                self.write_json(".github/releases/latest.json", self.meta)
                with self.assertRaisesRegex(ValueError, "Unexpected release asset name"):
                    RELEASE.verify(self.root)

    def test_legacy_id_named_releases_remain_valid_without_an_alias(self):
        self.promote_version("0.7.9")
        self.meta.pop("assetName")
        self.rename_package(RELEASE.MOD_ID + "-0.7.9.zip")
        result = RELEASE.verify(self.root)
        self.assertEqual(result["assetName"], RELEASE.MOD_ID + "-0.7.9.zip")

    def test_missing_mechanical_icon_is_rejected_even_with_valid_checksum(self):
        self.rewrite_archive(lambda entries: [(name, data) for name, data in entries if not name.endswith("/机械马.png")])
        with self.assertRaisesRegex(ValueError, "ZIP contents"):
            RELEASE.verify(self.root)

    def test_missing_circle_mask_is_rejected_even_with_valid_checksum(self):
        self.rewrite_archive(lambda entries: [(name, data) for name, data in entries if not name.endswith("/圆形遮罩.png")])
        with self.assertRaisesRegex(ValueError, "ZIP contents"):
            RELEASE.verify(self.root)

    def test_duplicate_entry_is_rejected_even_with_valid_checksum(self):
        self.rewrite_archive(lambda entries: entries + [entries[0]])
        with self.assertRaisesRegex(ValueError, "duplicate ZIP"):
            RELEASE.verify(self.root)

    def test_tampered_package_checksum_is_rejected(self):
        self.meta["sha256"] = "0" * 64
        self.write_json(".github/releases/latest.json", self.meta)
        with self.assertRaisesRegex(ValueError, "Package checksum mismatch"):
            RELEASE.verify(self.root)

    def test_source_and_packaged_manifest_must_match(self):
        manifest = RELEASE.read_json(self.root / "mod/manifest.json")
        manifest["author"] = "different author"
        self.write_json("mod/manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "Source and packaged manifests differ"):
            RELEASE.verify(self.root)

    def test_catalog_version_download_and_checksum_cannot_drift(self):
        original = RELEASE.read_json(self.root / "mods.json")
        for key, value in (("version", "0.0.0"), ("download", "https://example.com/wrong.zip"), ("sha256", "0" * 64)):
            with self.subTest(key=key):
                catalog = json.loads(json.dumps(original))
                catalog["mods"][0][key] = value
                self.write_json("mods.json", catalog)
                with self.assertRaisesRegex(ValueError, "Catalog|catalog"):
                    RELEASE.verify(self.root)

    def test_release_file_cannot_escape_repository(self):
        self.meta["artifact"] = "../outside.zip"
        self.write_json(".github/releases/latest.json", self.meta)
        with self.assertRaisesRegex(ValueError, "escapes repository"):
            RELEASE.verify(self.root)

    def test_stale_packaged_readme_is_rejected(self):
        (self.root / "mod/README.md").write_text("newer instructions", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Stale packaged file"):
            RELEASE.verify(self.root)

    def test_windows_package_and_linux_checkout_text_line_endings_are_equivalent(self):
        for relative in ("mod/README.md", "mod/assets/horse/NOTICE.md"):
            path = self.root / relative
            contents = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
            path.write_bytes(contents.encode("utf-8"))
        self.assertEqual(RELEASE.verify(self.root)["sha256"], self.meta["sha256"])

    def test_unexpected_user_data_cannot_enter_release(self):
        self.rewrite_archive(lambda entries: entries + [(RELEASE.MOD_ID + "/data/book.json", b"{}")])
        with self.assertRaisesRegex(ValueError, "ZIP contents"):
            RELEASE.verify(self.root)


if __name__ == "__main__":
    unittest.main()
