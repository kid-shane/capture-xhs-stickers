import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { CaptureError, isAllowedImageHost, requestHeaders } from "./xhs.mjs";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FEISHU_CHAT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const SIPS_PATH = "/usr/bin/sips";
const defaultCacheBase = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const defaultConfigBase = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

export const CACHE_ROOT = resolve(
  process.env.XHS_STICKER_CACHE_DIR || join(defaultCacheBase, "capture-xhs-stickers")
);
export const CONFIG_PATH = resolve(
  process.env.XHS_STICKER_CONFIG || join(defaultConfigBase, "capture-xhs-stickers", "config.json")
);

const FEISHU_CHAT_IMAGE_MIMES = new Set([
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/ico",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp"
]);

export function redactSourceUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|share|xsec_source|appuid|app_uid|userid|user_id|trace|signature|sign/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}

function padded(index) {
  return String(index + 1).padStart(3, "0");
}

function contentInfo(buffer, contentType = "") {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mime: "image/png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mime: "image/jpeg" };
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { extension: "gif", mime: "image/gif" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", mime: "image/webp" };
  }
  if (buffer.subarray(4, 12).toString("ascii").includes("ftypavif")) {
    return { extension: "avif", mime: "image/avif" };
  }
  if (contentType.startsWith("image/")) {
    const mime = contentType.split(";", 1)[0].trim().toLowerCase();
    const extension = mime === "image/jpeg" ? "jpg" : mime.split("/")[1]?.replace("svg+xml", "svg") || "img";
    return { extension, mime };
  }
  throw new CaptureError("NOT_AN_IMAGE", "小红书资源返回的内容不是图片，已停止导出。");
}

async function fetchImage(url, referer, fetchImpl = fetch) {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "https:" || !isAllowedImageHost(parsed.hostname)) {
      throw new CaptureError("UNSAFE_IMAGE_URL", "图片地址不属于小红书公开资源域名，已停止下载。");
    }
    const response = await fetchImpl(currentUrl, {
      redirect: "manual",
      headers: requestHeaders.image(referer),
      signal: AbortSignal.timeout(30_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new CaptureError("BAD_IMAGE_REDIRECT", "图片资源跳转缺少目标地址。");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) {
      throw new CaptureError("IMAGE_HTTP_ERROR", `原始图片资源下载失败（HTTP ${response.status}）。`);
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new CaptureError("IMAGE_TOO_LARGE", "单张图片超过 30 MB，已停止下载。");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new CaptureError("IMAGE_TOO_LARGE", "单张图片超过 30 MB，已停止下载。");
    }
    const info = contentInfo(buffer, response.headers.get("content-type") || "");
    return { buffer, ...info };
  }
  throw new CaptureError("IMAGE_TOO_MANY_REDIRECTS", "图片资源跳转次数过多，已停止下载。");
}

async function atomicWrite(filePath, buffer) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.part-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, buffer, { flag: "wx" });
  await rename(temporaryPath, filePath);
}

export async function autoCleanupAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    await access(SIPS_PATH);
    return true;
  } catch {
    return false;
  }
}

