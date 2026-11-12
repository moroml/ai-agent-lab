// 種類別ワークスペースの API (hub.py と1:1対応)。

async function jsonOrThrow(resp) {
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* JSONでないエラーボディは無視 */ }
    throw new Error(detail);
  }
  return resp.json();
}

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(jsonOrThrow);
const get = (url) => fetch(url, { cache: "no-store" }).then(jsonOrThrow);

export const fetchCategories = () => get("/hub/categories");
export const prewarmChat = (model) => post("/hub/prewarm", { model });

// チャット: SSE を fetch で読み、イベントごとに onEvent を呼ぶ
export async function streamChat(body, onEvent, signal) {
  const resp = await fetch("/hub/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!resp.ok) await jsonOrThrow(resp);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export const studioStatus = () => get("/studio/status");
export const studioCatalog = () => get("/studio/catalog");
export const studioGallery = (kind, limit = 60) => get(`/studio/gallery?kind=${kind}&limit=${limit}`);
export const enhancePrompt = (text_ja, mode) => post("/studio/enhance", { text_ja, mode });
export const generateImage = (body) => post("/studio/generate", body);
export const generateVideo = (body) => post("/studio/generate-video", body);
export const fetchJob = (id) => get(`/studio/jobs/${id}`);
export const cancelJob = (id) => post(`/studio/jobs/${id}/cancel`, {});
export const setFavorite = (id, is_favorite) => post(`/studio/generations/${id}/favorite`, { is_favorite });
export const trashGeneration = (id) => fetch(`/studio/generations/${id}`, { method: "DELETE" }).then(jsonOrThrow);

export const musicModels = () => get("/music/models");
export const musicList = () => get("/music/list");
export const generateMusic = (body) => post("/music/generate", body);
export const draftLyrics = (body) => post("/hub/lyrics", body);
export const deleteMusic = (file) => fetch(`/music/file/${encodeURIComponent(file)}`, { method: "DELETE" }).then(jsonOrThrow);
