/**
 * 保护快速捕获页渲染与样式约束相关行为，避免后续重构时出现静默回退。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWriteView } from "../../../src/ui/write/render-write";
import { buildWriteViewState } from "../../../src/ui/write/write-state";

// 构造最小宿主替身，承接渲染层与事件层断言。
class FakeElement {
  public className = "";
  public children: FakeElement[] = [];
  public parent: FakeElement | null = null;
  public dataset: Record<string, string> = {};
  public type = "";
  public placeholder = "";
  public autofocus = false;
  public value = "";
  public checked = false;
  public attributes: Record<string, string> = {};
  public selected = false;
  public focused = false;

  private _textContent = "";
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(public readonly tagName: string, public readonly ownerDocument: FakeDocument) {}

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  click(): void {
    const listeners = this.listeners.get("click") ?? [];
    listeners.forEach((listener) => listener());
  }

  dispatchEvent(event: { type: string }): void {
    const listeners = this.listeners.get(event.type) ?? [];
    listeners.forEach((listener) => listener(event));
  }

  select(): void {
    this.selected = true;
  }

  focus(): void {
    this.focused = true;
    const listeners = this.listeners.get("focus") ?? [];
    listeners.forEach((listener) => listener());
  }

  set textContent(value: string) {
    this._textContent = value;
  }

  get textContent(): string {
    const childText = this.children.map((child) => child.textContent).join("");
    return `${this._textContent}${childText}`;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith(".")) {
      return [];
    }

    const cls = selector.slice(1);
    const matches: FakeElement[] = [];

    const visit = (node: FakeElement): void => {
      const classes = node.className.split(/\s+/).filter(Boolean);
      if (classes.includes(cls)) {
        matches.push(node);
      }

      node.children.forEach(visit);
    };

    this.children.forEach(visit);
    return matches;
  }

  set innerHTML(_value: string) {
    this.children = [];
    this.textContent = "";
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toUpperCase(), this);
  }
}

// 提供测试夹具与辅助查询函数，减少重复的宿主搭建。
function createContainer(): HTMLElement {
  const document = new FakeDocument();
  return document.createElement("div") as unknown as HTMLElement;
}

type FakeBubblingEvent = {
  type: string;
  bubbles?: boolean;
  key?: string;
  defaultPrevented?: boolean;
  stopPropagation?: () => void;
  preventDefault?: () => void;
};

function dispatchBubblingEvent(target: FakeElement, event: Omit<FakeBubblingEvent, "stopPropagation" | "preventDefault">): FakeBubblingEvent {
  let propagationStopped = false;
  const bubblingEvent: FakeBubblingEvent = {
    ...event,
    bubbles: event.bubbles ?? true,
    defaultPrevented: false,
    stopPropagation() {
      propagationStopped = true;
    },
    preventDefault() {
      bubblingEvent.defaultPrevented = true;
    }
  };

  let current: FakeElement | null = target;
  while (current) {
    current.dispatchEvent(bubblingEvent as { type: string });
    if (!bubblingEvent.bubbles || propagationStopped) {
      break;
    }
    current = current.parent;
  }

  return bubblingEvent;
}

function activateButtonWithKeyboard(button: FakeElement, key: "Enter" | " "): FakeBubblingEvent {
  const keyboardEvent = dispatchBubblingEvent(button, { type: "keydown", key });
  if (!keyboardEvent.defaultPrevented) {
    button.click();
  }
  return keyboardEvent;
}

function isDescendantOf(node: FakeElement | null, ancestor: FakeElement | null): boolean {
  if (!node || !ancestor) {
    return false;
  }

  let current = node.parent;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

// 直接载入真实样式文本，确保结构断言与当前界面契约保持一致。
const stylesCss = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectDeclarationsInSelectorBlock(css: string, selector: string, declarations: string[]): void {
  const blockMatch = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  expect(blockMatch).not.toBeNull();
  const block = blockMatch?.[1] ?? "";
  declarations.forEach((declaration) => {
    expect(block).toContain(declaration);
  });
}

function expectNoDeclarationInSelectorBlock(css: string, selector: string, declaration: string): void {
  const blockMatch = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  expect(blockMatch).not.toBeNull();
  const block = blockMatch?.[1] ?? "";
  expect(block).not.toContain(declaration);
}

function getDeclarationValueInSelectorBlock(css: string, selector: string, property: string): string {
  const blockMatch = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  expect(blockMatch).not.toBeNull();
  const block = blockMatch?.[1] ?? "";
  const declarationMatch = block.match(new RegExp(`${escapeRegExp(property)}\\s*:\\s*([^;]+);`));
  expect(declarationMatch).not.toBeNull();
  return declarationMatch?.[1]?.trim() ?? "";
}

function expectDeclarationsInLastSelectorBlock(css: string, selector: string, declarations: string[]): void {
  const blockMatches = [...css.matchAll(new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`, "g"))];
  expect(blockMatches.length).toBeGreaterThan(0);
  const block = blockMatches[blockMatches.length - 1]?.[1] ?? "";
  declarations.forEach((declaration) => {
    expect(block).toContain(declaration);
  });
}

// 覆盖渲染单元在主要状态分支下的结构与交互契约。
describe("renderWriteView", () => {
  it("keeps quick-capture control surfaces framed and flat", () => {
    expect(stylesCss).toContain(
      ".glitter-write-stage--quick-capture .glitter-write-stage__auto-title {\n  border: none;"
    );
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__auto-title", [
      "border: none;",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);",
      "box-shadow: none;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__body-panel", [
      "border: none;",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);",
      "box-shadow: none;",
      "padding: 20px 18px 18px;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__clip-hint", [
      "border: none;",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);",
      "box-shadow: none;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__pool-button", [
      "border: none;",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);",
      "box-shadow: none;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__pool-button:disabled", [
      "cursor: default;",
      "opacity: 0.7;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__pool-dropdown", [
      "box-shadow: none;",
      "border: none;",
      "background: transparent;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__pool-container", [
      "border: 1px solid color-mix(in srgb, var(--glitter-ui-border) 42%, transparent);",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 78%, transparent);",
      "box-shadow: none;"
    ]);
    expect(stylesCss).not.toContain(".glitter-write-stage--quick-capture .glitter-write-stage__close-button {");
    expect(stylesCss).toContain(
      ".glitter-write-stage--quick-capture .glitter-write-stage__auto-title:focus-within {\n  outline: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 72%, transparent);"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage--quick-capture .glitter-write-stage__body-panel:focus-within {\n  outline: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 64%, transparent);"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage--quick-capture .glitter-write-stage__clip-hint:focus-visible,\n.glitter-write-stage--quick-capture .glitter-write-stage__clip-hint:active"
    );
    expect(stylesCss).toContain("@keyframes glitter-write-stage-pool-dropdown-rise {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-dropdown {");
    expect(stylesCss).toContain("position: absolute;");
    expect(stylesCss).toContain("bottom: calc(100% + 10px);");
    expect(stylesCss).toContain("left: 0;");
    expect(stylesCss).toContain("width: min(100%, 304px);");
    expect(stylesCss).toContain("max-width: min(304px, calc(100vw - 56px));");
    expect(stylesCss).toContain("z-index: 6;");
    expect(stylesCss).toContain("box-sizing: border-box;");
    expect(stylesCss).toContain("display: grid;");
    expect(stylesCss).toContain("gap: 10px;");
    expect(stylesCss).toContain("padding: 10px;");
    expect(stylesCss).toContain("overflow: hidden;");
    expect(stylesCss).toContain("border-radius: 16px;");
    expect(stylesCss).not.toContain("height: 264px;");
    expect(stylesCss).not.toContain("max-height: 264px;");
    expect(stylesCss).toContain("animation: glitter-write-stage-pool-dropdown-rise 220ms cubic-bezier(0.22, 1, 0.36, 1);");
    expect(stylesCss).toContain(".glitter-write-stage__pool-container {");
    expect(stylesCss).toContain("overflow: hidden;");
    expect(stylesCss).toContain("border-radius: 12px;");
    expect(stylesCss).toContain("-webkit-backdrop-filter: blur(18px) saturate(114%);");
    expect(stylesCss).toContain("backdrop-filter: blur(18px) saturate(114%);");
    expect(stylesCss).toContain("box-shadow: none;");
    expect(stylesCss).toContain(".glitter-write-stage__pool-scroll {");
    expect(stylesCss).toContain("overflow-y: auto;");
    expect(stylesCss).toContain("overscroll-behavior-y: contain;");
    expect(stylesCss).toContain("-webkit-overflow-scrolling: touch;");
    expect(stylesCss).toContain("touch-action: pan-y;");
    expect(stylesCss).toContain("scrollbar-gutter: stable;");
    expect(stylesCss).toContain("scrollbar-width: thin;");
    expect(stylesCss).toContain("max-height: 120px;");
    expect(stylesCss).toContain("scrollbar-color: color-mix(in srgb, var(--glitter-ui-accent) 18%, var(--glitter-ui-text) 32%) transparent;");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll,");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll::-webkit-scrollbar,");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll::-webkit-scrollbar-track,");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll::-webkit-scrollbar-track-piece:vertical:start,");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll::-webkit-scrollbar-track-piece:vertical:end,");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll::-webkit-scrollbar-thumb,");
    expect(stylesCss).toContain(".glitter-write-stage .glitter-write-stage__pool-scroll::-webkit-scrollbar-thumb:horizontal,");
    expect(stylesCss).toContain(".glitter-pool-stage .glitter-pool-stage__card-move-dialog-list::-webkit-scrollbar-thumb:horizontal {\n  min-width: 42px;\n}");
    expect(stylesCss).toContain("min-height: 42px;");
    expect(stylesCss).toContain("radial-gradient(\n      92% 18px at 50% 100%,");
    expect(stylesCss).toContain(".glitter-write-stage__pool-option {");
    expect(stylesCss).toContain("display: flex;");
    expect(stylesCss).toContain(
      ".glitter-write-stage--quick-capture .glitter-write-stage__create-file-toggle:focus-within,\n.glitter-write-stage--quick-capture .glitter-write-stage__create-file-toggle:active"
    );
    expect(stylesCss).toContain(".glitter-write-stage__retry-link {\n  margin-left: 0;\n  border: 1px solid transparent;");
    expect(stylesCss).toContain(
      ".glitter-write-stage--quick-capture .glitter-write-stage__retry-link:focus-visible,\n.glitter-write-stage--quick-capture .glitter-write-stage__retry-link:active"
    );
    expect(stylesCss).toContain("outline: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 72%, transparent);");
    expect(stylesCss).toContain("box-shadow: none;");
    expect(stylesCss).toContain(".glitter-write-stage__clip-hint {\n  margin-top: auto;");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__link-attachment-row", [
      "width: 100%;",
      "max-width: 100%;",
      "box-sizing: border-box;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__link-attachment-primary .glitter-write-stage__icon", [
      "flex-shrink: 0;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__link-attachment-row", [
      "border-color: transparent;",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);",
      "box-shadow: none;"
    ]);
    expect(stylesCss).not.toContain(".glitter-write-stage__link-status-inline {");
    expect(stylesCss).not.toContain(".glitter-write-stage__link-status-text {");
    expect(stylesCss).not.toContain(".glitter-write-stage__retry-link--inline {");
    expect(stylesCss).not.toContain(".glitter-write-stage__retry-link--inline .glitter-write-stage__icon {");
    expect(stylesCss).not.toContain(".glitter-write-stage--quick-capture .glitter-write-stage__media-pane,");
    expect(stylesCss).not.toContain(".glitter-write-stage--quick-capture .glitter-write-stage__media-note-pane,");
    expect(stylesCss).not.toContain(".glitter-write-stage--quick-capture .glitter-write-stage__media-entity-pane,");
    expect(stylesCss).not.toContain(".glitter-write-stage--quick-capture .glitter-write-stage__media-detail-pane,");
    expect(stylesCss).toContain(".glitter-write-stage__media-thumbnail-surface {");
    expect(stylesCss).toContain(".glitter-write-stage__media-editor-shell,");
    expect(stylesCss).toContain(".glitter-write-stage__media-path-shell {");
    expect(stylesCss).toContain(".glitter-write-stage__media-inputs-column {");
    expect(stylesCss).toContain(".glitter-write-stage__clip-hint {\n  border: none;");
    expect(stylesCss).toContain(".glitter-write-stage--quick-capture .glitter-write-stage__clip-hint {\n  border: none;\n  background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__pool-button", [
      "width: 100%;",
      "min-height: 36px;",
      "box-shadow: none;"
    ]);
    expect(stylesCss).toContain(".glitter-write-stage__pool-row {\n  margin-top: 12px;\n  position: relative;\n  width: min(244px, 100%);");
    expect(stylesCss).toContain(".glitter-write-stage__pool-dropdown {\n  position: absolute;");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__pool-option", [
      "position: relative;",
      "display: flex;",
      "min-height: 36px;",
      "border: none !important;",
      "-webkit-appearance: none !important;",
      "appearance: none !important;",
      "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 90%, var(--glitter-ui-text) 10%) !important;",
      "background-image: none !important;",
      "text-shadow: none;",
      "overflow: hidden;",
      "isolation: isolate;",
      "box-shadow: none !important;",
      "filter: none !important;"
    ]);
    expect(stylesCss).toContain(".glitter-write-stage__pool-group {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-container--options {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-container--create {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-group--options {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-group--create {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-group-label {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-option-text {");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__pool-option::before", [
      "inset: -24% -36%;",
      "filter: blur(18px);",
      "transform: translate3d(-36%, 0, 0);"
    ]);
    expect(stylesCss).not.toContain(".glitter-write-stage__pool-option::after {");
    expect(stylesCss).not.toContain("@keyframes glitter-write-stage-pool-ripple {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-option > * {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-option:hover,");
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__pool-option:hover::before,\n.glitter-write-stage__pool-option:focus-visible::before",
      ["opacity: 1;", "transform: translate3d(16%, 0, 0);"]
    );
    expect(stylesCss).toContain(".glitter-write-stage__pool-option--create {");
    expect(stylesCss).toContain("background: color-mix(in srgb, var(--glitter-ui-bg-alt) 88%, var(--glitter-ui-text) 12%) !important;");
    expect(stylesCss).toContain(".glitter-write-stage--quick-capture .glitter-write-stage__pool-dropdown {\n  box-shadow: none;\n  border: none;\n  background: transparent;");
    expect(stylesCss).toContain(".glitter-write-stage--quick-capture .glitter-write-stage__pool-container {\n  border: 1px solid color-mix(in srgb, var(--glitter-ui-border) 42%, transparent);\n  background: color-mix(in srgb, var(--glitter-ui-bg-alt) 78%, transparent);");
    expect(stylesCss).toContain(
      ".glitter-write-stage__close-confirm-secondary,\n.glitter-write-stage__close-confirm-primary {\n  min-height: 38px;\n  border: none;\n  background-image: none;\n  box-shadow: none;"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-secondary {\n  background: var(--glitter-ui-accent);\n  color: var(--glitter-ui-accent-contrast);\n}"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-secondary:hover,\n.glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-secondary:focus-visible,\n.glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-secondary:active {\n  background: var(--glitter-ui-accent-hover);"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-primary {\n  background: color-mix(in srgb, var(--glitter-ui-bg-alt) 88%, var(--glitter-ui-text) 12%);\n  color: var(--glitter-ui-text);\n}"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-primary:hover,\n.glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-primary:focus-visible,\n.glitter-write-stage__close-confirm-actions .glitter-write-stage__close-confirm-primary:active {\n  background: color-mix(in srgb, var(--glitter-ui-bg-alt) 80%, var(--glitter-ui-text) 20%);"
    );
    expect(stylesCss).toContain(".glitter-quick-capture-modal-host .modal-bg,");
    expect(stylesCss).toContain(".glitter-pool-modal-host .modal-bg,");
    expect(stylesCss).toContain(".GlitterIdea-edit-modal-host .modal-bg,");
    expect(stylesCss).toContain(".modal-container.glitter-quick-capture-modal-host,");
    expect(stylesCss).toContain(".modal-container.glitter-pool-modal-host");
    expect(stylesCss).toContain(".modal-container.GlitterIdea-edit-modal-host");
    expect(stylesCss).toContain(".modal.glitter-quick-capture-modal");
    expect(stylesCss).toContain(".modal.glitter-pool-modal");
    expect(stylesCss).toContain(".modal.GlitterIdea-edit-modal");
    expect(stylesCss).toContain(".modal-content.glitter-quick-capture-modal__content,");
    expect(stylesCss).toContain(".modal-content.glitter-pool-modal__content,");
    expect(stylesCss).toContain(".modal-content.GlitterIdea-edit-modal__content,");
    expect(stylesCss).toContain(".modal-content.GlitterIdea-picker-modal__content,");
    expect(stylesCss).toContain(".modal-content.glitter-snippet-locations-modal__content,");
    expect(stylesCss).toContain(".modal-content.glitter-pool-roam-history-modal__content,");
    expect(stylesCss).toContain(".modal-content.glitter-pool-roam-board-modal__content {");
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".modal-content.glitter-quick-capture-modal__content,\n.modal-content.glitter-pool-modal__content,\n.modal-content.GlitterIdea-edit-modal__content,\n.modal-content.GlitterIdea-picker-modal__content,\n.modal-content.glitter-snippet-locations-modal__content,\n.modal-content.glitter-pool-roam-history-modal__content,\n.modal-content.glitter-pool-roam-board-modal__content",
      ["width: 100%;", "max-width: 100%;", "min-width: 100%;", "height: 100%;"]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal:not(.glitter-quick-capture-modal--first-use) .glitter-quick-capture-modal__content,\n.glitter-pool-modal.glitter-pool-modal--create .glitter-pool-modal__content,\n.GlitterIdea-edit-modal .GlitterIdea-edit-modal__content",
      ["height: auto;"]
    );
    expect(stylesCss).toContain(".modal.glitter-quick-capture-modal > .modal-header,");
    expect(stylesCss).toContain(".modal.glitter-pool-modal > .modal-header,");
    expect(stylesCss).toContain(".modal.GlitterIdea-edit-modal > .modal-header,");
    expect(stylesCss).toContain(".modal.GlitterIdea-picker-modal > .modal-header,");
    expect(stylesCss).toContain(".modal.glitter-snippet-locations-modal > .modal-header,");
    expect(stylesCss).toContain(".modal.glitter-pool-roam-history-modal > .modal-header,");
    expect(stylesCss).toContain(".modal.glitter-pool-roam-board-modal > .modal-header {");
    expect(stylesCss).not.toContain(".glitter-quick-capture-modal .modal,");
    expect(stylesCss).not.toContain(".glitter-pool-modal .modal,");
    expect(stylesCss).not.toContain(".glitter-quick-capture-modal .modal-bg,");
    expect(stylesCss).not.toContain(".glitter-pool-modal .modal-bg,");
    expect(stylesCss).not.toContain(".glitter-quick-capture-modal .modal-container,");
    expect(stylesCss).not.toContain(".glitter-pool-modal .modal-container,");
    expect(stylesCss).not.toContain(".glitter-quick-capture-modal .modal-content,");
    expect(stylesCss).not.toContain(".glitter-pool-modal .modal-content,");
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal-host .modal-bg,\n.glitter-pool-modal-host .modal-bg,\n.GlitterIdea-edit-modal-host .modal-bg,\n.GlitterIdea-picker-modal-host .modal-bg,\n.glitter-snippet-locations-modal-host .modal-bg,\n.glitter-pool-roam-history-modal-host .modal-bg,\n.glitter-pool-roam-board-modal-host .modal-bg",
      [
        "background:",
        "radial-gradient(",
        "linear-gradient(",
        "-webkit-backdrop-filter: blur(68px) saturate(118%);",
        "backdrop-filter: blur(68px) saturate(118%);"
      ]
    );
    expect(stylesCss).toContain(
      ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host {"
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
      [
        "display: flex;",
        "align-items: center;",
        "justify-content: center;",
        "width: 100%;",
        "height: 100%;",
        "min-height: 100%;",
        "padding: 0;",
        "box-sizing: border-box;",
        "border: 0;",
        "background: transparent;",
        "box-shadow: none;"
      ]
    );
    expect(
      Number.parseInt(
        getDeclarationValueInSelectorBlock(
          stylesCss,
          ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
          "z-index"
        ),
        10
      )
    ).toBeGreaterThan(
      Number.parseInt(
        getDeclarationValueInSelectorBlock(stylesCss, ".glitter-pool-stage__toolbar-menu--results-overlay", "z-index"),
        10
      )
    );
    expect(
      Number.parseInt(
        getDeclarationValueInSelectorBlock(
          stylesCss,
          ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
          "z-index"
        ),
        10
      )
    ).toBeGreaterThan(
      Number.parseInt(getDeclarationValueInSelectorBlock(stylesCss, ".glitter-pool-stage__pool-switcher", "z-index"), 10)
    );
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
      "position: relative;"
    );
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
      "isolation: isolate;"
    );
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
      "padding: clamp(18px, 5vh, 44px) clamp(18px, 5vw, 44px);"
    );
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal-host,\n.glitter-pool-modal-host,\n.GlitterIdea-edit-modal-host,\n.GlitterIdea-picker-modal-host,\n.glitter-snippet-locations-modal-host,\n.glitter-pool-roam-history-modal-host,\n.glitter-pool-roam-board-modal-host",
      "backdrop-filter: blur(6px);"
    );
    expect(stylesCss).toContain(
      ".glitter-quick-capture-modal,\n.glitter-pool-modal,\n.GlitterIdea-edit-modal,\n.GlitterIdea-picker-modal,\n.glitter-snippet-locations-modal,\n.glitter-pool-roam-history-modal,\n.glitter-pool-roam-board-modal {\n  padding: 0;\n  border: 1px solid color-mix(in srgb, var(--glitter-ui-border) 58%, transparent);\n  border-radius: 16px;\n  background: var(--glitter-ui-bg);\n  box-shadow: none;\n}"
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-quick-capture-modal:not(.glitter-quick-capture-modal--first-use),\n.glitter-pool-modal.glitter-pool-modal--create,\n.GlitterIdea-edit-modal",
      [
        "background: color-mix(in srgb, var(--glitter-ui-bg) 72%, transparent);",
        "overflow: hidden;",
        "position: relative;",
        "isolation: isolate;",
        "-webkit-backdrop-filter: blur(28px) saturate(148%);",
        "backdrop-filter: blur(28px) saturate(148%);"
      ]
    );
    expect(stylesCss).not.toContain("padding: 18px 14px;");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-quick-capture-modal", [
      "width: min(664px, calc(100% - 28px));",
      "max-width: min(664px, calc(100% - 28px));",
      "min-width: min(664px, calc(100% - 28px));",
      "height: auto;",
      "max-height: calc(100% - 28px);"
    ]);
    expect(stylesCss).toContain(
      ".glitter-snippet-locations-modal {\n  width: min(576px, calc(100% - 28px));\n  max-width: min(576px, calc(100% - 28px));\n  min-width: min(576px, calc(100% - 28px));\n  height: auto;\n  max-height: calc(100% - 28px);\n}"
    );
    expect(stylesCss).not.toContain(
      ".glitter-quick-capture-modal,\n.glitter-snippet-locations-modal {\n  width: min(576px, calc(100% - 28px));"
    );
    expect(stylesCss).toContain(
      "  .glitter-quick-capture-modal {\n    width: min(664px, calc(100% - 20px));\n    max-width: min(664px, calc(100% - 20px));\n    min-width: min(664px, calc(100% - 20px));\n    max-height: calc(100% - 20px);\n  }"
    );
    expect(stylesCss).toContain(
      "  .GlitterIdea-edit-modal,\n  .glitter-snippet-locations-modal {\n    width: min(576px, calc(100% - 20px));\n    max-width: min(576px, calc(100% - 20px));\n    min-width: min(576px, calc(100% - 20px));\n    max-height: calc(100% - 20px);\n  }"
    );
    expect(stylesCss).toContain(
      "  .glitter-write-stage--quick-capture .glitter-write-stage__modal-card {\n    padding: 20px 18px 18px;\n  }"
    );
    expect(stylesCss).toContain(
      "  .glitter-write-stage--quick-capture .glitter-write-stage__body-panel {\n    padding: 18px 16px 16px;\n  }"
    );
    expect(stylesCss).toContain(
      "  .glitter-write-stage--quick-capture .glitter-write-stage__media-layout {\n    grid-template-columns: minmax(148px, 36%) minmax(0, 1fr);\n    gap: 10px;\n  }"
    );
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture", [
      "display: grid;",
      "place-items: center;",
      "padding: 0;",
      "box-sizing: border-box;",
      "width: 100%;",
      "margin: 0;",
      "min-height: min(620px, calc(100vh - 28px));",
      "border: none;",
      "border-radius: 0;",
      "background: transparent;",
      "box-shadow: none;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__modal-card", [
      "width: 100%;",
      "min-height: 0;",
      "height: auto;",
      "max-height: 100%;",
      "border: none;",
      "border-radius: 0;",
      "background: transparent;",
      "box-shadow: none;",
      "padding: 22px 22px 20px;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__modal-card", [
      "min-height: 100%;",
      "padding: 24px 24px 22px;"
    ]);
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__modal-card",
      "width: min(576px, calc(100% - 28px));"
    );
    expect(stylesCss).toContain(".glitter-pool-stage {");
    expect(stylesCss).toContain(".glitter-write-stage__close-button {");
    expect(stylesCss).toContain(".glitter-write-stage__clip-hint {");
    expect(stylesCss).toContain(".glitter-write-stage__media-layout {");
    expect(stylesCss).toContain("grid-template-columns: minmax(148px, 36%) minmax(0, 1fr);");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__media-layout", [
      "grid-template-columns: minmax(176px, 38%) minmax(0, 1fr);",
      "gap: 14px;"
    ]);
    expect(stylesCss).toContain(".glitter-write-stage__media-inputs-column {");
    expect(stylesCss).toContain(".glitter-write-stage__media-path-row {");
    expect(stylesCss).toContain(".glitter-write-stage__media-path-primary {");
    expect(stylesCss).toContain(".glitter-write-stage__pool-button {");
    expect(stylesCss).not.toContain(".glitter-write-stage__keyboard-button {");
    expect(stylesCss).not.toContain(".glitter-write-stage__icon--keyboard {");
    expect(stylesCss).toContain(".glitter-write-stage__quick-actions {");
    expect(stylesCss).toContain("width: fit-content;");
    expect(stylesCss).toContain(".glitter-write-stage__create-file-toggle {");
    expect(stylesCss).toContain("width: auto;");
    expect(stylesCss).toContain("min-width: 0;");
    expect(stylesCss).toContain("max-width: 100%;");
    expect(stylesCss).toContain("flex: 0 0 auto;");
    expect(stylesCss).toContain("justify-content: flex-start;");
    expect(stylesCss).toContain("align-self: center;");
    expect(stylesCss).toContain("display: inline-flex !important;");
    expect(stylesCss).toContain("gap: 6px;");
    expect(stylesCss).toContain("padding: 0;");
    expect(stylesCss).toContain("border: none;");
    expect(stylesCss).toContain("background: transparent;");
    expect(stylesCss).toContain("box-shadow: none;");
    expect(stylesCss).toContain("white-space: nowrap;");
    expect(stylesCss).toContain(".glitter-write-stage--quick-capture .glitter-write-stage__create-file-toggle {");
    expect(stylesCss).toContain(".glitter-write-stage[data-glitter-theme=\"obsidian-light\"] .glitter-write-stage__auto-title,");
    expect(stylesCss).not.toContain(
      ".glitter-write-stage[data-glitter-theme=\"obsidian-light\"] .glitter-write-stage__create-file-toggle,"
    );
    expect(stylesCss).toContain("border: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 28%, transparent);");
    expect(stylesCss).toContain(".glitter-write-stage__icon--save {");
    expect(stylesCss).toContain("color: currentColor;");
    expect(stylesCss).toContain(".glitter-write-stage__retry-link {");
    expect(stylesCss).toContain(".glitter-write-stage__action-primary--primary {");
    expect(stylesCss).toContain("border-color: color-mix(in srgb, var(--glitter-ui-border) 76%, transparent);");
    expect(stylesCss).toContain("background: var(--glitter-ui-accent);");
    expect(stylesCss).toContain("color: var(--glitter-ui-accent-contrast);");
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage--quick-capture .glitter-write-stage__action-primary--capture-submit[data-dirty=\"false\"]",
      [
        "border: 1px solid color-mix(in srgb, var(--glitter-ui-border) 76%, transparent);",
        "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 82%, transparent);",
        "color: var(--glitter-ui-text);",
        "box-shadow: none;"
      ]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage--quick-capture .glitter-write-stage__action-primary--capture-submit[data-dirty=\"true\"]",
      [
        "border: none;",
        "background: var(--glitter-ui-accent);",
        "background-image: none;",
        "color: var(--glitter-ui-accent-contrast);",
        "box-shadow: none;"
      ]
    );
    expect(stylesCss).not.toContain("body.glitter-quick-capture-modal-open .modal-close-button");
  });
  it("renders first-use quick capture modal shell and Chinese copy", () => {
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    const stage = container.querySelector(".glitter-write-stage") as
      | (HTMLElement & { className: string })
      | null;
    const titleInput = container.querySelector(".glitter-write-stage__auto-title-text") as
      | (HTMLElement & { value: string; placeholder: string })
      | null;
    const bodyInput = container.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { value: string; placeholder: string; autofocus: boolean })
      | null;
    const poolButton = container.querySelector(".glitter-write-stage__pool-button") as
      | (HTMLElement & { disabled?: boolean; getAttribute: (name: string) => string | null })
      | null;

    expect(stage).not.toBeNull();
    expect(stage?.className).toContain("glitter-plugin-root");
    expect(stage?.className).toContain("glitter-write-stage--quick-capture");
    expect(container.querySelector(".glitter-write-stage__scrim")).toBeNull();
    expect(container.querySelectorAll(".glitter-write-stage__modal-card")).toHaveLength(1);
    expect(container.querySelector(".glitter-write-stage__title")?.textContent).toContain("记录第一条灵感");
    expect(stylesCss).toContain(".glitter-write-stage__title {");
    expect(stylesCss).toContain("color: var(--glitter-ui-text);");
    expect(stylesCss).not.toContain("color: #e1e7f7;");
    expect(titleInput?.value).toBe("我的第一条灵感");
    expect(titleInput?.placeholder).toBe("我的第一条灵感");
    expect(stylesCss).toContain(".glitter-write-stage__auto-title {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--image {");
    expect(stylesCss).toContain(".glitter-write-stage--quick-capture .glitter-write-stage__auto-title {");
    expect(stylesCss).toContain("border: none;");
    expect(stylesCss).toContain(".glitter-write-stage__auto-title-text {");
    expect(stylesCss).toContain("border: none !important;");
    expect(stylesCss).toContain("box-shadow: none !important;");
    expect(bodyInput?.value).toBe("");
    expect(container.querySelector(".glitter-write-stage__body-sub")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__default-rule")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__submit-tooltip")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__clip-hint-text")?.textContent).toContain(
      "粘贴附件/链接后自动识别"
    );
    expect(container.querySelector(".glitter-write-stage__pool-button-text")?.textContent).toContain("池：默认池");
    expect(poolButton?.disabled).toBe(true);
    expect(poolButton?.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector(".glitter-write-stage__close-button")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__shortcut-hint")?.textContent).toContain(
      "Cmd/Ctrl+Enter"
    );

    const footer = container.querySelector(".glitter-write-stage__footer--quick-capture") as
      | (HTMLElement & { className: string })
      | null;
    const quickActions = container.querySelector(".glitter-write-stage__quick-actions") as
      | (HTMLElement & { className: string; children: Array<{ className: string; textContent: string }> })
      | null;
    const shortcutHint = container.querySelector(".glitter-write-stage__shortcut-hint") as
      | (HTMLElement & { parent: { className: string } | null })
      | null;
    const createFileToggle = container.querySelector(".glitter-write-stage__create-file-toggle") as
      | (HTMLElement & {
          children: Array<{ className: string; textContent: string; children?: Array<{ className: string; textContent: string }> }>;
          getAttribute: (name: string) => string | null;
        })
      | null;
    const createFileCheckbox = container.querySelector(".glitter-write-stage__create-file-checkbox") as
      | (HTMLElement & { checked: boolean })
      | null;
    const primaryButton = container.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & {
          className: string;
          children: Array<{ className: string; textContent: string }>;
          getAttribute: (name: string) => string | null;
        })
      | null;

    expect(footer).not.toBeNull();
    expect(footer?.children[0]?.className).toContain("glitter-write-stage__shortcut-hint");
    expect(footer?.children[1]?.className).toContain("glitter-write-stage__quick-actions");

    expect(quickActions).not.toBeNull();
    expect(quickActions?.children).toHaveLength(2);
    expect(quickActions?.children[0]?.className).toContain("glitter-write-stage__create-file-toggle");
    expect(quickActions?.children[1]?.className).toContain("glitter-write-stage__action-primary");

    expect(shortcutHint).not.toBeNull();
    expect(shortcutHint?.parent?.className).toContain("glitter-write-stage__footer--quick-capture");
    expect(createFileToggle?.textContent).toContain("保存灵感并创建文件");
    expect(createFileToggle?.getAttribute("aria-label")).toBe("保存灵感并创建文件");
    expect(createFileCheckbox?.checked).toBe(false);
    expect(primaryButton?.textContent).toContain("保存并下一步");
    expect(primaryButton?.className).toContain("glitter-write-stage__action-primary--capture-submit");
    expect(primaryButton?.getAttribute("data-dirty")).toBe("false");

    expect(createFileToggle?.children[1]?.className).toContain("glitter-write-stage__create-file-indicator");
    expect(createFileToggle?.children[1]?.children?.[0]?.className).toContain("glitter-write-stage__icon--check");
    expect(primaryButton?.children[0]?.className).toContain("glitter-write-stage__icon--save");

    expect(bodyInput?.placeholder).toBe("记录灵感，后续可继续补充...");
    expect(bodyInput?.autofocus).toBe(false);
    expect(stylesCss).toContain("background: color-mix(in srgb, var(--glitter-ui-bg-alt) 94%, black 6%);");
    expect(stylesCss).toContain(".glitter-write-stage__submit-tooltip {");
    expect(stylesCss).toContain("visibility 0s linear 0.6s;");
    expect(stylesCss).toContain(".glitter-write-stage__action-primary--capture-submit:hover .glitter-write-stage__submit-tooltip,");
  });

  it("renders English labels for quick-capture renderer-only controls", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        interfaceLanguage: "en",
        inputText: "Caption",
        attachedMediaCount: 2,
        attachedMediaPreviewUrl: "app://image.png",
        attachedMediaPreviewKind: "image",
        mediaOverlayMode: "image-gallery",
        selectedMediaIndex: 0,
        canSelectPreviousMedia: false,
        canSelectNextMedia: true,
        canAddMoreImages: true,
        mediaPreviewVisible: true,
        hasCaptureFieldEdits: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const closeButton = container.querySelector(".glitter-write-stage__close-button") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const previewTrigger = container.querySelector(".glitter-write-stage__media-thumbnail-preview-trigger") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const previousButton = container.querySelector(".glitter-write-stage__media-surface-nav-button--previous") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const nextButton = container.querySelector(".glitter-write-stage__media-surface-nav-button--next") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const addButton = container.querySelector(".glitter-write-stage__media-surface-action--add") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const replaceButton = container.querySelector(".glitter-write-stage__media-surface-action--replace") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const removeButton = container.querySelector(".glitter-write-stage__media-surface-action--remove") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const previewCloseButton = container.querySelector(".glitter-write-stage__media-preview-close") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const previewImage = container.querySelector(".glitter-write-stage__media-preview-image") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const submitTooltip = container.querySelector(".glitter-write-stage__submit-tooltip");

    expect(closeButton).toBeNull();
    expect(previewTrigger?.getAttribute("aria-label")).toBe("View large preview");
    expect(previousButton?.getAttribute("aria-label")).toBe("Previous image");
    expect(nextButton?.getAttribute("aria-label")).toBe("Next image");
    expect(addButton?.getAttribute("aria-label")).toBe("Add image");
    expect(replaceButton?.getAttribute("aria-label")).toBe("Replace current image");
    expect(removeButton?.getAttribute("aria-label")).toBe("Remove current image");
    expect(previewCloseButton?.getAttribute("aria-label")).toBe("Close large preview");
    expect(previewImage?.getAttribute("alt")).toBe("Media large preview");
    expect(submitTooltip?.textContent).toBe("Saved as an idea by default (no .md file created)");
  });

  it("keeps quick-capture submit button ghosted until the user changes title or body content", () => {
    const defaultContainer = createContainer();
    renderWriteView(defaultContainer, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    const defaultPrimaryButton = defaultContainer.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    expect(defaultPrimaryButton?.getAttribute("data-dirty")).toBe("false");

    const bodyChangedContainer = createContainer();
    renderWriteView(
      bodyChangedContainer,
      buildWriteViewState({
        flowContext: "first-use",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        inputText: "补上一句灵感"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const bodyChangedPrimaryButton = bodyChangedContainer.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    expect(bodyChangedPrimaryButton?.getAttribute("data-dirty")).toBe("true");

    const titleChangedContainer = createContainer();
    renderWriteView(
      titleChangedContainer,
      buildWriteViewState({
        flowContext: "first-use",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        hasManualTitle: true,
        titleText: "我的第一条灵感标题"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const titleChangedPrimaryButton = titleChangedContainer.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    expect(titleChangedPrimaryButton?.getAttribute("data-dirty")).toBe("true");
  });

  it("marks the quick-capture submit button dirty for media-only edits", () => {
    const mediaChangedContainer = createContainer();
    renderWriteView(
      mediaChangedContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaCount: 1,
        hasCaptureFieldEdits: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const mediaChangedPrimaryButton = mediaChangedContainer.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    expect(mediaChangedPrimaryButton?.getAttribute("data-dirty")).toBe("true");
  });

  it("renders quick-capture body as a single blended textarea surface", () => {
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    const bodyInput = container.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { className: string })
      | null;

    expect(bodyInput).not.toBeNull();
    expect(bodyInput?.className).toContain("glitter-write-stage__textarea");
    expect(bodyInput?.className).toContain("glitter-write-stage__textarea--panel-blend");
    expect(bodyInput?.className).not.toContain("glitter-write-stage__textarea--body");
    expect(stylesCss).toContain(".glitter-write-stage__body-editor {");
    expect(stylesCss).toContain("display: block;");
    expect(stylesCss).toContain("width: 100%;");
    expect(stylesCss).toContain("border: none !important;");
    expect(stylesCss).toContain("background: transparent !important;");
    expect(stylesCss).toContain("box-shadow: none !important;");
    expect(stylesCss).toContain("font: inherit;");
    expect(stylesCss).toContain("line-height: inherit;");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__body-editor::placeholder", [
      "color: color-mix(in srgb, var(--glitter-ui-text-faint) 88%, transparent);",
      "opacity: 1;",
      "white-space: pre-wrap;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage--quick-capture .glitter-write-stage__body-editor", [
      "line-height: 1.5;"
    ]);
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__body-editor::placeholder",
      "color: var(--glitter-ui-text-muted);"
    );
    expect(stylesCss).not.toContain(".glitter-write-stage__body-input-shell--focused");
    expect(stylesCss).not.toContain(".glitter-write-stage__body-input-shell--editing");
  });

  it("renders an inline ai polish trigger with icon styling and updates visibility during composition", () => {
    const startCalls: string[] = [];
    const bodyCalls: Array<{ value: string; isComposing?: boolean }> = [];
    const emptyContainer = createContainer();
    const emptyState = buildWriteViewState({
      flowContext: "global",
      phase: "capture",
      contentKind: "text",
      importState: "idle",
      inputText: ""
    });

    emptyState.quickCapture!.aiPolish = {
      visible: true,
      state: "idle",
      sourceValue: "",
      polishedValue: undefined,
      resultMatchesCurrentSource: true,
      errorMessage: undefined
    };

    renderWriteView(emptyContainer, emptyState, {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {},
      onAiPolishStart() {
        startCalls.push("start");
      },
      onBodyInputChange(value, options) {
        bodyCalls.push({ value, isComposing: options?.isComposing });
      }
    });

    const hiddenTriggerRow = emptyContainer.querySelector(".glitter-write-stage__ai-polish-row") as
      | (HTMLElement & { className: string })
      | null;
    const hiddenTrigger = emptyContainer.querySelector(".glitter-write-stage__ai-polish-trigger") as
      | (HTMLElement & { click: () => void; textContent: string; disabled?: boolean })
      | null;
    const hiddenTriggerLabel = emptyContainer.querySelector(".glitter-write-stage__ai-polish-trigger-label") as
      | (HTMLElement & { textContent: string })
      | null;
    const hiddenTriggerIcon = emptyContainer.querySelector(".glitter-write-stage__icon--sparkles");
    const emptyBodyInput = emptyContainer.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { value: string; dispatchEvent: (event: { type: string; isComposing?: boolean }) => void })
      | null;

    expect(hiddenTriggerRow).not.toBeNull();
    expect(hiddenTriggerRow?.className).toContain("glitter-write-stage__ai-polish-row--hidden");
    expect(hiddenTrigger).not.toBeNull();
    expect(hiddenTrigger?.textContent).toBe("AI 润色");
    expect(hiddenTriggerLabel?.textContent).toBe("AI 润色");
    expect(hiddenTriggerIcon).not.toBeNull();
    expect(hiddenTrigger?.disabled).toBe(false);

    emptyBodyInput!.value = "ni";
    emptyBodyInput!.dispatchEvent({ type: "input", isComposing: true });

    expect(hiddenTriggerRow?.className).not.toContain("glitter-write-stage__ai-polish-row--hidden");
    expect(bodyCalls).toEqual([{ value: "ni", isComposing: true }]);
    hiddenTrigger?.click();
    expect(startCalls).toEqual(["start"]);
    expect(emptyContainer.querySelector(".glitter-write-stage__ai-polish-review")).toBeNull();

    const loadingContainer = createContainer();
    renderWriteView(
      loadingContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        inputText: "待润色原文",
        aiPolishState: "loading"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onAiPolishStart() {
          startCalls.push("loading-start");
        }
      }
    );

    const loadingTrigger = loadingContainer.querySelector(".glitter-write-stage__ai-polish-trigger") as
      | (HTMLElement & { textContent: string; disabled?: boolean })
      | null;

    expect(loadingTrigger?.textContent).toBe("AI 润色中…");
    expect(loadingTrigger?.disabled).toBe(true);

    const linkContainer = createContainer();
    const linkState = buildWriteViewState({
      flowContext: "global",
      phase: "capture",
      contentKind: "link",
      importState: "idle",
      inputText: "待润色原文",
      sourceUrl: "https://example.com/post"
    });

    linkState.quickCapture!.aiPolish = {
      visible: true,
      state: "idle",
      sourceValue: linkState.fields.body.value ?? "",
      polishedValue: undefined,
      resultMatchesCurrentSource: true,
      errorMessage: undefined
    };

    renderWriteView(linkContainer, linkState, {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    const linkBodyPanel = linkContainer.querySelector(".glitter-write-stage__body-panel") as
      | (HTMLElement & { children: Array<{ className: string }> })
      | null;
    const linkChildClassNames = linkBodyPanel?.children.map((child) => child.className) ?? [];
    const triggerRowIndex = linkChildClassNames.findIndex((className) => className.includes("glitter-write-stage__ai-polish-row"));
    const linkAttachmentRowIndex = linkChildClassNames.findIndex((className) =>
      className.includes("glitter-write-stage__link-attachment-row")
    );

    expect(triggerRowIndex).toBeGreaterThan(-1);
    expect(linkAttachmentRowIndex).toBeGreaterThan(triggerRowIndex);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__ai-polish-row", [
      "display: flex;",
      "justify-content: flex-end;",
      "width: 100%;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__ai-polish-row--hidden", ["display: none;"]);
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__body-panel button.glitter-write-stage__ai-polish-trigger,\n.glitter-write-stage__body-panel button.glitter-write-stage__ai-polish-trigger:hover,\n.glitter-write-stage__body-panel button.glitter-write-stage__ai-polish-trigger:active,\n.glitter-write-stage__body-panel button.glitter-write-stage__ai-polish-trigger:focus,\n.glitter-write-stage__body-panel button.glitter-write-stage__ai-polish-trigger:focus-visible",
      [
        "all: unset;",
        "display: inline-flex !important;",
        "padding: 0 !important;",
        "border: none !important;",
        "background: transparent !important;",
        "box-shadow: none !important;",
        "appearance: none !important;",
        "-webkit-appearance: none !important;",
        "color: color-mix(in srgb, var(--glitter-ui-accent) 76%, white 24%) !important;"
      ]
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__body-panel button.glitter-write-stage__ai-polish-trigger:focus-visible {\n  outline: 2px solid color-mix(in srgb, var(--glitter-ui-accent) 38%, transparent);\n  outline-offset: 4px;"
    );
    expect(stylesCss).toContain(".glitter-write-stage__icon--sparkles {");
  });

  it("keeps first-use pool locked and never mounts ai polish controls", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "first-use",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        inputText: "正文",
        aiPolishVisible: true,
        aiPolishState: "reviewing",
        aiPolishSourceValue: "正文",
        aiPolishPolishedValue: "润色结果"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const poolButton = container.querySelector(".glitter-write-stage__pool-button") as
      | (HTMLElement & { disabled?: boolean; getAttribute: (name: string) => string | null })
      | null;
    const bodyInput = container.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { placeholder: string })
      | null;

    expect(container.querySelector(".glitter-write-stage__title")?.textContent).toContain("记录第一条灵感");
    expect(bodyInput?.placeholder).toBe("记录灵感，后续可继续补充...");
    expect(container.querySelector(".glitter-write-stage__ai-polish-row")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__ai-polish-review")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__clip-hint")).not.toBeNull();
    expect(poolButton?.disabled).toBe(true);
    expect(poolButton?.getAttribute("aria-disabled")).toBe("true");
  });

  it("allows adopting ai polish review output only when the source still matches", () => {
    const acceptCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        inputText: "待润色原文",
        aiPolishState: "reviewing",
        aiPolishSourceValue: "待润色原文",
        aiPolishPolishedValue: "润色后的灵感"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onAiPolishAccept() {
          acceptCalls.push("accept");
        }
      }
    );

    const adoptButton = container.querySelector(".glitter-write-stage__ai-polish-adopt") as
      | (HTMLElement & { click: () => void; disabled?: boolean })
      | null;

    expect(container.querySelector(".glitter-write-stage__ai-polish-stale-warning")).toBeNull();
    expect(adoptButton?.disabled).toBe(false);
    adoptButton?.click();
    expect(acceptCalls).toEqual(["accept"]);
  });

  it("renders stale ai polish review with warning, disabled adopt, and redo/back callbacks", () => {
    const redoCalls: string[] = [];
    const backCalls: string[] = [];
    const acceptCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        inputText: "已改过的原文",
        aiPolishState: "reviewing",
        aiPolishSourceValue: "待润色原文",
        aiPolishPolishedValue: "基于旧原文的润色"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onAiPolishAccept() {
          acceptCalls.push("accept");
        },
        onAiPolishRedo() {
          redoCalls.push("redo");
        },
        onAiPolishBackToEditing() {
          backCalls.push("back");
        }
      }
    );

    const staleWarning = container.querySelector(".glitter-write-stage__ai-polish-stale-warning") as
      | HTMLElement
      | null;
    const adoptButton = container.querySelector(".glitter-write-stage__ai-polish-adopt") as
      | (HTMLElement & { click: () => void; disabled?: boolean })
      | null;
    const redoButton = container.querySelector(".glitter-write-stage__ai-polish-redo") as
      | (HTMLElement & { click: () => void })
      | null;
    const backButton = container.querySelector(".glitter-write-stage__ai-polish-back") as
      | (HTMLElement & { click: () => void; getAttribute: (name: string) => string | null })
      | null;

    expect(staleWarning?.textContent).toBe("原文已更新，请重做后再采纳当前结果。");
    expect(adoptButton?.disabled).toBe(true);
    expect(backButton?.getAttribute("aria-label")).toBe("取消");
    adoptButton?.click();
    redoButton?.click();
    backButton?.click();

    expect(acceptCalls).toEqual([]);
    expect(redoCalls).toEqual(["redo"]);
    expect(backCalls).toEqual(["back"]);
  });

  it("renders ai polish error state without stale-result copy and keeps adopt disabled", () => {
    const redoCalls: string[] = [];
    const backCalls: string[] = [];
    const acceptCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        inputText: "正在修改的原文",
        aiPolishState: "error",
        aiPolishSourceValue: "正在修改的原文",
        aiPolishErrorMessage: "AI 请求失败，请检查网络后重试。"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onAiPolishAccept() {
          acceptCalls.push("accept");
        },
        onAiPolishRedo() {
          redoCalls.push("redo");
        },
        onAiPolishBackToEditing() {
          backCalls.push("back");
        }
      }
    );

    const errorPanel = container.querySelector(".glitter-write-stage__ai-polish-result--error") as HTMLElement | null;
    const adoptButton = container.querySelector(".glitter-write-stage__ai-polish-adopt") as
      | (HTMLElement & { click: () => void; disabled?: boolean })
      | null;
    const redoButton = container.querySelector(".glitter-write-stage__ai-polish-redo") as
      | (HTMLElement & { click: () => void })
      | null;
    const backButton = container.querySelector(".glitter-write-stage__ai-polish-back") as
      | (HTMLElement & { click: () => void; getAttribute: (name: string) => string | null })
      | null;

    expect(errorPanel?.textContent).toContain("AI 请求失败，请检查网络后重试。");
    expect(container.querySelector(".glitter-write-stage__ai-polish-stale-warning")).toBeNull();
    expect(adoptButton?.disabled).toBe(true);
    expect(backButton?.getAttribute("aria-label")).toBe("取消");
    adoptButton?.click();
    redoButton?.click();
    backButton?.click();

    expect(acceptCalls).toEqual([]);
    expect(redoCalls).toEqual(["redo"]);
    expect(backCalls).toEqual(["back"]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__ai-polish-result-scroll", [
      "overflow-y: auto;",
      "overscroll-behavior: contain;"
    ]);
  });

  it("renders capture variants for link and media in the same modal shell", () => {
    const linkContainer = createContainer();
    renderWriteView(
      linkContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "idle",
        generatedTitle: "外部文章摘录",
        titleText: "导入标题",
        inputText: "导入摘要",
        importedExcerpt: "导入摘要",
        sourceUrl: "https://example.com/article"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const linkBodyPanel = linkContainer.querySelector(".glitter-write-stage__body-panel") as
      | (HTMLElement & { className: string; children: Array<{ className: string }> })
      | null;
    expect(linkContainer.querySelector(".glitter-write-stage__scrim")).toBeNull();
    expect(linkContainer.querySelectorAll(".glitter-write-stage__modal-card")).toHaveLength(1);
    expect(linkBodyPanel?.className).toContain("glitter-write-stage__body-panel--link");
    const linkInlineStatus = linkContainer.querySelector(".glitter-write-stage__link-status-inline") as
      | (HTMLElement & { textContent: string })
      | null;
    const linkAutoTitleIcon = linkContainer.querySelector(".glitter-write-stage__icon--link") as HTMLElement | null;
    const linkAttachment = linkContainer.querySelector(".glitter-write-stage__link-attachment-row") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const linkAttachmentPrimary = linkContainer.querySelector(".glitter-write-stage__link-attachment-primary") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    expect(linkAttachment).not.toBeNull();
    expect(linkAutoTitleIcon).not.toBeNull();
    expect(linkContainer.querySelector(".glitter-write-stage__icon--clock")).toBeNull();
    expect(linkBodyPanel?.children[0]?.className).toContain("glitter-write-stage__body-editor");
    expect(linkBodyPanel?.children[linkBodyPanel.children.length - 1]?.className).toContain(
      "glitter-write-stage__link-attachment-row"
    );
    expect(linkAttachmentPrimary?.getAttribute("href")).toBe("https://example.com/article");
    expect(linkContainer.querySelector(".glitter-write-stage__link-attachment-text")?.textContent).toBe(
      "https://example.com/article"
    );
    expect(linkContainer.querySelector(".glitter-write-stage__link-attachment-result")).toBeNull();
    expect(linkInlineStatus).toBeNull();
    expect(linkContainer.querySelector(".glitter-write-stage__clip-hint")).toBeNull();
    expect(linkAttachment?.textContent).toContain("https://example.com/article");
    expect(linkAttachment?.textContent).not.toContain("导入摘要");
    const linkBodyInput = linkContainer.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { value?: string; placeholder?: string; className?: string })
      | null;
    expect(linkBodyInput?.value ?? "").toBe("导入摘要");
    expect(linkBodyInput?.placeholder).toBe("可选：补充备注或行动项...");
    expect(linkBodyInput?.className ?? "").not.toContain("glitter-write-stage__body-editor--link-imported");
    const linkTitleInput = linkContainer.querySelector(".glitter-write-stage__auto-title-text") as
      | (HTMLElement & { value: string })
      | null;
    const linkPrimaryButton = linkContainer.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & { textContent: string; className: string })
      | null;
    expect(linkTitleInput?.value).toBe("导入标题");
    expect(linkPrimaryButton?.textContent).toContain("完成记录");
    expect(linkPrimaryButton?.className).toContain("glitter-write-stage__action-primary--capture-submit");

    const linkPreviewSubs = Array.from(linkContainer.querySelectorAll(".glitter-write-stage__content-preview-sub"));
    expect(linkPreviewSubs).toHaveLength(0);
    expect(linkContainer.querySelectorAll(".glitter-write-stage__default-rule")).toHaveLength(0);
    const linkTooltip = linkContainer.querySelector(".glitter-write-stage__submit-tooltip") as
      | (HTMLElement & { textContent: string; parent: { className: string } | null; id?: string; getAttribute: (name: string) => string | null })
      | null;
    expect(linkTooltip?.textContent).toContain("默认仅保存为灵感（不创建 .md 文件）");
    expect(linkTooltip?.parent?.className).toContain("glitter-write-stage__action-primary--capture-submit");
    expect(linkPrimaryButton?.getAttribute("aria-describedby")).toBe("glitter-write-stage-submit-tooltip");

    const mediaContainer = createContainer();
    renderWriteView(
      mediaContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const mediaBodyPanel = mediaContainer.querySelector(".glitter-write-stage__body-panel") as
      | (HTMLElement & { className: string })
      | null;
    const mediaAutoTitleIcon = mediaContainer.querySelector(".glitter-write-stage__icon--image");
    const mediaDetailPane = mediaContainer.querySelector(".glitter-write-stage__media-detail-pane") as
      | (HTMLElement & { children: Array<{ className: string; textContent: string }> })
      | null;
    const mediaBodyInput = mediaContainer.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { parent: { className: string } | null })
      | null;
    expect(mediaContainer.querySelector(".glitter-write-stage__scrim")).toBeNull();
    expect(mediaContainer.querySelectorAll(".glitter-write-stage__modal-card")).toHaveLength(1);
    expect(mediaBodyPanel?.className).toContain("glitter-write-stage__body-panel--media");
    expect(mediaAutoTitleIcon).not.toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__icon--clock")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-layout")).not.toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-thumbnail-surface")).not.toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__icon--media")).not.toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-thumbnail-image")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-thumbnail-video")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-entity-pane")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-thumbnail-shell")).toBeNull();
    expect(mediaDetailPane).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-detail-title")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-editor-shell")).not.toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-path-shell")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-path-row")).toBeNull();
    expect(mediaBodyInput?.parent?.className).toContain("glitter-write-stage__media-editor-shell");
    expect(mediaContainer.querySelector(".glitter-write-stage__media-entity-copy")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__media-attachment-list")).toBeNull();
    expect(mediaContainer.querySelector(".glitter-write-stage__clip-hint")).toBeNull();

    const mediaPathContainer = createContainer();
    renderWriteView(
      mediaPathContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        selectedPoolLabel: "调研池",
        attachedMediaCount: 2,
        attachedMediaLabels: ["image-1.png", "clip.mov"]
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const mediaTitleInput = mediaPathContainer.querySelector(".glitter-write-stage__auto-title-text") as
      | (HTMLElement & { value: string })
      | null;
    expect(mediaTitleInput?.value).toBe("image-1.png");
    expect(mediaTitleInput?.value).not.toContain("灵感");
    expect(mediaPathContainer.querySelector(".glitter-write-stage__media-path-shell")).toBeNull();
    expect(mediaPathContainer.querySelector(".glitter-write-stage__media-path-row")).toBeNull();

    const mediaFallbackTitleContainer = createContainer();
    renderWriteView(
      mediaFallbackTitleContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        generatedTitle: "灵感 04-08 09:12"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const mediaFallbackTitle = mediaFallbackTitleContainer.querySelector(".glitter-write-stage__auto-title-text") as
      | (HTMLElement & { value: string })
      | null;
    expect(mediaFallbackTitle?.value).toBe("媒体灵感");
    expect(mediaFallbackTitle?.value).not.toContain("04-08 09:12");

    const mediaPreviewContainer = createContainer();
    renderWriteView(
      mediaPreviewContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaPreviewUrl: "blob:image-preview",
        attachedMediaPreviewKind: "image"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const previewImage = mediaPreviewContainer.querySelector(".glitter-write-stage__media-thumbnail-image") as
      | (HTMLElement & { attributes?: Record<string, string> })
      | null;
    expect(previewImage).not.toBeNull();
    expect(previewImage?.getAttribute?.("src")).toBe("blob:image-preview");
    expect(mediaPreviewContainer.querySelector(".glitter-write-stage__icon--media")).toBeNull();

    const mediaVideoPreviewContainer = createContainer();
    renderWriteView(
      mediaVideoPreviewContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaPreviewUrl: "blob:video-preview",
        attachedMediaPreviewKind: "video"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const previewVideo = mediaVideoPreviewContainer.querySelector(".glitter-write-stage__media-thumbnail-video") as
      | (HTMLElement & { attributes?: Record<string, string> })
      | null;
    expect(previewVideo).not.toBeNull();
    expect(previewVideo?.getAttribute?.("src")).toBe("blob:video-preview");
    expect(previewVideo?.getAttribute?.("muted")).toBe("");
    expect(previewVideo?.getAttribute?.("playsinline")).toBe("");
    expect(mediaVideoPreviewContainer.querySelector(".glitter-write-stage__icon--media")).toBeNull();

    const previewOpenCalls: string[] = [];
    const mediaPreviewActionContainer = createContainer();
    renderWriteView(
      mediaPreviewActionContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaPreviewUrl: "blob:image-preview",
        attachedMediaPreviewKind: "image"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaPreviewOpen() {
          previewOpenCalls.push("open");
        }
      }
    );

    const previewThumbnailSurface = mediaPreviewActionContainer.querySelector(
      ".glitter-write-stage__media-thumbnail-surface"
    ) as unknown as {
      getAttribute: (name: string) => string | null;
      className: string;
      tagName: string;
    };
    const previewThumbnailTrigger = mediaPreviewActionContainer.querySelector(
      ".glitter-write-stage__media-thumbnail-preview-trigger"
    ) as unknown as {
      click: () => void;
      getAttribute: (name: string) => string | null;
      className: string;
      tagName: string;
    };
    previewThumbnailTrigger.click();
    expect(previewOpenCalls).toEqual(["open"]);
    expect(previewThumbnailSurface.tagName).toBe("DIV");
    expect(previewThumbnailSurface.getAttribute("role")).toBeNull();
    expect(previewThumbnailSurface.getAttribute("tabindex")).toBeNull();
    expect(previewThumbnailSurface.getAttribute("aria-label")).toBeNull();
    expect(previewThumbnailSurface.className).toContain("glitter-write-stage__media-thumbnail-surface");
    expect(previewThumbnailSurface.className).toContain("glitter-write-stage__media-thumbnail-surface--action-icons-light");
    expect(previewThumbnailSurface.className).not.toContain("glitter-write-stage__media-thumbnail-surface--interactive");
    expect(previewThumbnailTrigger.tagName).toBe("BUTTON");
    expect(previewThumbnailTrigger.getAttribute("aria-label")).toBe("查看大图");
    expect(previewThumbnailTrigger.className).toContain("glitter-write-stage__media-thumbnail-preview-trigger");

    const previewOverlayContainer = createContainer();
    const previewCloseCalls: string[] = [];
    renderWriteView(
      previewOverlayContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaPreviewUrl: "blob:image-preview",
        attachedMediaPreviewKind: "image",
        mediaPreviewVisible: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaPreviewClose() {
          previewCloseCalls.push("close");
        }
      }
    );

    const previewOverlayImage = previewOverlayContainer.querySelector(".glitter-write-stage__media-preview-image") as
      | (HTMLElement & { getAttribute: (name: string) => string | null })
      | null;
    const previewOverlayClose = previewOverlayContainer.querySelector(".glitter-write-stage__media-preview-close") as unknown as {
      click: () => void;
      getAttribute: (name: string) => string | null;
    };
    expect(previewOverlayContainer.querySelector(".glitter-write-stage__media-preview-overlay")).not.toBeNull();
    expect(previewOverlayImage?.getAttribute("src")).toBe("blob:image-preview");
    expect(previewOverlayClose.getAttribute("aria-label")).toBe("关闭大图预览");
    previewOverlayClose.click();
    expect(previewCloseCalls).toEqual(["close"]);

    const videoPreviewActionCalls: string[] = [];
    const videoPreviewActionContainer = createContainer();
    renderWriteView(
      videoPreviewActionContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaPreviewUrl: "blob:video-preview",
        attachedMediaPreviewKind: "video"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaPreviewOpen() {
          videoPreviewActionCalls.push("open");
        }
      }
    );

    const videoPreviewThumbnailSurface = videoPreviewActionContainer.querySelector(
      ".glitter-write-stage__media-thumbnail-surface"
    ) as unknown as { getAttribute: (name: string) => string | null; className: string };
    expect(videoPreviewThumbnailSurface?.getAttribute?.("aria-label")).toBeNull();
    expect(videoPreviewThumbnailSurface.className).toContain("glitter-write-stage__media-thumbnail-surface--action-icons-light");
    expect(videoPreviewActionCalls).toEqual([]);
    expect(stylesCss).toContain(".glitter-write-stage__media-thumbnail-preview-trigger {");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-thumbnail-preview-trigger", [
      "width: 100%;",
      "height: 100%;",
      "align-self: stretch;",
      "justify-self: stretch;",
      "display: grid;",
      "place-items: center;",
      "padding: 0;",
      "border: none;",
      "background: none;",
      "cursor: zoom-in;",
      "appearance: none;",
      "-webkit-appearance: none;"
    ]);
    expect(stylesCss).toContain(".glitter-write-stage__media-preview-overlay {");
    expect(stylesCss).toContain(".glitter-write-stage__media-preview-image {");
    expect(stylesCss).toContain("object-fit: contain;");
  });

  it("renders image-gallery controls on the media thumbnail surface and wires their callbacks", () => {
    const previousCalls: string[] = [];
    const nextCalls: string[] = [];
    const addCalls: string[] = [];
    const replaceCalls: string[] = [];
    const removeCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaCount: 7,
        attachedMediaLabels: [
          "image-1.png",
          "image-2.png",
          "image-3.png",
          "image-4.png",
          "image-5.png",
          "image-6.png",
          "image-7.png"
        ],
        attachedMediaPreviewUrl: "blob:image-2.png",
        attachedMediaPreviewKind: "image",
        mediaOverlayMode: "image-gallery",
        selectedMediaIndex: 1,
        canSelectPreviousMedia: true,
        canSelectNextMedia: true,
        canAddMoreImages: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaNavigatePrevious() {
          previousCalls.push("previous");
        },
        onMediaNavigateNext() {
          nextCalls.push("next");
        },
        onMediaAddAttachment() {
          addCalls.push("add");
        },
        onMediaReplaceAttachment() {
          replaceCalls.push("replace");
        },
        onRemoveMediaAttachment() {
          removeCalls.push("remove");
        }
      } as unknown as Parameters<typeof renderWriteView>[2]
    );

    const previousButton = container.querySelector(".glitter-write-stage__media-surface-nav-button--previous") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;
    const nextButton = container.querySelector(".glitter-write-stage__media-surface-nav-button--next") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;
    const addButton = container.querySelector(".glitter-write-stage__media-surface-action--add") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;
    const replaceButton = container.querySelector(".glitter-write-stage__media-surface-action--replace") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;
    const removeButton = container.querySelector(".glitter-write-stage__media-surface-action--remove") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;
    const previewTrigger = container.querySelector(".glitter-write-stage__media-thumbnail-preview-trigger") as
      | FakeElement
      | null;

    expect(container.querySelector(".glitter-write-stage__media-path-shell")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__media-path-row")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__media-surface-page-chip")?.textContent).toBe("2 / 7");
    expect(container.querySelectorAll(".glitter-write-stage__media-surface-nav-button")).toHaveLength(2);
    expect(container.querySelectorAll(".glitter-write-stage__media-surface-action")).toHaveLength(3);
    expect(previousButton?.textContent ?? "").toBe("");
    expect(previousButton?.getAttribute("aria-label")).toBe("上一张");
    expect(previousButton?.getAttribute("title")).toBe("上一张");
    expect(previousButton?.querySelector(".glitter-write-stage__icon--chevron-left")).not.toBeNull();
    expect(nextButton?.textContent ?? "").toBe("");
    expect(nextButton?.getAttribute("aria-label")).toBe("下一张");
    expect(nextButton?.getAttribute("title")).toBe("下一张");
    expect(nextButton?.querySelector(".glitter-write-stage__icon--chevron-right")).not.toBeNull();
    expect(addButton?.textContent ?? "").toBe("");
    expect(addButton?.getAttribute("aria-label")).toBe("增加图片");
    expect(addButton?.getAttribute("title")).toBe("增加图片");
    expect(addButton?.querySelector(".glitter-write-stage__icon--plus")).not.toBeNull();
    expect(replaceButton?.textContent ?? "").toBe("");
    expect(replaceButton?.getAttribute("aria-label")).toBe("替换当前图片");
    expect(replaceButton?.getAttribute("title")).toBe("替换当前图片");
    expect(replaceButton?.querySelector(".glitter-write-stage__icon--replace")).not.toBeNull();
    expect(removeButton?.textContent ?? "").toBe("");
    expect(removeButton?.getAttribute("aria-label")).toBe("删除当前图片");
    expect(removeButton?.getAttribute("title")).toBe("删除当前图片");
    expect(removeButton?.querySelector(".glitter-write-stage__icon--trash")).not.toBeNull();
    expect(previewTrigger).not.toBeNull();
    expect(isDescendantOf(previousButton as FakeElement | null, previewTrigger)).toBe(false);
    expect(isDescendantOf(nextButton as FakeElement | null, previewTrigger)).toBe(false);
    expect(isDescendantOf(addButton as FakeElement | null, previewTrigger)).toBe(false);
    expect(isDescendantOf(replaceButton as FakeElement | null, previewTrigger)).toBe(false);
    expect(isDescendantOf(removeButton as FakeElement | null, previewTrigger)).toBe(false);

    previousButton?.click();
    nextButton?.click();
    addButton?.click();
    replaceButton?.click();
    removeButton?.click();

    expect(previousCalls).toEqual(["previous"]);
    expect(nextCalls).toEqual(["next"]);
    expect(addCalls).toEqual(["add"]);
    expect(replaceCalls).toEqual(["replace"]);
    expect(removeCalls).toEqual(["remove"]);
  });

  it("keeps overlay button Enter/Space activation from bubbling into the media preview trigger", () => {
    const previewOpenCalls: string[] = [];
    const previousCalls: string[] = [];
    const replaceCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaCount: 3,
        attachedMediaLabels: ["image-1.png", "image-2.png", "image-3.png"],
        attachedMediaPreviewUrl: "blob:image-2.png",
        attachedMediaPreviewKind: "image",
        mediaOverlayMode: "image-gallery",
        selectedMediaIndex: 1,
        canSelectPreviousMedia: true,
        canSelectNextMedia: true,
        canAddMoreImages: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaPreviewOpen() {
          previewOpenCalls.push("open");
        },
        onMediaNavigatePrevious() {
          previousCalls.push("previous");
        },
        onMediaReplaceAttachment() {
          replaceCalls.push("replace");
        }
      } as unknown as Parameters<typeof renderWriteView>[2]
    );

    const previousButton = container.querySelector(".glitter-write-stage__media-surface-nav-button--previous") as
      | FakeElement
      | null;
    const replaceButton = container.querySelector(".glitter-write-stage__media-surface-action--replace") as
      | FakeElement
      | null;

    expect(previousButton).not.toBeNull();
    expect(replaceButton).not.toBeNull();

    const previousEnterEvent = activateButtonWithKeyboard(previousButton!, "Enter");
    const replaceSpaceEvent = activateButtonWithKeyboard(replaceButton!, " ");

    expect(previousEnterEvent.defaultPrevented).toBe(false);
    expect(replaceSpaceEvent.defaultPrevented).toBe(false);
    expect(previewOpenCalls).toEqual([]);
    expect(previousCalls).toEqual(["previous"]);
    expect(replaceCalls).toEqual(["replace"]);
  });

  it("keeps the image-gallery page chip visible for a single image without rendering side navigation", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaCount: 1,
        attachedMediaLabels: ["image-1.png"],
        attachedMediaPreviewUrl: "blob:image-1.png",
        attachedMediaPreviewKind: "image",
        mediaOverlayMode: "image-gallery",
        selectedMediaIndex: 0,
        canSelectPreviousMedia: false,
        canSelectNextMedia: false,
        canAddMoreImages: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaAddAttachment() {},
        onMediaReplaceAttachment() {},
        onRemoveMediaAttachment() {}
      } as unknown as Parameters<typeof renderWriteView>[2]
    );

    expect(container.querySelector(".glitter-write-stage__media-surface-page-chip")?.textContent).toBe("1 / 1");
    expect(container.querySelectorAll(".glitter-write-stage__media-surface-nav-button")).toHaveLength(0);
    expect(container.querySelectorAll(".glitter-write-stage__media-surface-action")).toHaveLength(3);
  });

  it("renders video controls on the media thumbnail surface without gallery navigation", () => {
    const replaceCalls: string[] = [];
    const removeCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "media",
        importState: "idle",
        attachedMediaCount: 1,
        attachedMediaLabels: ["clip.mp4"],
        attachedMediaPreviewUrl: "blob:clip.mp4",
        attachedMediaPreviewKind: "video",
        mediaOverlayMode: "video",
        selectedMediaIndex: 0,
        canSelectPreviousMedia: false,
        canSelectNextMedia: false,
        canAddMoreImages: false
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onMediaReplaceAttachment() {
          replaceCalls.push("replace");
        },
        onRemoveMediaAttachment() {
          removeCalls.push("remove");
        }
      } as unknown as Parameters<typeof renderWriteView>[2]
    );

    const replaceButton = container.querySelector(".glitter-write-stage__media-surface-action--replace") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;
    const removeButton = container.querySelector(".glitter-write-stage__media-surface-action--remove") as
      | (HTMLElement & {
          click: () => void;
          textContent: string;
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => HTMLElement | null;
        })
      | null;

    expect(container.querySelector(".glitter-write-stage__media-path-shell")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__media-path-row")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__media-surface-page-chip")).toBeNull();
    expect(container.querySelectorAll(".glitter-write-stage__media-surface-nav-button")).toHaveLength(0);
    expect(container.querySelector(".glitter-write-stage__media-surface-action--add")).toBeNull();
    expect(container.querySelectorAll(".glitter-write-stage__media-surface-action")).toHaveLength(2);
    expect(replaceButton?.textContent ?? "").toBe("");
    expect(replaceButton?.getAttribute("aria-label")).toBe("替换视频");
    expect(replaceButton?.getAttribute("title")).toBe("替换视频");
    expect(replaceButton?.querySelector(".glitter-write-stage__icon--replace")).not.toBeNull();
    expect(removeButton?.textContent ?? "").toBe("");
    expect(removeButton?.getAttribute("aria-label")).toBe("删除视频");
    expect(removeButton?.getAttribute("title")).toBe("删除视频");
    expect(removeButton?.querySelector(".glitter-write-stage__icon--trash")).not.toBeNull();

    replaceButton?.click();
    removeButton?.click();

    expect(replaceCalls).toEqual(["replace"]);
    expect(removeCalls).toEqual(["remove"]);
  });

  it("styles quick-capture media overlays as icon-only frosted-glass controls without system button chrome", () => {
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-controls", [
      "position: absolute;",
      "inset: 0;",
      "padding: 10px;",
      "pointer-events: none;"
    ]);
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__media-surface-nav-button,\n.glitter-write-stage__media-surface-action",
      [
        "border-radius: 999px;",
        "border: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 42%, white 16%);",
        "background: color-mix(in srgb, var(--glitter-ui-bg) 62%, transparent);",
        "padding: 0;",
        "box-shadow: none;",
        "pointer-events: auto;",
        "appearance: none;",
        "-webkit-appearance: none;",
        "cursor: pointer;",
        "-webkit-backdrop-filter: blur(18px) saturate(148%);",
        "backdrop-filter: blur(18px) saturate(148%);"
      ]
    );
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-nav-button", [
      "position: absolute;",
      "top: 50%;",
      "transform: translateY(-50%);",
      "width: 34px;",
      "height: 34px;"
    ]);
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-nav-button,\n.glitter-write-stage__media-surface-action", "min-width: 54px;");
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-nav-button,\n.glitter-write-stage__media-surface-action", "padding: 0 12px;");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-nav-button--previous", ["left: 10px;"]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-nav-button--next", ["right: 10px;"]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-page-chip", [
      "position: absolute;",
      "top: 10px;",
      "right: 10px;",
      "background: color-mix(in srgb, var(--glitter-ui-bg) 62%, transparent);",
      "border: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 42%, white 16%);",
      "box-shadow: none;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-actions", [
      "position: absolute;",
      "left: 10px;",
      "right: 10px;",
      "bottom: 10px;",
      "justify-content: center;",
      "gap: 8px;",
      "flex-wrap: nowrap;"
    ]);
    expectDeclarationsInLastSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action",
      [
        "position: relative;",
        "width: 30px;",
        "height: 30px;",
        "overflow: hidden;",
        "isolation: isolate;",
        "color: var(--glitter-media-surface-action-icon-color);",
        "border-color: color-mix(in srgb, white 16%, var(--glitter-ui-border-strong) 14%);",
        "background:\n    radial-gradient(circle at 32% 24%, color-mix(in srgb, white 16%, transparent), transparent 54%),\n    linear-gradient(180deg, color-mix(in srgb, white 10%, transparent), color-mix(in srgb, black 8%, transparent)),\n    color-mix(in srgb, var(--glitter-ui-bg) 18%, transparent);",
        "box-shadow:\n    0 0 0 1px color-mix(in srgb, white 3%, transparent),\n    inset 0 1px 0 color-mix(in srgb, white 16%, transparent),\n    inset 0 -1px 0 color-mix(in srgb, black 12%, transparent),\n    0 10px 20px color-mix(in srgb, black 14%, transparent);",
        "-webkit-backdrop-filter: blur(22px) saturate(164%);",
        "backdrop-filter: blur(22px) saturate(164%);",
        "transform: translateY(0);",
        "transition:\n    opacity 140ms ease,\n    color 160ms ease,\n    border-color 160ms ease,\n    background 180ms ease,\n    box-shadow 180ms ease,\n    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);"
      ]
    );
    expect(stylesCss).not.toContain(
      ".glitter-write-stage__media-surface-action {\n  min-height: 30px;"
    );
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__media-surface-nav-button,\n.glitter-write-stage__media-surface-action", "padding: 0 12px;");
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-thumbnail-surface", [
      "--glitter-media-surface-action-icon-color: color-mix(in srgb, white 96%, var(--glitter-ui-text) 4%);"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-thumbnail-surface--action-icons-light", [
      "--glitter-media-surface-action-icon-color: color-mix(in srgb, white 96%, var(--glitter-ui-text) 4%);"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-thumbnail-surface--action-icons-dark", [
      "--glitter-media-surface-action-icon-color: color-mix(in srgb, black 88%, var(--glitter-ui-text) 12%);"
    ]);
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action::before,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action::before",
      ['content: "";', "position: absolute;", "inset: 0;", "border-radius: inherit;", "pointer-events: none;"]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action::before,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action::before",
      [
        "background:\n    linear-gradient(180deg, color-mix(in srgb, white 14%, transparent), transparent 62%),\n    radial-gradient(circle at 50% -10%, color-mix(in srgb, white 10%, transparent), transparent 72%);",
        "opacity: 1;"
      ]
    );
    expect(stylesCss).not.toContain(".glitter-write-stage__media-surface-action::after {");
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__media-surface-nav-button .glitter-write-stage__icon,\n.glitter-write-stage__media-surface-action .glitter-write-stage__icon",
      ["color: inherit;", "pointer-events: none;"]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action .glitter-write-stage__icon,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action .glitter-write-stage__icon",
      ["position: relative;", "z-index: 1;"]
    );
    expect(stylesCss).not.toContain("mix-blend-mode: difference;");
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__media-surface-nav-button:not(:disabled):hover,\n.glitter-write-stage__media-surface-nav-button:not(:disabled):focus-visible,\n.glitter-write-stage__media-surface-action:not(:disabled):hover,\n.glitter-write-stage__media-surface-action:not(:disabled):focus-visible",
      [
        "color: var(--glitter-ui-accent);",
        "border-color: color-mix(in srgb, var(--glitter-ui-accent) 52%, var(--glitter-ui-border-strong) 48%);",
        "background: color-mix(in srgb, var(--glitter-ui-accent) 14%, var(--glitter-ui-bg) 86%);",
        "box-shadow: none;"
      ]
    );
    expect(stylesCss).not.toContain(
      ".glitter-write-stage__media-surface-nav-button:hover,\n.glitter-write-stage__media-surface-nav-button:focus-visible,\n.glitter-write-stage__media-surface-action:hover,\n.glitter-write-stage__media-surface-action:focus-visible"
    );
    expectDeclarationsInLastSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action:not(:disabled):hover,\n.glitter-write-stage button.glitter-write-stage__media-surface-action:not(:disabled):focus-visible,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action:not(:disabled):hover,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action:not(:disabled):focus-visible",
      [
        "color: var(--glitter-ui-accent);",
        "border-color: color-mix(in srgb, var(--glitter-ui-accent) 68%, white 20%);",
        "background:\n    radial-gradient(circle at 32% 22%, color-mix(in srgb, white 52%, transparent), transparent 48%),\n    linear-gradient(180deg, color-mix(in srgb, white 44%, transparent), color-mix(in srgb, var(--glitter-ui-accent) 26%, transparent)),\n    color-mix(in srgb, var(--glitter-ui-bg) 58%, transparent);",
        "box-shadow:\n    0 0 0 1px color-mix(in srgb, var(--glitter-ui-accent) 18%, white 14%),\n    inset 0 1px 0 color-mix(in srgb, white 48%, transparent),\n    inset 0 -1px 0 color-mix(in srgb, var(--glitter-ui-accent) 30%, transparent),\n    0 18px 34px color-mix(in srgb, black 28%, transparent);"
      ]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action:not(:disabled):hover,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action:not(:disabled):hover",
      ["transform: translateY(-1px);"]
    );
    expect(stylesCss).not.toContain(
      ".glitter-write-stage__media-surface-action:not(:disabled):focus-visible {\n  transform:"
    );
    expect(stylesCss).not.toContain("@keyframes glitter-write-stage-media-surface-action-ripple {");
    expect(stylesCss).not.toContain(
      ".glitter-write-stage__media-surface-action:not(:disabled):hover::after"
    );
    expect(stylesCss).not.toContain(
      ".glitter-write-stage__media-surface-action:not(:disabled):focus-visible::after"
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action--remove:not(:disabled):hover,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action--remove:not(:disabled):hover",
      [
        "color: var(--text-error, #ff6b6b);",
        "border-color: color-mix(in srgb, var(--text-error, #ff6b6b) 68%, white 20%);",
        "background:\n    radial-gradient(circle at 32% 22%, color-mix(in srgb, white 50%, transparent), transparent 48%),\n    linear-gradient(180deg, color-mix(in srgb, white 42%, transparent), color-mix(in srgb, var(--text-error, #ff6b6b) 24%, transparent)),\n    color-mix(in srgb, var(--glitter-ui-bg) 58%, transparent);"
      ]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action:disabled::before,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action:disabled::before",
      ["opacity: 0;"]
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__media-surface-nav-button:disabled,\n.glitter-write-stage__media-surface-action:disabled {\n  opacity: 0.52;\n  color: color-mix(in srgb, var(--glitter-ui-text-muted) 84%, transparent);\n  cursor: default;\n}"
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage button.glitter-write-stage__media-surface-action:disabled,\n.GlitterIdea-edit-modal button.glitter-write-stage__media-surface-action:disabled",
      [
        "border-color: color-mix(in srgb, var(--glitter-ui-border-strong) 28%, transparent);",
        "background: color-mix(in srgb, var(--glitter-ui-bg) 42%, transparent);",
        "box-shadow: none;"
      ]
    );
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__media-preview-close", [
      "position: absolute;",
      "top: 0;",
      "right: 0;",
      "width: 34px;",
      "height: 34px;",
      "border-radius: 999px;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, "button.glitter-write-stage__media-preview-close", [
      "all: unset;",
      "position: absolute;",
      "top: 0;",
      "right: 0;",
      "box-sizing: border-box;",
      "width: 34px;",
      "height: 34px;",
      "border: 0 !important;",
      "border-radius: 999px;",
      "display: grid;",
      "place-items: center;",
      "padding: 0;",
      "appearance: none !important;",
      "-webkit-appearance: none !important;",
      "background: color-mix(in srgb, var(--glitter-ui-surface) 76%, transparent);",
      "background-image: none !important;",
      "box-shadow: none !important;",
      "color: var(--glitter-ui-text);",
      "filter: none !important;",
      "text-shadow: none !important;",
      "cursor: pointer;"
    ]);
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__media-preview-close:hover:not(:disabled),\n.glitter-write-stage__media-preview-close:focus-visible",
      [
        "background: color-mix(in srgb, var(--glitter-ui-surface) 72%, var(--glitter-ui-accent) 24%);",
        "color: var(--glitter-ui-accent);"
      ]
    );
    expectDeclarationsInLastSelectorBlock(stylesCss, ".glitter-write-stage__media-preview-close:focus-visible", [
      "outline: 2px solid color-mix(in srgb, var(--glitter-ui-accent) 68%, white 32%);",
      "outline-offset: 2px;"
    ]);
    expect(stylesCss).toContain(".glitter-write-stage__icon--chevron-left {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--chevron-right {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--plus {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--replace {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--trash {");
  });

  it("keeps the link attachment row removable with the shared flat icon-only close button", () => {
    const linkRemoveCalls: string[] = [];
    const linkContainer = createContainer();
    renderWriteView(
      linkContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "idle",
        titleText: "导入标题",
        inputText: "导入摘要",
        importedExcerpt: "导入摘要",
        sourceUrl: "https://example.com/article"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onRemoveLinkAttachment() {
          linkRemoveCalls.push("remove-link");
        }
      } as unknown as Parameters<typeof renderWriteView>[2]
    );

    const linkAttachmentRow = linkContainer.querySelector(".glitter-write-stage__link-attachment-row") as HTMLElement | null;
    const linkRemoveButton = linkContainer.querySelector(".glitter-write-stage__attachment-remove") as
      | (HTMLElement & { click: () => void; getAttribute: (name: string) => string | null })
      | null;
    expect(linkAttachmentRow).not.toBeNull();
    expect(linkRemoveButton).not.toBeNull();
    expect(linkRemoveButton?.getAttribute("aria-label")).toBe("移除已加载链接");
    linkRemoveButton?.click();
    expect(linkRemoveCalls).toEqual(["remove-link"]);

    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__link-attachment-row", [
      "position: relative;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__attachment-remove", [
      "position: absolute;",
      "background: none !important;",
      "background-color: transparent !important;",
      "border-radius: 0 !important;",
      "box-shadow: none !important;"
    ]);
  });

  it("renders loading and error link-import copy inline inside the body panel", () => {
    const loadingContainer = createContainer();
    renderWriteView(
      loadingContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "loading",
        sourceUrl: "https://help.obsidian.md/plugins"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const loadingBodyPanel = loadingContainer.querySelector(".glitter-write-stage__body-panel") as
      | (HTMLElement & { children: Array<{ className: string }> })
      | null;
    const loadingPrimaryButton = loadingContainer.querySelector(".glitter-write-stage__action-primary") as
      | (HTMLElement & { disabled?: boolean })
      | null;
    expect(loadingContainer.querySelector(".glitter-write-stage__link-loading")?.textContent).toBe("正在识别链接，请稍后…");
    expect(loadingContainer.querySelector(".glitter-write-stage__link-error")).toBeNull();
    expect(loadingContainer.querySelector(".glitter-write-stage__clip-hint")).toBeNull();
    expect(loadingBodyPanel?.children[0]?.className).toContain("glitter-write-stage__body-editor");
    expect(loadingBodyPanel?.children[1]?.className).toContain("glitter-write-stage__link-attachment-row");
    expect(loadingBodyPanel?.children[loadingBodyPanel.children.length - 1]?.className).toContain("glitter-write-stage__link-loading");
    expect(loadingContainer.querySelector(".glitter-write-stage__link-attachment-row")?.textContent).not.toContain(
      "正在识别链接，请稍后…"
    );
    expect(loadingContainer.querySelector(".glitter-write-stage__link-attachment-text")?.textContent).toBe(
      "https://help.obsidian.md/plugins"
    );
    expect(loadingContainer.querySelector(".glitter-write-stage__link-status-inline")).toBeNull();
    expect((loadingContainer.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { placeholder?: string }) | null)?.placeholder).toBe("正在识别链接，请稍后…");
    expect(loadingPrimaryButton?.disabled).toBe(true);

    const errorContainer = createContainer();
    renderWriteView(
      errorContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "error",
        sourceUrl: "https://help.obsidian.md/plugins"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const errorBodyPanel = errorContainer.querySelector(".glitter-write-stage__body-panel") as
      | (HTMLElement & { children: Array<{ className: string }> })
      | null;
    expect(errorContainer.querySelector(".glitter-write-stage__link-error")).toBeNull();
    expect(errorContainer.querySelector(".glitter-write-stage__clip-hint")).toBeNull();
    expect(errorBodyPanel?.children).toHaveLength(2);
    expect(errorBodyPanel?.children[0]?.className).toContain("glitter-write-stage__body-editor");
    expect(errorBodyPanel?.children[1]?.className).toContain("glitter-write-stage__link-attachment-row");
    expect(errorContainer.querySelector(".glitter-write-stage__link-attachment-row")?.textContent).not.toContain(
      "读取链接内容失败，可手动书写灵感"
    );
    expect(errorContainer.querySelector(".glitter-write-stage__link-attachment-row")?.className).not.toContain(
      "glitter-write-stage__link-attachment-row--error"
    );
    expect(errorContainer.querySelector(".glitter-write-stage__link-status-inline")).toBeNull();
    expect((errorContainer.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { placeholder?: string }) | null)?.placeholder).toBe("读取链接内容失败，可手动书写灵感");
    expect(errorContainer.querySelector(".glitter-write-stage__retry-link--inline")).toBeNull();
    expect(errorContainer.querySelector(".glitter-write-stage__icon--refresh")).toBeNull();
    expect(errorContainer.querySelector(".glitter-write-stage__retry-link")).toBeNull();
    expect(errorContainer.querySelector(".glitter-write-stage__status")).toBeNull();

    const typedErrorContainer = createContainer();
    renderWriteView(
      typedErrorContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "error",
        sourceUrl: "https://help.obsidian.md/plugins",
        inputText: "我自己已经开始写了"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    expect((typedErrorContainer.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { placeholder?: string; value?: string }) | null)?.value).toBe("我自己已经开始写了");
    expect((typedErrorContainer.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { placeholder?: string }) | null)?.placeholder).toBe("读取链接内容失败，可手动书写灵感");
    expect(typedErrorContainer.querySelector(".glitter-write-stage__retry-link")).toBeNull();
  });

  it("keeps loading guidance visible when link body already has text", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "loading",
        sourceUrl: "https://help.obsidian.md/plugins",
        inputText: "我自己已经开始写了"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    expect((container.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { value?: string }) | null)?.value).toBe(
      "我自己已经开始写了"
    );
    expect(container.querySelector(".glitter-write-stage__link-loading")?.textContent).toBe("正在识别链接，请稍后…");
  });

  it("keeps only the error placeholder when link body already has text", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "link",
        importState: "error",
        sourceUrl: "https://help.obsidian.md/plugins",
        inputText: "我自己已经开始写了"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    expect((container.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { value?: string; placeholder?: string }) | null)?.value).toBe(
      "我自己已经开始写了"
    );
    expect((container.querySelector(".glitter-write-stage__body-editor") as (HTMLElement & { placeholder?: string }) | null)?.placeholder).toBe(
      "读取链接内容失败，可手动书写灵感"
    );
    expect(container.querySelector(".glitter-write-stage__link-error")).toBeNull();
  });

  it("wires close, submit, and pool picker callbacks", () => {
    const closeCalls: string[] = [];
    const submitCalls: string[] = [];
    const poolToggleCalls: string[] = [];
    const poolSelectCalls: string[] = [];

    const immersiveContainer = createContainer();
    renderWriteView(immersiveContainer, buildWriteViewState("write-immersive-default"), {
      onClose() {
        closeCalls.push("close");
      },
      onSubmit() {
        submitCalls.push("submit");
      },
      onPoolPickerToggle() {
        poolToggleCalls.push("pool-toggle");
      },
      onPoolSelect: (poolId) => {
        poolSelectCalls.push(poolId);
      },
      onRetryLinkImport() {},
      onMediaPreviewOpen() {},
      onMediaPreviewClose() {}
    });

    const immersiveButtons = immersiveContainer.querySelectorAll(".glitter-write-stage__action-secondary");
    const closeButton = immersiveButtons[0] as unknown as { click: () => void; type: string };
    const submitButton = immersiveContainer.querySelector(
      ".glitter-write-stage__action-primary"
    ) as unknown as { click: () => void; type: string };
    const poolButton = immersiveContainer.querySelector(
      ".glitter-write-stage__pool-button"
    ) as unknown as { click: () => void; type: string };

    closeButton.click();
    submitButton.click();
    poolButton.click();

    const errorContainer = createContainer();
    renderWriteView(errorContainer, buildWriteViewState("quick-capture-link-error"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onPoolSelect() {},
      onRetryLinkImport() {},
      onMediaPreviewOpen() {},
      onMediaPreviewClose() {}
    });

    expect(errorContainer.querySelector(".glitter-write-stage__retry-link--inline")).toBeNull();

    expect(closeCalls).toEqual(["close"]);
    expect(submitCalls).toEqual(["submit"]);
    expect(poolToggleCalls).toEqual(["pool-toggle"]);
    expect(poolSelectCalls).toEqual([]);

    expect(closeButton.type).toBe("button");
    expect(submitButton.type).toBe("button");
    expect(poolButton.type).toBe("button");
  });

  it("shows inline pool dropdown and emits pool selections including create sentinel", () => {
    const poolToggleCalls: string[] = [];
    const poolSelectCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        poolDropdownVisible: true,
        selectedPoolId: "pool-writing",
        selectedPoolLabel: "写作池",
        poolOptions: [
          { id: "pool-writing", label: "写作池" },
          { id: "pool-research", label: "调研池" },
          { id: "create-new-pool", label: "新建池" }
        ],
        poolCreateActionLabel: "新建池 / Create"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {
          poolToggleCalls.push("toggle");
        },
        onPoolSelect: (poolId) => {
          poolSelectCalls.push(poolId);
        },
        onRetryLinkImport() {}
      }
    );

    const poolButton = container.querySelector(".glitter-write-stage__pool-button") as
      | (HTMLElement & { click: () => void; getAttribute: (name: string) => string | null })
      | null;
    const dropdown = container.querySelector(".glitter-write-stage__pool-dropdown") as HTMLElement | null;
    const optionsShell = container.querySelector(".glitter-write-stage__pool-container--options") as HTMLElement | null;
    const createShell = container.querySelector(".glitter-write-stage__pool-container--create") as HTMLElement | null;
    const scrollArea = container.querySelector(".glitter-write-stage__pool-scroll") as HTMLElement | null;
    const optionButtons = container.querySelectorAll(".glitter-write-stage__pool-option");
    const chevronUp = container.querySelector(".glitter-write-stage__icon--chevron-up") as HTMLElement | null;
    const chevronDown = container.querySelector(".glitter-write-stage__icon--chevron-down") as HTMLElement | null;

    expect(poolButton?.getAttribute("aria-expanded")).toBe("true");
    expect(dropdown).not.toBeNull();
    expect(optionsShell).not.toBeNull();
    expect(createShell).not.toBeNull();
    expect(scrollArea).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__pool-button-text")?.textContent).toContain("池：写作池");
    expect(optionButtons).toHaveLength(3);
    expect(container.querySelector(".glitter-write-stage__pool-create")).toBeNull();
    expect(container.querySelectorAll(".glitter-write-stage__pool-container")).toHaveLength(2);
    expect(container.querySelectorAll(".glitter-write-stage__pool-group")).toHaveLength(2);
    expect(container.querySelector(".glitter-write-stage__pool-group--options")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__pool-group--create")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__pool-group-label")?.textContent).toBe("新建池 / Create");
    expect((optionButtons[2] as HTMLElement).className).toContain("glitter-write-stage__pool-option--create");
    expect((optionButtons[2] as HTMLElement).querySelector?.(".glitter-write-stage__icon--waves")).not.toBeNull();
    expect((optionButtons[2] as HTMLElement).querySelector?.(".glitter-write-stage__pool-option-text")?.textContent).toBe("新建池");
    expect((optionButtons[2] as HTMLElement).querySelector?.(".glitter-write-stage__pool-option-bubble")).toBeNull();
    expect(chevronUp).not.toBeNull();
    expect(chevronDown).toBeNull();

    poolButton?.click();
    (optionButtons[1] as unknown as { click: () => void }).click();
    (optionButtons[2] as unknown as { click: () => void }).click();

    expect(poolToggleCalls).toEqual(["toggle"]);
    expect(poolSelectCalls).toEqual(["pool-research", "create-new-pool"]);
  });

  it("marks selected pool option by id when labels are duplicated", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        poolDropdownVisible: true,
        selectedPoolId: "pool-duplicate-b",
        selectedPoolLabel: "同名池",
        poolOptions: [
          { id: "pool-duplicate-a", label: "同名池" },
          { id: "pool-duplicate-b", label: "同名池" },
          { id: "pool-unique", label: "唯一池" }
        ]
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onPoolSelect() {},
        onRetryLinkImport() {}
      }
    );

    const selectedOptions = Array.from(
      container.querySelectorAll(".glitter-write-stage__pool-option"),
      (option) => option as Element & { dataset: Record<string, string> }
    ).filter((option) => option.className.includes("glitter-write-stage__pool-option--selected"));

    expect(selectedOptions).toHaveLength(1);
    expect(selectedOptions[0]?.dataset.poolId).toBe("pool-duplicate-b");
  });

  it("does not select any pool option when only selectedPoolLabel is provided", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        poolDropdownVisible: true,
        selectedPoolLabel: "调研池",
        poolOptions: [
          { id: "pool-writing", label: "写作池" },
          { id: "pool-research", label: "调研池" },
          { id: "pool-product", label: "产品池" }
        ]
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onPoolSelect() {},
        onRetryLinkImport() {}
      }
    );

    const selectedOptions = Array.from(container.querySelectorAll(".glitter-write-stage__pool-option")).filter(
      (option) => option.className.includes("glitter-write-stage__pool-option--selected")
    );

    expect(container.querySelector(".glitter-write-stage__pool-button-text")?.textContent).toContain("池：调研池");
    expect(selectedOptions).toHaveLength(0);
  });


  it("shows collapsed chevron when pool dropdown is closed", () => {
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    const chevronDown = container.querySelector(".glitter-write-stage__icon--chevron-down") as HTMLElement | null;
    const chevronUp = container.querySelector(".glitter-write-stage__icon--chevron-up") as HTMLElement | null;

    expect(chevronDown).not.toBeNull();
    expect(chevronUp).toBeNull();
  });

  it("renders close confirmation overlay and wires resume/exit actions", () => {
    const resumeCalls: string[] = [];
    const exitCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "first-use",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        closeConfirmVisible: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onResumeCapture() {
          resumeCalls.push("resume");
        },
        onConfirmClose() {
          exitCalls.push("exit");
        }
      }
    );

    expect(container.querySelector(".glitter-write-stage__close-confirm-dialog")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__close-confirm-title")?.textContent).toContain(
      "关闭将打断灵感记录"
    );
    expect(container.querySelector(".glitter-write-stage__close-confirm-description")?.textContent).toContain(
      "继续记录可返回当前编辑状态"
    );

    const resumeButton = container.querySelector(".glitter-write-stage__close-confirm-secondary") as unknown as {
      click: () => void;
      textContent?: string | null;
    };
    const exitButton = container.querySelector(".glitter-write-stage__close-confirm-primary") as unknown as {
      click: () => void;
      textContent?: string | null;
    };

    expect(resumeButton.textContent).toContain("继续记录");
    expect(exitButton.textContent).toContain("立即关闭");

    resumeButton.click();
    exitButton.click();

    expect(resumeCalls).toEqual(["resume"]);
    expect(exitCalls).toEqual(["exit"]);
  });

  it("renders empty-submit feedback overlay inside quick-capture", () => {
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        emptySubmitFeedbackVisible: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    expect(container.querySelector(".glitter-write-stage__empty-submit-feedback")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__empty-submit-feedback-scrim")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__empty-submit-feedback-dialog")?.textContent).toBe(
      "还没有灵感写入，请再抓住它吧～"
    );
  });

  it("emits body/title input changes, body paste events, and attachment click for quick-capture modal rerendering", () => {
    const bodyCalls: string[] = [];
    const titleCalls: string[] = [];
    const attachmentCalls: string[] = [];
    const pasteCalls: Array<{ text: string; itemCount: number }> = [];
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {},
      onBodyInputChange: (value) => {
        bodyCalls.push(value);
      },
      onBodyPaste: (payload) => {
        pasteCalls.push({
          text: payload.text,
          itemCount: payload.items.length
        });
      },
      onTitleInputChange: (value) => {
        titleCalls.push(value);
      },
      onAttachmentPick: () => {
        attachmentCalls.push("pick");
      }
    });

    const bodyInput = container.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { value: string; dispatchEvent: (event: { type: string; clipboardData?: { items?: unknown[]; getData: (type: string) => string }; preventDefault?: () => void }) => void })
      | null;
    const titleInput = container.querySelector(".glitter-write-stage__auto-title-text") as
      | (HTMLElement & { value: string; dispatchEvent: (event: { type: string }) => void; selected: boolean })
      | null;
    const clipHint = container.querySelector(".glitter-write-stage__clip-hint") as
      | (HTMLElement & { click: () => void; getAttribute: (name: string) => string | null })
      | null;

    bodyInput!.value = "https://example.com/article";
    bodyInput!.dispatchEvent({ type: "input" });
    bodyInput!.dispatchEvent({
      type: "paste",
      clipboardData: {
        items: [{ kind: "string", type: "text/plain" }],
        getData: (type: string) => (type === "text/plain" ? "https://example.com/pasted" : "")
      }
    });

    titleInput!.dispatchEvent({ type: "focus" });
    expect(titleInput?.selected).toBe(true);

    titleInput!.value = "手动改标题";
    titleInput!.dispatchEvent({ type: "input" });

    clipHint!.click();

    expect(bodyCalls).toEqual(["https://example.com/article"]);
    expect(pasteCalls).toEqual([{ text: "https://example.com/pasted", itemCount: 1 }]);
    expect(titleCalls).toEqual(["手动改标题"]);
    expect(attachmentCalls).toEqual(["pick"]);
    expect(container.querySelector(".glitter-write-stage__clip-hint-text")?.textContent).toBe("粘贴附件/链接后自动识别");
    expect(clipHint?.getAttribute("aria-label")).toBe("添加图片或视频附件");
  });

  it("passes IME composition state through body input changes", () => {
    const bodyCalls: Array<{ value: string; isComposing?: boolean }> = [];
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {},
      onBodyInputChange: (value, options) => {
        bodyCalls.push({ value, isComposing: options?.isComposing });
      }
    });

    const bodyInput = container.querySelector(".glitter-write-stage__body-editor") as
      | (HTMLElement & { value: string; dispatchEvent: (event: { type: string; isComposing?: boolean }) => void })
      | null;

    bodyInput!.value = "ni";
    bodyInput!.dispatchEvent({ type: "input", isComposing: true });
    bodyInput!.value = "你";
    bodyInput!.dispatchEvent({ type: "input", isComposing: false });

    expect(bodyCalls).toEqual([
      { value: "ni", isComposing: true },
      { value: "你", isComposing: false }
    ]);
  });

  it("passes IME composition state through title input changes", () => {
    const titleCalls: Array<{ value: string; isComposing?: boolean }> = [];
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {},
      onTitleInputChange: (value, options) => {
        titleCalls.push({ value, isComposing: options?.isComposing });
      }
    });

    const titleInput = container.querySelector(".glitter-write-stage__auto-title-text") as
      | (HTMLElement & { value: string; dispatchEvent: (event: { type: string; isComposing?: boolean }) => void })
      | null;

    titleInput!.value = "ni";
    titleInput!.dispatchEvent({ type: "input", isComposing: true });
    titleInput!.value = "你";
    titleInput!.dispatchEvent({ type: "input", isComposing: false });

    expect(titleCalls).toEqual([
      { value: "ni", isComposing: true },
      { value: "你", isComposing: false }
    ]);
  });

  it("emits create-file toggle changes, keeps the indicator visible, and exposes focus-visible affordance", () => {
    const toggleCalls: boolean[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle",
        createFileChecked: true
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onCreateFileToggle: (checked) => {
          toggleCalls.push(checked);
        }
      }
    );

    const toggle = container.querySelector(".glitter-write-stage__create-file-toggle") as
      | (HTMLElement & { className: string })
      | null;
    const checkbox = container.querySelector(".glitter-write-stage__create-file-checkbox") as
      | (HTMLElement & { checked: boolean; dispatchEvent: (event: { type: string }) => void; className: string })
      | null;

    expect(toggle?.className).toContain("glitter-write-stage__create-file-toggle");
    expect(checkbox?.className).toContain("glitter-write-stage__create-file-checkbox");
    expect(checkbox?.checked).toBe(true);
    expect(stylesCss).toContain(
      ".glitter-write-stage__create-file-indicator {\n  width: 16px;\n  height: 16px;\n  flex: 0 0 16px;\n  border-radius: 4px;"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__create-file-indicator {\n  width: 16px;\n  height: 16px;\n  flex: 0 0 16px;\n  border-radius: 4px;\n  border: 1px solid color-mix(in srgb, var(--glitter-ui-border-strong) 72%, white 8%);\n  background: color-mix(in srgb, var(--glitter-ui-bg-alt) 94%, var(--glitter-ui-bg) 6%);"
    );
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__create-file-indicator", ["box-shadow: none;"]);
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__create-file-indicator",
      "box-shadow: inset 0 1px 0 color-mix(in srgb, white 24%, transparent), 0 6px 14px color-mix(in srgb, black 18%, transparent);"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__create-file-checkbox:checked + .glitter-write-stage__create-file-indicator {\n  background: color-mix(in srgb, var(--glitter-ui-accent) 78%, var(--glitter-ui-bg-alt) 22%);\n  border-color: color-mix(in srgb, var(--glitter-ui-accent) 68%, var(--glitter-ui-border-strong) 32%);\n}"
    );
    expect(stylesCss).toContain(
      ".glitter-write-stage__create-file-checkbox:checked\n  + .glitter-write-stage__create-file-indicator\n  .glitter-write-stage__icon--check {\n  opacity: 1;\n  color: color-mix(in srgb, var(--glitter-ui-accent-contrast) 88%, white 12%);\n}"
    );

    checkbox!.checked = false;
    checkbox!.dispatchEvent({ type: "change" });

    expect(toggleCalls).toEqual([false]);
  });

  it("renders the create-file control as plain checkbox text in both first-use and global capture", () => {
    const firstUseContainer = createContainer();
    const globalContainer = createContainer();

    renderWriteView(firstUseContainer, buildWriteViewState("quick-capture-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    renderWriteView(
      globalContainer,
      buildWriteViewState({
        flowContext: "global",
        phase: "capture",
        contentKind: "text",
        importState: "idle"
      }),
      {
        onClose() {},
        onSubmit() {},
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    expect(firstUseContainer.querySelector(".glitter-write-stage__create-file-toggle")?.textContent).toContain(
      "保存灵感并创建文件"
    );
    expect(globalContainer.querySelector(".glitter-write-stage__create-file-toggle")?.textContent).toContain(
      "保存灵感并创建文件"
    );
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__create-file-toggle", [
      "width: auto;",
      "max-width: 100%;",
      "padding: 0;",
      "border: none;",
      "background: transparent;",
      "box-shadow: none;"
    ]);
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage--quick-capture .glitter-write-stage__create-file-toggle",
      ["border: none;", "background: transparent;", "box-shadow: none;"]
    );
    expectDeclarationsInSelectorBlock(
      stylesCss,
      ".glitter-write-stage--quick-capture .glitter-write-stage__create-file-indicator",
      [
        "border-color: color-mix(in srgb, var(--glitter-ui-border-strong) 72%, white 8%);",
        "background: color-mix(in srgb, var(--glitter-ui-bg-alt) 92%, var(--glitter-ui-bg) 8%);",
        "box-shadow: none;"
      ]
    );
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__create-file-toggle", "min-height: 34px;");
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__create-file-toggle", "border-radius: 9px;");
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__create-file-toggle",
      "width: max-content !important;"
    );
    expectNoDeclarationInSelectorBlock(
      stylesCss,
      ".glitter-write-stage__create-file-toggle",
      "inline-size: max-content !important;"
    );
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__create-file-toggle", "max-width: none;");
    expectNoDeclarationInSelectorBlock(stylesCss, ".glitter-write-stage__create-file-toggle", "flex: 0 0 max-content;");
  });

  it("renders immersive shell class and footer status text when present", () => {
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("write-immersive-error"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    const stage = container.querySelector(".glitter-write-stage") as
      | (HTMLElement & { className: string })
      | null;

    expect(stage?.className).toContain("glitter-write-stage--immersive");
    expect(container.querySelector(".glitter-write-stage__status")?.textContent).toContain(
      "Could not save draft"
    );
  });

  it("renders first-use saved-feedback as a focused next-step success card", () => {
    const submitCalls: string[] = [];
    const secondaryCalls: string[] = [];
    const closeCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "first-use",
        phase: "saved-feedback",
        contentKind: "text",
        importState: "idle",
        generatedTitle: "我的第一条灵感",
        inputText: "把水纹核心的频率调平稳一些",
        selectedPoolId: "pool-default",
        selectedPoolLabel: "未整理池"
      }),
      {
        onClose() {
          closeCalls.push("close");
        },
        onSubmit() {
          submitCalls.push("submit");
        },
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onSecondaryAction() {
          secondaryCalls.push("secondary");
        }
      }
    );

    const successCard = container.querySelector(".glitter-write-stage__success-card") as
      | (HTMLElement & { className: string })
      | null;
    const preview = container.querySelector(".glitter-write-stage__first-use-success-preview") as HTMLElement | null;
    const nextStep = container.querySelector(".glitter-write-stage__first-use-success-next-step") as HTMLElement | null;
    const statusChip = container.querySelector(".glitter-write-stage__first-use-success-chip") as HTMLElement | null;
    const previewBody = container.querySelector(".glitter-write-stage__first-use-success-body") as HTMLElement | null;
    const primaryButton = container.querySelector(
      ".glitter-write-stage__action-primary"
    ) as unknown as { textContent: string; click: () => void };
    const secondaryButton = container.querySelector(
      ".glitter-write-stage__action-secondary"
    ) as unknown as { textContent: string; click: () => void };
    const closeButton = container.querySelector(
      ".glitter-write-stage__success-close"
    ) as unknown as { click: () => void };

    expect(successCard).not.toBeNull();
    expect(successCard?.className).toContain("glitter-write-stage__first-use-success-card");
    expect(container.querySelector(".glitter-write-stage__title")?.textContent).toBe("灵感已保存");
    expect(container.querySelector(".glitter-write-stage__subtitle")?.textContent).toBe(
      "继续选择这条灵感要进入的灵感池。"
    );
    expect(container.querySelector(".glitter-write-stage__success-badge")).not.toBeNull();
    expect(statusChip).toBeNull();
    expect(preview).toBeNull();
    expect(previewBody).toBeNull();

    expect(nextStep).not.toBeNull();
    expect(nextStep?.querySelector(".glitter-write-stage__success-summary-title")?.textContent).toBe("下一步");
    expect(nextStep?.querySelector(".glitter-write-stage__success-summary-line")?.textContent).toBe(
      "继续为这条灵感选择目标池。"
    );

    expect(primaryButton.textContent).toContain("选择归池");
    expect(secondaryButton.textContent).toContain("返回首页");

    primaryButton.click();
    secondaryButton.click();
    closeButton.click();

    expect(submitCalls).toEqual(["submit"]);
    expect(secondaryCalls).toEqual(["secondary"]);
    expect(closeCalls).toEqual(["close"]);

    expect(container.querySelector(".glitter-write-stage__input--title")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__textarea--body")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__pool-button")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__status")).toBeNull();

    expect(stylesCss).toContain(".glitter-write-stage__first-use-success-card {");
    expect(stylesCss).toContain(".glitter-write-stage__first-use-success-next-step {");
    expect(stylesCss).not.toContain(".glitter-write-stage__first-use-success-preview {");
    expect(stylesCss).not.toContain(".glitter-write-stage__first-use-success-chip {");
    expect(stylesCss).not.toContain(".glitter-write-stage__first-use-success-body {");
  });

  it("renders global saved-feedback as P2 success modal and wires branch-specific actions", () => {
    const submitCalls: string[] = [];
    const secondaryCalls: string[] = [];
    const closeCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "saved-feedback",
        contentKind: "text",
        importState: "idle",
        selectedPoolLabel: "调研池",
        createFileChecked: true
      }),
      {
        onClose() {
          closeCalls.push("close");
        },
        onSubmit() {
          submitCalls.push("submit");
        },
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onSecondaryAction() {
          secondaryCalls.push("secondary");
        }
      }
    );

    const successCard = container.querySelector(".glitter-write-stage__success-card") as
      | (HTMLElement & { className: string })
      | null;
    const primaryButton = container.querySelector(
      ".glitter-write-stage__action-primary"
    ) as unknown as { textContent: string; click: () => void };
    const secondaryButton = container.querySelector(
      ".glitter-write-stage__action-secondary"
    ) as unknown as { textContent: string; click: () => void };
    const closeButton = container.querySelector(
      ".glitter-write-stage__success-close"
    ) as unknown as { click: () => void };

    expect(successCard).not.toBeNull();
    expect(successCard?.className).toContain("glitter-write-stage__modal-card");
    expect(container.querySelector(".glitter-write-stage__title")?.textContent).toBe("灵感已入池");
    expect(container.querySelector(".glitter-write-stage__success-badge")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__success-badge-ring")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__success-badge-icon")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__subtitle")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__success-summary")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__success-summary-title")).toBeNull();
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")).toHaveLength(2);
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")[0]?.textContent).toBe("· 已保存到调研池");
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")[1]?.textContent).toBe("· 可在池内继续编辑与创建文件");

    expect(primaryButton.textContent).toContain("进入池内");
    expect(secondaryButton.textContent).toContain("继续记录");

    primaryButton.click();
    secondaryButton.click();
    closeButton.click();

    expect(submitCalls).toEqual(["submit"]);
    expect(secondaryCalls).toEqual(["secondary"]);
    expect(closeCalls).toEqual(["close"]);

    expect(container.querySelector(".glitter-write-stage__input--title")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__textarea--body")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__pool-button")).toBeNull();
    expect(container.querySelector(".glitter-write-stage__status")).toBeNull();

    expect(stylesCss).toContain(".glitter-write-stage__success-card {");
    expect(stylesCss).toContain(".glitter-write-stage__success-badge {");
    expect(stylesCss).toContain(".glitter-write-stage__success-badge-ring {");
    expect(stylesCss).toContain(".glitter-write-stage__success-badge-icon {");
    expect(stylesCss).toContain(".glitter-write-stage__success-action-primary {");
    expect(stylesCss).toContain(".glitter-write-stage__success-summary {");
    expect(stylesCss).toContain(".glitter-write-stage__success-summary-title {");
    expect(stylesCss).toContain(".glitter-write-stage__success-summary-line {");
    expect(stylesCss).toContain(".glitter-write-stage__success-actions {");
    expect(stylesCss).toContain(".glitter-write-stage__success-action-secondary {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--enter-pool {");
  });

  it("keeps saved-feedback badge and footer actions matched to quick-capture sizing", () => {
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__success-badge", [
      "width: 49px;",
      "height: 49px;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__success-action-secondary,\n.glitter-write-stage__success-action-primary", [
      "height: 34px;",
      "min-height: 34px;",
      "flex: 0 0 132px;",
      "border-radius: 9px;",
      "padding: 0 14px;",
      "font-size: 13px;"
    ]);
  });

  it("keeps empty-submit feedback overlay styled as a centered mask prompt", () => {
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__empty-submit-feedback", [
      "position: absolute;",
      "inset: 0;",
      "display: grid;",
      "place-items: center;",
      "z-index: 8;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__empty-submit-feedback-scrim", [
      "position: absolute;",
      "inset: 0;"
    ]);
    expectDeclarationsInSelectorBlock(stylesCss, ".glitter-write-stage__empty-submit-feedback-dialog", [
      "position: relative;",
      "z-index: 1;",
      "border-radius: 999px;",
      "font-size: 13px;",
      "font-weight: 600;",
      "text-align: center;"
    ]);
  });

  it("renders global saving modal with loader icons and disabled footer actions", () => {
    const submitCalls: string[] = [];
    const secondaryCalls: string[] = [];
    const closeCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "saving",
        contentKind: "text",
        importState: "idle"
      }),
      {
        onClose() {
          closeCalls.push("close");
        },
        onSubmit() {
          submitCalls.push("submit");
        },
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onSecondaryAction() {
          secondaryCalls.push("secondary");
        }
      }
    );

    const closeButton = container.querySelector(
      ".glitter-write-stage__success-close"
    ) as unknown as { click: () => void };
    const badge = container.querySelector(".glitter-write-stage__success-badge") as
      | (HTMLElement & { className: string })
      | null;
    const badgeIcon = container.querySelector(".glitter-write-stage__success-badge-icon") as
      | (HTMLElement & { className: string })
      | null;
    const primaryButton = container.querySelector(
      ".glitter-write-stage__action-primary"
    ) as unknown as { textContent: string; click: () => void; disabled?: boolean };
    const secondaryButton = container.querySelector(
      ".glitter-write-stage__action-secondary"
    ) as unknown as { textContent: string; click: () => void; disabled?: boolean };

    expect(container.querySelector(".glitter-write-stage__title")?.textContent).toBe("灵感保存中");
    expect(container.querySelector(".glitter-write-stage__subtitle")?.textContent).toBe("正在写入灵感池与索引，请稍候…");
    expect(badge?.className).toContain("glitter-write-stage__success-badge--saving");
    expect(badgeIcon?.className).toContain("glitter-write-stage__icon--loader");
    expect(container.querySelector(".glitter-write-stage__success-summary-title")?.textContent).toBe("处理中");
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")).toHaveLength(2);
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")[0]?.textContent).toBe("· 正在保存标题与正文");
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")[1]?.textContent).toBe("· 正在同步池归属与状态标记");
    expect(primaryButton.textContent).toContain("保存中…");
    expect(secondaryButton.textContent).toContain("请稍候");
    expect(primaryButton.disabled).toBe(true);
    expect(secondaryButton.disabled).toBe(true);

    primaryButton.click();
    secondaryButton.click();
    closeButton.click();

    expect(submitCalls).toEqual([]);
    expect(secondaryCalls).toEqual([]);
    expect(closeCalls).toEqual(["close"]);
    expect(stylesCss).toContain(".glitter-write-stage__icon--loader {");
    expect(stylesCss).toContain("animation: glitter-write-stage-loader-spin 1.1s linear infinite;");
  });

  it("renders global save-failed modal with retry/edit actions", () => {
    const submitCalls: string[] = [];
    const secondaryCalls: string[] = [];
    const closeCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "save-failed",
        contentKind: "text",
        importState: "idle"
      }),
      {
        onClose() {
          closeCalls.push("close");
        },
        onSubmit() {
          submitCalls.push("submit");
        },
        onPoolPickerToggle() {},
        onRetryLinkImport() {},
        onSecondaryAction() {
          secondaryCalls.push("secondary");
        }
      }
    );

    const closeButton = container.querySelector(
      ".glitter-write-stage__success-close"
    ) as unknown as { click: () => void };
    const badge = container.querySelector(".glitter-write-stage__success-badge") as
      | (HTMLElement & { className: string })
      | null;
    const badgeIcon = container.querySelector(".glitter-write-stage__success-badge-icon") as
      | (HTMLElement & { className: string })
      | null;
    const primaryButton = container.querySelector(
      ".glitter-write-stage__action-primary"
    ) as unknown as { textContent: string; click: () => void; disabled?: boolean; children: Array<{ className: string }> };
    const secondaryButton = container.querySelector(
      ".glitter-write-stage__action-secondary"
    ) as unknown as { textContent: string; click: () => void; disabled?: boolean };

    expect(container.querySelector(".glitter-write-stage__title")?.textContent).toBe("灵感保存失败");
    expect(container.querySelector(".glitter-write-stage__subtitle")?.textContent).toBe("保存未完成，请检查必填信息或稍后重试。");
    expect(badge?.className).toContain("glitter-write-stage__success-badge--error");
    expect(badgeIcon?.className).toContain("glitter-write-stage__icon--alert");
    expect(container.querySelector(".glitter-write-stage__success-summary")?.className).toContain(
      "glitter-write-stage__success-summary--error"
    );
    expect(container.querySelector(".glitter-write-stage__success-summary-title")?.textContent).toBe("需处理");
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")).toHaveLength(2);
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")[0]?.textContent).toBe("· 池名称或内容可能为空");
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-line")[1]?.textContent).toBe("· 网络或文件系统暂不可用");
    expect(primaryButton.textContent).toContain("重试保存");
    expect(primaryButton.children[0]?.className).toContain("glitter-write-stage__icon--refresh");
    expect(secondaryButton.textContent).toContain("返回编辑");
    expect(primaryButton.disabled).toBe(false);
    expect(secondaryButton.disabled).toBe(false);

    primaryButton.click();
    secondaryButton.click();
    closeButton.click();

    expect(submitCalls).toEqual(["submit"]);
    expect(secondaryCalls).toEqual(["secondary"]);
    expect(closeCalls).toEqual(["close"]);
    expect(stylesCss).toContain(".glitter-write-stage__icon--alert {");
    expect(stylesCss).toContain(".glitter-write-stage__icon--refresh {");
  });

  it("disables global saved-feedback secondary CTA and does not route to close when branch secondary handler is omitted", () => {
    const closeCalls: string[] = [];
    const submitCalls: string[] = [];
    const container = createContainer();

    renderWriteView(
      container,
      buildWriteViewState({
        flowContext: "global",
        phase: "saved-feedback",
        contentKind: "text",
        importState: "idle",
        selectedPoolLabel: "默认池",
        createFileChecked: true
      }),
      {
        onClose() {
          closeCalls.push("close");
        },
        onSubmit() {
          submitCalls.push("submit");
        },
        onPoolPickerToggle() {},
        onRetryLinkImport() {}
      }
    );

    const secondaryButton = container.querySelector(
      ".glitter-write-stage__action-secondary"
    ) as unknown as { click: () => void; disabled?: boolean };

    expect(secondaryButton.disabled).toBe(true);

    secondaryButton.click();

    expect(closeCalls).toEqual([]);
    expect(submitCalls).toEqual([]);
  });

  it("preserves first-use save feedback next-step CTA and routes it through submit", () => {
    const container = createContainer();
    const submitCalls: string[] = [];

    renderWriteView(container, buildWriteViewState("quick-capture-first-use-saved"), {
      onClose() {},
      onSubmit() {
        submitCalls.push("submit");
      },
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    expect(container.querySelector(".glitter-write-stage__first-use-success-next-step")).not.toBeNull();
    expect(container.querySelectorAll(".glitter-write-stage__success-summary-title")).toHaveLength(1);
    expect(container.querySelector(".glitter-write-stage__success-summary-title")?.textContent).toContain("下一步");

    const choiceButton = container.querySelector(
      ".glitter-write-stage__action-primary"
    ) as unknown as { click: () => void; textContent: string };
    expect(choiceButton.textContent).toContain("选择归池");
    choiceButton.click();

    expect(submitCalls).toEqual(["submit"]);
  });

  it("clears previously rendered content before rerendering", () => {
    const container = createContainer();

    renderWriteView(container, buildWriteViewState("quick-capture-link-error"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });
    expect(container.querySelector(".glitter-write-stage__body-editor")).not.toBeNull();
    expect(container.querySelector(".glitter-write-stage__retry-link--inline")).toBeNull();

    renderWriteView(container, buildWriteViewState("write-immersive-default"), {
      onClose() {},
      onSubmit() {},
      onPoolPickerToggle() {},
      onRetryLinkImport() {}
    });

    expect(container.querySelector(".glitter-write-stage__retry-link")).toBeNull();
    expect(container.querySelector(".glitter-write-stage--immersive")).not.toBeNull();
  });
});
