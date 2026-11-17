// 種類別ワークスペースの外枠。左(狭い幅では下)のレールでチャット/エージェント/画像/動画/音楽を切り替える。
// エージェント(App)は切り替えても状態(下書き・SSE)を保つため常に描画し、非表示にするだけにする。
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Bot, Clapperboard, Image as ImageIcon, MessageSquare, Music } from "lucide-react";
import App from "./App.jsx";
import EngineButton from "./components/EngineButton.jsx";

// 再ビルド後に開きっぱなしのタブは古い分割ファイル名を読みに行き 404 で白画面になる。1回だけ再読込して新しい版を取る
const lazyView = (load) => lazy(() => load().catch((e) => {
  if (!sessionStorage.getItem("hub.reloaded")) {
    sessionStorage.setItem("hub.reloaded", "1");
    window.location.reload();
    return new Promise(() => {});
  }
  throw e;
}).then((m) => { sessionStorage.removeItem("hub.reloaded"); return m; }));
const ChatView = lazyView(() => import("./hub/ChatView.jsx"));
const ImageView = lazyView(() => import("./hub/ImageView.jsx"));
const VideoView = lazyView(() => import("./hub/VideoView.jsx"));
const MusicView = lazyView(() => import("./hub/MusicView.jsx"));

const KINDS = [
  { id: "chat", label: "チャット", icon: MessageSquare, active: "text-emerald-300 bg-emerald-500/10" },
  { id: "agent", label: "エージェント", icon: Bot, active: "text-sky-300 bg-sky-500/10" },
  { id: "image", label: "画像", icon: ImageIcon, active: "text-violet-300 bg-violet-500/10" },
  { id: "video", label: "動画", icon: Clapperboard, active: "text-rose-300 bg-rose-500/10" },
  { id: "music", label: "音楽", icon: Music, active: "text-amber-300 bg-amber-500/10" },
];
const IDS = new Set(KINDS.map((k) => k.id));

function fromHash() {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return IDS.has(h) ? h : null;
}

export default function Shell() {
  const [kind, setKind] = useState(() => fromHash() || localStorage.getItem("hub.kind") || "agent");
  const [videoSource, setVideoSource] = useState(null); // 画像→動画(I2V)の受け渡し

  useEffect(() => {
    const onHash = () => { const h = fromHash(); if (h) setKind(h); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    try { localStorage.setItem("hub.kind", kind); } catch { /* 保存不可は無視 */ }
    if (fromHash() !== kind) history.replaceState(null, "", `#${kind}`);
    document.title = kind === "agent" ? "ai-agent-lab" : `${KINDS.find((k) => k.id === kind).label} · ai-agent-lab`;
  }, [kind]);

  const toVideo = useCallback((item) => { setVideoSource(item); setKind("video"); }, []);

  return (
    <div className="flex h-dvh flex-col-reverse overflow-hidden bg-slate-950 text-slate-100 md:flex-row">
      <nav aria-label="種類" className="flex shrink-0 justify-around border-t border-slate-800 bg-slate-950 md:w-[72px] md:flex-col md:justify-start md:gap-1 md:border-r md:border-t-0 md:py-3">
        {KINDS.map(({ id, label, icon: Icon, active }) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            aria-current={kind === id ? "page" : undefined}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] transition md:mx-2 md:flex-none ${kind === id ? active : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}
          >
            <Icon size={20} aria-hidden="true" />
            <span className="leading-tight">{label}</span>
          </button>
        ))}
        <EngineButton />
      </nav>
      <main className="relative min-h-0 min-w-0 flex-1">
        <div className={kind === "agent" ? "h-full" : "hidden"}>
          <App />
        </div>
        {kind !== "agent" && (
          <Suspense fallback={<div className="p-6 text-sm text-slate-400">読み込み中…</div>}>
            {kind === "chat" && <ChatView />}
            {kind === "image" && <ImageView onToVideo={toVideo} />}
            {kind === "video" && <VideoView source={videoSource} onSourceChange={setVideoSource} />}
            {kind === "music" && <MusicView />}
          </Suspense>
        )}
      </main>
    </div>
  );
}
