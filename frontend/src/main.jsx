import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { lazyView } from "./lazyView.js";

// 幅の狭い端末 (横向きのスマホを含む) にはスマホ版を出す。?ui=desktop / ?ui=mobile で一時的に切り替えられる
const forced = new URLSearchParams(window.location.search).get("ui");
const mobile = forced ? forced === "mobile" : window.matchMedia("(max-width: 767px), (pointer: coarse) and (max-height: 520px)").matches;
if (mobile) {
  document.documentElement.dataset.ui = "mobile";
  for (const [media, color] of [["(prefers-color-scheme: light)", "#f4f6f4"], ["(prefers-color-scheme: dark)", "#0f1211"]]) {
    document.head.append(Object.assign(document.createElement("meta"), { name: "theme-color", media, content: color }));
  }
}
const Root = lazyView(() => (mobile ? import("./mobile/MobileApp.jsx") : import("./Shell.jsx")));

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>,
);
