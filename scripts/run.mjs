#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { captureXhsNote, CaptureError } from "./lib/xhs.mjs";
import {
  CACHE_ROOT,
  configureFeishuChat,
  exportFeishuChat,
  integrationStatus,
  materializeJob
} from "./lib/runtime.mjs";

const BOOLEAN_OPTIONS = new Set(["stdin", "confirmed-clean", "no-clean-bottom", "help"]);

function parseArguments(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      throw new CaptureError("CLI_USAGE", `参数 --${key} 缺少值。`);
    }
    options[key] = next;
    index += 1;
  }
  return { command, options, positionals };
}

async function readFirstInputLine() {
  const reader = createInterface({ input: process.stdin, terminal: false });
  const shouldHideInput = Boolean(process.stdin.isTTY);
  if (shouldHideInput) spawnSync("/bin/stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  try {
    for await (const line of reader) {
      if (line.trim()) return line;
    }
  } finally {
    reader.close();
    if (shouldHideInput) spawnSync("/bin/stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
  }
  throw new CaptureError("CLI_USAGE", "标准输入中没有小红书链接。");
}

function assertJobId(value) {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new CaptureError("INVALID_JOB_ID", "捕获任务 ID 格式不正确。");
  }
  return id;
}

async function loadJob(value) {
  const id = assertJobId(value);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(CACHE_ROOT, id, "manifest.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CaptureError("JOB_NOT_FOUND", "没有找到这个捕获任务，请重新提供小红书链接。");
    }
    throw new CaptureError("INVALID_JOB_MANIFEST", "捕获任务清单无法读取，请重新捕获。");
  }
  if (manifest.id !== id || !Array.isArray(manifest.images)) {
    throw new CaptureError("INVALID_JOB_MANIFEST", "捕获任务清单内容不完整，请重新捕获。");
  }
  return {
    ...manifest,
    images: manifest.images.map((image) => ({
      ...image,
      relativePath: image.relativePath || join("originals", image.fileName),
      rawRelativePath: image.rawRelativePath || null
    }))
  };
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    author: job.author,
    imageCount: job.images.length,
    images: job.images.map((image) => ({
      number: image.index + 1,
      fileName: image.fileName,
      mime: image.mime,
      bytes: image.bytes,
      width: image.actualWidth || image.width || null,
      height: image.actualHeight || image.height || null,
      cleanup: image.cleanup,
      localPath: join(CACHE_ROOT, job.id, image.relativePath || join("originals", image.fileName)),
      rawLocalPath: image.rawRelativePath ? join(CACHE_ROOT, job.id, image.rawRelativePath) : null
    }))
  };
}

function parseSelection(value, imageCount) {
  if (!value || value === "all") return undefined;
  const selected = new Set();
  for (const part of String(value).split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new CaptureError("INVALID_SELECTION", `图片范围 ${token} 顺序不正确。`);
      for (let number = start; number <= end; number += 1) selected.add(number - 1);
      continue;
    }
    if (!/^\d+$/.test(token)) throw new CaptureError("INVALID_SELECTION", `无法识别图片编号 ${token}。`);
    selected.add(Number(token) - 1);
  }
  if (!selected.size || [...selected].some((index) => index < 0 || index >= imageCount)) {
    throw new CaptureError("INVALID_SELECTION", `图片编号必须位于 1-${imageCount}。`);
  }
  return [...selected].sort((left, right) => left - right);
}

async function captureCommand(options) {
  if (!options.stdin) {
    throw new CaptureError("CLI_USAGE", "为避免分享参数进入 shell 历史，capture 命令只接受 --stdin。");
  }
  const captured = await captureXhsNote(await readFirstInputLine());
  const job = await materializeJob(
    { ...captured, id: randomUUID(), capturedAt: new Date().toISOString() },
    { cleanBottom: options["no-clean-bottom"] !== true }
  );
  return publicJob(job);
}

async function sendCommand(options) {
  if (!options["confirmed-clean"]) {
    throw new CaptureError("CLEAN_CONFIRMATION_REQUIRED", "逐张检查处理结果后，才能使用 --confirmed-clean 发送。");
  }
  const job = await loadJob(options.job);
  const selection = parseSelection(options.selection, job.images.length);
  return exportFeishuChat(job, { confirmedClean: true, selection });
}

async function configureCommand(options) {
  return configureFeishuChat(options["chat-id"], options["chat-name"]);
}

function usage() {
  return [
    "小红书表情包捕获 Skill",
    "",
    "status",
    "configure --chat-id oc_xxx [--chat-name 表情包收件箱]",
    "capture --stdin [--no-clean-bottom]",
    "show --job <任务 UUID>",
    "send --job <任务 UUID> [--selection all|1,3,5-7] --confirmed-clean"
  ].join("\n");
}

function writeSuccess(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

function writeError(error) {
  const known = error instanceof CaptureError;
  const safeDetails = known && error.details && typeof error.details === "object"
    ? {
        sentCount: error.details.sentCount,
        failedIndex: error.details.failedIndex,
        total: error.details.total
      }
    : undefined;
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "后台捕获任务遇到意外错误。",
          details: safeDetails && Object.values(safeDetails).some((value) => value !== undefined) ? safeDetails : undefined
        }
      },
      null,
      2
    )}\n`
  );
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new CaptureError("NODE_VERSION_UNSUPPORTED", "此 Skill 需要 Node.js 20 或更高版本。");
  }
  const { command, options, positionals } = parseArguments(process.argv.slice(2));
  if (positionals.length) throw new CaptureError("CLI_USAGE", "请使用命名参数，不要把链接或配置直接放在位置参数中。");
  if (options.help || command === "help") return process.stdout.write(`${usage()}\n`);
  if (command === "status") return writeSuccess(await integrationStatus());
  if (command === "configure") return writeSuccess(await configureCommand(options));
  if (command === "capture") return writeSuccess(await captureCommand(options));
  if (command === "show") return writeSuccess(publicJob(await loadJob(options.job)));
  if (command === "send") return writeSuccess(await sendCommand(options));
  throw new CaptureError("CLI_USAGE", `不支持命令 ${command}。\n${usage()}`);
}

main().catch((error) => {
  writeError(error);
  process.exitCode = 1;
});
