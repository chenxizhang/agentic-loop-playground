import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applicationMetadata } from "./app-metadata.js";

const ghExecutable = process.platform === "win32" ? "gh.exe" : "gh";
const feedbackRepository = applicationMetadata.feedbackRepository;
const maxTitleLength = 120;
const maxFeedbackLength = 4000;
const categories = new Set(["feedback", "bug", "idea", "success"]);
const managedUserRestriction = /Enterprise Managed User|managed user/i;

function feedbackError(message, code, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}

function boundedString(value, label, { min = 1, max }) {
  if (typeof value !== "string") throw feedbackError(`${label} is required.`, `INVALID_${label.toUpperCase()}`, 400);
  const text = value.trim();
  if (text.length < min) throw feedbackError(`${label} is required.`, `INVALID_${label.toUpperCase()}`, 400);
  if (text.length > max) throw feedbackError(`${label} must be ${max} characters or fewer.`, `INVALID_${label.toUpperCase()}`, 400);
  return text;
}

function publicIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    body: issue.body
  };
}

function ghFailure(error) {
  if (error.code === "ENOENT") {
    return feedbackError("GitHub CLI is not installed or is not on PATH. Install gh and run `gh auth login` before sending feedback.", "GH_NOT_FOUND", 503);
  }
  if (error.killed || error.signal === "SIGTERM") {
    return feedbackError("GitHub CLI did not finish before the timeout. The outcome is unknown; check GitHub before retrying.", "GH_TIMEOUT", 504);
  }
  const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join("\n").trim();
  if (managedUserRestriction.test(detail)) {
    const failure = feedbackError(
      "This GitHub account is enterprise-managed and cannot interact with this public repository through gh. Open the project on GitHub to star it or submit an issue with an account that has access.",
      "GH_EMU_RESTRICTED",
      403
    );
    failure.detail = detail;
    failure.fallback = fallbackLinks();
    return failure;
  }
  return feedbackError(detail || "GitHub CLI failed.", "GH_FAILED", 502);
}

function fallbackLinks() {
  return {
    repositoryUrl: applicationMetadata.feedbackRepositoryUrl,
    issueUrl: `${applicationMetadata.feedbackRepositoryUrl}/issues/new`
  };
}

export function formatFeedbackIssue({ category, title, feedback, context = {} }) {
  const version = applicationMetadata.version;
  const lines = [
    feedback,
    "",
    "## Context",
    `- Category: ${category}`,
    `- App version: ${version}`
  ];
  if (typeof context.labId === "string" && /^\d{2}$/.test(context.labId)) lines.push(`- Current lab: ${context.labId}`);
  if (Number.isFinite(context.score) && Number.isFinite(context.maximum)) lines.push(`- Final score: ${context.score} / ${context.maximum}`);
  lines.push(`- Submitted from: ${applicationMetadata.name}`);
  return {
    title: `[Playground feedback] ${title}`,
    body: lines.join("\n")
  };
}

export class GitHubFeedbackService {
  constructor({ runner = execFile, timeoutMs = 20_000, workspace = process.cwd() } = {}) {
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.workspace = resolve(workspace);
    this.submissions = new Map();
    this.restriction = null;
    this.currentLogin = null;
    this.restrictions = this.loadRestrictions();
  }

  get restrictionPath() {
    return join(this.workspace, ".workshop", "tmp", "feedback-restrictions.json");
  }

