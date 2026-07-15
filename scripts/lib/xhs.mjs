const XHS_PAGE_HOSTS = new Set([
  "xiaohongshu.com",
  "www.xiaohongshu.com",
  "m.xiaohongshu.com",
  "xhslink.com",
  "www.xhslink.com"
]);

const IMAGE_HOST_SUFFIXES = [".xhscdn.com", ".xiaohongshu.com"];
const IMAGE_HOSTS = new Set(["xhscdn.com", "xiaohongshu.com"]);

const PAGE_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
};

export class CaptureError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    this.details = details;
  }
}

export function extractSharedUrl(input) {
  const text = String(input ?? "").trim();
  const match = text.match(/https?:\/\/[^\s<>"'，。！？；）\]}]+/i);
  if (!match) {
    throw new CaptureError("INVALID_LINK", "没有找到可识别的小红书链接。请粘贴完整分享口令或 URL。");
  }

  let candidate = match[0].replace(/[.,!?;:]+$/g, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CaptureError("INVALID_LINK", "链接格式不正确，请重新复制小红书分享链接。");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CaptureError("INVALID_LINK", "只支持 http 或 https 小红书链接。");
  }
  if (!isAllowedPageHost(parsed.hostname)) {
    throw new CaptureError("UNSUPPORTED_HOST", "目前只支持 xiaohongshu.com 与 xhslink.com 的公开分享链接。");
  }
  parsed.hash = "";
  return parsed.toString();
}

export function isAllowedPageHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return XHS_PAGE_HOSTS.has(host);
}

export function isAllowedImageHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return IMAGE_HOSTS.has(host) || IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function redirectLocation(response, currentUrl) {
  const location = response.headers.get("location");
  if (!location) {
    throw new CaptureError("BAD_REDIRECT", "小红书返回了无目标地址的跳转。");
  }
  return new URL(location, currentUrl).toString();
}

export async function fetchXhsPage(input, { fetchImpl = fetch } = {}) {
  let currentUrl = extractSharedUrl(input);
  let response;

  for (let hop = 0; hop < 6; hop += 1) {
    const current = new URL(currentUrl);
    if (!isAllowedPageHost(current.hostname)) {
      throw new CaptureError("UNSAFE_REDIRECT", "分享链接跳转到了非小红书域名，已停止访问。");
    }

    const headers = { ...PAGE_HEADERS };
    response = await fetchImpl(currentUrl, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      currentUrl = redirectLocation(response, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new CaptureError(
        "XHS_HTTP_ERROR",
        `小红书页面暂时不可用（HTTP ${response.status}）。请确认笔记仍公开可见。`
      );
    }

    const html = await response.text();
    if (looksLikeBlockedPage(html, currentUrl)) {
      throw new CaptureError(
        "XHS_LINK_TOKEN_REQUIRED",
        "这个链接没有带可访问笔记所需的分享参数。请从小红书 App 重新点“分享 → 复制链接”，不要只复制浏览器地址栏。"
      );
    }
    return { html, finalUrl: currentUrl };
  }

  throw new CaptureError("TOO_MANY_REDIRECTS", "分享链接跳转次数过多，已停止访问。");
}

function looksLikeBlockedPage(html, finalUrl) {
  const path = new URL(finalUrl).pathname;
  return (
    path.startsWith("/404") ||
    /当前笔记暂时无法浏览|安全验证|访问异常|error_code["'=:\s]+300031/i.test(html)
  );
}

function findBalancedObject(source, startIndex) {
  const start = source.indexOf("{", startIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

export function sanitizeEmbeddedJson(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; ) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }

    const invalidLiteral = source.slice(index).match(/^(undefined|NaN|Infinity)(?![A-Za-z0-9_$])/);
    if (invalidLiteral) {
      output += "null";
      index += invalidLiteral[0].length;
      continue;
    }

    output += character;
    index += 1;
  }
  return output;
}

export function extractInitialState(html) {
  const markers = ["window.__INITIAL_STATE__", "__INITIAL_STATE__"];
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const assignmentIndex = html.indexOf("=", markerIndex + marker.length);
    if (assignmentIndex < 0) continue;
    const rawObject = findBalancedObject(html, assignmentIndex + 1);
    if (!rawObject) continue;
    try {
      return JSON.parse(sanitizeEmbeddedJson(rawObject));
    } catch (error) {
      throw new CaptureError("STATE_PARSE_FAILED", "已打开笔记，但无法解析其中的图片信息。", error.message);
    }
  }
  throw new CaptureError("STATE_NOT_FOUND", "页面里没有找到公开笔记数据，可能需要重新复制分享链接。");
}

export function noteIdFromUrl(url) {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/i);
  return match?.[1] ?? null;
}

function findNoteCandidates(root) {
  const candidates = [];
  const seen = new Set();
  const visit = (value, path = []) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value.imageList) && value.imageList.length > 0) {
      candidates.push({ value, path });
    }
    for (const [key, child] of Object.entries(value)) visit(child, path.concat(key));
  };
  visit(root);
  return candidates;
}

