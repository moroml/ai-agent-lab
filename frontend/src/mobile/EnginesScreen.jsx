// スマホ版のエンジン操作。下のシート (タイトルと閉じるはシート側) の中身だけを描く。
// サービス・VRAM・モデル・推論エンジンを1か所で、自分で起動・停止する。モデルの導入・API キー・接続コードは PC だけの操作なので出さない。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Eraser, Play, Power, RotateCw, Square } from "lucide-react";
import {
  fetchEngines, fetchGpu, fetchSystemModels, freeVram, loadModel, serviceAction, setAutoload, startEngine, startEngines, stopEngine, stopEngines, unloadModel,
} from "../api.js";
import { fmtGB } from "../derive.js";
import { Button, cx, Field, inputCls, Loading, Notice, Segmented, Spinner, SwitchRow } from "./ui.jsx";

const SERVICE_STATE = {
  up: { text: "稼働中", dot: "bg-m-primary" },
  starting: { text: "起動中…", dot: "bg-m-warning m-pulse" },
  down: { text: "停止中", dot: "bg-m-line-strong" },
};
const ENGINE_STATE = {
  ready: SERVICE_STATE.up,
  starting: { text: "起動中…（読み込みに数分かかります）", dot: SERVICE_STATE.starting.dot },
  stopped: SERVICE_STATE.down,
};

/** 1回目で「もう一度押すと…」に変わり、3秒以内の2回目で実行する */
function useArm() {
  const [armed, setArmed] = useState("");
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(""), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, (id, fn) => (armed === id ? (setArmed(""), fn()) : setArmed(id))];
}

const remain = (expires) => {
  if (!expires) return "";
  const min = Math.round((new Date(expires) - Date.now()) / 60000);
  return min > 60 * 24 ? "ずっと載せたままにします。" : min > 0 ? `あと約${min}分で自動解放します。` : "";
};

function Lamp({ look }) {
  return <span aria-hidden="true" className={cx("size-3 shrink-0 rounded-full", look.dot)} />;
}

