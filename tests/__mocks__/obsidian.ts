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

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
	}

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

// Polyfill Obsidian HTMLElement extensions in test environment
if (typeof window !== "undefined" && typeof HTMLElement !== "undefined") {
  if (!(HTMLElement.prototype as any).createSpan) {
    (HTMLElement.prototype as any).createSpan = function (options?: any) {
      const span = document.createElement("span");
      if (options?.cls) span.className = options.cls;
      if (options?.text) span.textContent = options.text;
      this.appendChild(span);
      return span;
    };
  }
  if (!(HTMLElement.prototype as any).empty) {
    (HTMLElement.prototype as any).empty = function () {
      this.innerHTML = "";
    };
  }
  if (!(HTMLElement.prototype as any).createDiv) {
    (HTMLElement.prototype as any).createDiv = function (options?: any) {
      const div = document.createElement("div");
      if (options?.cls) div.className = options.cls;
      if (options?.text) div.textContent = options.text;
      this.appendChild(div);
      return div;
    };
  }
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
