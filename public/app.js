import { createChatLedger, createPaintQueue, toolDetailPreview, matchesOperation, createOperationTracker } from "./chat-state.js";
import { attachCommandCompletion } from "./chat-completion.js";
import { sameConversation, conversationStorageKey, visibleSnapshot, prepareDelivery } from "./lab-session.js";

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
const chatLedger = createChatLedger();
const messageElements = new Map();
const toolElements = new Map();
let followChat = true;
let chatBusy = false;
let sending = false;
let commandRunning = false;
const operationTracker = createOperationTracker();
let recovering = null;
let commandRegistry = { commands: [], skills: [], agents: [] };
let chatRoute = null;
let labSnapshot = null;
let chatEvents = null;
let navigationVersion = 0;
let selectedConversation = null;
const clientId = sessionStorage.getItem("loop-client-id") ?? crypto.randomUUID();
sessionStorage.setItem("loop-client-id", clientId);
const newContentButton = document.querySelector("#copilot-new-content");
const paintQueue = createPaintQueue(paintChat);
const commandPalette = attachCommandCompletion(copilotInput, document.querySelector("#copilot-commands"), () => commandRegistry);

async function request(path, options) {
  const requestOptions = { ...options };
  if (requestOptions.method === "POST") {
    requestOptions.headers = { ...requestOptions.headers, "X-Loop-Lab": "browser" };
  }
  const response = await fetch(path, requestOptions);
  const body = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(body.error || "Request failed"), { status: response.status, code: body.code, current: body.current });
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
  if (followChat) {
    copilotMessages.scrollTop = copilotMessages.scrollHeight;
    newContentButton.hidden = true;
  } else {
    newContentButton.hidden = false;
  }
}

function removeWelcome() {
  const welcome = copilotMessages.querySelector(".copilot-welcome");
  if (welcome) welcome.hidden = true;
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
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "Code block");
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
      const scroller = document.createElement("div");
      scroller.className = "chat-table-scroll";
      scroller.tabIndex = 0;
      scroller.setAttribute("role", "region");
      scroller.setAttribute("aria-label", "Message table");
      scroller.append(table);
      fragment.append(scroller);
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

function addChatMessage(role, content, id, local = false) {
  if (!content.trim()) return null;
  removeWelcome();
  const wrapper = document.createElement("div");
  wrapper.className = `chat-message ${local ? "local" : role}`;
  const label = document.createElement("div");
  label.className = "chat-message-label";
  label.textContent = local ? "Lab guide (local)" : role === "user" ? "You" : "Copilot";
  const body = document.createElement("div");
  body.className = "chat-message-content";
  body.textContent = content;
  if (id) wrapper.dataset.messageId = id;
  wrapper.append(label, body);
  copilotMessages.append(wrapper);
  return body;
}

function paintChat(keys) {
  const started = performance.now();
  let processed = 0;
  for (let index = 0; index < keys.length; index++) {
    if (index > 0 && performance.now() - started >= 4) {
      for (const remaining of keys.slice(index)) paintQueue.add(remaining);
      break;
    }
    const key = keys[index];
    processed++;
    if (key.startsWith("tool:")) {
      paintTool(key.slice(5));
      continue;
    }
    const record = chatLedger.messages.get(key);
    if (!record) continue;
    let element = messageElements.get(key);
    if (!record.content.trim()) {
      element?.body.parentElement.remove();
      messageElements.delete(key);
      continue;
    }
    if (!element) {
      element = { body: addChatMessage(record.role, record.content, key, record.local === true), content: "", complete: false };
      messageElements.set(key, element);
    }
    if (element.content === record.content && element.complete === record.complete) continue;
    const { body } = element;
    const format = record.role === "assistant" && record.complete && record.content.length <= 65536;
    body.classList.toggle("is-streaming", !format);
    if (format) {
      renderMarkdown(body, record.content);
    } else if (!element.complete && body.firstChild?.nodeType === Node.TEXT_NODE && record.content.startsWith(element.content)) {
      if (element.content) body.firstChild.appendData(record.content.slice(element.content.length));
    } else {
      body.textContent = record.content;
    }
    element.content = record.content;
    element.complete = record.complete;
  }
  scrollChat();
  document.dispatchEvent(new CustomEvent("loop:chat-paint", { detail: { count: processed } }));
}

