// Minimal mock of the type-only `obsidian` package so that unit tests can
// resolve `import { ... } from "obsidian"` without the real Obsidian runtime.
// Extend these stubs as your tests need them.

export class Plugin {
	app: any;
	manifest: any;

	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}

	async onload(): Promise<void> {}
	onunload(): void {}
	addCommand(_command: any): any {}
	addSettingTab(_tab: any): void {}
	registerEvent(_event: any): void {}
	registerDomEvent(_el: any, _type: string, _callback: any): void {}
	registerEditorExtension(_extension: any): void {}
	registerInterval(_id: number): number {
		return _id;
	}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;
	settingItems: any[] = [];

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
	}

	// Declarative settings API (Obsidian 1.13+). The real base class reads/writes
	// plugin.settings; tests only need the stubs to exist and be callable.
	getSettingDefinitions(): any[] {
		return [];
	}
	getControlValue(_key: string): unknown {
		return undefined;
	}
	setControlValue(_key: string, _value: unknown): void | Promise<void> {}
	update(): void {}
	refreshDomState(): void {}

	display(): void {}
	hide(): void {}
}

export class Setting {
	containerEl: any;
	settingEl: any;

	constructor(_containerEl: any) {
		this.containerEl = _containerEl;
	}

	setName(_name: string): this {
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	addText(_cb: (text: any) => any): this {
		return this;
	}
	addToggle(_cb: (toggle: any) => any): this {
		return this;
	}
	addSlider(_cb: (slider: any) => any): this {
		const mockSlider = {
			setLimits: function () {
				return this;
			},
			setValue: function () {
				return this;
			},
			setDynamicTooltip: function () {
				return this;
			},
			onChange: function () {
				return this;
			},
		};
		_cb(mockSlider);
		return this;
	}
	addButton(_cb: (button: any) => any): this {
		return this;
	}
	addDropdown(_cb: (dropdown: any) => any): this {
		const mockDropdown = {
			addOption: function () {
				return this;
			},
			setValue: function () {
				return this;
			},
			onChange: function () {
				return this;
			},
		};
		_cb(mockDropdown);
		return this;
	}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
	setMessage(_message: string): this {
		return this;
	}
	hide(): void {}
}

export class Modal {
	app: any;
	contentEl: any;

	constructor(app: any) {
		this.app = app;
	}

	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class SuggestModal extends Modal {
  inputEl: any;
  resultContainerEl: any;
  constructor(app: any) {
    super(app);
    this.inputEl = { value: "", dispatchEvent: () => {} };
    this.resultContainerEl = { querySelector: () => null };
  }
  setPlaceholder(text: string): void {}
}

export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
}

// Polyfill Obsidian HTMLElement/DocumentFragment extensions in test environment.
// Mirrors the subset of Obsidian's `DomElementInfo`-based helpers (createEl/createDiv/
// createSpan/createFragment/appendText) that plugin source code relies on, so tests can
// exercise real widget-construction code without a live Obsidian runtime.
function applyDomElementInfo(el: any, options?: any) {
  if (!options) return;
  if (typeof options === "string") {
    el.className = options;
    return;
  }
  if (options.cls) {
    el.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  }
  if (options.text !== undefined) el.textContent = options.text;
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) {
      if (value === null || value === false) continue;
      el.setAttribute(key, String(value));
    }
  }
  if (options.title !== undefined) el.title = options.title;
  if (options.type !== undefined) el.type = options.type;
  if (options.value !== undefined) el.value = options.value;
  if (options.placeholder !== undefined) el.placeholder = options.placeholder;
  if (options.href !== undefined) el.href = options.href;
}

function mockCreateEl(this: any, tag: string, options?: any, callback?: (el: any) => void) {
  const el = document.createElement(tag);
  applyDomElementInfo(el, options);
  if (typeof options === "object" && options?.parent) {
    options.parent.appendChild(el);
  } else if (typeof options === "object" && options?.prepend) {
    this.insertBefore(el, this.firstChild);
  } else {
    this.appendChild(el);
  }
  callback?.(el);
  return el;
}

