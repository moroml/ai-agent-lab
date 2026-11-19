// スマホ版のエージェント。タブの中は2段: 依頼と一覧 (ここ) → 1件の実行の詳細 (AgentRun)。
// 依頼の送り方・一覧の並べ方・シークレットの扱いは PC 版 (App.jsx / TaskInput.jsx) と同じ。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, EyeOff, Play, Power, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { discardRun, fetchModels, fetchRuns, startEngines, startRun } from "../api.js";
import { fmtAgo } from "../derive.js";
import AgentOptions, { countDiff, DEFAULTS, useOptionGuards } from "./AgentOptions.jsx";
import AgentRun, { RunMissing, RunStatus } from "./AgentRun.jsx";
import { Button, Empty, Field, inputCls, Loading, Notice, ScreenHeader, cx } from "./ui.jsx";

const SAMPLE_TASK = "ブロック崩しゲームを作って";

export default function AgentScreen({ eng }) {
  const rootRef = useRef(null);
  const [runs, setRuns] = useState(undefined);   // undefined=読み込み中 / null=取得失敗 / []=0件
  const [stale, setStale] = useState(false);     // 一覧は出せているが、最新を取れていない
  const [models, setModels] = useState(undefined);
  const [optimistic, setOptimistic] = useState([]);   // 開始直後〜一覧に載るまでの仮の行
  const [plans, setPlans] = useState({});             // run_id -> 開始時の自動判定 (進め方・モデル・理由)
  const [openId, setOpenId] = useState(null);
  const [task, setTask] = useState("");
  const [opts, setOpts] = useState(DEFAULTS);
  const [optsOpen, setOptsOpen] = useState(false);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  // シークレット: このページで開始した実行の ID。解除・画面を閉じる・離れるでサーバーの作業フォルダごと消す
  const secretRuns = useRef(new Set());
  const secretOn = useRef(false);
  secretOn.current = secret;
  const discarded = useRef(new Set());

  const set = useCallback((patch) => setOpts((o) => ({ ...o, ...patch })), []);
  useOptionGuards(opts, setOpts, models);

  const refreshRuns = useCallback(() => fetchRuns()
    .then((d) => { setRuns(d.runs.filter((r) => !discarded.current.has(r.id))); setStale(false); })
    .catch(() => { setStale(true); setRuns((p) => (p === undefined ? null : p)); }), []);
  const refreshModels = useCallback(() => fetchModels().then(setModels).catch(() => setModels((p) => (p === undefined ? null : p))), []);
  const retryRuns = () => { setRuns(undefined); refreshRuns(); };

  // 一覧は3秒ごと。別のタブを見ている間 (この画面は隠れている) は取りに行かない
  useEffect(() => {
    refreshRuns();
    refreshModels();
    const t = setInterval(() => {
      if (!document.hidden && rootRef.current?.offsetParent !== null) refreshRuns();
    }, 3000);
    // エンジンの起動・停止のあと、モデルの使える状態を取り直す
    window.addEventListener("system-changed", refreshModels);
    return () => { clearInterval(t); window.removeEventListener("system-changed", refreshModels); };
  }, [refreshRuns, refreshModels]);

  // 仮の行は、サーバーの一覧に同じ id が載った時点で退く
  const runsView = useMemo(() => {
    if (!runs) return optimistic.length ? optimistic : runs;   // 一覧を取れなくても、今始めた依頼は開けるようにする
    const pending = optimistic.filter((o) => !runs.some((r) => r.id === o.id));
    return (pending.length ? [...pending, ...runs] : runs).filter((r) => r.mode !== "bench");   // ベンチは PC 版で見る
  }, [runs, optimistic]);
  useEffect(() => {
    if (!runs) return;
    setOptimistic((l) => { const n = l.filter((o) => !runs.some((r) => r.id === o.id)); return n.length === l.length ? l : n; });
  }, [runs]);

  // 開いている間は履歴を1つ積み、端末の「戻る」で一覧へ戻す。
  // 上にシートが重なって戻ったとき (state がまだこの画面のもの) は閉じない
  const isOpen = openId != null;
  useEffect(() => {
    if (!isOpen) return undefined;
    let viaBack = false;
    history.pushState({ agentRun: true }, "");
    const onPop = () => {
      if (history.state?.agentRun) return;
      viaBack = true;
      setOpenId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!viaBack && history.state?.agentRun) history.back();
    };
  }, [isOpen]);
  const closeRun = () => { if (history.state?.agentRun) history.back(); else setOpenId(null); };

  // ---- 開始・再実行 ----
  const handleStart = async (payload, asSecret = secret) => {
    const wasOn = secretOn.current;
    const res = await startRun(asSecret ? { ...payload, secret: true, claude_review: false, api_review: false } : payload);
    if (asSecret && wasOn && !secretOn.current) {   // 開始の応答を待つ間にシークレットを切った: 残さず捨てる
      discardRun(res.run_id);
      return;
    }
    if (asSecret) secretRuns.current.add(res.run_id);
    setPlans((m) => ({ ...m, [res.run_id]: res }));
    setOptimistic((l) => [{
      id: res.run_id, task: payload.task, status: "queued", created_at: Date.now() / 1000,
      mode: res.mode, deliverable: res.deliverable, model: res.model, model_tag: res.model_tag,
      pending_approvals: 0, tokens: 0, max_iter: payload.max_iter, approve: payload.approve,
      critique: payload.critique, claude_review: res.claude_review, secret: asSecret,
    }, ...l]);
    setOpenId(res.run_id);
    refreshRuns();
  };
  const submit = async () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      // mode / deliverable は送らない (auto = メインエージェントが決める)。添付はスマホ版では扱わない
      await handleStart({
        task: task.trim(), attach: null, model: opts.model, critique: opts.critique, approve: opts.approve,
        max_iter: opts.maxIter, allow_ram: opts.allowRam,
        claude_review: opts.claudeReview && !secret, api_review: opts.apiReview && !secret,
        think: opts.think === "auto" ? null : opts.think === "on",
      });
      setTask("");
    } catch (e) {
      setError(`依頼を始められませんでした。${e.message}`);   // 失敗したら入力は残す
    } finally {
      setBusy(false);
    }
  };
  const rerun = (run) => handleStart({
    task: run.task, attach: run.attach ?? null, mode: run.mode, model: run.model, critique: run.critique,
    approve: run.approve, max_iter: run.max_iter, deliverable: run.deliverable ?? "auto",
    claude_review: !!run.claude_review, api_review: !!run.api_review,
  }, !!run.secret);

  // ---- シークレット ----
  const discardSecretRuns = useCallback(() => {
    const ids = [...secretRuns.current];
    if (!ids.length) return;
    secretRuns.current.clear();
    ids.forEach((id) => { discarded.current.add(id); discardRun(id); });
    const gone = (r) => ids.includes(r.id);
    setRuns((rs) => (rs ? rs.filter((r) => !gone(r)) : rs));
    setOptimistic((l) => l.filter((r) => !gone(r)));
    setPlans((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !ids.includes(k))));
    setOpenId((id) => (ids.includes(id) ? null : id));
  }, []);
  const onSecretChange = (on) => { setSecret(on); if (!on) discardSecretRuns(); };
  // 画面を閉じる・再読み込み・この画面が外れるときも消す
  useEffect(() => {
    const drop = () => secretRuns.current.forEach((id) => discardRun(id));
    window.addEventListener("pagehide", drop);
    return () => { window.removeEventListener("pagehide", drop); drop(); };
  }, []);

  const onDeleted = (id) => {
    secretRuns.current.delete(id);
    setRuns((rs) => (rs ? rs.filter((r) => r.id !== id) : rs));   // API が成功してから一覧を更新する
    setOpenId(null);
    refreshRuns();
  };
  const newTaskFrom = (text) => { if (text) setTask(text); setOpenId(null); };

  // ---- 詳細 ----
  if (isOpen) {
    const run = runsView?.find((r) => r.id === openId);
    return (
      <div ref={rootRef} className="h-full">
        {run
          ? <AgentRun key={run.id} run={run} plan={plans[run.id]} onBack={closeRun} onDeleted={onDeleted} onRefresh={refreshRuns} onRerun={rerun} onNewTask={newTaskFrom} />
          : <RunMissing loading={runsView === undefined} onBack={closeRun} />}
      </div>
    );
  }

  // ---- 依頼と一覧 ----
  const ollama = eng.byId.ollama;
  const diff = countDiff(opts);
  const live = runsView?.filter((r) => r.status === "running" || r.status === "queued") ?? [];
  const past = runsView?.filter((r) => r.status !== "running" && r.status !== "queued") ?? [];
  const startOllama = async () => { setStarting(true); await eng.run(() => startEngines(["ollama"]), "起動しています…"); setStarting(false); };

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <ScreenHeader title="エージェント" />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-4">
        {eng.st === null && <Notice tone="warn">PCの状態を確認できないため、Ollama が動いているか分かりません。</Notice>}
        {eng.st && ollama?.state === "starting" && <Notice tone="info">Ollama を起動しています…</Notice>}
        {eng.st && ollama?.state !== "up" && ollama?.state !== "starting" && (
          <Notice tone="warn" action={<Button icon={Power} busy={starting} onClick={startOllama}>Ollamaを起動する</Button>}>
            ローカルLLM（Ollama）が止まっています。起動するまで、依頼は動きません。
          </Notice>
        )}

        <section aria-label="新しい依頼" className="space-y-3">
          <Field label="作りたいもの・調べたいこと">
            <textarea rows={5} value={task} onChange={(e) => setTask(e.target.value)} enterKeyHint="enter"
                      placeholder="例: ブロック崩しゲームを作って" className={cx(inputCls, "resize-none")} />
          </Field>
          {(secret || !opts.approve || opts.claudeReview || opts.think !== "auto") && (
            <ul className="flex flex-wrap gap-2 text-sm">
              {secret && <li className="flex min-h-8 items-center gap-1 rounded-lg bg-m-primary-soft px-2 font-semibold text-m-fg"><EyeOff size={14} aria-hidden="true" /> シークレット</li>}
              {!opts.approve && <li className="flex min-h-8 items-center gap-1 rounded-lg bg-m-danger-soft px-2 font-semibold text-m-fg"><ShieldAlert size={14} aria-hidden="true" /> 承認なしで実行</li>}
              {opts.claudeReview && !secret && <li className="flex min-h-8 items-center rounded-lg bg-m-warning-soft px-2 font-semibold text-m-fg">Claudeが最終レビュー</li>}
              {opts.think !== "auto" && <li className="flex min-h-8 items-center rounded-lg bg-m-sunken px-2 text-m-fg">思考{opts.think === "on" ? "あり" : "なし"}</li>}
            </ul>
          )}
          <Notice tone="error" onClose={() => setError("")}>{error}</Notice>
          <div className="flex gap-2">
            <Button icon={SlidersHorizontal} onClick={() => setOptsOpen(true)}>オプション{diff > 0 && <span className="m-num">（{diff}）</span>}</Button>
            <Button variant="primary" icon={Play} busy={busy} disabled={!task.trim()} className="flex-1" onClick={submit}>実行する</Button>
          </div>
        </section>

        <section aria-labelledby="agent-runs">
          <h2 id="agent-runs" className="mb-2 text-base font-semibold">タスク</h2>
          {stale && runs && <div className="mb-2"><Notice tone="warn" action={<Button onClick={retryRuns}>もう一度読み込む</Button>}>最新の状態を取得できません。表示は少し前のものです。</Notice></div>}
          {runsView === undefined ? <Loading text="タスクを読み込んでいます…" />
            : runsView === null ? (
              <Notice tone="error" action={<Button onClick={retryRuns}>もう一度読み込む</Button>}>サーバーに接続できません。PCが起動しているか確認してください。</Notice>
            ) : !runsView.length ? (
              <Empty icon={Bot} title="タスクはまだありません" hint="上の欄に依頼を書いて「実行する」を押すと、ここに並びます。"
                     action={<Button onClick={() => setTask(SAMPLE_TASK)}>例文を入れる</Button>} />
            ) : (
              <div className="space-y-4">
                <RunGroup title="実行中・待機中" runs={live} plans={plans} onOpen={setOpenId} />
                <RunGroup title="履歴" runs={past} plans={plans} onOpen={setOpenId} />
              </div>
            )}
        </section>
      </div>

      <AgentOptions open={optsOpen} onClose={() => setOptsOpen(false)} opts={opts} set={set} models={models}
                    secret={secret} onSecretChange={onSecretChange} onReset={() => setOpts(DEFAULTS)} onReload={refreshModels} />
    </div>
  );
}

