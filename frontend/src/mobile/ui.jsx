// スマホ版の共通部品。色は mobile.css のトークン (m-*) だけを使い、押せるものは高さ 48px を基準にする。
import { useEffect, useId, useRef } from "react";
import { Loader2, X } from "lucide-react";

export { usePersisted } from "../hub/ui.jsx";

export const cx = (...parts) => parts.filter(Boolean).join(" ");

const BUTTON_LOOK = {
  primary: "bg-m-primary text-m-on-primary active:bg-m-primary-hover",
  secondary: "border border-m-line-strong bg-m-surface text-m-fg active:bg-m-sunken",
  ghost: "text-m-primary active:bg-m-primary-soft",
  danger: "bg-m-danger text-m-on-danger",
};

/** busy の間は元のラベルを保ったまま回る印を出し、二重に押せなくする */
export function Button({ variant = "secondary", busy = false, icon: Icon, className, children, disabled, ...props }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cx("inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors motion-reduce:transition-none disabled:opacity-50",
        BUTTON_LOOK[variant], className)}
      {...props}
    >
      {busy ? <Spinner size={18} /> : Icon && <Icon size={18} aria-hidden="true" />}
      {children}
    </button>
  );
}

/** アイコンだけのボタン。label は読み上げ用の名前 (必須) */
export function IconButton({ label, icon: Icon, className, tone = "muted", ...props }) {
  const color = { muted: "text-m-muted", fg: "text-m-fg", primary: "text-m-primary", danger: "text-m-danger" }[tone];
  return (
    <button type="button" aria-label={label}
            className={cx("inline-flex size-12 shrink-0 items-center justify-center rounded-xl active:bg-m-sunken disabled:opacity-40", color, className)}
            {...props}>
      <Icon size={22} aria-hidden="true" />
    </button>
  );
}

export function Spinner({ size = 16, className }) {
  return <Loader2 size={size} aria-hidden="true" className={cx("m-spin shrink-0", className)} />;
}

/** 画面ごとの見出し行。left / right にはアイコンボタンを置く */
export function ScreenHeader({ title, left, right, children }) {
  return (
    <header className="shrink-0 border-b border-m-line bg-m-bg">
      <div className="flex min-h-14 items-center gap-1 px-2">
        {left}
        <h1 className={cx("min-w-0 flex-1 truncate text-xl font-semibold", !left && "pl-2")}>{title}</h1>
        {right}
      </div>
      {children}
    </header>
  );
}

/**
 * 下から出るシート (<dialog>)。開くとフォーカスが中へ移り、閉じると元へ戻る。
 * 端末の「戻る」で閉じられるよう、開いている間は履歴を1つ積む。
 */
export function Sheet({ open, onClose, title, children, footer }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!open || !d) return undefined;
    if (!d.open) d.showModal();
    let viaBack = false;
    history.pushState({ sheet: true }, "");
    const onPop = () => { viaBack = true; closeRef.current(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (d.open) d.close();
      if (!viaBack && history.state?.sheet) history.back();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-sheet m-root fixed inset-x-0 bottom-0 top-auto m-0 flex max-h-[88dvh] w-full flex-col rounded-t-2xl bg-m-raised p-0 text-m-fg shadow-(--m-shadow)"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-m-line pl-4 pr-1">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
        <IconButton label="閉じる" icon={X} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
      {footer && <div className="shrink-0 border-t border-m-line px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">{footer}</div>}
      {!footer && <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" />}
    </dialog>
  );
}

export const inputCls = "block w-full min-h-12 rounded-xl border border-m-line-strong bg-m-surface px-3 py-2 text-base text-m-fg placeholder:text-m-subtle";

/** ラベルは常に見せる。hint は補足、error は欄の直下に出す */
export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-sm font-semibold text-m-fg">
        {label}
        {hint && <span className="font-normal text-m-subtle">{hint}</span>}
      </span>
      {children}
      {error && <span role="alert" className="mt-1 block text-sm text-m-danger">{error}</span>}
    </label>
  );
}

/** 2〜4個から1つを選ぶ。options: [{ value, label }] */
export function Segmented({ label, options, value, onChange }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-xl bg-m-sunken p-1">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
                className={cx("min-h-12 flex-1 rounded-lg px-2 text-sm font-semibold transition-colors motion-reduce:transition-none",
                  value === o.value ? "bg-m-raised text-m-fg shadow-sm" : "text-m-muted")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** すぐ反映される入/切。説明つきの1行 */
export function SwitchRow({ label, hint, checked, onChange, icon: Icon, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
            className="flex min-h-14 w-full items-center gap-3 py-2 text-left disabled:opacity-50">
      {Icon && <Icon size={20} aria-hidden="true" className="shrink-0 text-m-muted" />}
      <span className="min-w-0 flex-1">
        <span className="block text-base text-m-fg">{label}</span>
        {hint && <span className="block text-sm text-m-subtle">{hint}</span>}
      </span>
      <span aria-hidden="true" className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors motion-reduce:transition-none", checked ? "bg-m-primary" : "bg-m-line-strong")}>
        <span className={cx("absolute top-1 left-1 size-5 rounded-full bg-m-raised transition-transform motion-reduce:transition-none", checked && "translate-x-5")} />
      </span>
    </button>
  );
}

const NOTICE_LOOK = {
  error: "bg-m-danger-soft text-m-fg border-m-danger",
  warn: "bg-m-warning-soft text-m-fg border-m-warning",
  info: "bg-m-primary-soft text-m-fg border-m-primary",
};

/** その場に出す知らせ。error は role=alert、それ以外は role=status。action にはボタンを渡す */
export function Notice({ tone = "info", children, onClose, action }) {
  if (!children) return null;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex items-start gap-2 rounded-xl border-l-4 px-3 py-2 text-sm", NOTICE_LOOK[tone])}>
      <div className="min-w-0 flex-1 whitespace-pre-wrap py-1">{children}{action && <div className="mt-2">{action}</div>}</div>
      {onClose && <IconButton label="閉じる" icon={X} onClick={onClose} className="-my-1 -mr-2 size-10" />}
    </div>
  );
}

/** 何も無いとき: 何が入るか (title) と最初の行動 (action) */
export function Empty({ icon: Icon, title, hint, action }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {Icon && <Icon size={32} aria-hidden="true" className="mb-3 text-m-subtle" />}
      <p className="text-base font-semibold text-m-fg">{title}</p>
      {hint && <p className="mt-1 text-sm text-m-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 読み込み中の1行。何をしているかを text に書く */
export function Loading({ text = "読み込んでいます…" }) {
  return <p role="status" className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-m-muted"><Spinner /> {text}</p>;
}

/** 進み具合 (0〜1)。value が無ければ不定の表示 */
export function Progress({ value, text }) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div role="status">
      <div className="h-2 overflow-hidden rounded-full bg-m-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={cx("h-full origin-left rounded-full bg-m-primary", pct == null && "m-pulse w-full")} style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
      {text && <p className="mt-1 text-sm text-m-muted">{text}{pct != null && <span className="m-num"> {pct}%</span>}</p>}
    </div>
  );
}
