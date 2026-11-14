/**
 * 離線模擬 DOM 與瀏覽器執行環境測試台（零外部相依）。
 *
 * 模擬 Antigravity 的 Base UI Menu / Portal 結構、Web Animations API、
 * localStorage、MutationObserver 與可控制虛擬時鐘。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

function parseSelectorParts(simple) {
  const s = simple.trim();
  if (!s) return null;
  let rest = s;
  let tag = "";
  const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  }
  const classes = [];
  const attrs = [];
  while (rest.length > 0) {
    if (rest[0] === ".") {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return null;
      classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "[") {
      const m = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/.exec(rest);
      if (!m) return null;
      attrs.push({ name: m[1], hasValue: m[2] !== undefined || m[3] !== undefined, value: m[2] ?? m[3] ?? "" });
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "#") {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return null;
      attrs.push({ name: "id", hasValue: true, value: m[1] });
      rest = rest.slice(m[0].length);
    } else {
      return null;
    }
  }
  return { tag, classes, attrs };
}

export function matchesSelector(node, selector) {
  if (!node || node.nodeType !== 1 || typeof selector !== "string") return false;
  const groups = selector.split(",");
  for (const group of groups) {
    const parts = group.trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) continue;
    const leafSpec = parseSelectorParts(parts[parts.length - 1]);
    if (!leafSpec || !matchesSimple(node, leafSpec)) continue;
    if (parts.length === 1) return true;
    let idx = parts.length - 2;
    let cur = node.parentNode;
    while (cur && idx >= 0) {
      const spec = parseSelectorParts(parts[idx]);
      if (spec && matchesSimple(cur, spec)) {
        idx -= 1;
      }
      cur = cur.parentNode;
    }
    if (idx < 0) return true;
  }
  return false;
}

function matchesSimple(node, spec) {
  if (spec.tag && node.tagName !== spec.tag) return false;
  for (const cls of spec.classes) {
    if (!node.classList.contains(cls)) return false;
  }
  for (const attr of spec.attrs) {
    if (!node.hasAttribute(attr.name)) return false;
    if (attr.hasValue && node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(attrStr) {
  const out = [];
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1];
    const hasVal = m[2] !== undefined || m[3] !== undefined || m[4] !== undefined;
    const val = hasVal ? decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
    out.push([name, val]);
  }
  return out;
}

const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link"]);

function parseHtmlInto(parent, html, doc) {
  parent.children = [];
  parent._text = undefined;
  const tokenRe = /<(\/?)([a-zA-Z0-9_-]+)([^>]*)>|([^<]+)/g;
  const stack = [parent];
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    const cur = stack[stack.length - 1];
    if (m[4] !== undefined) {
      const txt = decodeHtmlEntities(m[4]);
      if (txt.length > 0) {
        const textNode = new FakeTextNode(txt);
        cur.appendChild(textNode);
      }
      continue;
    }
    const isClose = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrStr = m[3] || "";
    if (isClose) {
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tagName.toLowerCase() === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el = doc.createElement(tag);
    for (const [k, v] of parseAttributes(attrStr)) {
      if (k === "checked") {
        el.checked = true;
      }
      if (k === "value") {
        el.value = v;
      }
      el.setAttribute(k, v);
    }
    cur.appendChild(el);
    const selfClosing = VOID_TAGS.has(tag) || attrStr.trim().endsWith("/");
    if (!selfClosing) {
      stack.push(el);
    }
  }
}

class FakeTextNode {
  constructor(text) {
    this.tagName = "#TEXT";
    this.nodeType = 3;
    this.parentNode = null;
    this.children = [];
    this._text = String(text);
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class FakeClassList {
  constructor(node) {
    this.node = node;
  }
  _list() {
    const raw = this.node.getAttribute("class") || "";
    return raw.trim() ? raw.trim().split(/\s+/) : [];
  }
  contains(cls) {
    return this._list().includes(cls);
  }
  add(...tokens) {
    const set = new Set(this._list());
    for (const t of tokens) if (t) set.add(t);
    this.node.setAttribute("class", [...set].join(" "));
  }
  remove(...tokens) {
    const drop = new Set(tokens);
    const next = this._list().filter((c) => !drop.has(c));
    this.node.setAttribute("class", next.join(" "));
  }
}

export class FakeStyle {
  constructor() {
    this._map = new Map();
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        return target._map.get(String(prop)) ?? "";
      },
      set(target, prop, value) {
        const key = String(prop);
        if (value === "" || value === null || value === undefined) {
          target._map.delete(key);
        } else {
          target._map.set(key, String(value));
        }
        return true;
      },
    });
  }
  setProperty(name, value) {
    if (value === "" || value === null || value === undefined) {
      this._map.delete(name);
    } else {
      this._map.set(name, String(value));
    }
  }
  getPropertyValue(name) {
    return this._map.get(name) ?? "";
  }
}

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== undefined ? Boolean(init.bubbles) : true;
    this.cancelable = init.cancelable !== undefined ? Boolean(init.cancelable) : true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, init);
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._captureListeners = new Map();
    this._bubbleListeners = new Map();
    this._text = undefined;
    this._animations = [];
    this.rect = { left: 0, top: 0, right: 240, bottom: 28, width: 240, height: 28 };
    this.offsetWidth = 280;
    this.offsetHeight = 200;
    this.value = "";
    this.checked = false;
    this.capturedPointer = null;
    this.focused = false;
  }

  get className() {
    return this.getAttribute("class") || "";
  }
  set className(val) {
    this.setAttribute("class", String(val));
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  set id(val) {
    this.setAttribute("id", String(val));
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get textContent() {
    if (this._text !== undefined) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(val) {
    this._text = String(val);
    this.children = [];
    this.ownerDocument?._notifyObserver(this, "characterData");
  }
  set innerHTML(html) {
    parseHtmlInto(this, String(html), this.ownerDocument);
    this.ownerDocument?._notifyObserver(this, "childList");
  }
  get innerHTML() {
    return this.textContent;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this._text = undefined;
    this.children.push(child);
    this.ownerDocument?._notifyObserver(this, "childList");
    return child;
  }

  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.children.indexOf(refNode);
    newNode.parentNode = this;
    this._text = undefined;
    if (idx < 0) {
      this.children.push(newNode);
    } else {
      this.children.splice(idx, 0, newNode);
    }
    this.ownerDocument?._notifyObserver(this, "childList");
    return newNode;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
      this.ownerDocument?._notifyObserver(this, "childList");
    }
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    const k = String(name);
    this.attributes.set(k, String(value));
    if (k === "value") this.value = String(value);
    if (k === "checked") this.checked = true;
    this.ownerDocument?._notifyObserver(this, "attributes", k);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    const k = String(name);
    this.attributes.delete(k);
    if (k === "checked") this.checked = false;
    this.ownerDocument?._notifyObserver(this, "attributes", k);
  }

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType === 1) {
          if (matchesSelector(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type, fn, opts) {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
    const map = capture ? this._captureListeners : this._bubbleListeners;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  }

  removeEventListener(type, fn, opts) {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
    const map = capture ? this._captureListeners : this._bubbleListeners;
    const set = map.get(type);
    if (set) set.delete(fn);
  }

  dispatchEvent(ev) {
    const event = ev instanceof FakeEvent ? ev : new FakeEvent(ev?.type || "custom", ev);
    event.target = event.target || this;

    const path = [];
    let cur = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    const doc = this.ownerDocument;
    const win = doc?._win;
    if (doc && path[path.length - 1] !== doc) path.push(doc);
    if (win) path.push(win);

    // Capture phase: outer -> inner
    for (let i = path.length - 1; i >= 0 && !event.propagationStopped; i -= 1) {
      const target = path[i];
      const set = target._captureListeners?.get(event.type);
      if (!set) continue;
      event.currentTarget = target;
      for (const fn of [...set]) {
        if (event.propagationStopped) break;
        fn.call(target, event);
      }
    }

    // Bubble phase: inner -> outer
    for (let i = 0; i < path.length && !event.propagationStopped; i += 1) {
      if (i > 0 && !event.bubbles) break;
      const target = path[i];
      const set = target._bubbleListeners?.get(event.type);
      if (!set) continue;
      event.currentTarget = target;
      for (const fn of [...set]) {
        if (event.propagationStopped) break;
        fn.call(target, event);
      }
    }
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(new FakeEvent("click", { bubbles: true, cancelable: true }));
  }

  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setPointerCapture(pointerId) {
    this.capturedPointer = pointerId;
  }

  getAnimations() {
    if (this.classList.contains("ces-star") && this._animations.length === 0) {
      this._animations.push({ playbackRate: 1 });
    }
    return this._animations;
  }
}

export function createTestEnv() {
  const storageMap = new Map();
  let now = 1000;
  let nextRafId = 1;
  const rafQueue = new Map();
  const observerRecords = [];
  const clipboardWrites = [];

  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.connected = false;
      this.pending = [];
      observerRecords.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
      this.pending = [];
    }
  }

  const doc = {
    nodeType: 9,
    readyState: "complete",
    activeElement: null,
    _captureListeners: new Map(),
    _bubbleListeners: new Map(),
    _win: null,
    _notifyObserver(target, type, attributeName) {
      for (const obs of observerRecords) {
        if (obs.connected) {
          obs.pending.push({ target, type, attributeName });
        }
      }
    },
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const map = capture ? this._captureListeners : this._bubbleListeners;
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    },
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const map = capture ? this._captureListeners : this._bubbleListeners;
      const set = map.get(type);
      if (set) set.delete(fn);
    },
    dispatchEvent(ev) {
      const event = ev instanceof FakeEvent ? ev : new FakeEvent(ev?.type || "custom", ev);
      event.target = event.target || doc.body;
      const win = doc._win;
      const path = [doc];
      if (win) path.push(win);
      for (let i = path.length - 1; i >= 0 && !event.propagationStopped; i -= 1) {
        const set = path[i]._captureListeners?.get(event.type);
        if (!set) continue;
        event.currentTarget = path[i];
        for (const fn of [...set]) {
          if (event.propagationStopped) break;
          fn.call(path[i], event);
        }
      }
      for (let i = 0; i < path.length && !event.propagationStopped; i += 1) {
        const set = path[i]._bubbleListeners?.get(event.type);
        if (!set) continue;
        event.currentTarget = path[i];
        for (const fn of [...set]) {
          if (event.propagationStopped) break;
          fn.call(path[i], event);
        }
      }
      return !event.defaultPrevented;
    },
  };

  doc.documentElement = new FakeElement("html", doc);
  doc.head = new FakeElement("head", doc);
  doc.body = new FakeElement("body", doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.getElementById = (id) => doc.documentElement.querySelector(`[id="${id}"]`);

  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    _captureListeners: new Map(),
    _bubbleListeners: new Map(),
    performance: { now: () => now },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
      clear: () => storageMap.clear(),
    },
    CustomEvent: class FakeCustomEvent extends FakeEvent {},
    MouseEvent: class FakeMouseEvent extends FakeEvent {},
    HTMLElement: FakeElement,
    MutationObserver: FakeMutationObserver,
    navigator: {
      clipboard: {
        writeText: async (text) => {
          clipboardWrites.push(String(text));
        },
      },
    },
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      rafQueue.delete(id);
    },
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const map = capture ? this._captureListeners : this._bubbleListeners;
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    },
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const map = capture ? this._captureListeners : this._bubbleListeners;
      const set = map.get(type);
      if (set) set.delete(fn);
    },
    dispatchEvent(ev) {
      const event = ev instanceof FakeEvent ? ev : new FakeEvent(ev?.type || "custom", ev);
      event.target = event.target || win;
      for (const map of [this._captureListeners, this._bubbleListeners]) {
        const set = map.get(event.type);
        if (!set) continue;
        event.currentTarget = win;
        for (const fn of [...set]) {
          if (event.propagationStopped) break;
          fn.call(win, event);
        }
      }
      return !event.defaultPrevented;
    },
    setInterval: () => 0,
    clearInterval: () => {},
  };

  doc._win = win;

  function flushFrames(maxFrames = 1, dtMs = 16) {
    let executed = 0;
    for (let i = 0; i < maxFrames; i += 1) {
      if (rafQueue.size === 0) break;
      now += dtMs;
      const entries = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [, cb] of entries) {
        executed += 1;
        cb(now);
      }
    }
    return executed;
  }

  function flushObservers() {
    let total = 0;
    for (const obs of observerRecords) {
      if (obs.connected && obs.pending.length > 0) {
        const batch = obs.pending.splice(0, obs.pending.length);
        total += batch.length;
        obs.cb(batch, obs);
      }
    }
    return total;
  }

  return {
    doc,
    win,
    storageMap,
    clipboardWrites,
    now: () => now,
    advanceClock(ms) {
      now += ms;
    },
    flushFrames,
    flushObservers,
    pendingFrameCount: () => rafQueue.size,
  };
}

/**
 * 建構真實 Antigravity 模型選擇器的模擬 DOM：
 * - [data-testid="model-selector-trigger"]
 * - [data-testid="model-selector-panel"] 含 [data-testid="model-selector-effort-group"]
 * - Base UI Menu.Portal 分離掛載於 body 下的 [role="menu"] 子選單，含 [data-testid="model-selector-effort-option"]
 */
