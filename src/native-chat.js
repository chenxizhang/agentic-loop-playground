import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverChatDefinitions } from "./chat-commands.js";
import { MAX_CHAT_STORE_BYTES } from "./chat-store.js";

const PINNED_SDK = Object.freeze({
  package: "@github/copilot-sdk",
  version: "1.0.11",
  repository: "github/copilot-sdk",
  commit: "a550258d5c37bd662197536992a23d633bfe5804"
});

const EXPLICIT_AVAILABLE_TOOLS = Object.freeze(["builtin:*"]);
const MAX_CHAT_STORE_ENTRIES = 8192;

export class NativeChatCapabilityError extends Error {
  constructor(message, code = "NATIVE_CAPABILITY_UNAVAILABLE", details = undefined) {
    super(message);
    this.name = "NativeChatCapabilityError";
    this.code = code;
    this.statusCode = 503;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

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

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function canonicalDirectory(path, label) {
  let canonical;
  try {
    canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new NativeChatCapabilityError(
      `${label} is unavailable: ${error.message}`,
      "NATIVE_PATH_UNAVAILABLE",
      { path: resolve(path) }
    );
  }
  return canonical;
}

function ensureUnlinkedDirectory(workspace, target) {
  const pathFromWorkspace = relative(workspace, target);
  if (
    !pathFromWorkspace ||
    pathFromWorkspace === ".." ||
    pathFromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(pathFromWorkspace)
  ) {
    throw new NativeChatCapabilityError(
      "The native runtime directory must be a workspace child directory.",
      "NATIVE_RUNTIME_PATH_ESCAPE",
      { runtimeDirectory: target }
    );
  }

  let current = workspace;
  for (const segment of pathFromWorkspace.split(sep)) {
    current = join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        throw new Error("path segment is a link or junction");
      }
      if (!entry.isDirectory()) {
        throw new Error("path segment is not a directory");
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        mkdirSync(current);
      } else {
        throw new NativeChatCapabilityError(
          `The native runtime path is unsafe: ${error.message}`,
          "NATIVE_RUNTIME_PATH_ESCAPE",
          { runtimeDirectory: current }
        );
      }
    }
    const canonical = canonicalDirectory(current, "Native runtime path");
    if (!samePath(canonical, current) || !pathIsInside(workspace, canonical)) {
      throw new NativeChatCapabilityError(
        "The native runtime path redirects outside its approved workspace location.",
        "NATIVE_RUNTIME_PATH_ESCAPE",
        { runtimeDirectory: canonical }
      );
    }
  }
  return canonicalDirectory(target, "Native runtime directory");
}

function canonicalFile(path, label) {
  let canonical;
  try {
    canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new NativeChatCapabilityError(
      `${label} is unavailable: ${error.message}`,
      "NATIVE_DEFINITION_UNAVAILABLE",
      { path: resolve(path) }
    );
  }
  return canonical;
}

function requireMethod(owner, name) {
  const method = owner?.[name];
  if (typeof method !== "function") {
    throw new NativeChatCapabilityError(
      `The pinned SDK runtime does not expose ${name}.`,
      "NATIVE_SDK_METHOD_UNAVAILABLE",
      { method: name, sdk: PINNED_SDK }
    );
  }
  return method.bind(owner);
}

function expectArray(value, label) {
  if (!Array.isArray(value)) {
    throw new NativeChatCapabilityError(
      `The native runtime returned malformed ${label} metadata.`,
      "NATIVE_METADATA_INVALID",
      { label }
    );
  }
  return value;
}

function normalizedTools(tools) {
  if (tools === undefined || tools === null) {
    return null;
  }
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
    return undefined;
  }
  return [...tools].sort((left, right) => left.localeCompare(right));
}

function sameTools(left, right) {
  const normalizedLeft = normalizedTools(left);
  const normalizedRight = normalizedTools(right);
  return (
    normalizedLeft !== undefined &&
    normalizedRight !== undefined &&
    JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight)
  );
}

function runtimePath(metadata) {
  return typeof metadata?.path === "string" && metadata.path
    ? metadata.path
    : null;
}

function diagnosticError(diagnostics) {
  const failures = diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (failures.length === 0) {
    return null;
  }
  return new NativeChatCapabilityError(
    "Workspace chat definitions contain errors and cannot be reloaded.",
    "NATIVE_DEFINITION_INVALID",
    { diagnostics }
  );
}

