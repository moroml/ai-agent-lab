// スマホ版の外枠。上に「PCの稼働状況」の1行、下に種類のタブ。画面の中身は種類ごとの *Screen.jsx。
// 一度開いた画面は隠すだけで残す (切り替えても生成中の追跡や会話の受信が途切れないように)。
import { Suspense, useCallback, useEffect, useState } from "react";
import { Bot, ChevronRight, Clapperboard, Image as ImageIcon, MessageSquare, Music } from "lucide-react";
import { NEEDS, useEngines } from "../components/EngineButton.jsx";
import { lazyView } from "../lazyView.js";
import { cx, Loading, Notice, Sheet } from "./ui.jsx";

const ChatScreen = lazyView(() => import("./ChatScreen.jsx"));
const AgentScreen = lazyView(() => import("./AgentScreen.jsx"));
const ImageScreen = lazyView(() => import("./ImageScreen.jsx"));
const VideoScreen = lazyView(() => import("./VideoScreen.jsx"));
const MusicScreen = lazyView(() => import("./MusicScreen.jsx"));
const EnginesScreen = lazyView(() => import("./EnginesScreen.jsx"));

const TABS = [
  { id: "chat", label: "チャット", icon: MessageSquare },
  { id: "agent", label: "エージェント", icon: Bot },
  { id: "image", label: "画像", icon: ImageIcon },
  { id: "video", label: "動画", icon: Clapperboard },
  { id: "music", label: "音楽", icon: Music },
];
const IDS = new Set(TABS.map((t) => t.id));

function fromHash() {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return IDS.has(h) ? h : null;
}

/** 今の画面に要るエンジンの状態を1行にまとめる。tone: ok / wait / warn / error */
function statusOf(eng, kind) {
  if (eng.st === undefined) return { tone: "wait", text: "PCの状態を確認しています…" };
  if (eng.st === null) return { tone: "error", text: "PCの状態を取得できません", hint: "開く" };
  const need = (NEEDS[kind] ?? []).map((id) => eng.byId[id]).filter(Boolean);
  const starting = need.find((s) => s.state === "starting");
  if (starting) return { tone: "wait", text: `${starting.label} を起動しています…` };
  const down = need.filter((s) => s.state !== "up");
  if (down.length) return { tone: "warn", text: `${down.map((s) => s.label).join("・")} が止まっています`, hint: "起動" };
  const loaded = eng.st.ollama?.models ?? [];
  return { tone: "ok", text: "稼働中", detail: loaded.length ? loaded.map((m) => m.name).join(" / ") : "モデル未読込" };
}

const LAMP = { ok: "bg-m-primary", wait: "bg-m-warning m-pulse", warn: "bg-m-warning", error: "bg-m-danger" };

export default function MobileApp() {
  const [kind, setKind] = useState(() => fromHash() || localStorage.getItem("hub.kind") || "chat");
  const [videoSource, setVideoSource] = useState(null);   // 画像→動画の受け渡し
  const [enginesOpen, setEnginesOpen] = useState(false);
  const eng = useEngines();

  useEffect(() => {
    const onHash = () => { const h = fromHash(); if (h) setKind(h); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    try { localStorage.setItem("hub.kind", kind); } catch { /* 保存不可は無視 */ }
    if (fromHash() !== kind) history.replaceState(history.state, "", `#${kind}`);
    document.title = `${TABS.find((t) => t.id === kind)?.label ?? ""} · ai-agent-lab`;
  }, [kind]);

  const toVideo = useCallback((item) => { setVideoSource(item); setKind("video"); }, []);
  const [visited, setVisited] = useState(() => new Set([kind]));
  useEffect(() => setVisited((v) => (v.has(kind) ? v : new Set(v).add(kind))), [kind]);
  const pane = (id, el) => visited.has(id) && (
    <div className={kind === id ? "h-full" : "hidden"}>
      <Suspense fallback={<Loading text="画面を読み込んでいます…" />}>{el}</Suspense>
    </div>
  );

  const status = statusOf(eng, kind);
  return (
    <div className="m-root flex h-dvh flex-col overflow-hidden bg-m-bg text-m-fg">
      <button
        type="button"
        onClick={() => setEnginesOpen(true)}
        aria-label={`エンジンを開く。${status.text}${status.detail ? `、${status.detail}` : ""}`}
        className="flex min-h-12 shrink-0 items-center gap-2 bg-m-sunken px-4 pt-[env(safe-area-inset-top)] text-left text-sm active:bg-m-line"
      >
        <span aria-hidden="true" className={cx("size-2.5 shrink-0 rounded-full", LAMP[status.tone])} />
        <span className={cx("shrink-0", status.tone === "ok" ? "text-m-muted" : "font-semibold text-m-fg")}>{status.text}</span>
        <span className="m-num min-w-0 flex-1 truncate text-xs text-m-subtle">{status.detail}</span>
        {status.hint && <span className="shrink-0 font-semibold text-m-primary">{status.hint}</span>}
        <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-m-subtle" />
      </button>

      <main className="relative min-h-0 flex-1">
        {pane("chat", <ChatScreen eng={eng} />)}
        {pane("agent", <AgentScreen eng={eng} />)}
        {pane("image", <ImageScreen eng={eng} onToVideo={toVideo} />)}
        {pane("video", <VideoScreen eng={eng} source={videoSource} onSourceChange={setVideoSource} />)}
        {pane("music", <MusicScreen eng={eng} />)}
      </main>

      {eng.note && !enginesOpen && (
        <div className="shrink-0 px-3 pb-2">
          <Notice tone={eng.note.error ? "error" : "info"} onClose={() => eng.setNote(null)}>{eng.note.lines.join("\n")}</Notice>
        </div>
      )}

      <nav aria-label="種類" className="flex shrink-0 border-t border-m-line bg-m-surface pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            aria-current={kind === id ? "page" : undefined}
            className={cx("flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs", kind === id ? "font-semibold text-m-primary" : "text-m-muted")}
          >
            <span className={cx("flex h-7 w-12 items-center justify-center rounded-full", kind === id && "bg-m-primary-soft")}>
              <Icon size={22} aria-hidden="true" />
            </span>
            <span className="max-w-full truncate leading-tight">{label}</span>
          </button>
        ))}
      </nav>

      <Sheet open={enginesOpen} onClose={() => setEnginesOpen(false)} title="エンジン">
        <Suspense fallback={<Loading />}>
          <EnginesScreen eng={eng} />
        </Suspense>
      </Sheet>
    </div>
  );
}