function detailText(value) {
  return toolDetailPreview(value);
}

function paintTool(id) {
  const tool = chatLedger.tools.get(id);
  if (!tool) return;
  removeWelcome();
  let card = toolElements.get(id);
  if (!card) {
    card = document.createElement("details");
    card.className = "chat-tool";
    card.dataset.toolCallId = id;
    card.append(document.createElement("summary"), document.createElement("div"));
    toolElements.set(id, card);
    copilotMessages.append(card);
  }
  card.dataset.state = tool.state;
  card.firstChild.textContent = `${tool.toolName || "Recovered tool"} · ${tool.state}`;
  const detail = card.lastChild;
  detail.replaceChildren();
  for (const [label, value] of [["Call", id], ["Arguments", tool.arguments], ["Result", tool.result], ["Error", tool.error]]) {
    if (value === undefined || value === null) continue;
    const heading = document.createElement("strong");
    heading.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = detailText(value);
    pre.tabIndex = 0;
    detail.append(heading, pre);
  }
  const running = [...chatLedger.tools.values()].filter((entry) => entry.state === "running").length;
  copilotToolStatus.textContent = running ? `${running} tool${running === 1 ? "" : "s"} running` : chatBusy ? "Thinking..." : "Workspace agent";
}

function restoreChat(snapshot) {
  paintQueue.cancel();
  copilotMessages.querySelectorAll(".chat-message, .chat-tool, .chat-activity").forEach((element) => element.remove());
  messageElements.clear();
  toolElements.clear();
  copilotPermissions.replaceChildren();
  for (const id of chatLedger.messages.keys()) paintQueue.add(id);
  for (const id of chatLedger.tools.keys()) paintQueue.add(`tool:${id}`);
  for (const permission of snapshot.permissions ?? []) renderPermission(permission);
  if (snapshot.status) setCopilotStatus(snapshot.status);
}

function isLabChat() {
  return state.info?.chatProtocol === "lab-v1";
}

function selectionKey(labId) {
  return `loop:selected:${state.info.workspaceId ?? state.info.workspace}:${labId}`;
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    showToast(`Browser preference could not be saved: ${error.message}`);
  }
}

function storeDraft() {
  if (!chatRoute) return;
  try {
    localStorage.setItem(conversationStorageKey(chatRoute, "draft"), copilotInput.value);
  } catch (error) {
    showToast(`Draft could not be saved locally: ${error.message}`);
  }
}

function clearLocalConversation(route) {
  for (const kind of ["draft", "hidden", "pending-send"]) {
    localStorage.removeItem(conversationStorageKey(route, kind));
  }
  if (localStorage.getItem(selectionKey(route.labId)) === route.conversationId) {
    localStorage.removeItem(selectionKey(route.labId));
  }
}

function hiddenHistory(route = chatRoute) {
  if (!route) return [];
  const key = conversationStorageKey(route, "hidden");
  try {
    const ids = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("Expected message identities");
    return ids;
  } catch (error) {
    localStorage.removeItem(key);
    showToast(`Saved view preference was invalid: ${error.message}`);
    return [];
  }
}

function labQuery() {
  return new URLSearchParams({
    labId: state.currentLessonId,
    clientId,
    ...(selectedConversation ? { conversationId: selectedConversation } : {})
  }).toString();
}

function ownsLease() {
  return labSnapshot?.lease?.clientId === clientId &&
    labSnapshot.lease.conversationId === chatRoute?.conversationId;
}

function refreshSendButton() {
  const command = isLabChat() && copilotInput.value.startsWith("/");
  copilotSend.disabled = commandRunning || (!command && (chatBusy || sending || operationTracker.waiting));
}