  loadRestrictions() {
    if (!existsSync(this.restrictionPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.restrictionPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveRestrictions() {
    mkdirSync(dirname(this.restrictionPath), { recursive: true });
    writeFileSync(this.restrictionPath, JSON.stringify(this.restrictions, null, 2));
  }

  runGh(args) {
    return new Promise((resolve, reject) => {
      this.runner(ghExecutable, args, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      }, (error, stdout, stderr) => {
        if (error) {
          reject(ghFailure(Object.assign(error, { stdout, stderr })));
          return;
        }
        resolve(stdout);
      });
    });
  }

  metadata() {
    return {
      repository: feedbackRepository,
      repositoryUrl: applicationMetadata.feedbackRepositoryUrl,
      issueUrl: fallbackLinks().issueUrl,
      version: applicationMetadata.version,
      directRestricted: Boolean(this.restriction),
      restriction: this.restriction
    };
  }

  async star() {
    this.applyStoredRestriction();
    if (this.restriction) return { ok: false, directRestricted: true, ...this.metadata() };
    try {
      await this.runGh(["api", "--method", "PUT", `/user/starred/${feedbackRepository}`]);
    } catch (error) {
      this.captureRestriction(error);
      throw error;
    }
    return { ok: true, starred: true, ...this.metadata() };
  }

  async account() {
    try {
      const stdout = await this.runGh(["api", "user"]);
      const user = JSON.parse(stdout);
      this.currentLogin = typeof user.login === "string" ? user.login : null;
      this.applyStoredRestriction();
      return {
        authenticated: true,
        login: this.currentLogin,
        type: typeof user.type === "string" ? user.type : null,
        managedUserLikely: Boolean(this.restriction),
        canUseDirectGithubFeedback: !this.restriction,
        ...this.metadata()
      };
    } catch (error) {
      this.captureRestriction(error);
      return {
        authenticated: false,
        managedUserLikely: Boolean(this.restriction),
        canUseDirectGithubFeedback: false,
        reason: error.message,
        code: error.code,
        ...this.metadata()
      };
    }
  }

  captureRestriction(error) {
    if (error?.code !== "GH_EMU_RESTRICTED") return;
    this.restriction = {
      code: error.code,
      message: error.message,
      repositoryUrl: applicationMetadata.feedbackRepositoryUrl,
      issueUrl: fallbackLinks().issueUrl
    };
    this.restrictions[this.currentLogin ?? "__active__"] = this.restriction;
    this.saveRestrictions();
  }

  applyStoredRestriction() {
    const stored = this.restrictions[this.currentLogin] ?? this.restrictions.__active__;
    if (stored?.code === "GH_EMU_RESTRICTED") this.restriction = stored;
  }

  async createIssue(input) {
    this.applyStoredRestriction();
    if (this.restriction) return { ok: false, directRestricted: true, ...this.metadata() };
    const submissionId = input.submissionId ?? randomUUID();
    if (typeof submissionId !== "string" || !/^[0-9a-f-]{8,64}$/i.test(submissionId)) {
      throw feedbackError("submissionId must be a stable identifier.", "INVALID_SUBMISSION_ID", 400);
    }
    if (this.submissions.has(submissionId)) return { ...this.submissions.get(submissionId), replayed: true };

    const category = categories.has(input.category) ? input.category : "feedback";
    const title = boundedString(input.title, "title", { max: maxTitleLength });
    const feedback = boundedString(input.feedback, "feedback", { max: maxFeedbackLength });
    const formatted = formatFeedbackIssue({ category, title, feedback, context: input.context });
    let stdout;
    try {
      stdout = await this.runGh([
        "api",
        "--method", "POST",
        `repos/${feedbackRepository}/issues`,
        "--field", `title=${formatted.title}`,
        "--field", `body=${formatted.body}`
      ]);
    } catch (error) {
      this.captureRestriction(error);
      throw error;
    }
    let issue;
    try {
      issue = JSON.parse(stdout);
    } catch {
      throw feedbackError("GitHub CLI returned an invalid issue response.", "GH_INVALID_RESPONSE", 502);
    }
    const receipt = { ok: true, issue: publicIssue(issue), ...this.metadata() };
    if (!Number.isInteger(receipt.issue.number) || typeof receipt.issue.url !== "string") {
      throw feedbackError("GitHub CLI returned an incomplete issue response.", "GH_INVALID_RESPONSE", 502);
    }
    this.submissions.set(submissionId, receipt);
    return receipt;
  }
}
