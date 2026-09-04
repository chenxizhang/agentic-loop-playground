const state = {
  lessons: [],
  progress: { completed: {}, attempts: {} },
  currentLessonId: "00",
  info: null
};

const lessonNav = document.querySelector("#lesson-nav");
const lessonView = document.querySelector("#lesson-view");
const progressLabel = document.querySelector("#progress-label");
const progressBar = document.querySelector("#progress-bar");
const progressMessage = document.querySelector("#progress-message");
const toast = document.querySelector("#toast");
const resultDialog = document.querySelector("#result-dialog");
const dialogTitle = document.querySelector("#dialog-title");
const dialogContent = document.querySelector("#dialog-content");
const runtimeStatus = document.querySelector("#runtime-status");
const repositoryDialog = document.querySelector("#repository-dialog");
const repositoryPrerequisites = document.querySelector("#repository-prerequisites");
const repositoryResult = document.querySelector("#repository-result");
const repositoryForm = document.querySelector("#repository-form");
const repositorySubmit = document.querySelector("#repository-submit");
const workspacePath = document.querySelector("#workspace-path");
const copilotMessages = document.querySelector("#copilot-messages");
const copilotPermissions = document.querySelector("#copilot-permissions");
const copilotStatus = document.querySelector("#copilot-status");
const copilotToolStatus = document.querySelector("#copilot-tool-status");
const copilotForm = document.querySelector("#copilot-form");
const copilotInput = document.querySelector("#copilot-input");
const copilotSend = document.querySelector("#copilot-send");
const copilotConnect = document.querySelector("#copilot-connect");
let streamingAssistant = null;

