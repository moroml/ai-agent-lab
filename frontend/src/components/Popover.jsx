import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * アンカー直下に開く共通ポップオーバー。層1(1クリックで開く詳細)の共通シェル。
 *
 * 閉じている間は**レンダーしない**(hidden ではなく null)。translate や invisible で
 * 隠すと内部のボタンが Tab 順に残る問題を、構造ごと避ける。
 * Esc(IME変換中は無視)・外側クリックで閉じ、開いたらパネルへフォーカスを移す。
 * labelledBy: role="dialog" のアクセシブルネーム。パネル内の見出し要素の id を渡す
 * (無名の dialog はスクリーンリーダーで「ダイアログ」としか読まれない)。
 * returnFocusRef: 閉じたときフォーカスを戻すトリガーボタンの ref。
 */
export default function Popover({ open, onClose, align = "right", children, labelledBy, returnFocusRef }) {
  const panelRef = useRef(null);
  const wasOpen = useRef(false);
  const [pos, setPos] = useState(null);

  // 親(ヘッダー等)が overflow-hidden でも切れないよう、アンカーの位置から fixed で置く
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = panelRef.current?.parentElement?.getBoundingClientRect();
      if (!r) return;
      setPos(align === "right"
        ? { top: r.bottom + 6, right: Math.max(12, window.innerWidth - r.right) }
        : { top: r.bottom + 6, left: Math.max(12, r.left) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e) => {
      // 親ラッパー(アンカー+パネルを包む relative 要素)の外側クリックで閉じる。
      // アンカー自体のクリックはトグル側に任せ、別のポップオーバーのアンカーを
      // 押したときはこちらが閉じるようにする
      const wrap = panelRef.current?.parentElement;
      if (wrap && !wrap.contains(e.target)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // パネルのアンマウントでフォーカスが body へ落ちたときだけトリガーへ戻す
    // (外側クリックで別の入力欄等へフォーカスが移った場合はそれを奪わない)
    const ae = document.activeElement;
    if (!ae || ae === document.body) returnFocusRef?.current?.focus({ preventScroll: true });
  }, [open, returnFocusRef]);

  if (!open) return null;
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-labelledby={labelledBy}
      style={pos ?? undefined}
      className="fixed z-50 max-h-[calc(100vh-5rem)] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-800 p-3 text-left shadow-2xl focus:outline-none"
    >
      {children}
    </div>
  );
}
