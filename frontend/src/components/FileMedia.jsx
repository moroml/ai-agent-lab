// チャットで作ったファイルのその場表示。画像・音声・動画だけ出し、それ以外 (glb など) はリンクに任せる。
const KINDS = { png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", mp3: "audio", wav: "audio", mp4: "video", webm: "video" };
export const mediaKind = (path) => KINDS[path.split(".").pop().toLowerCase()];

export function FileMedia({ file, className = "" }) {
  const kind = mediaKind(file.path);
  if (kind === "image") return <img src={file.url} alt={file.path} loading="lazy" className={`max-h-80 max-w-full ${className}`} />;
  if (kind === "audio") return <audio src={file.url} controls preload="metadata" className={`w-full max-w-md ${className}`} aria-label={file.path} />;
  if (kind === "video") return <video src={file.url} controls preload="metadata" className={`max-h-80 max-w-full ${className}`} aria-label={file.path} />;
  return null;
}
