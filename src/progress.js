import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export const PROGRESS_SCHEMA_VERSION = 2;
export const MAX_PROGRESS_CHECKS = 64;
export const MAX_PROGRESS_CHECK_NAME_BYTES = 512;
export const MAX_PROGRESS_CHECK_DETAIL_BYTES = 16 * 1024;

export class ProgressStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProgressStoreError";
    this.code = code;
  }
}

function emptyProgress() {
  return {
    version: PROGRESS_SCHEMA_VERSION,
    completed: {},
    attempts: {},
    evidence: {},
    latestChecks: {}
  };
}

function progressPath(workspace = process.cwd()) {
  return join(resolve(workspace), ".workshop", "progress.json");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low);
}

function normalizeProgress(value, { strict = false, path = "progress.json" } = {}) {
  if (!isRecord(value)) {
    throw new ProgressStoreError("PROGRESS_INVALID_SCHEMA", `Progress file ${path} must contain a JSON object.`);
  }
  if (
    value.version !== undefined &&
    value.version !== 1 &&
    value.version !== PROGRESS_SCHEMA_VERSION
  ) {
    throw new ProgressStoreError(
      "PROGRESS_UNSUPPORTED_VERSION",
      `Progress file ${path} uses unsupported schema version ${JSON.stringify(value.version)} and was preserved.`
    );
  }
  for (const field of ["completed", "attempts", "evidence", "latestChecks"]) {
    if (value[field] !== undefined && !isRecord(value[field])) {
      if (strict) {
        throw new ProgressStoreError(
          "PROGRESS_INVALID_SCHEMA",
          `Progress file ${path} has an invalid "${field}" field.`
        );
      }
    }
  }
  const completed = isRecord(value.completed) ? value.completed : {};
  const attempts = isRecord(value.attempts) ? value.attempts : {};
  const evidence = isRecord(value.evidence) ? value.evidence : {};
  const latestChecks = isRecord(value.latestChecks) ? value.latestChecks : {};
  if (strict) {
    for (const [id, timestamp] of Object.entries(completed)) {
      if (typeof timestamp !== "string" || !timestamp) {
        throw new ProgressStoreError(
          "PROGRESS_INVALID_SCHEMA",
          `Progress file ${path} has an invalid completion timestamp for ${id}.`
        );
      }
    }
    for (const [id, attempt] of Object.entries(attempts)) {
      if (!Number.isSafeInteger(attempt) || attempt < 0) {
        throw new ProgressStoreError(
          "PROGRESS_INVALID_SCHEMA",
          `Progress file ${path} has an invalid attempt count for ${id}.`
        );
      }
    }
    for (const [id, latest] of Object.entries(latestChecks)) {
      if (
        !isRecord(latest) ||
        typeof latest.source !== "string" ||
        !Number.isSafeInteger(latest.attempt) ||
        latest.attempt < 1 ||
        typeof latest.timestamp !== "string" ||
        typeof latest.ok !== "boolean" ||
        !Array.isArray(latest.checks)
      ) {
        throw new ProgressStoreError(
          "PROGRESS_INVALID_SCHEMA",
          `Progress file ${path} has an invalid latest check record for ${id}.`
        );
      }
      if (
        Buffer.byteLength(latest.source, "utf8") > 64 ||
        latest.checks.length > MAX_PROGRESS_CHECKS
      ) {
        throw new ProgressStoreError(
          "PROGRESS_INVALID_SCHEMA",
          `Progress file ${path} exceeds the latest check bounds for ${id}.`
        );
      }
      for (const check of latest.checks) {
        if (
          !isRecord(check) ||
          typeof check.name !== "string" ||
          typeof check.detail !== "string" ||
          typeof check.ok !== "boolean" ||
          (check.required !== undefined && typeof check.required !== "boolean")
        ) {
          throw new ProgressStoreError(
            "PROGRESS_INVALID_SCHEMA",
            `Progress file ${path} has an invalid check detail for ${id}.`
          );
        }
        if (
          Buffer.byteLength(check.name, "utf8") > MAX_PROGRESS_CHECK_NAME_BYTES ||
          Buffer.byteLength(check.detail, "utf8") > MAX_PROGRESS_CHECK_DETAIL_BYTES
        ) {
          throw new ProgressStoreError(
            "PROGRESS_INVALID_SCHEMA",
            `Progress file ${path} exceeds the check detail bounds for ${id}.`
          );
        }
      }
    }
  }
  return {
    ...value,
    version: PROGRESS_SCHEMA_VERSION,
    completed,
    attempts,
    evidence,
    latestChecks
  };
}

function sanitizeChecks(checks) {
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.slice(0, MAX_PROGRESS_CHECKS).map((check) => ({
    name: truncateUtf8(check?.name ?? "Unnamed check", MAX_PROGRESS_CHECK_NAME_BYTES),
    detail: truncateUtf8(check?.detail ?? "", MAX_PROGRESS_CHECK_DETAIL_BYTES),
    ok: Boolean(check?.ok),
    required: check?.required === undefined ? true : Boolean(check.required)
  }));
}

function atomicWriteJson(path, value, { renameFile = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const descriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameFile(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw new ProgressStoreError(
      "PROGRESS_WRITE_FAILED",
      `Could not atomically write progress file ${path}: ${error.message}`,
      { cause: error }
    );
  }
}

export function loadProgress(workspace = process.cwd(), { strict = false } = {}) {
  const path = progressPath(workspace);
  if (!existsSync(path)) {
    return emptyProgress();
  }
  try {
    return normalizeProgress(JSON.parse(readFileSync(path, "utf8")), { strict, path });
  } catch (error) {
    if (strict) {
      if (error instanceof ProgressStoreError) {
        throw error;
      }
      throw new ProgressStoreError(
        "PROGRESS_MALFORMED",
        `Progress file ${path} is malformed and was not replaced: ${error.message}`,
        { cause: error }
      );
    }
    return emptyProgress();
  }
}

export function saveProgress(progress, workspace = process.cwd(), options = {}) {
  const path = progressPath(workspace);
  const normalized = normalizeProgress(progress, { strict: true, path });
  atomicWriteJson(path, normalized, options);
  return normalized;
}

export function recordCheckpoint(id, ok, options = {}) {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("Checkpoint id must be a non-empty string.");
  }
  const normalizedOptions = typeof options === "string" ? { workspace: options } : options;
  const workspace = normalizedOptions.workspace ?? process.cwd();
  const progress = loadProgress(workspace, { strict: true });
  const attempt = (progress.attempts[id] ?? 0) + 1;
  const timestamp = normalizedOptions.timestamp ?? new Date().toISOString();
  progress.attempts[id] = attempt;
  progress.latestChecks[id] = {
    source: truncateUtf8(normalizedOptions.source ?? "unknown", 64),
    attempt,
    timestamp,
    ok: Boolean(ok),
    checks: sanitizeChecks(normalizedOptions.checks)
  };
  if (ok) {
    progress.completed[id] = timestamp;
    if (id === "04") {
      progress.evidence.lab04Worktree = timestamp;
    }
  } else {
    delete progress.completed[id];
  }
  saveProgress(progress, workspace);
  return progress;
}
