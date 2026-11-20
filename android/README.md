# ai-agent-lab Android

PC で動く ai-agent-lab のダッシュボード(`https://<host>:8765/`)を開く薄いネイティブシェル。
PC 側が止まっているときは、ランチャー(`https://<host>:8766`)に起動を頼める。接続は Tailscale 経由の HTTPS のみ。

## ビルド

事前に `android/local.properties` に `sdk.dir=` を書く(任意で `aal.host=my-pc.tailxxxx.ts.net` で初期アドレスを埋め込める。未設定なら初回に入力)。

```powershell
cd android; ./gradlew.bat assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## インストール

スマホのブラウザで `https://<host>:8765/app.apk` を開く(ビルドした APK をサーバーが配る)。USB でつないでいるなら:

```powershell
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

初回起動で「PCのアドレス」を保存する(`https://` やポートは不要)。