export function createAntigravityDom(env, options = {}) {
  const { doc } = env;
  const efforts = options.efforts || [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ];
  const modelBase = options.modelBase ?? "Claude Opus 4.6 (Thinking)";
  const contextSuffix = options.contextSuffix ?? "";
  let activeEffort = options.activeEffort ?? "high";
  let submenuOpen = options.submenuOpen !== false;
  let panelOpen = options.panelOpen !== false;
  const clicks = [];
  let submenuClosedByLeave = false;

  const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };

  // Trigger button (always in composer)
  const trigger = doc.createElement("button");
  trigger.setAttribute("type", "button");
  trigger.setAttribute("data-testid", "model-selector-trigger");
  const triggerOuterSpan = doc.createElement("span");
  const triggerBaseText = doc.createElement("span");
  triggerBaseText.textContent = modelBase;
  const triggerEffortSpan = doc.createElement("span");
  triggerEffortSpan.className = "opacity-70";
  triggerEffortSpan.textContent = ` ${EFFORT_LABELS[activeEffort] || activeEffort}${contextSuffix}`;
  triggerOuterSpan.appendChild(triggerBaseText);
  triggerOuterSpan.appendChild(triggerEffortSpan);
  trigger.appendChild(triggerOuterSpan);
  doc.body.appendChild(trigger);

  // Panel (portal 1)
  const panel = doc.createElement("div");
  panel.setAttribute("data-testid", "model-selector-panel");
  const nativeListContainer = doc.createElement("div");
  nativeListContainer.setAttribute("data-testid", "native-list-container");
  const headerEl = doc.createElement("div");
  headerEl.setAttribute("data-testid", "model-selector-header");
  headerEl.textContent = "Model";
  nativeListContainer.appendChild(headerEl);

  const groupRow = doc.createElement("div");
  groupRow.setAttribute("role", "menuitem");
  groupRow.setAttribute("data-highlighted", "true");
  const groupSpan = doc.createElement("span");
  groupSpan.setAttribute("data-testid", "model-selector-effort-group");
  groupSpan.setAttribute("data-model-base", modelBase);
  groupSpan.textContent = modelBase;
  const groupEffortSpan = doc.createElement("span");
  groupEffortSpan.className = "shrink-0 opacity-70 text-sm";
  groupEffortSpan.textContent = EFFORT_LABELS[activeEffort] || activeEffort;
  groupRow.appendChild(groupSpan);
  groupRow.appendChild(groupEffortSpan);
  nativeListContainer.appendChild(groupRow);

  const singleModelName = options.singleModelName ?? "Gemini 3 Flash";
  const singleItemRow = doc.createElement("div");
  singleItemRow.setAttribute("role", "menuitem");
  singleItemRow.setAttribute("data-testid", "model-selector-item");
  singleItemRow.setAttribute("data-model-label", singleModelName);
  singleItemRow.textContent = singleModelName;
  if (options.includeSingleModel !== false) {
    nativeListContainer.appendChild(singleItemRow);
  }
  panel.appendChild(nativeListContainer);

  const nativeFooter = doc.createElement("div");
  nativeFooter.setAttribute("data-testid", "native-footer");
  nativeFooter.textContent = "View Usage";
  panel.appendChild(nativeFooter);

  if (panelOpen) doc.body.appendChild(panel);

  // Submenu (portal 2 — sibling under body, matching Base UI Menu.Portal)
  const submenu = doc.createElement("div");
  submenu.setAttribute("role", "menu");
  submenu.addEventListener("mouseleave", () => {
    submenuClosedByLeave = true;
  });

  const optionEls = [];
  for (const eff of efforts) {
    const item = doc.createElement("div");
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", eff.id === activeEffort ? "true" : "false");
    if (eff.disabled) {
      item.setAttribute("aria-disabled", "true");
      item.setAttribute("data-disabled", "");
    }
    const optSpan = doc.createElement("span");
    optSpan.setAttribute("data-testid", "model-selector-effort-option");
    optSpan.setAttribute("data-effort", eff.id);
    optSpan.textContent = eff.label;
    item.appendChild(optSpan);

    item.addEventListener("click", () => {
      if (eff.disabled) return;
      clicks.push(eff.id);
      if (options.rejectClick) return;
      activeEffort = eff.id;
      for (const rec of optionEls) {
        rec.item.setAttribute("aria-checked", rec.id === activeEffort ? "true" : "false");
      }
      groupEffortSpan.textContent = EFFORT_LABELS[activeEffort] || activeEffort;
      triggerEffortSpan.textContent = ` ${EFFORT_LABELS[activeEffort] || activeEffort}${contextSuffix}`;
      if (options.closeOnSelect) {
        closeMenu();
      }
    });

    submenu.appendChild(item);
    optionEls.push({ id: eff.id, item, optSpan });
  }
  if (submenuOpen) doc.body.appendChild(submenu);

  function closeMenu() {
    panelOpen = false;
    submenuOpen = false;
    panel.remove();
    submenu.remove();
  }

  function openMenu() {
    panelOpen = true;
    submenuOpen = true;
    if (!panel.parentNode) doc.body.appendChild(panel);
    if (!submenu.parentNode) doc.body.appendChild(submenu);
  }

  const fiberCalls = [];
  let providerValue = null;

  function syncTriggerAndRows(selectedOpt) {
    if (!selectedOpt) return;
    const m = /^(.*?)\s*\((low|medium|high|xhigh|max)(?:\s+thinking)?\)\s*$/i.exec(selectedOpt.label);
    if (m) {
      const base = m[1].trim();
      const eff = m[2].toLowerCase();
      activeEffort = eff;
      triggerBaseText.textContent = base;
      triggerEffortSpan.textContent = ` ${EFFORT_LABELS[eff] || eff}${contextSuffix}`;
      triggerEffortSpan.style.display = "";
      groupEffortSpan.textContent = EFFORT_LABELS[eff] || eff;
      for (const rec of optionEls) {
        rec.item.setAttribute("aria-checked", rec.id === eff ? "true" : "false");
      }
    } else {
      triggerBaseText.textContent = selectedOpt.label;
      triggerEffortSpan.textContent = "";
    }
  }

  if (options.withFiber) {
    const byEffort = new Map();
    const effortOptions = [];
    for (const eff of efforts) {
      const opt = {
        label: `${modelBase} (${EFFORT_LABELS[eff.id] || eff.id})`,
        value: `MODEL_${modelBase.replace(/\W+/g, "_").toUpperCase()}_${eff.id.toUpperCase()}`,
        disabled: Boolean(eff.disabled),
        isCustom: false,
        tagTitle: eff.tagTitle,
        tagDescription: eff.tagDescription,
        quotaInfo: eff.quotaInfo,
      };
      byEffort.set(eff.id, opt);
      effortOptions.push(opt);
    }
    const secondBase = options.secondModelBase ?? "GPT-OSS 120B";
    const secondByEffort = new Map();
    for (const eid of ["low", "medium", "high"]) {
      secondByEffort.set(eid, {
        label: `${secondBase} (${EFFORT_LABELS[eid]})`,
        value: `MODEL_GPT_OSS_${eid.toUpperCase()}`,
        disabled: false,
        isCustom: false,
        tagTitle: options.secondTagTitle,
        tagDescription: options.secondTagDescription,
        quotaInfo: options.secondQuotaInfo,
      });
    }
    const singleOpt = {
      label: singleModelName,
      value: "MODEL_GEMINI_FLASH",
      disabled: false,
      isCustom: false,
      tagTitle: options.singleTagTitle !== undefined ? options.singleTagTitle : "Fast",
      tagDescription: options.singleTagDescription !== undefined ? options.singleTagDescription : "Fast responses for everyday tasks",
      quotaInfo: options.singleQuotaInfo,
    };

    const effortIndex = new Map([
      [modelBase, byEffort],
      [secondBase, secondByEffort],
    ]);

    const initialOpt = byEffort.get(activeEffort) || effortOptions[0];
    providerValue = {
      effortIndex,
      selectedModel: initialOpt,
      groups: [
        {
          groupName: "Recommended",
          options: [initialOpt, secondByEffort.get("medium"), singleOpt],
        },
      ],
      bestOfNConfig: { isBestOfNEnabled: Boolean(options.bestOfN) },
      isModelListLoading: Boolean(options.isLoading),
      setSelectedModel(opt) {
        fiberCalls.push({ via: "provider", label: opt.label, value: opt.value });
        if (!options.rejectFiber) {
          providerValue.selectedModel = opt;
          syncTriggerAndRows(opt);
        }
        closeMenu();
      },
    };

    const outsideEditor = doc.createElement("div");
    outsideEditor.setAttribute("data-lexical-editor", "true");
    doc.body.appendChild(outsideEditor);

    const nonClosingSetSelectedModel = (opt) => {
      fiberCalls.push({ via: "xqc", label: opt.label, value: opt.value });
      if (!options.rejectFiber) {
        providerValue.selectedModel = opt;
        syncTriggerAndRows(opt);
      }
      // 模擬 Antigravity $Qc 的 w()?.focus()：若未攔截會把焦點移到外部編輯器並導致 Base UI 關閉選單
      outsideEditor.focus();
      if (doc.activeElement === outsideEditor) {
        closeMenu();
      }
    };

    const setIsOpenFn = (open) => {
      if (!open) closeMenu();
      else openMenu();
    };

    const xqcFiber = {
      memoizedProps: {
        setSelectedModel: nonClosingSetSelectedModel,
        setIsOpen: setIsOpenFn,
      },
      return: null,
    };
    const lqcComponentFiber = {
      memoizedProps: {
        setSelectedModel: providerValue.setSelectedModel,
        setIsOpen: setIsOpenFn,
      },
      return: xqcFiber,
    };
    const lqcFiber = {
      memoizedProps: { value: providerValue },
      return: lqcComponentFiber,
    };
    const leafFiber = {
      memoizedProps: {},
      return: lqcFiber,
    };
    panel.__reactFiber$test = leafFiber;
    trigger.__reactFiber$test = leafFiber;
  }

  function setEffortExternally(effortId) {
    activeEffort = effortId;
    for (const rec of optionEls) {
      rec.item.setAttribute("aria-checked", rec.id === activeEffort ? "true" : "false");
    }
    groupEffortSpan.textContent = EFFORT_LABELS[activeEffort] || activeEffort;
    triggerEffortSpan.textContent = ` ${EFFORT_LABELS[activeEffort] || activeEffort}${contextSuffix}`;
    if (providerValue && providerValue.effortIndex.has(modelBase)) {
      const nextOpt = providerValue.effortIndex.get(modelBase).get(effortId);
      if (nextOpt) providerValue.selectedModel = nextOpt;
    }
  }

  return {
    trigger,
    triggerBaseText,
    triggerEffortSpan,
    panel,
    nativeListContainer,
    nativeFooter,
    groupRow,
    groupSpan,
    groupEffortSpan,
    singleItemRow,
    submenu,
    optionEls,
    clicks,
    fiberCalls,
    providerValue,
    closeMenu,
    openMenu,
    setEffortExternally,
    wasSubmenuClosedByLeave: () => submenuClosedByLeave,
    resetLeaveFlag: () => { submenuClosedByLeave = false; },
    getActiveEffort: () => activeEffort,
  };
}

/**
 * 在無 module/require 的純瀏覽器 VM 環境下執行腳本，測試主世界自動啟動與冪等守衛。
 */
export function runInBrowserVm(scriptPath, env) {
  const code = readFileSync(scriptPath, "utf8");
  const timers = [];
  const context = {
    globalThis: null,
    window: env.win,
    document: env.doc,
    performance: env.win.performance,
    localStorage: env.win.localStorage,
    CustomEvent: env.win.CustomEvent,
    MouseEvent: env.win.MouseEvent,
    MutationObserver: env.win.MutationObserver,
    navigator: env.win.navigator,
    console,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    },
    clearTimeout,
    setInterval: env.win.setInterval,
    clearInterval: env.win.clearInterval,
  };
  context.globalThis = env.win;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: scriptPath });
  return {
    context,
    cleanup() {
      for (const id of timers) clearTimeout(id);
    },
  };
}