async function request(path, options) {
  const requestOptions = { ...options };
  if (requestOptions.method === "POST") {
    requestOptions.headers = { ...requestOptions.headers, "X-Loop-Lab": "browser" };
  }
  const response = await fetch(path, requestOptions);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatInline(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function renderProgress() {
  const completed = Object.keys(state.progress.completed).length;
  const total = state.lessons.length;
  progressLabel.textContent = `${completed} / ${total}`;
  progressBar.style.width = `${total ? (completed / total) * 100 : 0}%`;
  progressMessage.textContent = completed === total
    ? "All labs now form a complete evidence chain for the final human decision."
    : `${total - completed} labs remaining. Each failure is evidence for the next iteration.`;
}

function renderNavigation() {
  lessonNav.innerHTML = state.lessons.map((lesson) => {
    const active = lesson.id === state.currentLessonId;
    const complete = Boolean(state.progress.completed[lesson.id]);
    return `
      <button class="nav-item${active ? " active" : ""}" data-lesson="${lesson.id}">
        <span class="nav-number">${lesson.id}</span>
        <span class="nav-title">${escapeHtml(lesson.title)}</span>
        <span class="nav-check">${complete ? "●" : ""}</span>
      </button>
    `;
  }).join("");
}

function renderLesson() {
  const lesson = state.lessons.find((item) => item.id === state.currentLessonId);
  if (!lesson) return;
  const complete = Boolean(state.progress.completed[lesson.id]);
  lessonView.innerHTML = `
    <article>
      <section class="lesson-hero">
        <div class="lesson-meta">
          <span class="lesson-index">LAB ${lesson.id}</span>
          <span>•</span>
          <span>${escapeHtml(lesson.component)}</span>
          ${complete ? "<span>•</span><span style=\"color:var(--green)\">PASSED</span>" : ""}
        </div>
        <h2>${escapeHtml(lesson.title)}</h2>
        <p class="lesson-objective">${escapeHtml(lesson.objective)}</p>
        <div class="scenario"><strong>Scenario:</strong> ${escapeHtml(lesson.scenario)}</div>
      </section>

      <div class="content-grid">
        <div>
          <section class="panel">
            <h3>Hands-on Steps</h3>
            <ol class="step-list">
              ${lesson.steps.map((step, index) => `
                <li><span class="step-number">${String(index + 1).padStart(2, "0")}</span><span>${formatInline(step)}</span></li>
              `).join("")}
            </ol>
          </section>

          <section class="prompt-card">
            <div class="prompt-header">
              <span>RUN WITH EMBEDDED COPILOT</span>
              <div class="prompt-actions">
                <button class="copy-button" data-copy-prompt>Copy</button>
                <button class="copy-button" data-send-prompt>Send to Copilot</button>
              </div>
            </div>
            <pre class="prompt-text">${escapeHtml(lesson.prompt)}</pre>
          </section>
        </div>

        <aside class="panel">
          <h3>Pass Evidence</h3>
          <ul class="evidence-list">
            ${lesson.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
          <div class="reflection">
            <span>REFLECT</span>
            <p>${escapeHtml(lesson.reflection)}</p>
          </div>
        </aside>
      </div>

      <section class="checkpoint">
        <div>
          <strong>${complete ? "Run Validation Again" : "Run Automated Validation"}</strong>
          <span>${formatInline(lesson.verification)}</span>
        </div>
        <button class="button button-primary" data-check="${lesson.id}">Check Lab ${lesson.id}</button>
      </section>
    </article>
  `;
}

function render() {
  renderProgress();
  renderNavigation();
  renderLesson();
}

function resultMarkup(checks) {
  return checks.map((check) => `
    <div class="check-result ${check.ok ? "pass" : "fail"}">
      <div class="check-icon">${check.ok ? "✓" : "×"}</div>
      <div>
        <strong>${escapeHtml(check.name)}</strong>
        <p>${escapeHtml(check.detail)}</p>
      </div>
    </div>
  `).join("");
}

function showResults(title, checks, prefix = "") {
  dialogTitle.textContent = title;
  dialogContent.innerHTML = `${prefix}${resultMarkup(checks)}`;
  resultDialog.showModal();
}

function scrollChat() {
  copilotMessages.scrollTop = copilotMessages.scrollHeight;
}

function removeWelcome() {
  copilotMessages.querySelector(".copilot-welcome")?.remove();
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^) \n]+\))/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const link = document.createElement("a");
      link.textContent = parts[1];
      try {
        const url = new URL(parts[2], window.location.href);
        if (["http:", "https:", "mailto:"].includes(url.protocol)) {
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noreferrer";
        }
      } catch {
        // Invalid links remain visible without becoming navigable.
      }
      parent.append(link);
    }
    cursor = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

