// エージェントの実行の詳細 (スマホ版)。進み具合・回答・成果物・各エージェントのログ・承認・会話での修正を縦1列に並べる。
// データは PC 版と同じ (useRunEvents / derive.js / api.js)。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Ban, Check, CheckCircle2, ChevronDown, Clock, Download, ExternalLink, EyeOff, FileText,
  Hourglass, RotateCcw, SendHorizontal, ShieldAlert, Sparkles, Square, Trash2, Wrench, X, XCircle, Zap,
} from "lucide-react";
import Markdown from "../components/md.jsx";
import { cancelRun, continueRun, deleteRun, resolveApproval } from "../api.js";
import {
  AGENT_STATES, DELIVERABLE_LABEL, KIND_LABEL, MODE_LABEL, PHASE_META, RUN_STATUS,
  deriveAgentState, fmtElapsed, isModelLoading, lastLine, modelDisplay, segmentByPhase,
} from "../derive.js";
import { useRunEvents } from "../useRunEvents.js";
import { Button, cx, Empty, IconButton, inputCls, Notice, ScreenHeader, Spinner } from "./ui.jsx";

// ---- 状態の見せ方 (色だけに頼らず、必ず言葉を添える) ----
const RUN_DOT = {
  running: "bg-m-primary m-pulse", queued: "bg-m-warning", done: "bg-m-primary",
  error: "bg-m-danger", cancelled: "bg-m-subtle", interrupted: "bg-m-subtle",
};

/** 実行全体の状態: 点 + 言葉 */
export function RunStatus({ status }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold text-m-fg">
      <span aria-hidden="true" className={cx("size-2.5 shrink-0 rounded-full", RUN_DOT[status] ?? RUN_DOT.cancelled)} />
      {RUN_STATUS[status]?.label ?? status}
    </span>
  );
}

const STATE_ICON = {
  active: Zap, queued: Hourglass, waiting: Clock, tool: Wrench, completed: CheckCircle2,
  failed: XCircle, canceled: Ban, aborted: Square, stalled: AlertTriangle,
};
const STATE_TONE = {
  active: "text-m-primary", tool: "text-m-primary", completed: "text-m-primary",
  queued: "text-m-warning", stalled: "text-m-warning", failed: "text-m-danger",
  waiting: "text-m-subtle", canceled: "text-m-subtle", aborted: "text-m-subtle",
};

const STATUS_ANNOUNCE = {
  queued: "待機中です", running: "実行中です", done: "完了しました",
  error: "エラーで終了しました", cancelled: "中断しました", interrupted: "サーバー停止で中断されました",
};

// ---- 承認 (PC版 ApprovalBar と同じ規則) ----
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;   // runs.py の自動却下に合わせた表示用の目安
const DANGEROUS_RE =
  /(^|[\s;&|])(rm|rmdir|del|erase)\s+(-[a-z]*[rf]|\/[sq])|format\s|mkfs|shutdown|reboot|taskkill|reg\s+delete|git\s+push|npm\s+publish|pip\s+uninstall|\|\s*(sh|bash)\b|Invoke-WebRequest|curl\s+[^|]*\|/i;

