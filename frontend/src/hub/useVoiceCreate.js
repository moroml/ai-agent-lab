// 音声画面の「声を作る」の状態と操作。説明 (文章・画像・動画の見た目) → 試し声 → 気に入ったら声の見本に保存。
// 声の見本の一覧と保存は useSpeech (s) のものを使う。PC 版・スマホ版で共有する。
import { useEffect, useRef, useState } from "react";
import { describeVoice, generateSpeech, uploadVoice } from "./api.js";

export const DEFAULT_TRIAL_TEXT = "こんにちは。はじめまして、これからよろしくお願いします。";
export const DESC_PLACEHOLDER = "落ち着いた20代の女性。少しハスキーで、ゆっくり優しく話す";
export const SOURCES = [
  { value: "text", label: "文章で説明" },
  { value: "image", label: "画像から" },
  { value: "video", label: "動画から" },
];

// 経過秒つきで非同期処理を走らせる
function useElapsed() {
  const [sec, setSec] = useState(0);
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  const begin = () => {
    const t0 = Date.now();
    setSec(0);
    clearInterval(timer.current);
    timer.current = setInterval(() => setSec((Date.now() - t0) / 1000), 1000);
  };
  const end = () => clearInterval(timer.current);
  return [sec, begin, end];
}

export function useVoiceCreate(s) {
  const [source, setSourceRaw] = useState("text");
  const [desc, setDesc] = useState("");
  const [hint, setHint] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [start, setStart] = useState("0");
  const [testText, setTestText] = useState(DEFAULT_TRIAL_TEXT);
  const [lang, setLang] = useState("");
  const [error, setError] = useState("");

  const [describing, setDescribing] = useState(false);
  const [descElapsed, beginDesc, endDesc] = useElapsed();
  const [trying, setTrying] = useState(false);
  const [tryElapsed, beginTry, endTry] = useElapsed();
  const [trials, setTrials] = useState([]);       // 新しい順 [{file, url, title, ...}]
  const [names, setNames] = useState({});         // 試し声ごとの保存名の入力
  const [saved, setSaved] = useState({});         // 試し声の file → 保存した声の名前
  const [savingFile, setSavingFile] = useState("");
  const [videoName, setVideoName] = useState("");
  const [videoVoice, setVideoVoice] = useState(null);   // 動画の声をそのまま保存したときの声の名前
  const [videoBusy, setVideoBusy] = useState(false);

  const qwen = s.info?.engines.find((e) => e.key === "qwen3");
  const language = qwen?.languages.includes(lang) ? lang : "";

  useEffect(() => {
    if (!file) { setPreview(""); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const isVideo = !!file && file.type.startsWith("video/");
  const setSource = (v) => { setSourceRaw(v); setFile(null); setError(""); setVideoVoice(null); };
  const pickFile = (f) => {
    setFile(f ?? null);
    setVideoVoice(null);
    setVideoName(f ? f.name.replace(/\.[^.]+$/, "") : "");
    setError("");
  };

  // 画像・動画の見た目から説明を作り、説明欄へ入れる (手で直せる)
  async function describe() {
    if (!file) return;
    setError("");
    setDescribing(true);
    beginDesc();
    try {
      const r = await describeVoice(file, hint.trim());
      setDesc(String(r.description ?? ""));
    } catch (e) {
      setError(`声を考えられませんでした: ${e.message}`);
    } finally {
      endDesc();
      setDescribing(false);
    }
  }

  // 動画に映っている人の声をそのまま見本にする (start 秒から30秒)
  async function useVideoVoice() {
    if (!file) return;
    setError("");
    setVideoBusy(true);
    try {
      const v = await uploadVoice(file, file.name, videoName.trim(), "", Math.max(0, Number(start) || 0));
      await s.reloadVoices();
      setVideoVoice(v.name);
    } catch (e) {
      setError(`声の見本にできませんでした: ${e.message}`);
    } finally {
      setVideoBusy(false);
    }
  }

  // 試し声。speaker と voice は付けない (説明どおりの声を作るモードになる)。何度でも作り直せる
  async function tryVoice() {
    const style = desc.trim();
    if (!style || !testText.trim()) return;
    setError("");
    setTrying(true);
    beginTry();
    try {
      const r = await generateSpeech({
        engine: "qwen3", text: testText.trim(), style, language: language || null, title: `試し声: ${style.slice(0, 20)}`,
      });
      setTrials((xs) => [{ ...r, desc: style }, ...xs]);
      setNames((n) => ({ ...n, [r.file]: n[r.file] ?? "" }));
      s.reload();
    } catch (e) {
      setError(`試し声を作れませんでした: ${e.message}`);
    } finally {
      endTry();
      setTrying(false);
    }
  }

  const setName = (f, v) => setNames((n) => ({ ...n, [f]: v }));
  async function saveTrial(t) {
    const name = (names[t.file] ?? "").trim();
    if (!name) return;
    setError("");
    setSavingFile(t.file);
    try {
      const v = await s.saveVoice(t.file, name);
      setSaved((m) => ({ ...m, [t.file]: v.name }));
    } catch (e) {
      setError(`声を保存できませんでした: ${e.message}`);
    } finally {
      setSavingFile("");
    }
  }

  return {
    source, setSource, desc, setDesc, hint, setHint, file, pickFile, preview, isVideo, start, setStart,
    testText, setTestText, lang, language, setLang, qwen, error, setError,
    describing, descElapsed, describe, trying, tryElapsed, tryVoice, trials,
    names, setName, saved, savingFile, saveTrial, videoName, setVideoName, videoVoice, videoBusy, useVideoVoice,
  };
}