function appendParagraph(parent, lines) {
  const paragraph = document.createElement("p");
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append(document.createElement("br"));
    appendInlineMarkdown(paragraph, line);
  });
  parent.append(paragraph);
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdown(target, markdown) {
  const fragment = document.createDocumentFragment();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.language = fence[1];
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const value of tableCells(line)) {
        const cell = document.createElement("th");
        appendInlineMarkdown(cell, value);
        headRow.append(cell);
      }
      head.append(headRow);
      table.append(head);
      index += 2;

      const body = document.createElement("tbody");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr");
        for (const value of tableCells(lines[index])) {
          const cell = document.createElement("td");
          appendInlineMarkdown(cell, value);
          row.append(cell);
        }
        body.append(row);
        index += 1;
      }
      table.append(body);
      fragment.append(table);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      appendParagraph(quote, quoteLines);
      fragment.append(quote);
      continue;
    }

    const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
        if (!itemMatch || /\d+\./.test(itemMatch[1]) !== ordered) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemMatch[2]);
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```[\w-]*\s*$/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[index]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(fragment, paragraphLines);
  }

  target.replaceChildren(fragment);
}

function addChatMessage(role, content = "") {
  removeWelcome();
  const wrapper = document.createElement("div");
  wrapper.className = `chat-message ${role}`;
  const label = document.createElement("div");
  label.className = "chat-message-label";
  label.textContent = role === "user" ? "You" : "Copilot";
  const body = document.createElement("div");
  body.className = "chat-message-content";
  if (role === "assistant") {
    body.dataset.markdown = content;
    renderMarkdown(body, content);
  } else {
    body.textContent = content;
  }
  wrapper.append(label, body);
  copilotMessages.append(wrapper);
  scrollChat();
  return body;
}

function addActivity(text, stateName = "") {
  removeWelcome();
  const activity = document.createElement("div");
  activity.className = `chat-activity ${stateName}`;
  activity.textContent = text;
  copilotMessages.append(activity);
  scrollChat();
}

function setCopilotStatus(status) {
  copilotStatus.className = "copilot-status";
  if (status.state === "ready") {
    copilotStatus.classList.add("ready");
    copilotStatus.lastChild.textContent = status.login ? ` Connected · ${status.login}` : " Connected";
  } else if (status.state === "connecting") {
    copilotStatus.classList.add("working");
    copilotStatus.lastChild.textContent = " Connecting";
  } else if (status.state === "error") {
    copilotStatus.classList.add("error");
    copilotStatus.lastChild.textContent = " Connection failed";
    addActivity(status.error || "Copilot connection failed", "failure");
  } else {
    copilotStatus.lastChild.textContent = " Disconnected";
  }
}

function renderPermission(data) {
  const card = document.createElement("div");
  card.className = "permission-card";
  card.dataset.permissionId = data.requestId;
  const request = data.request;
  card.innerHTML = `
    <h3>${escapeHtml(request.title)}</h3>
    <p>${escapeHtml(request.intention || "")}</p>
    ${request.warning ? `<p class="permission-warning">${escapeHtml(request.warning)}</p>` : ""}
    ${data.sandboxBypass ? '<p class="permission-warning">This operation requests a sandbox bypass.</p>' : ""}
    <div class="permission-detail">${escapeHtml(request.diff || request.detail || JSON.stringify(request.arguments ?? {}, null, 2))}</div>
    <div class="permission-actions">
      <button class="permission-reject" data-permission-decision="reject">Reject</button>
      <button class="permission-approve" data-permission-decision="approve">Allow Once</button>
    </div>
  `;
  copilotPermissions.append(card);
}

function connectCopilotEvents() {
  const events = new EventSource("/api/copilot/events");
  const eventTypes = [
    "chat.status",
    "user.message",
    "assistant.delta",
    "assistant.message",
    "tool.started",
    "tool.completed",
    "session.idle",
    "chat.error",
    "chat.reset",
    "permission.requested",
    "permission.resolved"
  ];
  for (const type of eventTypes) {
    events.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      const data = payload.data ?? {};
      if (type === "chat.status") setCopilotStatus(data);
      if (type === "user.message") addChatMessage("user", data.content);
      if (type === "assistant.delta") {
        if (!streamingAssistant) streamingAssistant = addChatMessage("assistant");
        streamingAssistant.dataset.markdown += data.content;
        renderMarkdown(streamingAssistant, streamingAssistant.dataset.markdown);
        scrollChat();
      }
      if (type === "assistant.message") {
        if (streamingAssistant) {
          streamingAssistant.dataset.markdown = data.content;
          renderMarkdown(streamingAssistant, data.content);
          streamingAssistant = null;
        } else {
          addChatMessage("assistant", data.content);
        }
      }
      if (type === "tool.started") {
        copilotToolStatus.textContent = `Running ${data.toolName || "tool"}`;
        addActivity(`Tool started: ${data.toolName || "unknown"}`);
      }
      if (type === "tool.completed") {
        copilotToolStatus.textContent = "Workspace agent";
        addActivity(`Tool ${data.success === false ? "failed" : "completed"}: ${data.toolName || "unknown"}`, data.success === false ? "failure" : "success");
      }
      if (type === "session.idle") {
        copilotToolStatus.textContent = "Workspace agent";
        copilotSend.disabled = false;
      }
      if (type === "chat.error") addActivity(data.message, "failure");
      if (type === "chat.reset") {
        streamingAssistant = null;
        copilotMessages.innerHTML = "";
        copilotPermissions.innerHTML = "";
        copilotToolStatus.textContent = "Workspace agent";
        copilotSend.disabled = false;
        addActivity("New Copilot session");
      }
      if (type === "permission.requested") renderPermission(data);
      if (type === "permission.resolved") {
        copilotPermissions.querySelector(`[data-permission-id="${CSS.escape(data.requestId)}"]`)?.remove();
      }
    });
  }
  events.onerror = () => {
    copilotToolStatus.textContent = "Reconnecting…";
  };
}

async function startCopilot() {
  setCopilotStatus({ state: "connecting" });
  try {
    const status = await request("/api/copilot/start", { method: "POST" });
    setCopilotStatus(status);
    return true;
  } catch (error) {
    setCopilotStatus({ state: "error", error: error.message });
    return false;
  }
}

async function sendToCopilot(prompt) {
  if (!prompt.trim()) return;
  copilotSend.disabled = true;
  copilotToolStatus.textContent = "Thinking…";
  try {
    await request("/api/copilot/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
  } catch (error) {
    copilotSend.disabled = false;
    copilotToolStatus.textContent = "Workspace agent";
    addActivity(error.message, "failure");
  }
}

async function checkLesson(id, button) {
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const result = await request(`/api/check/${id}`, { method: "POST" });
    state.progress = result.progress;
    render();
    showResults(result.ok ? `Lab ${id} Passed` : `Lab ${id} Needs Another Iteration`, result.checks);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

lessonNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-lesson]");
  if (!button) return;
  state.currentLessonId = button.dataset.lesson;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

lessonView.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-prompt]");
  if (copyButton) {
    const lesson = state.lessons.find((item) => item.id === state.currentLessonId);
    await navigator.clipboard.writeText(lesson.prompt);
    showToast("Prompt copied.");
    return;
  }
  const sendPromptButton = event.target.closest("[data-send-prompt]");
  if (sendPromptButton) {
    const lesson = state.lessons.find((item) => item.id === state.currentLessonId);
    await sendToCopilot(lesson.prompt);
    return;
  }
  const checkButton = event.target.closest("[data-check]");
  if (checkButton) {
    await checkLesson(checkButton.dataset.check, checkButton);
  }
});

copilotConnect.addEventListener("click", startCopilot);
copilotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = copilotInput.value;
  copilotInput.value = "";
  await sendToCopilot(prompt);
});
copilotInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    copilotForm.requestSubmit();
  }
});
document.querySelector("#copilot-abort").addEventListener("click", async () => {
  await request("/api/copilot/abort", { method: "POST" });
});
document.querySelector("#copilot-reset").addEventListener("click", async () => {
  await request("/api/copilot/reset", { method: "POST" });
});
copilotPermissions.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-permission-decision]");
  if (!button) return;
  const card = button.closest("[data-permission-id]");
  button.disabled = true;
  try {
    await request("/api/copilot/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: card.dataset.permissionId,
        decision: button.dataset.permissionDecision
      })
    });
  } catch (error) {
    addActivity(error.message, "failure");
  }
});

document.querySelector("#doctor-button").addEventListener("click", async () => {
  try {
    const result = await request("/api/doctor");
    showResults(result.ok ? "Environment Ready" : "Environment Setup Required", result.checks);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#grade-button").addEventListener("click", async () => {
  try {
    const result = await request("/api/grade", { method: "POST" });
    state.progress = result.progress;
    render();
    const checks = result.results.map((item) => ({
      ok: item.ok,
      name: `Lab ${item.id} · ${item.title}`,
      detail: item.ok ? "Evidence accepted" : item.checks.filter((check) => !check.ok).map((check) => check.detail).join("\n")
    }));
    showResults("Final Score", checks, `<div class="score">${result.score} / ${result.maximum}</div>`);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#copy-workspace-path").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.info.workspace);
  showToast("Workspace path copied.");
});

function renderPrerequisites(result) {
  repositoryPrerequisites.innerHTML = result.checks.map((check) => `
    <div class="prerequisite-item${check.ok ? "" : " missing"}">
      <strong>${check.ok ? "✓" : "△"} ${escapeHtml(check.name)}</strong>
      <span>${escapeHtml(check.detail)}</span>
      <small>${escapeHtml(check.requiredFor)}</small>
    </div>
  `).join("") + `<p class="safety-note">${result.safety.map((item) => escapeHtml(item)).join(" · ")}</p>`;
}

function renderRepositoryAnalysis(result) {
  repositoryResult.innerHTML = `
    <div class="analysis-summary">
      <div>
        <strong>${escapeHtml(result.repository)}</strong>
        <span>${escapeHtml(result.level)} · Scanned ${result.scannedFiles} files${result.truncated ? " (scan limit reached)" : ""}</span>
      </div>
      <div class="analysis-score">${result.score}<small>/100</small></div>
    </div>
    ${result.categories.map((category) => `
      <div class="analysis-category">
        <div class="analysis-category-header">
          <span>${escapeHtml(category.title)}</span>
          <span>${category.earned} / ${category.maximum}</span>
        </div>
        <div class="analysis-meter"><div style="width:${(category.earned / category.maximum) * 100}%"></div></div>
        <p>${category.evidence.map((item) => escapeHtml(item)).join(" · ")}</p>
        ${category.earned < category.maximum ? `<p class="recommendation">Recommendation: ${escapeHtml(category.recommendation)}</p>` : ""}
      </div>
    `).join("")}
  `;
}

document.querySelector("#repository-button").addEventListener("click", async () => {
  repositoryDialog.showModal();
  repositoryResult.innerHTML = "";
  try {
    renderPrerequisites(await request("/api/repository-analysis/prerequisites"));
  } catch (error) {
    repositoryPrerequisites.innerHTML = `<div class="analysis-error">${escapeHtml(error.message)}</div>`;
  }
});

repositoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const repository = new FormData(repositoryForm).get("repository");
  repositorySubmit.disabled = true;
  repositorySubmit.textContent = "Analyzing…";
  repositoryResult.innerHTML = '<div class="analysis-loading">Safely cloning and analyzing the repository. Large repositories may take a little longer…</div>';
  try {
    const result = await request("/api/repository-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository })
    });
    renderRepositoryAnalysis(result);
  } catch (error) {
    repositoryResult.innerHTML = `<div class="analysis-error">${escapeHtml(error.message)}</div>`;
  } finally {
    repositorySubmit.disabled = false;
    repositorySubmit.textContent = "Start Analysis";
  }
});

document.querySelector("#dialog-close").addEventListener("click", () => resultDialog.close());
resultDialog.addEventListener("click", (event) => {
  if (event.target === resultDialog) resultDialog.close();
});
document.querySelector("#repository-dialog-close").addEventListener("click", () => repositoryDialog.close());
repositoryDialog.addEventListener("click", (event) => {
  if (event.target === repositoryDialog) repositoryDialog.close();
});

async function initialize() {
  try {
    const [curriculum, progress, info] = await Promise.all([
      request("/api/lessons"),
      request("/api/progress"),
      request("/api/info")
    ]);
    state.lessons = curriculum.lessons;
    state.progress = progress;
    state.info = info;
    workspacePath.textContent = info.workspace;
    workspacePath.title = info.workspace;
    runtimeStatus.title = `Workspace: ${info.workspace}\nRuntime: ${info.runtime}`;
    runtimeStatus.lastChild.textContent = " Local workspace";
    state.currentLessonId = state.lessons.find((lesson) => !state.progress.completed[lesson.id])?.id ?? "00";
    render();
  } catch (error) {
    lessonView.innerHTML = `<div class="loading">Unable to load the platform: ${escapeHtml(error.message)}</div>`;
  }
}

connectCopilotEvents();
initialize();
