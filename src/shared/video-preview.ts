import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MEDIA_MAX_BYTES } from "./media-assets.js";

const run = promisify(execFile);
let activeConversions = 0;

export type VideoPreviewResult =
  | { data: Buffer }
  | { status: 422 | 503; detail: string };

// Key by the original file digest so aliases share a cover and replacements
// cannot reuse an outdated frame. Keep only small JPEGs in memory.
const covers = new Map<string, Buffer>();
const pendingCovers = new Map<string, Promise<VideoPreviewResult>>();

export async function videoThumbnail(source: string, sha256: string): Promise<VideoPreviewResult> {
  const cached = covers.get(sha256);
  if (cached) {
    covers.delete(sha256);
    covers.set(sha256, cached);
    return { data: cached };
  }
  const pending = pendingCovers.get(sha256);
  if (pending) return pending;
  if (pendingCovers.size >= 2) return { status: 503, detail: "封面生成繁忙，请稍后重试。" };

  const task = (async (): Promise<VideoPreviewResult> => {
    try {
      const { stdout } = await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi",
        "-threads", "2", "-max_pixels", "16777216", "-i", source,
        "-map", "0:V:0", "-frames:v", "1", "-filter_threads", "1",
        "-vf", "scale=224:168:force_original_aspect_ratio=decrease",
        "-c:v", "mjpeg", "-threads", "1", "-q:v", "4", "-f", "image2pipe", "pipe:1",
      ], { encoding: "buffer", timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, windowsHide: true });
      if (!stdout.length) return { status: 422, detail: "视频没有可用于封面的画面。" };
      if (covers.size >= 64) covers.delete(covers.keys().next().value!);
      covers.set(sha256, stdout);
      return { data: stdout };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: 503, detail: "视频封面暂不可用。" };
      }
      return { status: 422, detail: "无法生成视频封面。" };
    } finally {
      pendingCovers.delete(sha256);
    }
  })();
  pendingCovers.set(sha256, task);
  return task;
}

export async function compatibleVideoPreview(source: string, signal?: AbortSignal): Promise<VideoPreviewResult> {
  if (activeConversions >= 2) return { status: 503, detail: "视频预览正在处理其他文件，请稍后重试。" };
  activeConversions += 1;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(tmpdir(), "rea-video-preview-"));
    const output = path.join(directory, "preview.mp4");
    await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi",
      "-threads", "2", "-max_pixels", "16777216", "-i", source,
      "-map", "0:V:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
      "-filter_threads", "1", "-vf", "scale=min(iw\\,1280):min(ih\\,720):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "25",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
      "-fs", String(MEDIA_MAX_BYTES + 1024 * 1024), output,
    ], { signal, timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, windowsHide: true });
    const { size } = await stat(output);
    if (!size || size > MEDIA_MAX_BYTES) return { status: 422, detail: "视频预览超出大小限制，请压缩视频后重新上传。" };
    return { data: await readFile(output) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: 503, detail: "视频兼容预览暂不可用，请稍后重试。" };
    }
    return { status: 422, detail: "无法生成有画面的预览，请将视频导出为 H.264 MP4 后重新上传。" };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    activeConversions -= 1;
  }
}
