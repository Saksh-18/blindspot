#!/usr/bin/env python3
"""
build_extension.py - Cross-Browser Extension Builder & Packager for BlindSpot Vision Agent

Supports:
- Google Chrome (Chromium)
- Microsoft Edge (Chromium)
- Mozilla Firefox (Gecko)
- Brave / Opera (Chromium)

Usage:
    python scripts/build_extension.py              # Syncs extension-firefox/ directory
    python scripts/build_extension.py --zip        # Syncs and generates release ZIPs in dist/
"""

import argparse
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
EXT_DIR = ROOT_DIR / "extension"
FIREFOX_EXT_DIR = ROOT_DIR / "extension-firefox"
DIST_DIR = ROOT_DIR / "dist"

def validate_manifest(manifest_path: Path, browser_type: str = "chromium"):
    """Validates manifest JSON structure."""
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_path}")
    
    with open(manifest_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    assert data.get("manifest_version") == 3, "manifest_version must be 3"
    assert "name" in data, "manifest missing 'name'"
    assert "version" in data, "manifest missing 'version'"

    if browser_type == "firefox":
        assert "browser_specific_settings" in data, "Firefox manifest missing 'browser_specific_settings'"
        assert "sidebar_action" in data, "Firefox manifest missing 'sidebar_action'"
        assert "sidePanel" not in data.get("permissions", []), "Firefox manifest should not contain 'sidePanel' permission"
    else:
        assert "side_panel" in data or "action" in data, "Chromium manifest missing side_panel or action"
    
    print(f"  [OK] Validated {browser_type} manifest: {manifest_path.name}")

def sync_firefox_extension():
    """Copies extension files to extension-firefox/ with the Firefox manifest."""
    print("\n[*] Syncing Firefox extension bundle (`extension-firefox/`)...")
    
    if FIREFOX_EXT_DIR.exists():
        shutil.rmtree(FIREFOX_EXT_DIR)
    
    FIREFOX_EXT_DIR.mkdir(parents=True, exist_ok=True)
    
    # Files to ignore when copying
    ignore_patterns = shutil.ignore_patterns(
        "manifest.firefox.json",
        "*.pyc",
        "__pycache__",
        ".DS_Store"
    )
    
    # Copy all extension files
    for item in EXT_DIR.iterdir():
        if item.name == "manifest.firefox.json":
            continue
        dest = FIREFOX_EXT_DIR / item.name
        if item.is_dir():
            shutil.copytree(item, dest, ignore=ignore_patterns)
        else:
            shutil.copy2(item, dest)
            
    # Copy Firefox manifest as manifest.json
    ff_manifest_src = EXT_DIR / "manifest.firefox.json"
    ff_manifest_dst = FIREFOX_EXT_DIR / "manifest.json"
    shutil.copy2(ff_manifest_src, ff_manifest_dst)
    
    # Validate both manifests
    validate_manifest(EXT_DIR / "manifest.json", "chromium")
    validate_manifest(ff_manifest_dst, "firefox")
    
    print(f"  [OK] Successfully created Firefox extension at: {FIREFOX_EXT_DIR.resolve()}")

def make_zip(source_dir: Path, zip_path: Path):
    """Zips the directory contents."""
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(source_dir):
            for file in files:
                file_path = Path(root) / file
                if file == "manifest.firefox.json":
                    continue
                arcname = file_path.relative_to(source_dir)
                zf.write(file_path, arcname)
    print(f"  [OK] Created ZIP: {zip_path.relative_to(ROOT_DIR)} ({zip_path.stat().st_size / 1024:.1f} KB)")

def package_distributions():
    """Packages zip files for both Chromium and Firefox."""
    print("\n[*] Creating distribution packages in `dist/`...")
    DIST_DIR.mkdir(exist_ok=True)
    
    chrome_edge_zip = DIST_DIR / "blindspot-chrome-edge.zip"
    firefox_zip = DIST_DIR / "blindspot-firefox.zip"
    
    make_zip(EXT_DIR, chrome_edge_zip)
    make_zip(FIREFOX_EXT_DIR, firefox_zip)

def print_usage_instructions():
    print("\n" + "=" * 55)
    print("  Browser Setup & Loading Instructions")
    print("=" * 55)
    print("\n1. Google Chrome / Brave / Opera:")
    print("   - Navigate to: chrome://extensions (or brave://extensions)")
    print("   - Enable 'Developer mode' (top right)")
    print("   - Click 'Load unpacked' -> Select the `extension/` folder")
    print("\n2. Microsoft Edge:")
    print("   - Navigate to: edge://extensions")
    print("   - Enable 'Developer mode' (left sidebar)")
    print("   - Click 'Load unpacked' -> Select the `extension/` folder")
    print("\n3. Mozilla Firefox:")
    print("   - Navigate to: about:debugging#/runtime/this-firefox")
    print("   - Click 'Load Temporary Add-on...'")
    print("   - Select `manifest.json` from the `extension-firefox/` folder")
    print("=" * 55 + "\n")

def main():
    parser = argparse.ArgumentParser(description="BlindSpot Extension Multi-Browser Build Script")
    parser.add_argument("--zip", action="store_true", help="Generate distributable ZIP packages in dist/")
    args = parser.parse_args()

    sync_firefox_extension()
    if args.zip:
        package_distributions()
    print_usage_instructions()

if __name__ == "__main__":
    main()
