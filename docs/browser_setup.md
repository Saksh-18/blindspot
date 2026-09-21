# Cross-Browser Setup Guide

This guide details how to install and run the **BlindSpot Privacy-Preserving Vision Agent** across all major web browsers.

---

## 1. Microsoft Edge (Recommended for Windows)

Microsoft Edge is built on the Chromium engine and natively supports Manifest V3 with Edge's built-in sidebar.

### Installation Steps:
1. Open **Microsoft Edge**.
2. Go to the address bar, type `edge://extensions` and hit <kbd>Enter</kbd>.
3. In the left sidebar, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button at the top.
5. In the file picker, select the `extension/` directory from this project:
   ```
   browser-vision-agent/extension
   ```
6. The extension is now loaded! Click the **BlindSpot** icon in your toolbar to open the native side panel.

> [!TIP]
> **Allow File URLs**: If testing on local HTML test pages (`file://...`), click **Details** on the extension card in `edge://extensions` and enable **"Allow access to file URLs"**.

---

## 2. Mozilla Firefox

Mozilla Firefox uses the Gecko rendering engine and the Firefox WebExtension standard.

### Installation Steps:
1. Open **Mozilla Firefox**.
2. In the address bar, navigate to:
   ```
   about:debugging#/runtime/this-firefox
   ```
3. Under **Temporary Extensions**, click the **Load Temporary Add-on...** button.
4. Browse to the `extension-firefox/` folder in this project and select `manifest.json`:
   ```
   browser-vision-agent/extension-firefox/manifest.json
   ```
5. The extension will install immediately.
6. Click the extension toolbar icon or press <kbd>Ctrl</kbd> + <kbd>B</kbd> (Sidebar) to access the **Privacy-Preserving Vision Agent** sidebar.

> [!NOTE]
> Firefox temporary add-ons remain active for your current Firefox session. To refresh changes during development, simply click **Reload** in `about:debugging`.

---

## 3. Google Chrome & Brave Browser

### Google Chrome:
1. Open Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `extension/` folder.
4. Click the extension icon to trigger the Chrome side panel.

### Brave Browser:
1. Open Brave and navigate to `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.

---

## 4. Opera Browser

1. Open Opera and navigate to `opera://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and choose `extension/`.

---

## Build & Sync Command

Whenever you make updates to the core extension code in `extension/`, run the build script to synchronize the Firefox build and create release ZIPs:

```powershell
# Sync extension-firefox/
python scripts/build_extension.py

# Or sync + package ready-to-distribute ZIPs in dist/
python scripts/build_extension.py --zip
```
