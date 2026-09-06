import test from "node:test";
import assert from "node:assert/strict";
import { commandCompletions } from "../public/chat-completion.js";

const registry = {
  commands: [{ name: "help", description: "Help" }, { name: "/skills", description: "Skills" }, { name: "agent", description: "Agents" }],
  skills: [{ name: "loop-engineering", description: "Design a bounded loop" }],
  agents: [{ name: "loop-verifier", description: "Independent checker" }]
};

test("slash command completion includes project definitions and filters case-insensitively", () => {
  assert.equal(commandCompletions("/", registry).length, 4);
  assert.equal(commandCompletions("/SK", registry)[0].value, "/skills");
  assert.equal(commandCompletions("/loop", registry)[0].value, "/loop-engineering");
});

test("argument completion discovers configured agents and skills", () => {
  assert.deepEqual(commandCompletions("/agent lo", registry).map((item) => item.value), ["/agent loop-verifier"]);
  assert.deepEqual(commandCompletions("/skills info lo", registry).map((item) => item.value), ["/skills info loop-engineering"]);
  assert.deepEqual(commandCompletions("/skills re", registry).map((item) => item.value), ["/skills reload"]);
});

test("completion never hijacks prose, task arguments, multiline or an interior cursor", () => {
  for (const value of ["Explain /skills", "/loop-engineering implement", "/skills\nhelp", "hello"]) {
    assert.deepEqual(commandCompletions(value, registry), []);
  }
  assert.deepEqual(commandCompletions("/skills", registry, 3), []);
});
