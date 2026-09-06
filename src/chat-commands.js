import {
  existsSync,
  opendirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export const MAX_DISCOVERY_ENTRIES = 256;
export const MAX_DISCOVERY_FILE_BYTES = 64 * 1024;
export const MAX_DISCOVERY_TOTAL_BYTES = 1024 * 1024;
export const MAX_DISCOVERY_MILLISECONDS = 2_000;

const DEFINITION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DIAGNOSTICS = 512;
const CLI_ONLY_COMMANDS = new Map([
  ["model", "Model selection is available in GitHub Copilot CLI, not this embedded chat."],
  ["review", "The /review command is available in GitHub Copilot CLI, not this embedded chat."],
  ["plan", "The /plan command is available in GitHub Copilot CLI, not this embedded chat."],
  ["fleet", "The /fleet command is available in GitHub Copilot CLI, not this embedded chat."],
  ["experimental", "Experimental CLI settings cannot be changed from this embedded chat."],
  ["loop", "Scheduled or autonomous loops must be configured in GitHub Copilot CLI."],
  ["every", "Scheduled prompts must be configured in GitHub Copilot CLI."],
  ["login", "Authentication is owned by the backend GitHub Copilot runtime, not this browser."],
  ["quit", "Close the browser tab or stop the local server from its terminal."]
]);

export const CHAT_COMMAND_REGISTRY = Object.freeze([
  Object.freeze({
    name: "help",
    usage: "/help",
    description: "List embedded application commands and their limitations.",
    effect: "local"
  }),
  Object.freeze({
    name: "skills",
    usage: "/skills [list|info <name>|reload]",
    description: "Inspect or rescan workspace skill candidates.",
    effect: "local",
    capabilityDependency: "Native activation requires runtime adapter confirmation."
  }),
  Object.freeze({
    name: "agent",
    usage: "/agent [name]",
    description: "List or request a workspace agent candidate.",
    effect: "local",
    capabilityDependency: "Selection is not active until the runtime adapter confirms the canonical definition and restrictions."
  }),
  Object.freeze({
    name: "clear",
    usage: "/clear",
    description: "Clear only the rendered view; durable conversation context remains.",
    effect: "view"
  }),
  Object.freeze({
    name: "new",
    usage: "/new",
    description: "Create a new conversation generation for the current lab.",
    effect: "mutation"
  }),
  Object.freeze({
    name: "history",
    usage: "/history [conversation-id]",
    description: "List or open conversation history for the current lab.",
    effect: "local"
  }),
  Object.freeze({
    name: "stop",
    usage: "/stop",
    description: "Request cancellation of the current scoped operation.",
    effect: "mutation"
  }),
  Object.freeze({
    name: "status",
    usage: "/status",
    description: "Show current lab, runtime, operation, agent, and validation state.",
    effect: "local"
  }),
  Object.freeze({
    name: "check",
    usage: "/check",
    description: "Run deterministic validation for the selected lab.",
    effect: "validation"
  }),
  Object.freeze({
    name: "forget",
    usage: "/forget [conversation-id]",
    description: "Delete application transcript state and request separately verified native-session deletion.",
    effect: "destructive",
    capabilityDependency: "Success requires the runtime adapter to report native-session deletion or residual retention."
  })
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathIsInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function sourcePath(workspace, path) {
  return relative(workspace, path).split(sep).join("/");
}

function addDiagnostic(diagnostics, diagnostic) {
  if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push({ severity: "error", ...diagnostic });
  }
}

function parseQuoted(value) {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseScalar(value, field) {
  const trimmed = value.trim();
  const quoted = (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
  if (!quoted && (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )) {
    throw new Error(`${field} must be a plain, quoted, or multiline scalar`);
  }
  return parseQuoted(trimmed);
}

function splitInlineArray(value) {
  const items = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) {
        quote = "";
      }
    } else if (character === "\"" || character === "'") {
      quote = character;
      current += character;
    } else if (character === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote) {
    throw new Error("unterminated quoted array item");
  }
  if (current.trim() || value.trim()) {
    items.push(current.trim());
  }
  return items.filter(Boolean).map((item) => {
    const quoted = (
      (item.startsWith("\"") && item.endsWith("\"")) ||
      (item.startsWith("'") && item.endsWith("'"))
    );
    if (!quoted && /[{}\[\]:]/.test(item)) {
      throw new Error("tools inline arrays support only scalar string entries");
    }
    return parseQuoted(item);
  });
}

function parseTools(value, blockLines) {
  if (value === "") {
    const tools = [];
    for (const line of blockLines) {
      const match = line.match(/^\s+-\s+(.+?)\s*$/);
      if (!match) {
        throw new Error("tools block must contain only '- value' entries");
      }
      const item = match[1];
      const quoted = (
        (item.startsWith("\"") && item.endsWith("\"")) ||
        (item.startsWith("'") && item.endsWith("'"))
      );
      if (!quoted && /[{}\[\]:]/.test(item)) {
        throw new Error("tools block arrays support only scalar string entries");
      }
      tools.push(parseQuoted(item));
    }
    return tools;
  }
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error("tools must use a JSON, inline, or block array");
  }
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  let tools;
  try {
    tools = JSON.parse(value);
  } catch {
    tools = splitInlineArray(inner);
  }
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error("tools array entries must be non-empty strings");
  }
  return tools;
}

