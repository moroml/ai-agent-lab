import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { fetchSystemStatus, pullModel } from "../api.js";
import { groupByBackend, modelName, shortBaseUrl } from "../derive.js";
import EngineControls from "./EngineControls.jsx";

/**
 * モデル選択(カード式)。まず接続先サーバーのカード(Ollama / llama-server /
 * Strata / Claude API など、サーバーごとに分かれている)を選び、そのサーバーの
 * モデルをチップから選ぶ。モックアップ v1/v3 の見せ方に合わせたもの。
 *
 * describe(m) は呼び出し側が各モデルの表示情報を返す:
 *   { blocked: 選べないか, note: " ※未導入" 等の注記, suffix: "(用途)" 等の補足 }
 * extraOptions は auto / none のような「モデル以外」の選択肢で、チップで出す。
 */
export default function ModelPicker({ models, value, onChange, extraOptions = [], describe, onEnginesChanged }) {
  const groups = useMemo(() => groupByBackend(models), [models]);
  const valueGroupKey = groups.find((g) => g.models.some((m) => m.key === value))?.key ?? null;
  const [activeKey, setActiveKey] = useState(valueGroupKey ?? groups[0]?.key ?? null);
  const [showBlocked, setShowBlocked] = useState(false);

  // 外から選択が変わったら(プリフィル等)、そのモデルのサーバーを開いておく
  useEffect(() => {
    if (valueGroupKey) setActiveKey(valueGroupKey);
  }, [valueGroupKey]);

  const active = groups.find((g) => g.key === activeKey) ?? groups[0] ?? null;

  const groupNote = (g) => {
    const sts = g.models.map((m) => m.backend_status).filter(Boolean);
    let note;
    if (sts.length && sts.every((s) => s === "server_unreachable")) note = "未接続";
    else if (sts.some((s) => s === "no_api_key")) note = "APIキー未設定";
    else note = `${g.models.length} モデル`;
    // 接続先は http:// を付けず localhost:ポート の短い形で添える
    const short = g.backend === "openai" ? shortBaseUrl(g.base_url) : "";
    return short ? `${short} ・ ${note}` : note;
  };

  const chipCls = (selected) =>
    `flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
      selected
        ? "border-blue-500 bg-blue-500/15 text-slate-100"
        : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
    }`;

  return (
    <div>
      {extraOptions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {extraOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              title={o.title}
              onClick={() => onChange(o.value)}
              aria-pressed={value === o.value}
              className={chipCls(value === o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {/* サーバー選択カード */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="接続先サーバー">
        {groups.map((g) => {
          const contains = g.models.some((m) => m.key === value);
          const isActive = active?.key === g.key;
          return (
            <button
              key={g.key}
              type="button"
              title={g.base_url ? `接続先 ${shortBaseUrl(g.base_url)}` : undefined}
              onClick={() => setActiveKey(g.key)}
              aria-pressed={isActive}
              className={`min-w-40 rounded-xl border px-3 py-2 text-left transition-colors ${
                isActive
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-slate-700 bg-slate-950 hover:border-slate-500"
              }`}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-100">
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                {contains && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-400" title="選択中のモデルはこのサーバー" />}
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-400">{groupNote(g)}</span>
            </button>
          );
        })}
      </div>

      {active?.backend === "openai" && (
        <EngineControls baseUrls={[...new Set(active.models.map((m) => m.base_url))]} onChanged={onEnginesChanged} />
      )}

      {/* 選択中サーバーのモデル。用途の説明はツールチップへ回し、今使えないモデルは畳む */}
      {active && (() => {
        const items = active.models.map((m) => ({ m, d: describe ? describe(m) : { blocked: false, note: "", suffix: "" } }));
        const usable = items.filter(({ m, d }) => !d.blocked || m.key === value);
        const blocked = items.filter(({ m, d }) => d.blocked && m.key !== value);
        const chip = ({ m, d }) => {
          const selected = value === m.key;
          const why = d.blocked ? (d.note || "").trim() || "このモデルは今使えません" : "";
          return (
            <button
              key={m.key}
              type="button"
              disabled={d.blocked}
              onClick={() => onChange(m.key)}
              aria-pressed={selected}
              title={[modelName(m) !== m.tag ? m.tag : "", d.suffix, why].filter(Boolean).join(" ・ ")}
              className={`${chipCls(selected)} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <span className="font-medium">{modelName(m)}</span>
              {d.note && <span className="text-[11px] text-amber-400">{d.note.trim()}</span>}
            </button>
          );
        };
        return (
          <div className="mt-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="モデル">
              {usable.map(chip)}
              {!usable.length && <p className="text-xs text-slate-500">このサーバーで今使えるモデルはありません</p>}
            </div>
            {blocked.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setShowBlocked((v) => !v)}
                  aria-expanded={showBlocked}
                  className="text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
                >
                  {showBlocked ? "今使えないモデルを隠す" : `今使えないモデル ${blocked.length} 件を表示`}
                </button>
                {showBlocked && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {blocked.map((it) => (it.m.backend_status === "not_installed" ? (
                      <span key={it.m.key} className="flex items-center gap-1">
                        {chip(it)}
                        <PullButton tag={it.m.tag} onDone={onEnginesChanged} />
                      </span>
                    ) : chip(it)))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

/** 未導入の Ollama モデルをアプリ内で導入する(ollama pull 相当)。進み具合を2秒ごとに見る。 */
function PullButton({ tag, onDone }) {
  const [st, setSt] = useState(null);   // { status, completed, total, error }
  const running = st && !["success", "error"].includes(st.status);

  useEffect(() => {
    if (!running) return undefined;
    let misses = 0;   // 30秒続けて状態が取れなければ失敗として止める(押せないまま回り続けるのを避ける)
    const miss = (why) => { if (++misses >= 15) setSt({ status: "error", error: why }); };
    const t = setInterval(() => fetchSystemStatus().then((d) => {
      const p = d.pulls?.[tag];
      if (!p) return miss("導入の進み具合を取得できません");
      misses = 0;
      setSt(p);
      if (p.status === "success") onDone?.();
    }).catch(() => miss("サーバーに接続できません")), 2000);
    return () => clearInterval(t);
  }, [running, tag, onDone]);

  const start = () => {
    setSt({ status: "starting", completed: 0, total: 0, error: "" });
    pullModel(tag).catch((e) => setSt({ status: "error", error: e.message }));
  };
  const pct = st?.total ? Math.floor((st.completed / st.total) * 100) : null;
  if (st?.status === "success") return <span className="text-[11px] text-green-400">導入しました</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={start} disabled={running} title={`${tag} をダウンロードして導入します`}
              className="flex min-h-7 items-center gap-1 rounded-full border border-blue-500/40 px-2 text-[11px] text-blue-200 hover:bg-blue-500/10 disabled:opacity-70">
        {running ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
        {running ? (pct !== null ? `導入中 ${pct}%` : "導入中…") : st?.status === "error" ? "再試行" : "導入"}
      </button>
      {/* 失敗の理由はツールチップに隠さず横に出す */}
      {st?.status === "error" && <span role="alert" className="text-[11px] text-red-400">失敗: {st.error}</span>}
    </span>
  );
}