const PAGE = 30;   // 履歴は多いので、少しずつ出す

function RunGroup({ title, runs, plans, onOpen }) {
  const [shown, setShown] = useState(PAGE);
  if (!runs.length) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-m-muted">{title}（<span className="m-num">{runs.length}</span>）</h3>
      <ul className="space-y-2">
        {runs.slice(0, shown).map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r.id)}
                    className="flex min-h-12 w-full flex-col gap-1 rounded-xl border border-m-line bg-m-surface px-4 py-3 text-left transition-colors active:bg-m-sunken motion-reduce:transition-none">
              <span className="line-clamp-2 text-base text-m-fg">{r.task}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <RunStatus status={r.status} />
                {r.pending_approvals > 0 && (
                  <span className="flex items-center gap-1 text-sm font-semibold text-m-warning"><ShieldAlert size={14} aria-hidden="true" /> 承認待ち <span className="m-num">{r.pending_approvals}</span>件</span>
                )}
                {r.secret && <span className="flex items-center gap-1 text-sm text-m-muted"><EyeOff size={14} aria-hidden="true" /> シークレット</span>}
                <span className="ml-auto text-sm text-m-subtle">{fmtAgo(r.created_at)}</span>
              </span>
              {(plans[r.id]?.model_tag ?? r.model_tag ?? r.model) && <span className="m-num truncate text-xs text-m-subtle">{plans[r.id]?.model_tag ?? r.model_tag ?? r.model}</span>}
            </button>
          </li>
        ))}
      </ul>
      {runs.length > shown && (
        <Button className="mt-2 w-full" onClick={() => setShown((n) => n + PAGE)}>
          さらに表示（残り <span className="m-num">{runs.length - shown}</span>件）
        </Button>
      )}
    </div>
  );
}