function parseFrontmatter(contents) {
  const match = contents.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("missing opening or closing frontmatter delimiter");
  }
  const lines = match[1].split(/\r?\n/);
  const metadata = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!field) {
      throw new Error(`unsupported frontmatter line ${index + 1}`);
    }
    const key = field[1];
    const value = field[2] ?? "";
    const blockLines = [];
    const acceptsBlock = value === "|" || value === ">" || (key === "tools" && value.trim() === "");
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      if (/^\s+/.test(nextLine) || (acceptsBlock && nextLine.trim() === "")) {
        blockLines.push(nextLine);
        index += 1;
      } else {
        break;
      }
    }
    if (key === "tools") {
      metadata.tools = parseTools(value.trim(), blockLines);
    } else if (value === "|" || value === ">") {
      if (blockLines.length === 0) {
        metadata[key] = "";
      } else {
        const indentation = Math.min(...blockLines.filter((item) => item.trim()).map((item) => (
          item.length - item.trimStart().length
        )));
        const parts = blockLines.map((item) => item.slice(Number.isFinite(indentation) ? indentation : 0));
        metadata[key] = value === "|"
          ? parts.join("\n")
          : parts.join("\n")
            .split(/\n{2,}/)
            .map((paragraph) => paragraph.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
            .join("\n\n");
      }
    } else {
      if (blockLines.length > 0) {
        throw new Error(`${key} uses an unsupported nested restriction shape`);
      }
      metadata[key] = parseScalar(value, key);
    }
  }
  return {
    metadata,
    body: contents.slice(match[0].length)
  };
}