function applyLabSnapshot(snapshot, sequence) {
  if (snapshot.route.labId !== state.currentLessonId) return false;
  if (chatRoute && !sameConversation(chatRoute, snapshot.route)) {
    paintQueue.cancel();
    chatLedger.reset();
    operationTracker.clear();
  }
  const chat = visibleSnapshot({
    ...snapshot.chat,
    cursor: sequence ?? snapshot.sequence ?? snapshot.chat.cursor,
    status: { ...snapshot.chat.status, generation: snapshot.route.generation }
  }, hiddenHistory(snapshot.route));
  if (!chatLedger.apply({ type: "chat.snapshot", data: chat })) return false;
  chatRoute = snapshot.route;
  labSnapshot = snapshot;
  selectedConversation = chatRoute.conversationId;
  writePreference(selectionKey(chatRoute.labId), selectedConversation);
  const definitions = snapshot.definitions ?? {};
  commandRegistry = {
    commands: definitions.commands ?? [],
    skills: definitions.skills ?? [],
    agents: definitions.agents ?? []
  };
  restoreChat(chat);
  const lesson = state.lessons.find((item) => item.id === chatRoute.labId);
  document.querySelector("#copilot-lab-title").textContent = `Lab ${chatRoute.labId} Conversation`;
  const intro = copilotMessages.querySelector(".copilot-welcome");
  if (intro) {
    intro.hidden = chat.messages.length > 0;
    intro.querySelector("h3").textContent = lesson.title;
    intro.querySelector("p").textContent = `${lesson.objective} ${snapshot.latestValidation?.ok === false ? "The latest checkpoint needs another iteration." : "Connect to receive guidance for this lab."}`;
  }
  const history = document.querySelector("#copilot-history");
  history.replaceChildren();
  for (const record of snapshot.history ?? []) {
    const option = document.createElement("option");
    option.value = record.conversationId;
    option.textContent = `Conversation ${record.generation}${record.conversationId === chatRoute.conversationId ? " (viewing)" : ""}`;
    history.append(option);
  }
  history.value = chatRoute.conversationId;
  const agent = document.querySelector("#copilot-agent");
  agent.replaceChildren(new Option("Default lab agent", "default"));
  for (const entry of commandRegistry.agents) {
    agent.append(new Option(entry.name, entry.name));
  }
  agent.value = typeof snapshot.selectedAgent === "string" ? snapshot.selectedAgent : snapshot.selectedAgent?.name ?? "default";
  copilotConnect.textContent = ownsLease() ? "Connected / resume" : snapshot.lease?.busy ? "Take over" : "Connect / resume";
  document.querySelector("#copilot-lease").textContent = ownsLease()
    ? "This tab owns the active conversation."
    : snapshot.lease ? "Viewing only. Connect explicitly to take over the workspace agent." : "Local lab context. Connect to start Copilot.";
  for (const button of copilotPermissions.querySelectorAll("button")) button.disabled = !ownsLease();
  return true;
}

async function refreshLabSnapshot() {
  const version = navigationVersion;
  const snapshot = await request(`/api/copilot/snapshot?${labQuery()}`);
  if (version !== navigationVersion) return false;
  return applyLabSnapshot(snapshot);
}

async function switchLabChat({ resume = true } = {}) {
  const version = ++navigationVersion;
  chatEvents?.close();
  paintQueue.cancel();
  chatLedger.reset();
  operationTracker.clear();
  chatRoute = null;
  chatBusy = false;
  sending = false;
  commandRunning = false;
  restoreChat({ status: { state: "disconnected", busy: false }, permissions: [] });
  copilotToolStatus.textContent = `Loading Lab ${state.currentLessonId}...`;
  try {
    const snapshot = await request(`/api/copilot/snapshot?${labQuery()}`);
    if (version !== navigationVersion) return;
    applyLabSnapshot(snapshot);
    copilotInput.value = localStorage.getItem(conversationStorageKey(chatRoute, "draft")) ?? "";
    connectCopilotEvents();
    const consent = sessionStorage.getItem(`loop-connected:${chatRoute.workspaceId}`) === "1";
    if (resume && consent && !snapshot.lease?.busy &&
        (!snapshot.lease || snapshot.lease.clientId === clientId)) await startCopilot();
  } catch (error) {
    if (version === navigationVersion) addActivity(error.message, "failure");
  }
}

