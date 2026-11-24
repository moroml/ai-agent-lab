// 音声画面 (PC版・スマホ版) の状態と操作。見た目は SpeechView.jsx / mobile/SpeechScreen.jsx が持つ。
import { useEffect, useRef, useState } from "react";
import { deleteSpeech, deleteVoice, generateSpeech, speechEngines, speechList, speechVoices, uploadVoice, voiceFromResult } from "./api.js";
import { usePersisted } from "./ui.jsx";

export const MAX_TEXT = 5000;
export const MAX_REC_SEC = 30;
const BLANK = { engine: "", text: "", language: "", speaker: "", style: "", voice: "", voiceText: "", title: "" };
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// 録音はマイクを使うので https か localhost でしか動かない。使えない理由を画面に出す
function recordSupport() {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return window.isSecureContext
      ? "このブラウザは録音に対応していません。"
      : "録音は https か localhost で開いたときだけ使えます (今のアドレスでは使えません)。";
  }
  return "";
}

// 押す→「削除?」→3秒以内にもう一度、の2段階。削除は元に戻せないため
function useArmed() {
  const [armed, setArmed] = useState(null);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, setArmed];
}

export function useSpeech() {
  const [info, setInfo] = useState(undefined);   // undefined=読込中 / null=取得失敗
  const [items, setItems] = useState(undefined);
  const [voices, setVoices] = useState([]);
  const [kept, setKept] = usePersisted("hub.speech.form", BLANK);
  const form = { ...BLANK, ...kept };
  const set = (k, v) => setKept((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState(null);
  const [armed, setArmed] = useArmed();
  const [armedVoice, setArmedVoice] = useArmed();
  const timer = useRef(null);

  const engine = info?.engines.find((e) => e.key === (form.engine || info.default)) ?? info?.engines[0];
  const language = engine?.languages.includes(form.language) ? form.language : "";
  const speaker = engine?.speakers.includes(form.speaker) ? form.speaker : "";

  const reload = () => speechList().then((d) => setItems(d.items)).catch((e) => { setError(e.message); setItems((x) => x ?? []); });
  const reloadVoices = () => speechVoices().then((d) => setVoices(d.items)).catch((e) => setError(e.message));
  useEffect(() => {
    speechEngines().then(setInfo).catch((e) => { setInfo(null); setError(e.message); });
    reload();
    reloadVoices();
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    setError("");
    setBusy(true);
    setElapsed(0);
    const t0 = Date.now();
    timer.current = setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000);
    try {
      const r = await generateSpeech({
        engine: engine.key, text: form.text, language: language || null, speaker: speaker || null,
        style: form.style.trim() || null, voice: form.voice || null, voice_text: form.voice ? form.voiceText.trim() || null : null,
        title: form.title.trim() || null,
      });
      setFresh(r.file);
      setItems((xs) => [r, ...(xs ?? [])]);
    } catch (e) {
      setError(e.message);
    } finally {
      clearInterval(timer.current);
      setBusy(false);
    }
  }

  async function remove(item) {
    if (armed !== item.file) return setArmed(item.file);
    setArmed(null);
    try {
      await deleteSpeech(item.file);
      setItems((xs) => xs.filter((x) => x.file !== item.file));
    } catch (e) { setError(`削除できませんでした: ${e.message}`); }
  }

  const pickVoice = (name) => {
    const v = voices.find((x) => x.name === name);
    setKept((f) => ({ ...f, voice: name, voiceText: v?.text ?? "" }));
  };
  async function removeVoice(v) {
    if (armedVoice !== v.name) return setArmedVoice(v.name);
    setArmedVoice(null);
    try {
      await deleteVoice(v.name);
      setVoices((xs) => xs.filter((x) => x.name !== v.name));
      if (form.voice === v.name) pickVoice("");
    } catch (e) { setError(`削除できませんでした: ${e.message}`); }
  }
  async function addVoice(blob, filename) {
    setError("");
    try {
      const v = await uploadVoice(blob, filename, "", form.voiceText.trim());
      setVoices((xs) => [v, ...xs]);
      setKept((f) => ({ ...f, voice: v.name }));
      return v;
    } catch (e) { setError(`声の見本を登録できませんでした: ${e.message}`); return null; }
  }
  async function useAsVoice(item) {
    setError("");
    try {
      const v = await voiceFromResult(item.file, { name: item.title });
      setVoices((xs) => [v, ...xs]);
      setKept((f) => ({ ...f, voice: v.name, voiceText: v.text }));
      return v;
    } catch (e) { setError(`声の見本にできませんでした: ${e.message}`); return null; }
  }

  // マイク録音。止めると webm/ogg/m4a のままサーバーへ送り、wav に変えて登録する
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const rec = useRef(null);
  const recSupport = recordSupport();
  async function startRecording() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      const t0 = Date.now();
      const tick = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        setRecSec(s);
        if (s >= MAX_REC_SEC && mr.state === "recording") mr.stop();
      }, 250);
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        clearInterval(tick);
        stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        setRecording(false);
        const type = mr.mimeType || "audio/webm";
        const ext = /ogg/.test(type) ? "ogg" : /mp4|aac/.test(type) ? "m4a" : "webm";
        const d = new Date();
        const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
        if (chunks.length) addVoice(new Blob(chunks, { type }), `録音_${stamp}.${ext}`);
      };
      rec.current = mr;
      setRecSec(0);
      setRecording(true);
      mr.start();
    } catch (e) {
      setError(e.name === "NotAllowedError" ? "マイクの使用が許可されていません。ブラウザの設定で許可してください" : `録音を始められませんでした: ${e.message}`);
    }
  }
  const stopRecording = () => rec.current?.state === "recording" && rec.current.stop();
  useEffect(() => () => { if (rec.current?.state === "recording") rec.current.stop(); }, []);

  return {
    info, items, voices, form, set, engine, language, speaker, busy, elapsed, error, setError, fresh,
    armed, armedVoice, reload, generate, remove, pickVoice, removeVoice, addVoice, useAsVoice,
    recording, recSec, recSupport, startRecording, stopRecording,
  };
}