function collectCandidatePaths(workspace, diagnostics, {
  clock,
  deadline,
  maxEntries
}) {
  const candidates = [];
  const skillRoot = join(workspace, ".github", "skills");
  const agentRoot = join(workspace, ".github", "agents");
  let entryLimitReported = false;
  let timedOut = false;
  let scannedEntries = 0;

  function withinDeadline(source) {
    if (clock() <= deadline) {
      return true;
    }
    if (!timedOut) {
      timedOut = true;
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_TIMEOUT",
        source,
        message: `Discovery exceeded its bounded work deadline.`
      });
    }
    return false;
  }

  function reportEntryLimit() {
    if (!entryLimitReported) {
      entryLimitReported = true;
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_ENTRY_LIMIT",
        source: ".github",
        message: `Discovery reached the ${maxEntries}-filesystem-entry scan limit.`
      });
    }
  }

  function canReadEntry(source) {
    if (!withinDeadline(source)) {
      return false;
    }
    if (scannedEntries >= maxEntries) {
      reportEntryLimit();
      return false;
    }
    return true;
  }

  function inspectEntry(source) {
    if (!withinDeadline(sourcePath(workspace, source))) {
      return false;
    }
    scannedEntries += 1;
    return true;
  }

  function addCandidate(candidate) {
    candidates.push(candidate);
  }

  function canonicalDirectory(path, kind) {
    if (!withinDeadline(sourcePath(workspace, path)) || !existsSync(path)) {
      return null;
    }
    try {
      const canonicalPath = realpathSync(path);
      if (!withinDeadline(sourcePath(workspace, path))) {
        return null;
      }
      if (!pathIsInside(workspace, canonicalPath)) {
        addDiagnostic(diagnostics, {
          code: "DISCOVERY_PATH_ESCAPE",
          source: sourcePath(workspace, path),
          message: `${kind} discovery root resolves outside the workspace.`
        });
        return null;
      }
      return canonicalPath;
    } catch (error) {
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_READ_FAILED",
        source: sourcePath(workspace, path),
        message: `Could not inspect ${kind} discovery root: ${error.message}`
      });
      return null;
    }
  }

  const canonicalSkillRoot = canonicalDirectory(skillRoot, "Skill");
  if (canonicalSkillRoot) {
    const directoryHandle = opendirSync(skillRoot);
    try {
      while (canReadEntry(".github/skills")) {
        const entry = directoryHandle.readSync();
        if (!entry) {
          break;
        }
        const directory = join(skillRoot, entry.name);
        if (!inspectEntry(directory)) {
          break;
        }
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = statSync(directory).isDirectory();
          } catch {
            isDirectory = false;
          }
        }
        if (isDirectory) {
          const file = join(directory, "SKILL.md");
          if (existsSync(file)) {
            addCandidate({ type: "skill", path: file });
          }
        }
      }
    } finally {
      directoryHandle.closeSync();
    }
  }

  const canonicalAgentRoot = !timedOut && !entryLimitReported
    ? canonicalDirectory(agentRoot, "Agent")
    : null;
  if (canonicalAgentRoot) {
    const directoryHandle = opendirSync(agentRoot);
    try {
      while (canReadEntry(".github/agents")) {
        const entry = directoryHandle.readSync();
        if (!entry) {
          break;
        }
        const path = join(agentRoot, entry.name);
        if (!inspectEntry(path)) {
          break;
        }
        if (entry.name.endsWith(".agent.md") && (entry.isFile() || entry.isSymbolicLink())) {
          addCandidate({ type: "agent", path });
        }
      }
    } finally {
      directoryHandle.closeSync();
    }
  }

  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return { candidates, timedOut, entryLimitReported };
}

function invalidDefinition(type, path, workspace, canonicalPath = null) {
  return {
    type,
    name: null,
    description: null,
    tools: null,
    body: null,
    source: sourcePath(workspace, path),
    canonicalPath,
    valid: false,
    activatable: false,
    activation: {
      state: "invalid",
      capabilityDependency: "Invalid definitions cannot be offered to the native runtime adapter."
    }
  };
}

