#!/bin/bash
# 打包成 macOS .app，并输出可分发的 zip
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(cat VERSION)"
APP="dist/PortConsole.app"
ZIP="dist/PortConsole-macOS-${VERSION}.zip"

rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

cp server.mjs "$APP/Contents/Resources/app/server.mjs"
cp -R public "$APP/Contents/Resources/app/public"
cp packaging/launcher.sh "$APP/Contents/MacOS/PortConsole"
chmod +x "$APP/Contents/MacOS/PortConsole"

# 图标：有 1024 源图就生成 icns
if [ -f assets/icon-1024.png ]; then
  ICONSET="dist/AppIcon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" "512 512x512" "1024 512x512@2x"; do
    set -- $spec
    sips -z "$1" "$1" assets/icon-1024.png --out "$ICONSET/icon_$2.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PortConsole</string>
  <key>CFBundleDisplayName</key><string>端口控制台</string>
  <key>CFBundleIdentifier</key><string>com.forest0622.portconsole</string>
  <key>CFBundleExecutable</key><string>PortConsole</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
</dict>
</plist>
PLIST

# ad-hoc 签名，避免 Apple Silicon 上被直接判定为损坏
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

ditto -c -k --keepParent "$APP" "$ZIP"
echo "已生成：$APP"
echo "分发包：$ZIP"
du -sh "$APP" "$ZIP"