function unwrapNoteDetail(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.imageList)) return value;
  if (value.note && Array.isArray(value.note.imageList)) return value.note;
  return null;
}

function chooseNote(state, noteId) {
  const detailMap = state?.note?.noteDetailMap;
  if (detailMap && typeof detailMap === "object") {
    if (noteId && detailMap[noteId]) {
      const exact = unwrapNoteDetail(detailMap[noteId]);
      if (exact) return exact;
    }
    for (const [key, detail] of Object.entries(detailMap)) {
      const note = unwrapNoteDetail(detail);
      if (!note) continue;
      if (!noteId || key.includes(noteId) || note.noteId === noteId || note.id === noteId) return note;
    }
  }

  const candidates = findNoteCandidates(state);
  const exact = candidates.find(({ value, path }) =>
    noteId
      ? value.noteId === noteId || value.id === noteId || path.some((segment) => String(segment).includes(noteId))
      : false
  );
  return exact?.value ?? (candidates.length === 1 ? candidates[0].value : null);
}

function normalizedHttpsUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!isAllowedImageHost(url.hostname)) return null;
    url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

export function originalImageUrl(value) {
  const normalized = normalizedHttpsUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);

  // These are documented-style resize/format operations already present in the
  // public URL. Removing them asks the same public resource for its base bytes;
  // watermark transforms and opaque XHS suffixes are deliberately untouched.
  if (/^\?(?:imageView2|imageMogr2|imageMogr)\//i.test(url.search)) {
    url.search = "";
  }
  return url.toString();
}

function addCandidate(candidates, url, score, scene, origin) {
  const normalized = normalizedHttpsUrl(url);
  if (!normalized) return;
  const upperScene = String(scene ?? "").toUpperCase();
  if (/(?:^|_)WM(?:_|$)|WATERMARK/.test(upperScene)) return;
  candidates.push({
    url: originalImageUrl(normalized) ?? normalized,
    fallbackUrl: normalized,
    score,
    scene: scene || origin,
    origin
  });
}

export function pickOriginalImage(image) {
  const candidates = [];
  addCandidate(candidates, image?.urlDefault, 100, "WB_DFT", "urlDefault");
  addCandidate(candidates, image?.urlPre, 88, "WB_PRV", "urlPre");
  addCandidate(candidates, image?.url, 80, "DIRECT", "url");

  for (const info of image?.infoList ?? []) {
    const scene = String(info?.imageScene ?? info?.scene ?? "");
    let score = 78;
    if (/DFT|DEFAULT/i.test(scene)) score = 96;
    else if (/PRV|PREVIEW/i.test(scene)) score = 86;
    else if (/CRD|CARD/i.test(scene)) score = 70;
    addCandidate(candidates, info?.url, score, scene, "infoList");
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] ?? null;
}

function cleanText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function extractNoteFromState(state, finalUrl) {
  const noteId = noteIdFromUrl(finalUrl);
  const note = chooseNote(state, noteId);
  if (!note) {
    throw new CaptureError("NOTE_NOT_FOUND", "没有在页面中找到这篇笔记的图片列表。请确认它是公开图文笔记。");
  }

  const images = note.imageList
    .map((image, index) => {
      const picked = pickOriginalImage(image);
      if (!picked) return null;
      return {
        index,
        url: picked.url,
        fallbackUrl: picked.fallbackUrl,
        width: Number(image.width || image?.infoList?.[0]?.width) || null,
        height: Number(image.height || image?.infoList?.[0]?.height) || null,
        sourceScene: picked.scene,
        sourceKind: "public_image_resource",
        watermarkRisk:
          /wlteh|watermark|(?:^|_)wm(?:_|$)/i.test(`${picked.url} ${picked.fallbackUrl}`) ||
          /^WB_DFT$/i.test(String(picked.scene || ""))
      };
    })
    .filter(Boolean)
    .filter((image, index, list) => list.findIndex((item) => item.url === image.url) === index);

  if (images.length === 0) {
    throw new CaptureError("NO_ORIGINAL_IMAGES", "这篇笔记没有暴露可确认的非水印原始图片，因此没有输出文件。");
  }

  return {
    noteId: noteId ?? cleanText(note.noteId || note.id, "unknown"),
    title: cleanText(note.title || note.displayTitle, "未命名表情包"),
    description: cleanText(note.desc),
    author: cleanText(note?.user?.nickname || note?.user?.nickName || note.nickname, "未知作者"),
    sourceUrl: finalUrl,
    images
  };
}

export async function captureXhsNote(input, options = {}) {
  const { html, finalUrl } = await fetchXhsPage(input, options);
  const state = extractInitialState(html);
  return extractNoteFromState(state, finalUrl);
}

export const requestHeaders = {
  image(referer) {
    return {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      referer: referer || "https://www.xiaohongshu.com/",
      "user-agent": PAGE_HEADERS["user-agent"]
    };
  }
};
