// エージェントの依頼オプション。項目・既定値・使えないモデルの判定は PC 版 (TaskInput.jsx) と同じにして、送る内容を揃える。
import { useEffect } from "react";
import { Brain, EyeOff, ListChecks, MemoryStick, ShieldCheck, Sparkles, Plug } from "lucide-react";
import { groupByBackend, modelName, modelStatusLine, modelStatusNote } from "../derive.js";
import { Button, Field, inputCls, Segmented, Sheet, SwitchRow } from "./ui.jsx";

export const DEFAULTS = { model: "auto", critique: false, approve: true, maxIter: 18, allowRam: false, claudeReview: false, apiReview: false, think: "auto" };

// 軽量 hybrid (RAM オフロード 8GB 以下) は実用速度なので、RAM 併用が OFF でも選べる (router.pick_model と同じ基準)
const isLightHybrid = (m) => m.needs_ram && (m.ram_gb ?? 0) <= 8;

/** モデルが今選べるか、選べないなら理由の注記 */
function describeModel(m, allowRam) {
  const isOllama = (m.backend ?? "ollama") === "ollama";
  const light = isLightHybrid(m);
  const blocked = !m.installed
    || (isOllama && m.needs_ram && !m.ram_ok)
    || (isOllama && m.needs_ram && !light && !allowRam);
  const note = modelStatusNote(m)
    || (!isOllama ? ""
      : m.needs_ram && !m.ram_ok ? " ※RAM不足"
      : m.needs_ram && !light && !allowRam ? " ※RAM併用をONに"
      : m.needs_ram && !light ? " ※低速" : "");
  return { blocked, note: note.trim() };
}

/** 既定値から外れている設定の数 (閉じていても分かるように、ボタンに出す) */
export const countDiff = (o) => Object.keys(DEFAULTS).filter((k) => o[k] !== DEFAULTS[k]).length;

/** 使えなくなった選択を戻す: キーが無い等で Claude / API レビューが使えない、RAM 併用を切ったのに大型モデルが残っている */
export function useOptionGuards(opts, setOpts, models) {
  const claudeOk = models?.claude?.available;
  const apiOk = models?.api_review?.available;
  useEffect(() => {
    if (!models) return;
    setOpts((o) => {
      let n = o;
      if (o.claudeReview && !claudeOk) n = { ...n, claudeReview: false };
      if (o.apiReview && !apiOk) n = { ...n, apiReview: false };
      const cur = models.models?.find((m) => m.key === o.model);
      if (cur?.needs_ram && !isLightHybrid(cur) && (!o.allowRam || !cur.ram_ok)) n = { ...n, model: "auto" };
      if (cur && isLightHybrid(cur) && !cur.ram_ok) n = { ...n, model: "auto" };
      return n;
    });
  }, [models, claudeOk, apiOk, opts.allowRam, opts.model, setOpts]);
}

const THINK_OPTIONS = [{ value: "auto", label: "自動" }, { value: "on", label: "あり" }, { value: "off", label: "なし" }];

export default function AgentOptions({ open, onClose, opts, set, models, secret, onSecretChange, onReset, onReload }) {
  const list = models?.models ?? [];
  const groups = groupByBackend(list);
  const claude = models?.claude ?? null;
  const api = models?.api_review ?? null;
  const chosen = list.find((m) => m.key === opts.model) ?? null;
  const status = opts.model !== "auto" ? modelStatusLine(chosen) : null;

  return (
    <Sheet open={open} onClose={onClose} title="依頼のオプション"
           footer={(
             <div className="flex gap-2">
               <Button className="shrink-0" onClick={onReset}>既定に戻す</Button>
               <Button variant="primary" className="flex-1" onClick={onClose}>設定を閉じる</Button>
             </div>
           )}>
      <div className="space-y-4">
        <div>
          <Field label="モデル">
            <select value={opts.model} onChange={(e) => set({ model: e.target.value })} className={inputCls}>
              <option value="auto">自動選択（内容に合わせて決める）</option>
              {groups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.models.map((m) => {
                    const d = describeModel(m, opts.allowRam);
                    return (
                      <option key={m.key} value={m.key} disabled={d.blocked && m.key !== opts.model}>
                        {modelName(m)}{d.note && ` ${d.note}`}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </Field>
          {models === undefined && <p role="status" className="mt-1 text-sm text-m-muted">モデルの一覧を読み込んでいます…</p>}
          {models === null && (
            <p role="alert" className="mt-1 text-sm text-m-danger">
              モデルの一覧を取得できません。自動選択で実行できます。
              <button type="button" onClick={onReload} className="ml-2 min-h-12 font-semibold text-m-primary">もう一度取得する</button>
            </p>
          )}
          {status && <p className="mt-1 text-sm text-m-muted">{status.text}</p>}
        </div>

        <div>
          <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-m-fg"><Brain size={16} aria-hidden="true" /> 思考（think）</p>
          <Segmented label="思考" options={THINK_OPTIONS} value={opts.think} onChange={(think) => set({ think })} />
          <p className="mt-1 text-sm text-m-subtle">答える前に裏で考える工程。「なし」は大幅に速く、難しい推論では「あり」が効くことがあります。</p>
        </div>

        <Field label="最大イテレーション" hint="作る→直す の往復の上限">
          <input type="number" inputMode="numeric" min={1} max={60} value={opts.maxIter}
                 onChange={(e) => set({ maxIter: Number(e.target.value) || DEFAULTS.maxIter })} className={`${inputCls} m-num`} />
        </Field>

        <div className="divide-y divide-m-line">
          <SwitchRow icon={ShieldCheck} label="コマンド実行前に承認" hint="実行する前に、毎回あなたの確認を挟む" checked={opts.approve} onChange={(approve) => set({ approve })} />
          <SwitchRow icon={ListChecks} label="完了後レビュー" hint="終わったあと、別のモデルが批評して必要なら直す" checked={opts.critique} onChange={(critique) => set({ critique })} />
          <SwitchRow icon={MemoryStick} label="大きいモデルも使う（RAM併用・低速）"
                     hint={`VRAMに収まらないモデルも候補に入る${models?.free_ram_gb != null ? `。空きRAM ${models.free_ram_gb}GB` : ""}`}
                     checked={opts.allowRam} onChange={(allowRam) => set({ allowRam })} />
          <SwitchRow icon={Sparkles} label="Claudeが最終レビュー"
                     hint={claude?.available ? `完了後に ${claude.model} が確認して直す。サブスクの5時間利用枠を使う` : (claude?.reason || "利用できません")}
                     checked={opts.claudeReview && !secret} disabled={!claude?.available || secret} onChange={(claudeReview) => set({ claudeReview })} />
          <SwitchRow icon={Plug} label="任意モデルで最終レビュー"
                     hint={api?.available ? `完了後に ${api.model} が読んで評価する（直さない）` : (api?.reason || "利用できません")}
                     checked={opts.apiReview && !secret} disabled={!api?.available || secret} onChange={(apiReview) => set({ apiReview })} />
          <SwitchRow icon={EyeOff} label="シークレット"
                     hint="記録とキャッシュを残さない。切る・画面を閉じると作業フォルダごと消え、外部レビューは使えない"
                     checked={secret} onChange={onSecretChange} />
        </div>
        <p className="text-sm text-m-subtle">進め方と成果物の形は、エージェントが自動で決めます。</p>
      </div>
    </Sheet>
  );
}
