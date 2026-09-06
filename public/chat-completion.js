export function commandCompletions(value, registry, cursor = value.length) {
  if (!value.startsWith("/") || value.includes("\n") || cursor !== value.length) return [];
  const [command, ...parts] = value.slice(1).split(/\s+/);
  let options;
  let filter;
  if (!parts.length) {
    options = [
      ...(registry.commands ?? []).map((item) => ({ value: `/${item.name.replace(/^\//, "")}`, description: item.description })),
      ...(registry.skills ?? []).map((item) => ({ value: `/${item.name}`, description: `Project skill: ${item.description}` }))
    ];
    filter = value;
  } else if (command.toLowerCase() === "agent" && parts.length === 1) {
    options = [{ value: "/agent default", description: "Default lab agent" }, ...(registry.agents ?? []).map((item) => ({
      value: `/agent ${item.name}`, description: item.description
    }))];
    filter = value;
  } else if (command.toLowerCase() === "skills" && parts.length === 1) {
    options = [
      { value: "/skills list", description: "List project skill candidates" },
      { value: "/skills info ", description: "Inspect a project's skill" },
      { value: "/skills reload", description: "Reload project skill definitions" }
    ];
    filter = value;
  } else if (command.toLowerCase() === "skills" && parts[0].toLowerCase() === "info" && parts.length === 2) {
    options = (registry.skills ?? []).map((item) => ({
      value: `/skills info ${item.name}`, description: item.description
    }));
    filter = value;
  } else {
    return [];
  }
  const seen = new Set();
  return options.filter((option) => {
    const key = option.value.toLowerCase();
    if (!key.startsWith(filter.toLowerCase()) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
}

export function attachCommandCompletion(input, list, getRegistry) {
  let choices = [];
  let selected = 0;
  let composing = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  list.setAttribute("role", "listbox");

  function close() {
    choices = [];
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function render() {
    list.replaceChildren();
    if (!choices.length) return close();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    for (const [index, choice] of choices.entries()) {
      const option = document.createElement("div");
      option.id = `${list.id}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selected));
      option.dataset.index = index;
      const name = document.createElement("strong");
      name.textContent = choice.value;
      const detail = document.createElement("span");
      detail.textContent = choice.description ?? "";
      option.append(name, detail);
      list.append(option);
    }
    input.setAttribute("aria-activedescendant", `${list.id}-${selected}`);
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  }

  function refresh() {
    if (composing) return close();
    choices = commandCompletions(input.value, getRegistry(), input.selectionStart);
    selected = 0;
    render();
  }

  function choose(index) {
    const choice = choices[index];
    if (!choice) return;
    input.value = choice.value;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    close();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  input.addEventListener("input", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("compositionstart", () => { composing = true; close(); });
  input.addEventListener("compositionend", () => { composing = false; refresh(); });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || composing || event.keyCode === 229 || !choices.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      render();
    } else if (event.key === "Tab" || event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(selected);
    }
  });
  list.addEventListener("mousedown", (event) => { event.preventDefault(); });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-index]");
    if (option) choose(Number(option.dataset.index));
  });
  input.addEventListener("blur", close);
  return { refresh, close };
}
