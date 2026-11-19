import { lazy } from "react";

// 再ビルド後に開きっぱなしのタブは古い分割ファイル名を読みに行き 404 で白画面になる。1回だけ再読込して新しい版を取る
export const lazyView = (load) => lazy(() => load().catch((e) => {
  if (!sessionStorage.getItem("hub.reloaded")) {
    sessionStorage.setItem("hub.reloaded", "1");
    window.location.reload();
    return new Promise(() => {});
  }
  throw e;
}).then((m) => { sessionStorage.removeItem("hub.reloaded"); return m; }));