async function imageDimensions(filePath) {
  if (!(await autoCleanupAvailable())) return null;
  try {
    const { stdout } = await execFileAsync(
      SIPS_PATH,
      ["-g", "pixelWidth", "-g", "pixelHeight", filePath],
      { timeout: 20_000, maxBuffer: 512 * 1024 }
    );
    const width = Number(String(stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(String(stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

async function makeCleanVariant(job, image, downloaded, rawPath, enabled) {
  const originalDimensions = await imageDimensions(rawPath);
  const rawResult = {
    path: rawPath,
    extension: downloaded.extension,
    mime: downloaded.mime,
    dimensions: originalDimensions,
    cleanup: { applied: false, reason: enabled ? "not_needed_or_unavailable" : "disabled" }
  };
  if (!enabled || !image.watermarkRisk || downloaded.mime === "image/gif" || !originalDimensions) return rawResult;
  if (originalDimensions.height < 300) return rawResult;

  const cropPixels = Math.max(48, Math.round(originalDimensions.height * 0.045));
  const croppedHeight = originalDimensions.height - cropPixels;
  const outputExtension = downloaded.mime === "image/jpeg" ? "jpg" : "png";
  const outputMime = outputExtension === "jpg" ? "image/jpeg" : "image/png";
  const cleanPath = join(CACHE_ROOT, job.id, "originals", `${padded(image.index)}.${outputExtension}`);
  const args = ["-s", "format", outputExtension === "jpg" ? "jpeg" : "png"];
  if (outputExtension === "jpg") args.push("-s", "formatOptions", "95");
  args.push(
    "-c",
    String(croppedHeight),
    String(originalDimensions.width),
    "--cropOffset",
    "0",
    "0",
    rawPath,
    "--out",
    cleanPath
  );
  try {
    await mkdir(dirname(cleanPath), { recursive: true });
    await execFileAsync(SIPS_PATH, args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const cleanBuffer = await readFile(cleanPath);
    contentInfo(cleanBuffer, outputMime);
    return {
      path: cleanPath,
      extension: outputExtension,
      mime: outputMime,
      dimensions: { width: originalDimensions.width, height: croppedHeight },
      cleanup: {
        applied: true,
        method: "bottom_crop",
        cropPixels,
        cropRatio: cropPixels / originalDimensions.height,
        sourceHeight: originalDimensions.height
      }
    };
  } catch {
    await rm(cleanPath, { force: true });
    return rawResult;
  }
}

async function downloadAsset(job, image, fetchImpl, cleanBottom) {
  let downloaded;
  try {
    downloaded = await fetchImage(image.url, job.sourceUrl, fetchImpl);
  } catch (error) {
    if (!image.fallbackUrl || image.fallbackUrl === image.url) throw error;
    downloaded = await fetchImage(image.fallbackUrl, job.sourceUrl, fetchImpl);
  }
  const rawFileName = `${padded(image.index)}.${downloaded.extension}`;
  const rawRelativePath = join("raw", rawFileName);
  const rawPath = join(CACHE_ROOT, job.id, rawRelativePath);
  await atomicWrite(rawPath, downloaded.buffer);

  const cleaned = await makeCleanVariant(job, image, downloaded, rawPath, cleanBottom);
  const fileName = `${padded(image.index)}.${cleaned.extension}`;
  const relativePath = join("originals", fileName);
  const absolutePath = join(CACHE_ROOT, job.id, relativePath);
  if (cleaned.path === rawPath) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await copyFile(rawPath, absolutePath);
  }
  const outputBuffer = cleaned.path === rawPath ? downloaded.buffer : await readFile(cleaned.path);
  return {
    ...image,
    fileName,
    relativePath,
    rawRelativePath,
    mime: cleaned.mime,
    bytes: outputBuffer.byteLength,
    actualWidth: cleaned.dimensions?.width ?? null,
    actualHeight: cleaned.dimensions?.height ?? null,
    cleanup: cleaned.cleanup,
    sha256: createHash("sha256").update(outputBuffer).digest("hex")
  };
}

export async function materializeJob(job, { fetchImpl = fetch, cleanBottom = true } = {}) {
  await rm(join(CACHE_ROOT, job.id), { recursive: true, force: true });
  await mkdir(join(CACHE_ROOT, job.id, "originals"), { recursive: true });
  await mkdir(join(CACHE_ROOT, job.id, "raw"), { recursive: true });
  const assets = [];
  for (let offset = 0; offset < job.images.length; offset += 3) {
    const batch = job.images.slice(offset, offset + 3);
    assets.push(...(await Promise.all(batch.map((image) => downloadAsset(job, image, fetchImpl, cleanBottom)))));
  }
  const completeJob = { ...job, images: assets };
  await writeFile(
    join(CACHE_ROOT, job.id, "manifest.json"),
    JSON.stringify(
      {
        id: completeJob.id,
        noteId: completeJob.noteId,
        title: completeJob.title,
        author: completeJob.author,
        sourceUrl: redactSourceUrl(completeJob.sourceUrl),
        capturedAt: completeJob.capturedAt,
        images: assets.map(
          ({ index, fileName, relativePath, rawRelativePath, mime, bytes, width, height, actualWidth, actualHeight, sha256, sourceKind, cleanup }) => ({
            index,
            fileName,
            relativePath,
            rawRelativePath,
            mime,
            bytes,
            width,
            height,
            actualWidth,
            actualHeight,
            sha256,
            sourceKind,
            cleanup
          })
        )
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  return completeJob;
}

function selectedAssets(job, selection) {
  const indexes = Array.isArray(selection) && selection.length
    ? new Set(selection.map(Number).filter(Number.isInteger))
    : new Set(job.images.map((image) => image.index));
  const assets = job.images.filter((image) => indexes.has(image.index));
  if (!assets.length) throw new CaptureError("EMPTY_SELECTION", "至少选择一张图片后再发送。");
  return assets;
}

function assertCleanConfirmation(confirmedClean) {
  if (confirmedClean !== true) {
    throw new CaptureError(
      "CLEAN_CONFIRMATION_REQUIRED",
      "请先完整预览并确认所选图片没有小红书平台水印；未确认的图片不会发送。"
    );
  }
}

export function parseFeishuChatId(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (!/^oc_[A-Za-z0-9_-]{16,}$/.test(input)) {
    throw new CaptureError("INVALID_FEISHU_CHAT", "飞书收件群 chat_id 格式不正确。");
  }
  return input;
}

async function readStoredConfig() {
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("not an object");
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new CaptureError("INVALID_LOCAL_CONFIG", "本机 Skill 配置文件无法读取。", undefined);
  }
}

export async function getFeishuChatConfig() {
  const stored = (await readStoredConfig()).feishuChat || {};
  const chatId = parseFeishuChatId(process.env.XHS_STICKER_FEISHU_CHAT_ID || stored.chatId);
  const name = String(process.env.XHS_STICKER_FEISHU_CHAT_NAME || stored.name || "表情包收件箱").trim();
  return { chatId, name: name.slice(0, 80) || "表情包收件箱" };
}

export async function configureFeishuChat(chatIdValue, nameValue) {
  const chatId = parseFeishuChatId(chatIdValue);
  if (!chatId) throw new CaptureError("INVALID_FEISHU_CHAT", "请提供飞书收件群 chat_id。");
  const name = String(nameValue || "表情包收件箱").trim().slice(0, 80) || "表情包收件箱";
  const payload = JSON.stringify({ feishuChat: { chatId, name } }, null, 2);
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${CONFIG_PATH}.part-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, payload, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  return { configured: true, chatName: name };
}

function parseCliEnvelope(stdout, stderr) {
  for (const raw of [stdout, stderr]) {
    const text = String(raw || "").trim();
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          return JSON.parse(text.slice(firstBrace, lastBrace + 1));
        } catch {
          // Ignore malformed upstream diagnostics.
        }
      }
    }
  }
  return null;
}

function idempotencyKey(job, asset) {
  const jobPart = String(job.id || "job").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const hashPart = String(asset.sha256 || "image").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `xhs-${jobPart}-${asset.index}-${hashPart}`.slice(0, 50);
}

function assertFeishuAssets(assets) {
  for (const asset of assets) {
    if (Number(asset.bytes) > FEISHU_CHAT_MAX_IMAGE_BYTES) {
      throw new CaptureError("FEISHU_CHAT_IMAGE_TOO_LARGE", `${asset.fileName} 超过飞书群图片 10 MB 上限，尚未发送任何图片。`);
    }
    if (!FEISHU_CHAT_IMAGE_MIMES.has(String(asset.mime || "").toLowerCase())) {
      throw new CaptureError("FEISHU_CHAT_IMAGE_UNSUPPORTED", `${asset.fileName} 的图片格式暂不支持发送到飞书群，尚未发送任何图片。`);
    }
    const width = Number(asset.actualWidth || asset.width || 0);
    const height = Number(asset.actualHeight || asset.height || 0);
    const maximumDimension = asset.mime === "image/gif" ? 2_000 : 12_000;
    if (width > maximumDimension || height > maximumDimension) {
      throw new CaptureError("FEISHU_CHAT_IMAGE_DIMENSIONS_EXCEEDED", `${asset.fileName} 的尺寸超过飞书群图片上限，尚未发送任何图片。`);
    }
  }
}

function mappedSendError(error) {
  if (error?.code === "ENOENT") {
    return new CaptureError("LARK_CLI_NOT_INSTALLED", "运行环境没有找到 lark-cli，暂时无法发送到飞书群。");
  }
  const envelope = error.envelope || parseCliEnvelope(error.stdout, error.stderr);
  const upstream = envelope?.error || {};
  const combined = `${upstream.subtype || ""} ${upstream.message || ""} ${upstream.hint || ""}`;
  if (/scope|permission|授权|权限/i.test(combined)) {
    return new CaptureError("LARK_BOT_SCOPE_REQUIRED", "飞书机器人缺少 im:resource 或 im:message:send_as_bot 权限。");
  }
  if (/not.*chat|chat.*not|not.*group|not.*member|机器人.*群|群.*机器人/i.test(combined)) {
    return new CaptureError("LARK_BOT_NOT_IN_CHAT", "飞书机器人无法访问配置的收件群，请确认机器人仍在群内。");
  }
  if (/rate|frequency|too many|限流|频率/i.test(combined)) {
    return new CaptureError("LARK_CHAT_RATE_LIMITED", "飞书发送过快，请稍后重试；幂等窗口内已发送图片不会重复。");
  }
  return new CaptureError("LARK_CHAT_SEND_FAILED", "发送到飞书收件群失败，请检查机器人配置后重试。");
}

async function sendAsset(job, asset, chatId, execFileImpl) {
  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    chatId,
    "--image",
    asset.relativePath,
    "--idempotency-key",
    idempotencyKey(job, asset),
    "--format",
    "json"
  ];
  try {
    const { stdout, stderr } = await execFileImpl("lark-cli", args, {
      cwd: join(CACHE_ROOT, job.id),
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
      }
    });
    const envelope = parseCliEnvelope(stdout, stderr);
    if (!envelope?.ok) throw Object.assign(new Error("Feishu send failed"), { envelope });
  } catch (error) {
    throw mappedSendError(error);
  }
}

export async function exportFeishuChat(job, options = {}, dependencies = {}) {
  assertCleanConfirmation(options.confirmedClean);
  const assets = selectedAssets(job, options.selection);
  assertFeishuAssets(assets);
  const chat = dependencies.chatConfig || (await getFeishuChatConfig());
  if (!chat.chatId) {
    throw new CaptureError("FEISHU_CHAT_NOT_CONFIGURED", "尚未配置飞书收件群，请先运行 configure 命令。");
  }
  let sentCount = 0;
  const execFileImpl = dependencies.execFileImpl || execFileAsync;
  for (const asset of assets) {
    try {
      await sendAsset(job, asset, chat.chatId, execFileImpl);
      sentCount += 1;
    } catch (error) {
      error.details = { sentCount, failedIndex: asset.index, total: assets.length };
      if (sentCount) error.message = `已发送 ${sentCount}/${assets.length} 张；第 ${asset.index + 1} 张失败。${error.message}`;
      throw error;
    }
  }
  return { target: "feishu-chat", chatName: chat.name, count: sentCount };
}

export async function integrationStatus() {
  let installed = true;
  let botReady = false;
  try {
    const { stdout, stderr } = await execFileAsync("lark-cli", ["auth", "status", "--json", "--verify"], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
      }
    });
    const envelope = parseCliEnvelope(stdout, stderr) || {};
    const bot = envelope?.data?.identities?.bot || envelope?.identities?.bot;
    botReady = bot?.status === "ready" && bot?.verified !== false;
  } catch (error) {
    installed = error?.code !== "ENOENT";
  }

  let chat = { chatId: null, name: null };
  let configError = null;
  try {
    chat = await getFeishuChatConfig();
  } catch (error) {
    configError = error instanceof CaptureError ? error.code : "INVALID_LOCAL_CONFIG";
  }
  return {
    feishuChat: {
      installed,
      botReady,
      configured: Boolean(chat.chatId),
      chatName: chat.name,
      configError,
      autoCleanupAvailable: await autoCleanupAvailable()
    }
  };
}