export default function EnginesScreen({ eng }) {
  const { st } = eng;
  const [busy, setBusy] = useState("");   // 操作中のボタン id
  const [armed, arm] = useArm();
  const [models, setModels] = useState(undefined);     // undefined=読込中 / null=失敗
  const [gpu, setGpu] = useState(undefined);
  const [engines, setEngines] = useState(undefined);   // 推論エンジン (Strata 等)。無い・取れないときは出さない

  const load = useCallback(() => {
    fetchSystemModels().then(setModels).catch(() => setModels(null));
    fetchGpu().then(setGpu).catch(() => setGpu(null));
    fetchEngines().then((d) => setEngines(d.engines)).catch(() => setEngines(null));
  }, []);
  const settling = models?.models?.some((m) => m.state === "loading") || engines?.some((e) => e.state === "starting");
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, settling ? 2000 : 6000);
    window.addEventListener("system-changed", load);
    return () => { clearInterval(t); window.removeEventListener("system-changed", load); };
  }, [load, settling]);

  const act = async (id, fn, pending) => {
    setBusy(id);
    await eng.run(fn, pending);
    setBusy("");
  };

  const note = eng.note && (
    <div className="sticky top-0 z-10 -mx-4 bg-m-raised px-4 pb-3">
      <Notice tone={eng.note.error ? "error" : "info"} onClose={() => eng.setNote(null)}>{eng.note.lines.join("\n")}</Notice>
    </div>
  );

  if (st === undefined) return <>{note}<Loading text="エンジンの状態を確認しています…" /></>;
  if (st === null) {
    return (
      <div className="space-y-3">
        {note}
        <Notice tone="error" action={<Button icon={RotateCw} onClick={eng.reload}>もう一度確認する</Button>}>
          サーバーから状態を取得できませんでした。PC の電源とつながりを確認してから、もう一度試してください。
        </Notice>
      </div>
    );
  }

  const services = st.services;
  const anyUp = services.some((s) => s.state !== "down");
  const allUp = services.every((s) => s.state === "up");
  const ollama = services.find((s) => s.id === "ollama");

  return (
    <div className="space-y-8">
      {note}

      <section aria-labelledby="m-eng-all" className="space-y-2">
        <h3 id="m-eng-all" className="text-base font-semibold">まとめて操作</h3>
        <p className="text-sm text-m-muted">アプリを開いても、エンジンは自動では起動しません。使うものだけ起動してください。</p>
        <Button variant="primary" icon={Play} className="w-full" busy={busy === "all-start"} disabled={!!busy || allUp}
                onClick={() => act("all-start", () => startEngines(), "すべて起動しています…")}>すべて起動</Button>
        {allUp && <p className="text-sm text-m-subtle">すべて稼働中です。</p>}
        <Button variant={armed === "all-stop" ? "danger" : "secondary"} icon={Square} className="w-full" busy={busy === "all-stop"} disabled={!!busy || !anyUp}
                onClick={() => arm("all-stop", () => act("all-stop", () => stopEngines(), "すべて停止しています…"))}>
          {armed === "all-stop" ? "停止する" : "すべて停止"}
        </Button>
        {armed === "all-stop" && <p role="status" className="text-sm text-m-muted">もう一度押すと、すべてのサービスを停止します。</p>}
        {!anyUp && <p className="text-sm text-m-subtle">止まっているので、停止するものはありません。</p>}
      </section>

      <section aria-labelledby="m-eng-svc" className="space-y-3">
        <h3 id="m-eng-svc" className="text-base font-semibold">サービス</h3>
        <ul className="space-y-3">
          {services.map((s) => {
            const look = SERVICE_STATE[s.state] ?? SERVICE_STATE.down;
            return (
              <li key={s.id} className="rounded-2xl border border-m-line bg-m-surface p-4">
                <div className="flex items-center gap-2">
                  <Lamp look={look} />
                  <h4 className="min-w-0 flex-1 truncate text-base font-semibold">{s.label}</h4>
                  <span className="shrink-0 text-sm font-semibold text-m-muted">{look.text}</span>
                </div>
                <p className="mt-1 text-sm text-m-muted">{s.purpose}</p>
                <p className="text-sm text-m-subtle">ポート <span className="m-num">{s.port}</span>{s.pid ? <>・PID <span className="m-num">{s.pid}</span></> : null}</p>
                {s.conflict && <p className="mt-1 text-sm text-m-warning">{s.conflict} が既定の番号を使っています。起動すると空いている番号を使います。</p>}
                {!s.startable && <p className="mt-1 text-sm text-m-warning">起動できません: {s.why}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {s.state === "down" ? (
                    <Button icon={Play} busy={busy === `${s.id}-start`} disabled={!!busy || !s.startable}
                            onClick={() => act(`${s.id}-start`, () => serviceAction(s.id, "start"), `${s.label} を起動しています…`)}>起動</Button>
                  ) : (
                    <>
                      <Button icon={Square} busy={busy === `${s.id}-stop`} disabled={!!busy}
                              onClick={() => act(`${s.id}-stop`, () => serviceAction(s.id, "stop"), `${s.label} を停止しています…`)}>停止</Button>
                      <Button icon={RotateCw} busy={busy === `${s.id}-restart`} disabled={!!busy || !s.startable}
                              onClick={() => act(`${s.id}-restart`, () => serviceAction(s.id, "restart"), `${s.label} を再起動しています…`)}>再起動</Button>
                      {s.id === "comfy" && s.state === "up" && (
                        // 止めずに、載っている画像・動画のモデルだけ外す
                        <Button icon={Eraser} busy={busy === "comfy-free"} disabled={!!busy}
                                onClick={() => act("comfy-free", () => freeVram(["comfy"]), "ComfyUI のモデルを解放しています…")}>モデルを外す</Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="m-eng-vram" className="space-y-3">
        <h3 id="m-eng-vram" className="text-base font-semibold">VRAM</h3>
        <GpuBar gpu={gpu} />
        <Button variant={armed === "free" ? "danger" : "secondary"} icon={Eraser} className="w-full" busy={busy === "free"} disabled={!!busy}
                onClick={() => arm("free", () => act("free", () => freeVram(), "VRAM を空けています…"))}>
          {armed === "free" ? "空ける" : "VRAM を空ける"}
        </Button>
        <p role={armed === "free" ? "status" : undefined} className="text-sm text-m-subtle">
          {armed === "free"
            ? "もう一度押すと、Ollama のモデルを降ろし、ComfyUI のモデルを外し、ACE-Step を停止します。"
            : "Ollama・ComfyUI・ACE-Step が使っている VRAM をまとめて解放します。"}
        </p>
      </section>

      <ModelsSection models={models} ollama={ollama} autoload={st.autoload} busy={busy} act={act} armed={armed} arm={arm} reload={load} />

      <EnginesSection engines={engines} busy={busy} act={act} />
    </div>
  );
}

function GpuBar({ gpu }) {
  if (gpu === undefined) return <Loading text="VRAM の使用量を確認しています…" />;
  if (!gpu?.available) return <p className="text-sm text-m-muted">VRAM の使用量を取得できません。</p>;
  const total = gpu.total_bytes || 1;
  const own = gpu.ollama_bytes ?? 0;
  const other = Math.max(0, (gpu.used_bytes ?? 0) - own);
  return (
    <div>
      <p className="text-base">
        <span className="m-num">{fmtGB(gpu.used_bytes)} / {fmtGB(total)} GB</span> 使用中
      </p>
      <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-m-sunken" aria-hidden="true">
        <div className="h-full bg-m-primary" style={{ width: `${(own / total) * 100}%` }} />
        <div className="h-full bg-m-line-strong" style={{ width: `${(other / total) * 100}%` }} />
      </div>
      <ul className="mt-2 space-y-1 text-sm text-m-muted">
        <li className="flex items-center gap-2"><span aria-hidden="true" className="size-3 shrink-0 rounded-sm bg-m-primary" />Ollama のモデル <span className="m-num">{fmtGB(own)} GB</span></li>
        <li className="flex items-center gap-2"><span aria-hidden="true" className="size-3 shrink-0 rounded-sm bg-m-line-strong" />ほかのプロセス（画像・音楽など） <span className="m-num">{fmtGB(other)} GB</span></li>
      </ul>
    </div>
  );
}

function ModelsSection({ models, ollama, autoload, busy, act, armed, arm, reload }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const rows = models?.models ?? [];
  const loadedCount = rows.filter((m) => m.loaded).length;
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((m) => (all || ql || m.loaded || m.state === "loading" || m.state === "error")
      && (!ql || `${m.label} ${m.tag} ${m.for}`.toLowerCase().includes(ql)));
  }, [rows, q, all]);

  return (
    <section aria-labelledby="m-eng-models" className="space-y-3">
      <h3 id="m-eng-models" className="text-base font-semibold">モデル（Ollama）</h3>
      <SwitchRow label="自動読み込み" checked={!!autoload} disabled={!!busy}
                 hint="入れると、チャットを開いたときや待機中にモデルを先に読み込みます。切っておけば、降ろしたモデルが勝手に戻りません。"
                 onChange={(on) => act("autoload", () => setAutoload(on).then((r) => ({ done: [r.autoload ? "自動読み込みを入れました" : "自動読み込みを切りました"] })), "設定しています…")} />

      {ollama?.state !== "up" ? (
        <p className="text-sm text-m-muted">
          {ollama?.state === "starting" ? "Ollama を起動しています…" : "Ollama が止まっています。上のサービスで Ollama を起動すると、モデルを操作できます。"}
        </p>
      ) : models === undefined ? (
        <Loading text="モデルの一覧を読み込んでいます…" />
      ) : models === null ? (
        <Notice tone="error" action={<Button icon={RotateCw} onClick={reload}>もう一度読み込む</Button>}>モデルの一覧を取得できませんでした。</Notice>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-m-muted">VRAM に載っているもの <span className="m-num">{loadedCount}</span> 件</p>
            <Button variant={armed === "unload-all" ? "danger" : "secondary"} icon={Eraser} busy={busy === "unload-all"} disabled={!!busy || !loadedCount}
                    onClick={() => arm("unload-all", () => act("unload-all", () => unloadModel(""), "すべて降ろしています…"))}>
              {armed === "unload-all" ? "降ろす" : "すべて降ろす"}
            </Button>
          </div>
          {armed === "unload-all" && <p role="status" className="text-sm text-m-muted">もう一度押すと、載っているモデルをすべて降ろします。</p>}
          <Field label="モデルを探す">
            <input aria-label="モデルを探す" value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前・用途" className={inputCls} />
          </Field>
          <Segmented label="表示するモデル" value={all} onChange={setAll}
                     options={[{ value: false, label: "載っているもの" }, { value: true, label: `すべて（${rows.length}）` }]} />
          <ul className="divide-y divide-m-line">
            {shown.map((m) => (
              <li key={m.tag} className="py-3">
                <p className="text-base font-semibold">{m.label}</p>
                <p className="m-num break-all text-xs text-m-subtle">{m.tag}</p>
                {m.for && <p className="text-sm text-m-muted">{m.for}</p>}
                {m.loaded && (
                  <p className="text-sm text-m-primary">VRAM に載っています（<span className="m-num">{fmtGB(m.size_vram)} GB</span>）。{remain(m.expires_at)}</p>
                )}
                {m.state === "error" && <p role="alert" className="text-sm text-m-danger">読み込みに失敗しました: {m.error}</p>}
                <div className="mt-2">
                  {!m.installed ? (
                    <p className="text-sm text-m-subtle">未導入です。導入は PC で行ってください。</p>
                  ) : m.loaded ? (
                    <Button icon={Power} busy={busy === `u-${m.tag}`} disabled={!!busy}
                            onClick={() => act(`u-${m.tag}`, () => unloadModel(m.tag), `${m.label} を降ろしています…`)}>降ろす</Button>
                  ) : m.state === "loading" ? (
                    <p role="status" className="flex items-center gap-2 text-sm text-m-muted"><Spinner /> 読み込んでいます…</p>
                  ) : (
                    <Button icon={Play} busy={busy === `l-${m.tag}`} disabled={!!busy}
                            onClick={() => act(`l-${m.tag}`, () => loadModel(m.tag), `${m.label} の読み込みを始めています…`)}>読み込む</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {!shown.length && (
            <p className="text-sm text-m-muted">{q ? "一致するモデルがありません。" : "VRAM に載っているモデルはありません。「すべて」から読み込めます。"}</p>
          )}
        </>
      )}
    </section>
  );
}

function EnginesSection({ engines, busy, act }) {
  if (!engines?.length) return null;
  return (
    <section aria-labelledby="m-eng-infer" className="space-y-3">
      <h3 id="m-eng-infer" className="text-base font-semibold">推論エンジン</h3>
      <ul className="space-y-3">
        {engines.map((e) => {
          const look = ENGINE_STATE[e.state] ?? ENGINE_STATE.stopped;
          return (
            <li key={e.name} className="rounded-2xl border border-m-line bg-m-surface p-4">
              <div className="flex items-center gap-2">
                <Lamp look={look} />
                <h4 className="min-w-0 flex-1 truncate text-base font-semibold">{e.label}</h4>
              </div>
              <p className="mt-1 text-sm text-m-muted">{look.text}</p>
              {e.note && <p className="text-sm text-m-subtle">{e.note}</p>}
              <div className="mt-3">
                {e.state === "stopped" ? (
                  e.startable ? (
                    <>
                      <Button icon={Play} busy={busy === `e-${e.name}`} disabled={!!busy} aria-label={`${e.label} を起動`}
                              onClick={() => act(`e-${e.name}`, () => startEngine(e.name), `${e.label} を起動しています…`)}>起動</Button>
                      <p className="mt-2 text-sm text-m-subtle">Ollama のモデルを VRAM から降ろしてから起動します。</p>
                    </>
                  ) : <p className="text-sm text-m-subtle">起動の設定がないため、ここからは起動できません。</p>
                ) : (
                  <Button icon={Square} busy={busy === `e-${e.name}`} disabled={!!busy} aria-label={`${e.label} を停止`}
                          onClick={() => act(`e-${e.name}`, () => stopEngine(e.name), `${e.label} を停止しています…`)}>停止</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
