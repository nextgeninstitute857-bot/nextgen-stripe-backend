function isDraftable(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shallowCopy(value) {
  if (Array.isArray(value)) return value.slice();
  return Object.assign(Object.create(Object.getPrototypeOf(value)), value);
}

/**
 * Apply a JSON-compatible mutation without cloning the full source tree.
 *
 * The mutator receives a Proxy draft. Reads continue to reference the source,
 * while the first write at each object/array level creates a shallow copy.
 * If the mutator throws, the source remains untouched.
 */
export async function mutateJsonCopyOnWrite(source, mutator) {
  if (!isDraftable(source)) throw new TypeError("Copy-on-write source must be a JSON object or array");
  if (typeof mutator !== "function") throw new TypeError("Copy-on-write mutator must be a function");

  const proxyStates = new WeakMap();
  let clonedNodes = 0;
  let modifiedNodes = 0;

  const markModified = (state) => {
    if (state.modified) return;
    state.copy = shallowCopy(state.base);
    state.modified = true;
    clonedNodes += 1;
    modifiedNodes += 1;

    if (state.parent) {
      markModified(state.parent);
      state.parent.copy[state.parentKey] = state.proxy;
    }
  };

  const createDraft = (base, parent = null, parentKey = null) => {
    if (!isDraftable(base)) return base;
    if (proxyStates.has(base)) return base;

    const state = {
      base,
      copy: null,
      modified: false,
      finalized: false,
      finalValue: null,
      parent,
      parentKey,
      children: new Map(),
      proxy: null,
    };

    const current = () => state.modified ? state.copy : state.base;

    const handler = {
      get(_target, property, receiver) {
        const value = Reflect.get(current(), property, receiver);
        if (!isDraftable(value)) return value;
        if (proxyStates.has(value)) return value;

        const cached = state.children.get(property);
        if (cached && (cached.base === value || cached.proxy === value)) return cached.proxy;

        const child = createDraft(value, state, property);
        state.children.set(property, proxyStates.get(child));
        return child;
      },

      set(_target, property, value) {
        const existing = Reflect.get(current(), property);
        if (Object.is(existing, value) && Object.prototype.hasOwnProperty.call(current(), property)) return true;
        markModified(state);
        state.children.delete(property);
        return Reflect.set(state.copy, property, value);
      },

      deleteProperty(_target, property) {
        if (!Object.prototype.hasOwnProperty.call(current(), property)) return true;
        markModified(state);
        state.children.delete(property);
        return Reflect.deleteProperty(state.copy, property);
      },

      defineProperty(_target, property, descriptor) {
        markModified(state);
        state.children.delete(property);
        return Reflect.defineProperty(state.copy, property, descriptor);
      },

      has(_target, property) {
        return Reflect.has(current(), property);
      },

      ownKeys() {
        return Reflect.ownKeys(current());
      },

      getOwnPropertyDescriptor(_target, property) {
        return Reflect.getOwnPropertyDescriptor(current(), property);
      },

      getPrototypeOf() {
        return Reflect.getPrototypeOf(current());
      },
    };

    state.proxy = new Proxy(base, handler);
    proxyStates.set(state.proxy, state);
    return state.proxy;
  };

  const finalizeState = (state) => {
    if (state.finalized) return state.finalValue;
    if (!state.modified) {
      state.finalized = true;
      state.finalValue = state.base;
      return state.finalValue;
    }

    for (const property of Reflect.ownKeys(state.copy)) {
      const value = Reflect.get(state.copy, property);
      const directState = proxyStates.get(value);
      if (directState) {
        Reflect.set(state.copy, property, finalizeState(directState));
        continue;
      }

      const child = state.children.get(property);
      if (child?.modified && (value === child.base || value === child.proxy)) {
        Reflect.set(state.copy, property, finalizeState(child));
      }
    }

    state.finalized = true;
    state.finalValue = state.copy;
    return state.finalValue;
  };

  const draft = createDraft(source);
  const result = await mutator(draft);
  const next = finalizeState(proxyStates.get(draft));

  const materializeResult = (value, seen = new WeakMap()) => {
    const draftState = proxyStates.get(value);
    if (draftState) return finalizeState(draftState);
    if (!isDraftable(value)) return value;
    if (value === source) return next;
    if (seen.has(value)) return seen.get(value);

    let output = value;
    seen.set(value, value);
    for (const property of Reflect.ownKeys(value)) {
      const child = Reflect.get(value, property);
      const materialized = materializeResult(child, seen);
      if (materialized === child) continue;
      if (output === value) {
        output = shallowCopy(value);
        seen.set(value, output);
      }
      Reflect.set(output, property, materialized);
    }
    return output;
  };

  return {
    value: next,
    result: materializeResult(result),
    changed: next !== source,
    stats: {
      cloned_nodes: clonedNodes,
      modified_nodes: modifiedNodes,
    },
  };
}