function nativeDefinitionError(type, definition, message, runtime = undefined) {
  return new NativeChatCapabilityError(
    `${type} "${definition.name}" failed native verification: ${message}`,
    "NATIVE_METADATA_MISMATCH",
    {
      type: type.toLowerCase(),
      source: definition.source,
      ...(runtime === undefined ? {} : { runtime })
    }
  );
}

function parseSkillCommand(commandLine) {
  if (typeof commandLine !== "string") {
    throw new TypeError("Native skill command must be a string.");
  }
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(commandLine.trim());
  if (!match) {
    throw new NativeChatCapabilityError(
      "Native skill invocation requires a slash command.",
      "NATIVE_SKILL_COMMAND_INVALID"
    );
  }
  return {
    name: match[1],
    input: match[2]
  };
}

export class NativeChatAdapter {
  #definitions;
  #verification = null;
  #selectedAgents = new WeakMap();

  constructor(workspace, { runtimeDirectory, definitions } = {}) {
    this.workspace = canonicalDirectory(workspace, "Workspace");
    if (typeof runtimeDirectory !== "string" || !runtimeDirectory) {
      throw new NativeChatCapabilityError(
        "A workspace-scoped native runtime directory is required.",
        "NATIVE_RUNTIME_DIRECTORY_REQUIRED"
      );
    }

    const allowedRuntimeRoot = resolve(this.workspace, ".workshop", "chat", "native");
    const requestedRuntimeDirectory = resolve(runtimeDirectory);
    if (!pathIsInside(allowedRuntimeRoot, requestedRuntimeDirectory)) {
      throw new NativeChatCapabilityError(
        "The native runtime directory must remain under .workshop/chat/native.",
        "NATIVE_RUNTIME_PATH_ESCAPE",
        { runtimeDirectory: requestedRuntimeDirectory }
      );
    }
    const canonicalRuntimeRoot = ensureUnlinkedDirectory(this.workspace, allowedRuntimeRoot);
    this.runtimeDirectory = ensureUnlinkedDirectory(this.workspace, requestedRuntimeDirectory);
    if (!pathIsInside(canonicalRuntimeRoot, this.runtimeDirectory)) {
      throw new NativeChatCapabilityError(
        "The native runtime directory resolves outside .workshop/chat/native.",
        "NATIVE_RUNTIME_PATH_ESCAPE",
        { runtimeDirectory: this.runtimeDirectory }
      );
    }

    // Client-level deletion resolves sessions in COPILOT_HOME, not a per-session override.
    this.configDirectory = this.runtimeDirectory;
    this.#definitions = this.#normalizeDefinitions(
      definitions ?? discoverChatDefinitions(this.workspace)
    );
  }

  clientOptions() {
    return {
      mode: "empty",
      baseDirectory: this.runtimeDirectory,
      workingDirectory: this.workspace,
      builtinPluginDirectories: []
    };
  }

  sessionOptions(selectedAgent = null) {
    const agent = this.#resolveDefinition("agent", selectedAgent, { allowDefault: true });
    const options = {
      workingDirectory: this.workspace,
      configDirectory: this.configDirectory,
      enableConfigDiscovery: false,
      enableExperimentalMode: false,
      enableSkills: true,
      enableSessionStore: true,
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      requestExtensions: false,
      requestCanvasRenderer: false,
      manageScheduleEnabled: false,
      enableSessionTelemetry: false,
      availableTools: [...EXPLICIT_AVAILABLE_TOOLS],
      pluginDirectories: [],
      mcpServers: {},
      customAgents: this.#definitions.agents.map((definition) => ({
        name: definition.name,
        description: definition.description,
        prompt: definition.body,
        tools: definition.tools === null ? null : [...definition.tools]
      })),
      skillDirectories: [
        ...new Set(this.#definitions.skills.map((definition) => dirname(definition.canonicalPath)))
      ]
    };
    if (agent) {
      options.agent = agent.name;
    }
    return options;
  }

  capabilityMetadata() {
    return {
      sdk: { ...PINNED_SDK },
      isolation: {
        mode: "empty",
        runtimeDirectory: this.runtimeDirectory,
        configDiscovery: false,
        availableTools: [...EXPLICIT_AVAILABLE_TOOLS],
        ambientPlugins: false
      },
      storage: {
        sharesChatStoreBudget: true,
        budgetBytes: MAX_CHAT_STORE_BYTES,
        entryLimit: MAX_CHAT_STORE_ENTRIES
      },
      nativeCommands: {
        agentSelection: "session.rpc.agent.select/deselect",
        definitionReload: "session.rpc.agent.reload and session.rpc.skills.reload",
        skillInvocation: "session.rpc.commands.invoke",
        sessionDeletion: "client.deleteSession when present"
      },
      unsupportedEmbeddedCommands: ["model", "plan", "review", "fleet", "experimental", "loop", "every", "login", "quit"],
      diagnostics: this.#definitions.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    };
  }

  async verify(session) {
    const agentList = requireMethod(session?.rpc?.agent, "list");
    const skillList = requireMethod(session?.rpc?.skills, "list");
    const [agentResult, skillResult] = await Promise.all([
      agentList({ includePrompt: true }),
      skillList()
    ]);
    if (!isRecord(agentResult) || !isRecord(skillResult)) {
      throw new NativeChatCapabilityError(
        "The native runtime returned malformed definition metadata.",
        "NATIVE_METADATA_INVALID"
      );
    }

    const runtimeAgents = expectArray(agentResult.agents, "agent");
    const runtimeSkills = expectArray(skillResult.skills, "skill");
    const agents = this.#definitions.agents.map((definition) => (
      this.#verifyAgent(definition, runtimeAgents)
    ));
    const skills = this.#definitions.skills.map((definition) => (
      this.#verifySkill(definition, runtimeSkills)
    ));
    this.#verification = { session, agents, skills };
    return { agents, skills };
  }

  async selectAgent(session, name) {
    if (name === undefined || name === null || name === "" || String(name).toLowerCase() === "default") {
      const deselect = requireMethod(session?.rpc?.agent, "deselect");
      await deselect();
      this.#selectedAgents.set(session, null);
      return { selectedAgent: null };
    }

    const verification = await this.#ensureVerified(session);
    const agent = verification.agents.find((candidate) => (
      candidate.name.toLowerCase() === String(name).toLowerCase()
    ));
    if (!agent) {
      throw new NativeChatCapabilityError(
        `Agent "${name}" is not a verified workspace agent.`,
        "NATIVE_AGENT_NOT_VERIFIED",
        { name }
      );
    }
    const select = requireMethod(session?.rpc?.agent, "select");
    await select({ name: agent.name });
    this.#selectedAgents.set(session, agent.name);
    return { selectedAgent: agent.name, agent };
  }

  async reload(session) {
    const definitions = this.#normalizeDefinitions(discoverChatDefinitions(this.workspace));
    this.#definitions = definitions;
    this.#verification = null;
    let selectedAgent = this.#selectedAgents.get(session) ?? null;

    if (
      selectedAgent &&
      !definitions.agents.some((agent) => agent.name.toLowerCase() === selectedAgent.toLowerCase())
    ) {
      const deselect = requireMethod(session?.rpc?.agent, "deselect");
      await deselect();
      selectedAgent = null;
      this.#selectedAgents.set(session, null);
    }

    const reloadAgents = requireMethod(session?.rpc?.agent, "reload");
    const reloadSkills = requireMethod(session?.rpc?.skills, "reload");
    const [, skillReloadResult] = await Promise.all([reloadAgents(), reloadSkills()]);
    if (
      !isRecord(skillReloadResult) ||
      !Array.isArray(skillReloadResult.warnings) ||
      !Array.isArray(skillReloadResult.errors)
    ) {
      throw new NativeChatCapabilityError(
        "The native runtime returned a malformed skill reload result.",
        "NATIVE_METADATA_INVALID"
      );
    }

    const definitionFailure = diagnosticError(definitions.diagnostics);
    if (definitionFailure) {
      throw definitionFailure;
    }
    if (skillReloadResult.errors.length > 0) {
      throw new NativeChatCapabilityError(
        "The native runtime could not reload workspace skills.",
        "NATIVE_SKILL_RELOAD_FAILED",
        {
          warnings: [...skillReloadResult.warnings],
          errors: [...skillReloadResult.errors]
        }
      );
    }

    const verified = await this.verify(session);
    return {
      ...verified,
      selectedAgent,
      diagnostics: definitions.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      warnings: [...skillReloadResult.warnings],
      errors: []
    };
  }

  async invokeSkill(session, commandLine) {
    const command = parseSkillCommand(commandLine);
    const verification = await this.#ensureVerified(session);
    const skill = verification.skills.find((candidate) => (
      candidate.commandName.toLowerCase() === command.name.toLowerCase() ||
      candidate.name.toLowerCase() === command.name.toLowerCase()
    ));
    if (!skill) {
      throw new NativeChatCapabilityError(
        `Skill command "/${command.name}" is not verified for this workspace.`,
        "NATIVE_SKILL_NOT_VERIFIED",
        { command: command.name }
      );
    }

    const invoke = requireMethod(session?.rpc?.commands, "invoke");
    const result = await invoke({
      name: skill.commandName,
      ...(command.input === undefined ? {} : { input: command.input })
    });
    if (
      !isRecord(result) ||
      result.kind !== "agent-prompt" ||
      typeof result.prompt !== "string" ||
      typeof result.displayPrompt !== "string"
    ) {
      throw new NativeChatCapabilityError(
        "The native skill command did not produce an agent prompt.",
        "NATIVE_SKILL_RESULT_UNSUPPORTED",
        { command: skill.commandName, result }
      );
    }
    return {
      prompt: result.prompt,
      displayPrompt: result.displayPrompt
    };
  }

  async deleteSession(client, sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new TypeError("A native session ID is required.");
    }
    if (typeof client?.deleteSession !== "function") {
      return {
        deleted: false,
        nativeDeleted: false,
        sessionId,
        supported: false,
        unsupported: true,
        residualRetention: true,
        code: "NATIVE_SESSION_DELETE_UNSUPPORTED",
        message: "The pinned SDK client does not expose verified native-session deletion."
      };
    }
    await client.deleteSession(sessionId);
    return {
      deleted: true,
      nativeDeleted: true,
      sessionId,
      supported: true,
      unsupported: false,
      residualRetention: false
    };
  }

  #normalizeDefinitions(definitions) {
    if (
      !isRecord(definitions) ||
      !Array.isArray(definitions.skills) ||
      !Array.isArray(definitions.agents) ||
      !Array.isArray(definitions.diagnostics)
    ) {
      throw new NativeChatCapabilityError(
        "Workspace chat definitions are malformed.",
        "NATIVE_DEFINITION_INVALID"
      );
    }

    const normalize = (definition, type) => {
      if (!isRecord(definition) || definition.type !== type || !definition.valid) {
        return null;
      }
      if (
        typeof definition.name !== "string" ||
        typeof definition.description !== "string" ||
        typeof definition.body !== "string" ||
        typeof definition.source !== "string" ||
        typeof definition.canonicalPath !== "string" ||
        normalizedTools(definition.tools) === undefined
      ) {
        throw new NativeChatCapabilityError(
          `Workspace ${type} definition metadata is malformed.`,
          "NATIVE_DEFINITION_INVALID",
          { source: definition.source ?? null }
        );
      }
      if (type === "skill" && definition.tools !== null) {
        throw new NativeChatCapabilityError(
          "The pinned SDK does not expose verifiable per-skill tool restrictions.",
          "NATIVE_SKILL_TOOL_RESTRICTION_UNSUPPORTED",
          { source: definition.source, tools: [...definition.tools] }
        );
      }
      const canonicalPath = canonicalFile(definition.canonicalPath, `Workspace ${type} definition`);
      const expectedRoot = resolve(
        this.workspace,
        ".github",
        type === "skill" ? "skills" : "agents"
      );
      if (!pathIsInside(expectedRoot, canonicalPath)) {
        throw new NativeChatCapabilityError(
          `Workspace ${type} definition resolves outside its approved project directory.`,
          "NATIVE_DEFINITION_PATH_ESCAPE",
          { source: definition.source, canonicalPath }
        );
      }
      return {
        type,
        name: definition.name,
        description: definition.description,
        tools: definition.tools === null ? null : [...definition.tools],
        body: definition.body,
        source: definition.source,
        canonicalPath
      };
    };

    return {
      skills: definitions.skills.map((definition) => normalize(definition, "skill")).filter(Boolean),
      agents: definitions.agents.map((definition) => normalize(definition, "agent")).filter(Boolean),
      diagnostics: definitions.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    };
  }

  #resolveDefinition(type, name, { allowDefault = false } = {}) {
    if (allowDefault && (
      name === undefined ||
      name === null ||
      name === "" ||
      String(name).toLowerCase() === "default"
    )) {
      return null;
    }
    const definitions = type === "agent" ? this.#definitions.agents : this.#definitions.skills;
    const definition = definitions.find((candidate) => (
      candidate.name.toLowerCase() === String(name).toLowerCase()
    ));
    if (!definition) {
      throw new NativeChatCapabilityError(
        `${type === "agent" ? "Agent" : "Skill"} "${name}" is not an approved workspace definition.`,
        type === "agent" ? "NATIVE_AGENT_NOT_APPROVED" : "NATIVE_SKILL_NOT_APPROVED",
        { name }
      );
    }
    return definition;
  }

  async #ensureVerified(session) {
    if (this.#verification?.session === session) {
      return this.#verification;
    }
    await this.verify(session);
    return this.#verification;
  }

  #verifyAgent(definition, runtimeAgents) {
    const matches = runtimeAgents.filter((agent) => (
      isRecord(agent) &&
      typeof agent.name === "string" &&
      agent.name.toLowerCase() === definition.name.toLowerCase()
    ));
    if (matches.length !== 1) {
      throw nativeDefinitionError(
        "Agent",
        definition,
        matches.length === 0 ? "the runtime did not load it" : "the runtime returned duplicate identities",
        matches
      );
    }
    const runtime = matches[0];
    if (
      runtime.id !== definition.name ||
      runtime.name !== definition.name ||
      typeof runtime.description !== "string" ||
      runtime.description !== definition.description ||
      runtime.userInvocable === false
    ) {
      throw nativeDefinitionError("Agent", definition, "the runtime identity metadata is incomplete or mismatched", runtime);
    }
    if (runtime.prompt !== undefined && runtime.prompt !== definition.body) {
      throw nativeDefinitionError("Agent", definition, "the runtime prompt differs from the project definition", runtime);
    }
    if (!sameTools(runtime.tools, definition.tools)) {
      throw nativeDefinitionError("Agent", definition, "the runtime tool restrictions differ from the project definition", runtime);
    }
    if (runtime.source !== undefined && runtime.source !== "project") {
      throw nativeDefinitionError("Agent", definition, "the runtime reported conflicting provenance", runtime);
    }
    const path = runtimePath(runtime);
    if (path) {
      const canonicalPath = canonicalFile(path, `Runtime agent "${definition.name}"`);
      if (!pathIsInside(this.workspace, canonicalPath) || !samePath(canonicalPath, definition.canonicalPath)) {
        throw nativeDefinitionError("Agent", definition, "the runtime source is not the approved project file", runtime);
      }
    }
    return {
      name: definition.name,
      id: runtime.id,
      description: definition.description,
      prompt: definition.body,
      promptSource: runtime.prompt === undefined ? "configured" : "runtime",
      tools: definition.tools === null ? null : [...definition.tools],
      source: definition.source,
      canonicalPath: definition.canonicalPath,
      runtimeSource: runtime.source ?? null,
      runtimePath: path,
      verified: true
    };
  }

  #verifySkill(definition, runtimeSkills) {
    const matches = runtimeSkills.filter((skill) => (
      isRecord(skill) &&
      (
        (
          typeof skill.name === "string" &&
          skill.name.toLowerCase() === definition.name.toLowerCase()
        ) ||
        (
          typeof skill.commandName === "string" &&
          skill.commandName.toLowerCase() === definition.name.toLowerCase()
        )
      )
    ));
    if (matches.length !== 1) {
      throw nativeDefinitionError(
        "Skill",
        definition,
        matches.length === 0 ? "the runtime did not load it" : "the runtime returned duplicate identities",
        matches
      );
    }
    const runtime = matches[0];
    if (
      typeof runtime.name !== "string" ||
      typeof runtime.commandName !== "string" ||
      typeof runtime.description !== "string" ||
      runtime.name !== definition.name ||
      runtime.commandName !== definition.name ||
      runtime.description !== definition.description ||
      !["custom", "project"].includes(runtime.source) ||
      runtime.enabled !== true ||
      runtime.userInvocable !== true
    ) {
      throw nativeDefinitionError("Skill", definition, "the runtime metadata is incomplete or inactive", runtime);
    }
    const path = runtimePath(runtime);
    if (!path) {
      throw nativeDefinitionError("Skill", definition, "the runtime omitted its canonical file path", runtime);
    }
    const canonicalPath = canonicalFile(path, `Runtime skill "${definition.name}"`);
    if (!pathIsInside(this.workspace, canonicalPath) || !samePath(canonicalPath, definition.canonicalPath)) {
      throw nativeDefinitionError("Skill", definition, "the runtime source is not the approved project file", runtime);
    }
    return {
      name: definition.name,
      commandName: runtime.commandName,
      description: runtime.description,
      source: definition.source,
      canonicalPath: definition.canonicalPath,
      runtimeSource: runtime.source ?? null,
      runtimePath: canonicalPath,
      enabled: true,
      userInvocable: true,
      verified: true
    };
  }
}