if (typeof window !== "undefined" && typeof HTMLElement !== "undefined") {
  if (!(HTMLElement.prototype as any).createEl) {
    (HTMLElement.prototype as any).createEl = function (
      tag: string,
      options?: any,
      callback?: (el: any) => void
    ) {
      return mockCreateEl.call(this, tag, options, callback);
    };
  }
  if (!(HTMLElement.prototype as any).createSpan) {
    (HTMLElement.prototype as any).createSpan = function (options?: any, callback?: (el: any) => void) {
      return mockCreateEl.call(this, "span", options, callback);
    };
  }
  if (!(HTMLElement.prototype as any).createDiv) {
    (HTMLElement.prototype as any).createDiv = function (options?: any, callback?: (el: any) => void) {
      return mockCreateEl.call(this, "div", options, callback);
    };
  }
  if (!(HTMLElement.prototype as any).empty) {
    (HTMLElement.prototype as any).empty = function () {
      this.innerHTML = "";
    };
  }
  if (!(HTMLElement.prototype as any).setText) {
    (HTMLElement.prototype as any).setText = function (val: string) {
      this.textContent = val;
      return this;
    };
  }
  if (!(HTMLElement.prototype as any).appendText) {
    (HTMLElement.prototype as any).appendText = function (val: string) {
      this.appendChild(document.createTextNode(val));
    };
  }
}
if (typeof window !== "undefined" && typeof DocumentFragment !== "undefined") {
  if (!(DocumentFragment.prototype as any).createEl) {
    (DocumentFragment.prototype as any).createEl = function (
      tag: string,
      options?: any,
      callback?: (el: any) => void
    ) {
      return mockCreateEl.call(this, tag, options, callback);
    };
  }
  if (!(DocumentFragment.prototype as any).createSpan) {
    (DocumentFragment.prototype as any).createSpan = function (options?: any, callback?: (el: any) => void) {
      return mockCreateEl.call(this, "span", options, callback);
    };
  }
  if (!(DocumentFragment.prototype as any).createDiv) {
    (DocumentFragment.prototype as any).createDiv = function (options?: any, callback?: (el: any) => void) {
      return mockCreateEl.call(this, "div", options, callback);
    };
  }
}
if (typeof window !== "undefined") {
  (globalThis as any).createFragment = function (callback?: (el: DocumentFragment) => void) {
    const fragment = document.createDocumentFragment();
    callback?.(fragment as any);
    return fragment;
  };
}

export interface Loc {
  line: number;
  col: number;
  offset: number;
}
export interface Pos {
  start: Loc;
  end: Loc;
}
export interface CacheItem {
  position: Pos;
}
export interface ReferenceCache extends CacheItem {
  link: string;
  original: string;
  displayText?: string;
}
export interface LinkCache extends ReferenceCache {}
export interface EmbedCache extends ReferenceCache {}
export interface FrontmatterLinkCache extends ReferenceCache {
  key: string;
}
export interface SectionCache {
  type: string;
  position: Pos;
}
export interface FrontMatterCache {
  [key: string]: any;
  position?: Pos;
}
export interface CachedMetadataMock {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  frontmatter?: FrontMatterCache;
  frontmatterPosition?: Pos;
  sections?: SectionCache[];
}

export function mockFileCache(overrides: Partial<CachedMetadataMock> = {}): CachedMetadataMock {
  return {
    links: [],
    embeds: [],
    ...overrides,
  };
}

export function setIcon(parent: HTMLElement | any, _iconId: string): void {
  if (parent) {
    const iconSpan = document.createElement("span");
    iconSpan.className = "svg-icon lucide-" + _iconId;
    parent.appendChild(iconSpan);
  }
}