export function discoverChatDefinitions(workspace, {
  clock = () => performance.now(),
  maxEntries = MAX_DISCOVERY_ENTRIES,
  maxFileBytes = MAX_DISCOVERY_FILE_BYTES,
  maxTotalBytes = MAX_DISCOVERY_TOTAL_BYTES,
  maxMilliseconds = MAX_DISCOVERY_MILLISECONDS
} = {}) {
  const diagnostics = [];
  const skills = [];
  const agents = [];
  const startedAt = clock();
  const deadline = startedAt + maxMilliseconds;
  let canonicalWorkspace;
  try {
    canonicalWorkspace = realpathSync(resolve(workspace));
    if (!statSync(canonicalWorkspace).isDirectory()) {
      throw new Error("workspace is not a directory");
    }
  } catch (error) {
    addDiagnostic(diagnostics, {
      code: "DISCOVERY_WORKSPACE_UNAVAILABLE",
      source: String(workspace),
      message: `Could not inspect workspace definitions: ${error.message}`
    });
    return { skills, agents, diagnostics };
  }

  let candidates;
  try {
    const collected = collectCandidatePaths(canonicalWorkspace, diagnostics, {
      clock,
      deadline,
      maxEntries
    });
    candidates = collected.candidates;
    if (collected.timedOut) {
      return { skills, agents, diagnostics };
    }
  } catch (error) {
    addDiagnostic(diagnostics, {
      code: "DISCOVERY_READ_FAILED",
      source: ".github",
      message: `Could not enumerate workspace definitions: ${error.message}`
    });
    return { skills, agents, diagnostics };
  }
  let totalBytes = 0;
  for (const candidate of candidates) {
    const target = candidate.type === "skill" ? skills : agents;
    const source = sourcePath(canonicalWorkspace, candidate.path);
    if (clock() > deadline) {
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_TIMEOUT",
        source,
        message: `Discovery exceeded its ${maxMilliseconds}ms work budget.`
      });
      break;
    }
    let canonicalPath;
    try {
      canonicalPath = realpathSync(candidate.path);
      if (!pathIsInside(canonicalWorkspace, canonicalPath)) {
        addDiagnostic(diagnostics, {
          code: "DISCOVERY_PATH_ESCAPE",
          source,
          message: "Definition resolves outside the active workspace."
        });
        target.push(invalidDefinition(candidate.type, candidate.path, canonicalWorkspace, canonicalPath));
        continue;
      }
      const size = statSync(canonicalPath).size;
      if (size > maxFileBytes) {
        addDiagnostic(diagnostics, {
          code: "DISCOVERY_FILE_LIMIT",
          source,
          message: `Definition exceeds the ${maxFileBytes}-byte file limit.`
        });
        target.push(invalidDefinition(candidate.type, candidate.path, canonicalWorkspace, canonicalPath));
        continue;
      }
      if (totalBytes + size > maxTotalBytes) {
        addDiagnostic(diagnostics, {
          code: "DISCOVERY_TOTAL_LIMIT",
          source,
          message: `Definition would exceed the ${maxTotalBytes}-byte scan limit.`
        });
        target.push(invalidDefinition(candidate.type, candidate.path, canonicalWorkspace, canonicalPath));
        continue;
      }
      totalBytes += size;
      const contents = readFileSync(canonicalPath, "utf8");
      const { metadata, body } = parseFrontmatter(contents);
      const unsupportedFields = Object.keys(metadata).filter((field) => (
        !["name", "description", "tools"].includes(field)
      ));
      if (unsupportedFields.length > 0) {
        throw new Error(`unsupported frontmatter field(s): ${unsupportedFields.join(", ")}`);
      }
      if (typeof metadata.name !== "string" || !DEFINITION_NAME_PATTERN.test(metadata.name)) {
        throw new Error("name must contain 1-64 letters, numbers, dots, underscores, or hyphens");
      }
      if (typeof metadata.description !== "string" || !metadata.description.trim()) {
        throw new Error("description must be a non-empty string");
      }
      if (metadata.tools !== undefined && (
        !Array.isArray(metadata.tools) ||
        metadata.tools.some((tool) => typeof tool !== "string" || !tool.trim())
      )) {
        throw new Error("tools must be an array of non-empty strings");
      }
      target.push({
        type: candidate.type,
        name: metadata.name,
        description: metadata.description,
        tools: metadata.tools ?? null,
        body,
        source,
        canonicalPath,
        valid: true,
        activatable: false,
        activation: {
          state: "candidate",
          capabilityDependency: "The native runtime adapter must confirm this canonical source, name, and tool restriction."
        }
      });
    } catch (error) {
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_INVALID_DEFINITION",
        source,
        message: `Definition is not activatable: ${error.message}`
      });
      target.push(invalidDefinition(candidate.type, candidate.path, canonicalWorkspace, canonicalPath ?? null));
    }
    if (clock() > deadline) {
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_TIMEOUT",
        source: ".github",
        message: `Discovery exceeded its ${maxMilliseconds}ms work budget.`
      });
      break;
    }
  }

  for (const definitions of [skills, agents]) {
    const byName = new Map();
    for (const definition of definitions) {
      if (definition.valid) {
        const key = definition.name.toLowerCase();
        const matches = byName.get(key) ?? [];
        matches.push(definition);
        byName.set(key, matches);
      }
    }
    for (const matches of byName.values()) {
      if (matches.length < 2) {
        continue;
      }
      for (const definition of matches) {
        definition.valid = false;
        definition.activatable = false;
        definition.activation = {
          state: "invalid",
          capabilityDependency: "Duplicate names must be resolved before native activation."
        };
      }
      addDiagnostic(diagnostics, {
        code: "DISCOVERY_DUPLICATE_NAME",
        source: matches.map((definition) => definition.source).join(", "),
        message: `Duplicate ${matches[0].type} name "${matches[0].name}" is not activatable.`
      });
    }
  }

  return { skills, agents, diagnostics };
}