const fmtRemain = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function ApprovalCard({ runId, a, now }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const [armed, setArmed] = useState(false);   // 壊す可能性のあるコマンドは、承認を2回押しにする
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (gone) return null;

  const danger = DANGEROUS_RE.test(a.command || "");
  const remain = APPROVAL_TIMEOUT_MS - (now - (a.receivedAt ?? now));

  const respond = async (approved) => {
    setBusy(true);
    setError("");
    try {
      await resolveApproval(runId, a.aid, approved);
    } catch (e) {
      // 409 = サーバー側で解決済み (自動却下など)。実態に合わせて消す
      if (e.status === 409) setGone(true);
      else setError("送れませんでした。通信を確認して、もう一度押してください。");
    } finally {
      setBusy(false);
    }
  };
  const approve = () => {
    if (danger && !armed) {
      setArmed(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    respond(true);
  };

  return (
    <div className={cx("rounded-xl bg-m-surface p-3", danger ? "border-2 border-m-danger" : "border border-m-line")}>
      <p className="flex items-center gap-2 text-base font-semibold text-m-fg">
        <ShieldAlert size={18} aria-hidden="true" className="shrink-0 text-m-warning" /> このコマンドを実行してよいですか
      </p>
      {danger && <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-m-danger"><AlertTriangle size={16} aria-hidden="true" /> 元に戻せない操作の可能性があります</p>}
      <pre className="m-num mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-m-sunken p-3 text-sm text-m-fg">{a.command}</pre>
      <p className="m-num mt-1 break-all text-xs text-m-subtle">cwd: {a.cwd}</p>
      <p className={cx("mt-1 text-sm", remain < 60_000 && !a.fromSnapshot ? "font-semibold text-m-danger" : "text-m-muted")}>
        {a.fromSnapshot ? "15分で自動的に却下されます（受付時刻は不明）" : <>自動却下まで <span className="m-num">{fmtRemain(remain)}</span></>}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="primary" icon={Check} busy={busy} onClick={approve}>{armed ? "本当に承認する" : "承認"}</Button>
        <Button icon={X} disabled={busy} onClick={() => respond(false)}>却下</Button>
      </div>
      {armed && <p role="status" className="mt-1 text-sm text-m-danger">3秒以内にもう一度押すと承認します。</p>}
      {error && <p role="alert" className="mt-1 text-sm text-m-danger">{error}</p>}
    </div>
  );
}

// ---- 各エージェント (1行、押すとログが開く) ----
const LOG_LINES = 200;   // 長いログは末尾だけ出す (全量は PC 版で見られる)
const TEXT_TAIL = 4000;

function AgentRow({ node, ctx, speed, now, open, onToggle }) {
  const st = deriveAgentState(node, ctx);
  const meta = AGENT_STATES[st.key];
  const Icon = STATE_ICON[st.key];
  const loading = st.key === "active" && isModelLoading(node, now);
  const model = modelDisplay(node);
  const elapsed = node.started_at != null ? (node.finished_at ?? now / 1000) - node.started_at : null;
  const live = st.key === "active" || st.key === "tool";
  const title = (node.title || "").replace(/^[^\p{L}\p{N}]*/u, "");
  const bodyId = `agent-${node.id}`;
  const line = lastLine(node);

  let logText = "";
  if (open && node.log?.length) logText = node.log.join("\n").split("\n").slice(-LOG_LINES).join("\n");
  const out = open ? (node.output || node.preview || "") : "";
  const stalledSec = speed?.sinceMs != null ? Math.floor(speed.sinceMs / 1000) : null;

  return (
    <li className="rounded-xl border border-m-line bg-m-surface">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left active:bg-m-sunken">
        <Icon size={20} aria-hidden="true" className={cx("shrink-0", STATE_TONE[st.key], live && "m-pulse")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base text-m-fg">{title}</span>
          <span className="block truncate text-sm text-m-muted">
            {KIND_LABEL[node.kind] ?? node.kind} ・ {loading ? "モデル準備中" : meta.jp}
            {st.key === "queued" && st.pos != null && <> <span className="m-num">#{st.pos}</span></>}
            {elapsed != null && <> ・ <span className="m-num">{fmtElapsed(elapsed)}</span></>}
          </span>
          {live && line && <span className="m-num block truncate text-xs text-m-subtle">{line}</span>}
        </span>
        <ChevronDown size={18} aria-hidden="true" className={cx("shrink-0 text-m-subtle", open && "rotate-180")} />
      </button>
      {open && (
        <div id={bodyId} className="space-y-3 border-t border-m-line px-3 py-3">
          <p className="text-sm text-m-muted">
            {model.has && <>モデル <span className="m-num">{model.tag}</span></>}
            {live && speed?.tps > 0 && <> ・ <span className="m-num">{speed.tps.toFixed(1)}</span> tok/s</>}
            {node.ctx_fill > 0.85 && <> ・ コンテキスト <span className="m-num">{Math.round(node.ctx_fill * 100)}%</span></>}
          </p>
          {st.key === "stalled" && (
            <p className="text-sm font-semibold text-m-warning">{stalledSec != null ? `${stalledSec}秒間` : ""}トークンが届いていません。ログを確認してください。</p>
          )}
          {st.key === "failed" && <p className="text-sm font-semibold text-m-danger">{(node.output || "エラーの詳細はありません").split("\n")[0]}</p>}
          {st.key === "canceled" && <p className="text-sm text-m-muted">前の工程が失敗したため、自動で中止されました。</p>}
          {logText && (
            <div>
              <p className="mb-1 text-sm font-semibold text-m-fg">実行ログ</p>
              <pre role="log" aria-live="off" aria-label={`${title}の実行ログ`} tabIndex={0}
                   className="m-num max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-m-sunken p-3 text-xs text-m-fg">{logText}</pre>
            </div>
          )}
          {out && st.key !== "failed" && (
            <div>
              <p className="mb-1 text-sm font-semibold text-m-fg">出力</p>
              {st.key === "completed"
                ? <div className="max-h-64 overflow-auto rounded-lg bg-m-sunken p-3"><Markdown text={out.slice(-TEXT_TAIL)} className="m-md" /></div>
                : <pre role="log" aria-live="off" aria-label={`${title}の出力`} tabIndex={0}
                       className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-m-sunken p-3 text-sm text-m-fg">{out.slice(-TEXT_TAIL)}</pre>}
            </div>
          )}
          {node.think && (
            <details className="rounded-lg bg-m-sunken px-3 py-2 text-sm text-m-muted">
              <summary className="flex min-h-8 cursor-pointer items-center">考えた過程（<span className="m-num">{node.think.length.toLocaleString()}</span>字）</summary>
              <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{node.think.slice(-TEXT_TAIL)}</p>
            </details>
          )}
          {!logText && !out && !node.think && st.key !== "failed" && st.key !== "canceled" && st.key !== "stalled" && (
            <p className="text-sm text-m-subtle">{st.key === "waiting" ? "前の工程が終わるのを待っています。" : st.key === "queued" ? "GPUの空きを待っています。" : "まだ出力はありません。"}</p>
          )}
        </div>
      )}
    </li>
  );
}

// ---- 成果物 ----
const effectiveKind = (a) => {
  if (a.kind) return a.kind;
  const n = (a.name || "").toLowerCase();
  if (n.endsWith(".html") || n.endsWith(".htm")) return "html";
  if (n.endsWith(".exe")) return "exe";
  if (n.endsWith(".bat") || n.endsWith(".cmd")) return "bat";
  return a.kind;
};

function ArtifactLink({ a }) {
  const kind = effectiveKind(a);
  const save = kind === "exe" || kind === "bat";
  const name = (a.name || "").split("/").pop();
  const look = "flex min-h-12 w-full items-center gap-3 rounded-xl border border-m-line-strong bg-m-surface px-3 text-left text-base";
  if (!a.path) return <span className={cx(look, "text-m-muted")}><FileText size={18} aria-hidden="true" className="shrink-0" /><span className="min-w-0 flex-1 truncate">{name}</span></span>;
  return (
    <a href={a.path} {...(save ? { download: name } : { target: "_blank", rel: "noreferrer" })} className={cx(look, "font-semibold text-m-primary active:bg-m-primary-soft")}>
      {kind === "html" ? <ExternalLink size={18} aria-hidden="true" className="shrink-0" /> : save ? <Download size={18} aria-hidden="true" className="shrink-0" /> : <FileText size={18} aria-hidden="true" className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{a.name}</span>
      <span className="shrink-0 text-sm font-normal text-m-muted">{kind === "html" ? "ブラウザで開く" : save ? "保存する" : "開く"}</span>
    </a>
  );
}

// ---- 工程 (計画→実行→レビュー→統合→回答) ----
function Phases({ nodes }) {
  const segments = segmentByPhase(nodes);
  return (
    <ol aria-label="実行工程" className="flex">
      {Object.entries(PHASE_META).map(([phase, meta]) => {
        const group = segments.filter((s) => s.phase === phase).flatMap((s) => s.nodes);
        const done = group.length > 0 && group.every((n) => n.status === "done");
        const active = !done && group.some((n) => ["thinking", "generating", "running"].includes(n.status));
        return (
          <li key={phase} aria-current={active ? "step" : undefined} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className={cx("flex size-7 items-center justify-center rounded-full border-2",
              done ? "border-m-primary bg-m-primary text-m-on-primary" : active ? "border-m-primary bg-m-primary-soft" : "border-m-line-strong")}>
              {done ? <Check size={16} aria-hidden="true" /> : active && <span aria-hidden="true" className="m-pulse size-2.5 rounded-full bg-m-primary" />}
            </span>
            <span className={cx("text-sm", done || active ? "font-semibold text-m-fg" : "text-m-subtle")}>{meta.label}<span className="sr-only">{done ? "（完了）" : active ? "（進行中）" : ""}</span></span>
          </li>
        );
      })}
    </ol>
  );
}

export default function AgentRun({ run, plan, onBack, onDeleted, onRefresh, onRerun, onNewTask }) {
  const [epoch, setEpoch] = useState(0);   // 完了後に続きを送ったとき、購読をつなぎ直す
  const { state, speeds } = useRunEvents(run.id, epoch);
  const [now, setNow] = useState(Date.now());
  const [openIds, setOpenIds] = useState(() => new Set());
  const [showDisconnected, setShowDisconnected] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [armed, setArmed] = useState(false);   // 削除は2回押し (3秒以内)
  const [deleting, setDeleting] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const armTimer = useRef(null);
  useEffect(() => () => clearTimeout(armTimer.current), []);

  const live = run.status === "running" || run.status === "queued";
  useEffect(() => {
    if (!live && !state.running) return undefined;
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(t);
  }, [live, state.running]);

  // 中断は推論が降りるまで数秒かかる。収まったら「中断しています」を解除する
  useEffect(() => { if (aborting && !live) setAborting(false); }, [aborting, live]);
  // 一瞬の未接続では出さない (1.5秒の猶予)
  useEffect(() => {
    if (state.connected) { setShowDisconnected(false); return undefined; }
    const t = setTimeout(() => setShowDisconnected(true), 1500);
    return () => clearTimeout(t);
  }, [state.connected]);

  const agentNodes = useMemo(() => state.order.map((id) => state.nodes[id]).filter((n) => n && n.kind !== "task"), [state.order, state.nodes]);
  const rootProgress = useMemo(() => state.order.map((id) => state.nodes[id]).find((n) => n && n.kind === "task")?.progress ?? null, [state.order, state.nodes]);
  const cascadeFailed = agentNodes.some((n) => n.status === "error");
  const stalledIds = useMemo(() => new Set(Object.keys(speeds).filter((id) => speeds[id].stalled)), [speeds]);
  const ctx = { runQueued: run.status === "queued", queuePos: run.queue_pos, cascadeFailed, stalledIds };

  const answerNode = [...agentNodes].reverse().find((n) => n.kind === "answer" && n.output);
  // 続きの質問。回答より後に出ていれば、その答えはまだ作っている途中
  const askNode = [...agentNodes].reverse().find((n) => n.kind === "coder" && n.detail && n.title?.startsWith("\u{1F6E0} 追加指示"));
  const askPending = !!askNode && agentNodes.indexOf(askNode) > agentNodes.indexOf(answerNode);
  const segments = useMemo(
    () => segmentByPhase(agentNodes.filter((n) => n.id !== answerNode?.id)),
    [agentNodes, answerNode?.id],
  );
  const activeNode = agentNodes.find((n) => n.status === "thinking" || n.status === "generating");
  const speed = activeNode ? speeds[activeNode.id] : null;

  const elapsed = run.created_at ? (run.finished_at ?? now / 1000) - run.created_at : null;
  const [done, total] = rootProgress ?? [];
  const modeLabel = MODE_LABEL[plan?.mode ?? run.mode] ?? (plan?.mode ?? run.mode);
  const dlvLabel = DELIVERABLE_LABEL[plan?.deliverable ?? run.deliverable];
  const modelTag = plan?.model_tag ?? run.model_tag ?? run.model;
  const makesFiles = run.mode === "code" || run.mode === "swarm-code";

  const banner = showDisconnected ? { tone: "warn", text: "サーバーとの接続が切れています。つなぎ直しています…" }
    : state.finishError ? { tone: "error", text: state.finishError }
    : run.status === "interrupted" ? { tone: "warn", text: "サーバーが止まったため、この実行は中断されました。" }
    : run.status === "queued" ? { tone: "info", text: `待機中です（あと${run.queue_pos ?? "?"}件で開始）${run.queue_reason ? `\n${run.queue_reason}` : ""}` }
    : null;

  const abort = () => {
    setAborting(true);
    setActionError("");
    cancelRun(run.id).catch((e) => { setAborting(false); setActionError(`中断できませんでした。${e.message}`); }).finally(onRefresh);
  };
  const remove = () => {
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(armTimer.current);
    setArmed(false);
    setDeleting(true);
    setActionError("");
    deleteRun(run.id).then(() => onDeleted(run.id)).catch((e) => { setDeleting(false); setActionError(`削除できませんでした。${e.message}`); });
  };
  const rerun = () => {
    setRerunning(true);
    setActionError("");
    onRerun(run).catch((e) => { setRerunning(false); setActionError(`再実行できませんでした。${e.message}`); });
  };
  const toggle = (id) => setOpenIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={run.task} left={<IconButton label="タスクの一覧へ戻る" icon={ArrowLeft} tone="fg" onClick={onBack} />} />
      <p role="status" className="sr-only">{STATUS_ANNOUNCE[run.status] ?? ""}</p>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
        {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
        {run.secret && (
          <Notice tone="info">
            <span className="flex items-center gap-2"><EyeOff size={16} aria-hidden="true" className="shrink-0" /> シークレット: 画面を閉じるか設定で切ると、作業フォルダごと消えます。</span>
          </Notice>
        )}

        <section aria-label="状態" className="space-y-3 rounded-xl border border-m-line bg-m-surface p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <RunStatus status={run.status} />
            {elapsed != null && <span className="text-sm text-m-muted">経過 <span className="m-num">{fmtElapsed(elapsed)}</span></span>}
            {live && activeNode && (
              <span className="text-sm text-m-muted">
                {activeNode.tokens > 0 ? <>生成 <span className="m-num">{(speed?.tps ?? 0).toFixed(1)}</span> tok/s</> : <>応答待ち <span className="m-num">{Math.floor((speed?.sinceMs ?? 0) / 1000)}</span>秒</>}
              </span>
            )}
          </div>
          {total > 0 && (
            <div className="flex items-center gap-3">
              <div role="progressbar" aria-label="進み具合" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-2 flex-1 overflow-hidden rounded-full bg-m-sunken">
                <div className="h-full rounded-full bg-m-primary" style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
              </div>
              <span className="m-num text-xs text-m-muted">{done}/{total}</span>
            </div>
          )}
          <Phases nodes={agentNodes} />
          <div className="space-y-1 border-t border-m-line pt-3 text-sm text-m-muted">
            <p><span className="font-semibold text-m-fg">進め方</span> {modeLabel}{dlvLabel && ` / ${dlvLabel}`}</p>
            {modelTag && <p><span className="font-semibold text-m-fg">モデル</span> <span className="m-num">{modelTag}</span></p>}
            {plan?.reason && <p><span className="font-semibold text-m-fg">判定理由</span> {plan.reason}</p>}
            {run.claude_review && <p><span className="font-semibold text-m-fg">最終レビュー</span> Claude</p>}
            {run.api_review && <p><span className="font-semibold text-m-fg">最終レビュー</span> 任意のAPIモデル</p>}
            {run.tokens > 0 && <p><span className="font-semibold text-m-fg">トークン</span> <span className="m-num">{run.tokens.toLocaleString()}</span></p>}
          </div>
          <details className="border-t border-m-line pt-1">
            <summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold text-m-fg">依頼の全文</summary>
            <p className="whitespace-pre-wrap pb-2 text-base text-m-fg">{run.task}</p>
          </details>
          <div className="flex flex-wrap gap-2">
            {live ? (
              <Button icon={Square} busy={aborting} className="flex-1" onClick={abort}>{aborting ? "中断しています…" : "中断する"}</Button>
            ) : (
              <>
                <Button icon={RotateCcw} busy={rerunning} className="flex-1" onClick={rerun}>同じ設定で再実行</Button>
                <Button variant={armed ? "danger" : "secondary"} icon={Trash2} busy={deleting} className="flex-1" onClick={remove}>{armed ? "削除する" : "削除"}</Button>
              </>
            )}
          </div>
          {armed && <p role="status" className="text-sm text-m-muted">3秒以内にもう一度押すと、この記録を削除します。</p>}
          {actionError && <p role="alert" className="text-sm text-m-danger">{actionError}</p>}
        </section>

        {answerNode && (
          <section aria-labelledby="agent-answer" className="rounded-xl border border-m-line bg-m-surface p-4">
            <h2 id="agent-answer" className="mb-3 text-base font-semibold text-m-fg">{askPending ? "前の回答" : askNode ? "回答" : "最終回答"}</h2>
            {askNode && (
              <p className="mb-3 whitespace-pre-wrap rounded-lg bg-m-sunken px-3 py-2 text-sm text-m-fg">
                <span className="text-m-muted">続きの質問: </span>{askNode.detail}
                {askPending && <span className="ml-2 text-m-muted">回答を作っています…</span>}
              </p>
            )}
            {/* 生成中は整形せず素のテキストで出し、完了したら Markdown に切り替える */}
            {answerNode.status === "done"
              ? <Markdown text={answerNode.output} className="m-md" />
              : <pre role="log" aria-live="off" aria-label="回答（生成中）" className="whitespace-pre-wrap text-base text-m-fg">{answerNode.output}</pre>}
          </section>
        )}

        {state.artifacts.length > 0 && (
          <section aria-labelledby="agent-artifacts">
            <h2 id="agent-artifacts" className="mb-2 text-base font-semibold text-m-fg">成果物（<span className="m-num">{state.artifacts.length}</span>）</h2>
            <ul className="space-y-2">{state.artifacts.map((a, i) => <li key={a.path ?? i}><ArtifactLink a={a} /></li>)}</ul>
          </section>
        )}

        <section aria-labelledby="agent-agents">
          <h2 id="agent-agents" className="mb-2 text-base font-semibold text-m-fg">エージェント</h2>
          {agentNodes.length === 0 ? (
            state.connected
              ? <p role="status" className="flex items-center gap-2 text-sm text-m-muted"><Spinner /> エージェントを起動しています…</p>
              : <p role="status" className="flex items-center gap-2 text-sm text-m-muted"><Spinner /> 実行の様子を読み込んでいます…</p>
          ) : (
            <div className="space-y-4">
              {segments.map((seg, i) => (
                <div key={`${seg.phase}-${i}`}>
                  <h3 className="mb-2 text-sm font-semibold text-m-muted">
                    {PHASE_META[seg.phase].label}（<span className="m-num">{seg.nodes.filter((n) => n.status === "done").length}/{seg.nodes.length}</span> 完了）
                  </h3>
                  <ul className="space-y-2">
                    {seg.nodes.map((node) => (
                      <AgentRow key={node.id} node={node} ctx={ctx} speed={speeds[node.id]} now={now} open={openIds.has(node.id)} onToggle={() => toggle(node.id)} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {state.approvals.length > 0 && (
        <section role="alert" aria-label="コマンド実行の承認要求" className="max-h-[50dvh] shrink-0 space-y-3 overflow-y-auto border-t-2 border-m-warning bg-m-warning-soft px-3 py-3">
          {state.approvals.map((a) => <ApprovalCard key={a.aid} runId={run.id} a={a} now={now} />)}
        </section>
      )}

      <Composer run={run} running={state.running} resumable={state.resumable} makesFiles={makesFiles}
                onSent={() => { setEpoch((n) => n + 1); onRefresh(); }} onNewTask={onNewTask} />
    </div>
  );
}

/** 会話で成果物や答えを直す入力。送ると同じ実行・同じ作業フォルダの続きになる */
function Composer({ run, running, resumable, makesFiles, onSent, onNewTask }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentAt, setSentAt] = useState(null);   // 送信直後〜実行開始が届くまでの二重送信を防ぐ

  useEffect(() => {
    if (!sentAt) return undefined;
    if (running) { setSentAt(null); return undefined; }
    const t = setTimeout(() => setSentAt(null), 20_000);   // 開始が届かなくても詰まらないように
    return () => clearTimeout(t);
  }, [sentAt, running]);

  // 継続できない実行は行き止まりにせず、新しいタスクへ流す (待機中は開始すれば送れるので除く)
  const deadEnd = !resumable && !running && run.status !== "queued";
  const text = msg.trim();
  const send = async () => {
    if (!text || busy || running || sentAt || !resumable) return;
    setBusy(true);
    setError("");
    setSentAt(Date.now());
    try {
      await continueRun(run.id, text);
      setMsg("");
      onSent();
    } catch (e) {
      setError(`送れませんでした。${e.message}`);
      setSentAt(null);
    } finally {
      setBusy(false);
    }
  };
  const placeholder = running ? "実行中です。終わると送れます（書きかけは残ります）"
    : run.status === "queued" ? "待機中です。始まると送れます"
    : deadEnd ? "この実行は続けられません"
    : makesFiles ? "成果物への追加指示（例: 色を変えて）" : "続けて質問する（例: 3つに絞って）";

  return (
    <div className="shrink-0 space-y-2 border-t border-m-line bg-m-surface px-3 py-2">
      {deadEnd && <Notice tone="info">この実行は続けられません。書いた内容は、新しいタスクとして始められます。</Notice>}
      {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
      <div className="flex items-end gap-2">
        <label htmlFor="m-agent-continue" className="sr-only">会話で修正する（この実行への追加指示）</label>
        <textarea id="m-agent-continue" rows={Math.min(5, Math.max(1, msg.split("\n").length))} value={msg}
                  onChange={(e) => setMsg(e.target.value)} placeholder={placeholder} enterKeyHint="enter"
                  className={cx(inputCls, "max-h-[30dvh] resize-none")} />
        {!deadEnd && (
          <button type="button" onClick={send} disabled={busy || running || !resumable || !!sentAt || !text} aria-label="追加指示を送る"
                  className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-m-primary text-m-on-primary active:bg-m-primary-hover disabled:opacity-40">
            {busy ? <Spinner size={20} /> : <SendHorizontal size={22} aria-hidden="true" />}
          </button>
        )}
      </div>
      {deadEnd && <Button variant="primary" icon={Sparkles} className="w-full" onClick={() => onNewTask(text)}>新しいタスクとして始める</Button>}
    </div>
  );
}

/** 見つからないとき (削除済み・サーバーを入れ替えたなど) */
export function RunMissing({ loading, onBack }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="タスク" left={<IconButton label="タスクの一覧へ戻る" icon={ArrowLeft} tone="fg" onClick={onBack} />} />
      {loading
        ? <p role="status" className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-m-muted"><Spinner /> 読み込んでいます…</p>
        : <Empty title="このタスクは見つかりません" hint="削除されたか、サーバーが入れ替わった可能性があります。" action={<Button variant="primary" onClick={onBack}>一覧へ戻る</Button>} />}
    </div>
  );
}