async function labMutation(action, extra = {}) {
  if (!chatRoute) throw new Error("Wait for the current lab conversation to load.");
  const version = navigationVersion;
  try {
    return await request(`/api/copilot/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: chatRoute, ...extra })
    });
  } catch (error) {
    if (error.status === 409 && version === navigationVersion) {
      await refreshLabSnapshot();
    }
    throw error;
  }
}

async function runChatCommand(command) {
  if (commandRunning) throw new Error("Wait for the current command to finish.");
  const version = navigationVersion;
  const submittedRoute = chatRoute;
  const forgetting = /^\/forget(?:\s|$)/i.test(command);
  commandRunning = true;
  refreshSendButton();
  copilotToolStatus.textContent = `Running ${command.split(/\s/)[0]}...`;
  try {
    const result = await labMutation("command", { command });
    if (submittedRoute && !forgetting) {
      const key = conversationStorageKey(submittedRoute, "draft");
      if (localStorage.getItem(key) === command) localStorage.removeItem(key);
    }
    if (version !== navigationVersion) return;
    if (forgetting) {
      if (result.result?.confirmationRequired !== true) throw new Error("Conversation deletion was not prepared by the server.");
      const query = new URLSearchParams({
        labId: submittedRoute.labId, clientId, conversationId: result.result.conversationId
      });
      const target = await request(`/api/copilot/snapshot?${query}`);
      if (version !== navigationVersion) return false;
      if (!window.confirm(`Permanently forget conversation ${target.route.generation} in Lab ${target.route.labId}, including its native session?`)) return false;
      const deletion = await request("/api/copilot/forget", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: target.route, confirm: true })
      });
      if (deletion.result?.applicationDeleted !== true || deletion.result?.nativeSession?.deleted !== true) {
        throw new Error("Application and native conversation deletion were not both confirmed.");
      }
      clearLocalConversation(target.route);
      if (version !== navigationVersion) return;
      if (sameConversation(chatRoute, target.route)) {
        selectedConversation = null;
        await switchLabChat({ resume: false });
      } else await refreshLabSnapshot();
      addActivity("Conversation and native session deleted.");
      showCleanupWarnings(deletion);
      return deletion;
    }
    if (/^\/clear\s*$/i.test(command)) {
      localStorage.setItem(conversationStorageKey(chatRoute, "hidden"), JSON.stringify([
        ...chatLedger.messages.keys(), ...chatLedger.tools.keys()
      ]));
    }
    const output = result.result;
    if (/^\/history\s+\S/i.test(command) && output?.route && output?.chat) {
      selectedConversation = output.route.conversationId;
      await switchLabChat({ resume: false });
      return result;
    }
    const changedConversation = result.route && !sameConversation(chatRoute, result.route);
    if (output?.action === "new" || /^\/new\s*$/i.test(command) || changedConversation) {
      selectedConversation = changedConversation ? result.route.conversationId : null;
      await switchLabChat();
    } else {
      await refreshLabSnapshot();
    }
    if (output !== undefined) addActivity(typeof output === "string" ? output : output.message ?? output.text ?? toolDetailPreview(output));
    return result;
  } finally {
    if (version === navigationVersion) {
      commandRunning = false;
      refreshSendButton();
      copilotToolStatus.textContent = chatBusy ? "Working..." : "Workspace agent";
    }
  }
}

function addActivity(text, stateName = "") {
  removeWelcome();
  const activity = document.createElement("div");
  activity.className = `chat-activity ${stateName}`;
  activity.textContent = text;
  copilotMessages.append(activity);
  scrollChat();
}

function reportChatError(error, version, action = "operation") {
  if (version === navigationVersion) addActivity(error.message, "failure");
  else showToast(`Previous lab ${action} failed: ${error.message}`);
}

function showCleanupWarnings(receipt) {
  for (const warning of receipt?.result?.cleanupWarnings ?? []) {
    addActivity(`Native cleanup warning: ${warning.message ?? warning}`, "warning");
  }
}

function setCopilotStatus(status) {
  if (status.busy === false && status.operationId) {
    operationTracker.observe(status);
  }
  chatBusy = Boolean(status.busy) || ["sending", "running", "awaiting-permission", "cancelling"].includes(status.state);
  refreshSendButton();
  copilotStatus.className = "copilot-status";
  if (status.state === "ready") {
    copilotStatus.classList.add("ready");
    copilotStatus.lastChild.textContent = status.login ? ` Connected · ${status.login}` : " Connected";
  } else if (status.state === "connecting") {
    copilotStatus.classList.add("working");
    copilotStatus.lastChild.textContent = " Connecting";
  } else if (status.state === "error" || status.state === "unavailable") {
    copilotStatus.classList.add("error");
    copilotStatus.lastChild.textContent = status.state === "unavailable" ? " SDK unavailable" : " Connection failed";
    copilotToolStatus.textContent = status.error || "Copilot connection failed";
  } else if (chatBusy) {
    copilotStatus.classList.add("working");
    copilotStatus.lastChild.textContent = " Working";
  } else {
    copilotStatus.lastChild.textContent = " Disconnected";
  }
}

function renderPermission(data) {
  if (copilotPermissions.querySelector(`[data-permission-id="${CSS.escape(data.requestId)}"]`)) return;
  const card = document.createElement("div");
  card.className = "permission-card";
  card.dataset.permissionId = data.requestId;
  const request = data.request;
  card.innerHTML = `
    <h3>${escapeHtml(request.title)}</h3>
    <p>${escapeHtml(request.intention || "")}</p>
    ${request.warning ? `<p class="permission-warning">${escapeHtml(request.warning)}</p>` : ""}
    ${data.sandboxBypass ? '<p class="permission-warning">This operation requests a sandbox bypass.</p>' : ""}
    ${[request.detail, request.diff, request.arguments].filter((value) => value !== undefined && value !== "").map((value) => `<div class="permission-detail">${escapeHtml(detailText(value))}</div>`).join("")}
    <div class="permission-actions">
      <button class="permission-reject" data-permission-decision="reject">Reject</button>
      <button class="permission-approve" data-permission-decision="approve">Allow Once</button>
    </div>
  `;
  copilotPermissions.append(card);
}

function connectCopilotEvents() {
  chatEvents?.close();
  const version = navigationVersion;
  const events = new EventSource(`/api/copilot/events${isLabChat() ? `?${labQuery()}` : ""}`);
  chatEvents = events;
  const eventTypes = [
    "chat.snapshot",
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
      let payload;
      let change;
      let nextLeaseVersion;
      try {
        payload = JSON.parse(event.data);
        if (isLabChat()) {
          if (version !== navigationVersion || !sameConversation(chatRoute, payload)) return;
          if (type === "chat.snapshot") {
            applyLabSnapshot(payload.data, payload.sequence);
            return;
          }
          payload = { ...payload, id: payload.sequence };
          if (type === "chat.status") payload.data = { ...payload.data, generation: payload.generation };
          if (Number.isInteger(payload.leaseVersion)) nextLeaseVersion = payload.leaseVersion;
        }
        if (payload.type !== type || !payload.data || typeof payload.data !== "object") throw new Error("Invalid chat event");
        change = chatLedger.apply(payload);
      } catch (error) {
        copilotToolStatus.textContent = `Recovering chat: ${error.message}`;
        recovering ??= (isLabChat() ? refreshLabSnapshot() : request("/api/copilot/snapshot").then((snapshot) => {
          if (chatLedger.apply({ type: "chat.snapshot", data: snapshot })) restoreChat(snapshot);
        })).catch((failure) => { copilotToolStatus.textContent = failure.message; }).finally(() => { recovering = null; });
        return;
      }
      if (!change) return;
      if (nextLeaseVersion !== undefined && nextLeaseVersion !== chatRoute.leaseVersion) {
        chatRoute = { ...chatRoute, leaseVersion: nextLeaseVersion };
        recovering ??= refreshLabSnapshot().catch((error) => {
          copilotToolStatus.textContent = error.message;
        }).finally(() => { recovering = null; });
      }
      const data = payload.data ?? {};
      if (type === "session.idle" || type === "chat.error") operationTracker.observe(payload);
      if (change.snapshot) restoreChat(data);
      if (change.message) paintQueue.add(change.message);
      if (change.tool) paintQueue.add(`tool:${change.tool}`);
      if (type === "chat.status") setCopilotStatus(data);
      if (type === "session.idle" && (!operationTracker.pending || matchesOperation(operationTracker.pending, payload))) {
        copilotToolStatus.textContent = "Workspace agent";
        chatBusy = false;
        copilotSend.disabled = false;
      }
      if (type === "chat.error" && (!operationTracker.pending || matchesOperation(operationTracker.pending, payload))) {
        chatBusy = false;
        copilotSend.disabled = false;
        addActivity(data.message, "failure");
      }
      if (type === "chat.reset") {
        operationTracker.clear();
        copilotToolStatus.textContent = "Workspace agent";
        chatBusy = false;
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
  events.onopen = () => { copilotToolStatus.textContent = chatBusy ? "Working..." : "Workspace agent"; };
}

async function startCopilot() {
  const version = navigationVersion;
  setCopilotStatus({ state: "connecting" });
  try {
    if (isLabChat()) {
      let takeover = false;
      if (labSnapshot?.lease && !ownsLease() &&
          (labSnapshot.lease.clientId !== clientId || labSnapshot.lease.busy)) {
        takeover = window.confirm(labSnapshot.lease.busy
          ? "Stop the currently running workspace operation and take over this lab?"
          : "Take over the idle workspace agent from another tab?");
        if (!takeover) {
          await refreshLabSnapshot();
          return false;
        }
      }
      const snapshot = await labMutation("activate", { takeover });
      if (version !== navigationVersion) return false;
      applyLabSnapshot(snapshot);
      sessionStorage.setItem(`loop-connected:${chatRoute.workspaceId}`, "1");
      return true;
    }
    const status = await request("/api/copilot/start", { method: "POST" });
    setCopilotStatus(status);
    return true;
  } catch (error) {
    if (version === navigationVersion) setCopilotStatus({ state: "error", error: error.message });
    else showToast(`Previous lab activation failed: ${error.message}`);
    return false;
  }
}

async function sendToCopilot(prompt) {
  if (!prompt.trim()) {
    showToast("Enter a message first.");
    return false;
  }
  if (isLabChat() && prompt.startsWith("/")) {
    const version = navigationVersion;
    try {
      return (await runChatCommand(prompt)) !== false;
    } catch (error) {
      reportChatError(error, version, "command");
      return false;
    }
  }
  if (sending || commandRunning || chatBusy || operationTracker.waiting) {
    showToast("Wait for the current operation or stop it first.");
    return false;
  }
  sending = true;
  const version = navigationVersion;
  const submittedRoute = chatRoute;
  copilotSend.disabled = true;
  copilotToolStatus.textContent = "Thinking…";
  try {
    let delivery;
    if (submittedRoute) {
      const key = conversationStorageKey(submittedRoute, "pending-send");
      delivery = prepareDelivery(JSON.parse(localStorage.getItem(key) ?? "null"), prompt);
      writePreference(key, JSON.stringify(delivery));
    }
    const accepted = isLabChat() ? await labMutation("message", { prompt, requestId: delivery.requestId }) : await request("/api/copilot/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
    if (submittedRoute) {
      const key = conversationStorageKey(submittedRoute, "draft");
      if (localStorage.getItem(key) === prompt) localStorage.removeItem(key);
      const pendingKey = conversationStorageKey(submittedRoute, "pending-send");
      if (JSON.parse(localStorage.getItem(pendingKey) ?? "null")?.requestId === delivery.requestId) localStorage.removeItem(pendingKey);
    }
    if (version !== navigationVersion) return false;
    operationTracker.accept({ operationId: accepted.operationId, generation: accepted.route?.generation ?? accepted.generation });
    if (accepted.terminal === true) operationTracker.observe(operationTracker.pending);
    return true;
  } catch (error) {
    if (version === navigationVersion) {
      copilotSend.disabled = false;
      copilotToolStatus.textContent = "Workspace agent";
      addActivity(error.status ? error.message : `${error.message} Delivery is unconfirmed; inspect /status before retrying.`, "failure");
    } else showToast(`Previous lab message failed: ${error.message}`);
    return false;
  } finally {
    if (version === navigationVersion) {
      sending = false;
      refreshSendButton();
    }
  }
}

async function checkLesson(id, button) {
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const result = await request(`/api/check/${id}`, { method: "POST" });
    state.progress = result.progress;
    render();
    if (isLabChat()) await refreshLabSnapshot();
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
  storeDraft();
  state.currentLessonId = button.dataset.lesson;
  selectedConversation = isLabChat() ? localStorage.getItem(selectionKey(state.currentLessonId)) : null;
  if (isLabChat()) writePreference(`loop:last-lab:${state.info.workspaceId ?? state.info.workspace}`, state.currentLessonId);
  render();
  if (isLabChat()) switchLabChat();
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
  const version = navigationVersion;
  if (await sendToCopilot(prompt) && version === navigationVersion && copilotInput.value === prompt) {
    copilotInput.value = "";
    storeDraft();
  }
});
copilotInput.addEventListener("input", () => { storeDraft(); refreshSendButton(); });
copilotInput.addEventListener("change", () => { storeDraft(); refreshSendButton(); });
copilotInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    copilotForm.requestSubmit();
  }
});
document.querySelector("#copilot-abort").addEventListener("click", async () => {
  const version = navigationVersion;
  try {
    if (isLabChat()) {
      await labMutation("abort");
      if (version === navigationVersion) await refreshLabSnapshot();
    } else await request("/api/copilot/abort", { method: "POST" });
  } catch (error) {
    reportChatError(error, version, "stop");
  }
});
document.querySelector("#copilot-reset").addEventListener("click", async () => {
  const version = navigationVersion;
  try {
    if (isLabChat()) {
      storeDraft();
      await labMutation("reset");
      if (version !== navigationVersion) return;
      selectedConversation = null;
      await switchLabChat();
    } else await request("/api/copilot/reset", { method: "POST" });
  } catch (error) {
    reportChatError(error, version, "reset");
  }
});
document.querySelector("#copilot-history").addEventListener("change", async (event) => {
  storeDraft();
  selectedConversation = event.target.value;
  await switchLabChat({ resume: false });
});
document.querySelector("#copilot-agent").addEventListener("change", async (event) => {
  const version = navigationVersion;
  try { await runChatCommand(`/agent ${event.target.value}`); }
  catch (error) {
    reportChatError(error, version, "agent selection");
    if (version === navigationVersion) {
      try { await refreshLabSnapshot(); }
      catch (failure) { reportChatError(failure, version, "refresh"); }
    }
  }
});
document.querySelector("#copilot-forget").addEventListener("click", async () => {
  if (!window.confirm("Permanently forget this conversation? Native SDK deletion must also be confirmed.")) return;
  const version = navigationVersion;
  const submittedRoute = chatRoute;
  try {
    const result = await labMutation("forget", { confirm: true });
    if (result.result?.applicationDeleted !== true || result.result?.nativeSession?.deleted !== true) throw new Error("Application and native deletion were not both confirmed.");
    clearLocalConversation(submittedRoute);
    if (version !== navigationVersion) return;
    selectedConversation = null;
    await switchLabChat({ resume: false });
    showCleanupWarnings(result);
  } catch (error) { reportChatError(error, version, "deletion"); }
});
copilotMessages.addEventListener("scroll", () => {
  followChat = copilotMessages.scrollHeight - copilotMessages.clientHeight - copilotMessages.scrollTop <= 48;
  if (followChat) newContentButton.hidden = true;
}, { passive: true });
newContentButton.addEventListener("click", () => {
  followChat = true;
  scrollChat();
});
copilotPermissions.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-permission-decision]");
  if (!button) return;
  const card = button.closest("[data-permission-id]");
  const version = navigationVersion;
  button.disabled = true;
  try {
    await request("/api/copilot/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(isLabChat() ? { route: chatRoute } : {}),
        requestId: card.dataset.permissionId,
        decision: button.dataset.permissionDecision
      })
    });
  } catch (error) {
    reportChatError(error, version, "permission");
    button.disabled = false;
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
    if (isLabChat()) await refreshLabSnapshot();
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
    const savedLab = isLabChat() ? localStorage.getItem(`loop:last-lab:${info.workspaceId ?? info.workspace}`) : null;
    state.currentLessonId = state.lessons.some((lesson) => lesson.id === savedLab)
      ? savedLab : state.lessons.find((lesson) => !state.progress.completed[lesson.id])?.id ?? "00";
    selectedConversation = isLabChat() ? localStorage.getItem(selectionKey(state.currentLessonId)) : null;
    render();
    document.querySelector(".lab-chat-controls").hidden = !isLabChat();
    if (isLabChat()) await switchLabChat({ resume: false });
    else connectCopilotEvents();
  } catch (error) {
    lessonView.innerHTML = `<div class="loading">Unable to load the platform: ${escapeHtml(error.message)}</div>`;
  }
}

initialize();