function tokenizeCommand(input) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        current += character;
      }
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) {
    return { error: "Command contains an unfinished escape or quote." };
  }
  if (current) {
    tokens.push(current);
  }
  return { tokens };
}

function commandError(code, message, command = null) {
  return { kind: "error", code, command, message, sendToModel: false };
}

function validateApplicationArguments(command, args) {
  if (["help", "clear", "new", "stop", "status", "check"].includes(command) && args.length > 0) {
    return `/${command} does not accept arguments.`;
  }
  if (command === "skills") {
    const subcommand = args[0] ?? "list";
    if (!["list", "info", "reload"].includes(subcommand)) {
      return "/skills accepts list, info <name>, or reload.";
    }
    if (subcommand === "info" && args.length !== 2) {
      return "/skills info requires exactly one skill name.";
    }
    if (subcommand !== "info" && args.length !== 1 && args.length !== 0) {
      return `/skills ${subcommand} does not accept additional arguments.`;
    }
  }
  if (command === "agent" && args.length > 1) {
    return "/agent accepts at most one agent name.";
  }
  if (["history", "forget"].includes(command) && args.length > 1) {
    return `/${command} accepts at most one conversation ID.`;
  }
  return null;
}

export function listChatCommandMetadata({ skills = [], agents = [] } = {}, capabilitiesProvided = false) {
  return {
    commands: CHAT_COMMAND_REGISTRY.map((command) => ({ ...command })),
    skillCandidates: skills.filter((skill) => skill.valid).map((skill) => ({
      name: skill.name,
      command: `/${skill.name}`,
      description: skill.description,
      source: skill.source,
      activatable: capabilitiesProvided,
      capabilityDependency: skill.activation.capabilityDependency
    })),
    agentCandidates: agents.filter((agent) => agent.valid).map((agent) => ({
      name: agent.name,
      description: agent.description,
      source: agent.source,
      tools: agent.tools,
      activatable: capabilitiesProvided,
      capabilityDependency: agent.activation.capabilityDependency
    }))
  };
}

export function parseChatCommand(input, definitions = {}, capabilitiesProvided = false) {
  if (typeof input !== "string") {
    throw new TypeError("Chat input must be a string.");
  }
  if (!input.startsWith("/")) {
    return { kind: "message", displayPrompt: input, sendToModel: true };
  }
  const tokenized = tokenizeCommand(input.slice(1));
  if (tokenized.error) {
    return commandError("COMMAND_PARSE_ERROR", tokenized.error);
  }
  const [rawCommand = "", ...args] = tokenized.tokens;
  const command = rawCommand.toLowerCase();
  if (!command) {
    return commandError("UNKNOWN_COMMAND", "Enter a command after '/'.");
  }
  const metadata = CHAT_COMMAND_REGISTRY.find((entry) => entry.name === command);
  if (metadata) {
    const argumentError = validateApplicationArguments(command, args);
    if (argumentError) {
      return commandError("INVALID_COMMAND_ARGUMENTS", argumentError, command);
    }
    return {
      kind: "application-command",
      command,
      args,
      subcommand: command === "skills" ? (args[0] ?? "list") : null,
      metadata: { ...metadata },
      sendToModel: false
    };
  }
  if (CLI_ONLY_COMMANDS.has(command)) {
    return commandError("CLI_ONLY_COMMAND", CLI_ONLY_COMMANDS.get(command), command);
  }
  const skill = (definitions.skills ?? []).find((definition) => (
    definition.valid && definition.name.toLowerCase() === command
  ));
  if (skill) {
    return {
      kind: "native-skill-candidate",
      command,
      args,
      skill,
      activatable: capabilitiesProvided,
      capabilityDependency: skill.activation.capabilityDependency,
      message: capabilitiesProvided
        ? `Skill ${skill.name} is verified for native runtime dispatch.`
        : `Skill ${skill.name} is discovered, but the native runtime adapter must confirm activation before execution.`,
      sendToModel: false
    };
  }
  return commandError(
    "UNKNOWN_COMMAND",
    `Unknown embedded command "/${rawCommand}". Use /help to list supported commands.`,
    command
  );
}
