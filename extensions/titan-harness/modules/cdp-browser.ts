/**
 * cdp-browser.ts — a dependency-free browser driver over the Chrome DevTools Protocol
 * (plan H8, §5.8 "orca-browser" lane; P8). This Orca build has no browser automation and
 * Kane is not installed, so simulated users drive a headless Chromium that already exists
 * on the machine: Playwright's `chrome-headless-shell` / `chrome` under
 * ~/.cache/ms-playwright, or brave-browser / google-chrome / chromium on PATH.
 *
 *   findChromium()            the first usable binary (TITAN_CHROMIUM env first)
 *   findFfmpeg()              ffmpeg on PATH, else ~/.cache/ms-playwright/ffmpeg-<version>/ffmpeg-linux
 *   CdpBrowser.launch(opts)   spawns `<chromium> --headless=new --no-sandbox
 *                             --remote-debugging-port=0 --user-data-dir=<dir> …`, reads the
 *                             ws URL from "DevTools listening on ws://…" (or DevToolsActivePort)
 *   browser.page()            Target.createTarget + attachToTarget(flatten) → a CdpPage
 *   page.goto/snapshot/click/fill/press/eval/screenshot/waitFor/consoleLog/networkLog
 *   runFlow(flow, outDir)     executes a FlowSpec step by step and writes step-<n>.png,
 *                             frames/frame-<n>.jpg (video input), snapshot-<n>.txt,
 *                             console.json, network.json, flow-result.json
 *
 * Transport: JSON-RPC over Node's global WebSocket (Node ≥ 22), ids + sessionId, event
 * subscriptions (Page, Runtime, Network, Log). Every command has a timeout; a CDP error
 * surfaces with its message. `--no-sandbox` is required on Ubuntu 23.10+ where AppArmor
 * disables unprivileged user namespaces (the launch fails with "No usable sandbox!"
 * otherwise); the profile lives in a throw-away directory. Pure Node, no pi.
 *
 * scripts/cdp-browser.mjs is the CLI over this module (Node's built-in type stripping
 * imports the .ts directly), and modules/workflow/runners/cdp-browser.ts is the verify
 * runner that turns a flow's files into an evidence package (source "cdp").
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ═══ Binaries ═══════════════════════════════════════════════════════════════

export type ChromiumKind = "headless-shell" | "chrome" | "brave";
export interface ChromiumBinary {
	path: string;
	kind: ChromiumKind;
}

const executable = (file: string): boolean => {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
};

/** Newest-first directories under `root` whose name starts with `prefix` (Playwright's cache layout). */
function cacheDirs(root: string, prefix: string): string[] {
	try {
		return fs
			.readdirSync(root)
			.filter((name) => name.startsWith(prefix))
			.sort()
			.reverse()
			.map((name) => path.join(root, name));
	} catch {
		return [];
	}
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(dir, name);
		if (executable(candidate)) return candidate;
	}
	return undefined;
}

/** The first usable Chromium: TITAN_CHROMIUM, Playwright's headless shell, Playwright's chrome, then brave/chrome/chromium on PATH. */
export function findChromium(env: NodeJS.ProcessEnv = process.env): ChromiumBinary | undefined {
	const override = env.TITAN_CHROMIUM;
	if (override) return executable(override) ? { path: override, kind: /headless[-_]shell/.test(override) ? "headless-shell" : /brave/.test(override) ? "brave" : "chrome" } : undefined;
	const home = env.HOME ?? os.homedir();
	const cache = path.join(home, ".cache", "ms-playwright");
	for (const dir of cacheDirs(cache, "chromium_headless_shell-")) {
		for (const rel of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-linux/chrome-headless-shell", "chrome-linux/headless_shell"]) {
			const candidate = path.join(dir, rel);
			if (executable(candidate)) return { path: candidate, kind: "headless-shell" };
		}
	}
	for (const dir of cacheDirs(cache, "chromium-")) {
		for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
			const candidate = path.join(dir, rel);
			if (executable(candidate)) return { path: candidate, kind: "chrome" };
		}
	}
	for (const name of ["brave-browser", "brave", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
		const found = onPath(name, env);
		if (found) return { path: found, kind: name.startsWith("brave") ? "brave" : "chrome" };
	}
	return undefined;
}

/** ffmpeg on PATH (or TITAN_FFMPEG), else Playwright's bundled ffmpeg-linux. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.TITAN_FFMPEG;
	if (override) return executable(override) ? override : undefined;
	const found = onPath("ffmpeg", env);
	if (found) return found;
	const home = env.HOME ?? os.homedir();
	for (const dir of cacheDirs(path.join(home, ".cache", "ms-playwright"), "ffmpeg-")) {
		for (const rel of ["ffmpeg-linux", "ffmpeg"]) {
			const candidate = path.join(dir, rel);
			if (executable(candidate)) return candidate;
		}
	}
	return undefined;
}

// ═══ Protocol plumbing ══════════════════════════════════════════════════════

export class CdpError extends Error {
	readonly method?: string;
	constructor(message: string, method?: string) {
		super(message);
		this.name = "CdpError";
		this.method = method;
	}
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

type EventListener = (params: Record<string, any>, sessionId?: string) => void;

const DEFAULT_TIMEOUT_MS = 15_000;

/** A JSON-RPC connection to one DevTools websocket (browser-level, sessions multiplexed by sessionId). */
export class CdpConnection {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, Set<EventListener>>();
	private closed = false;

	private readonly ws: WebSocket;
	readonly defaultTimeoutMs: number;

	private constructor(ws: WebSocket, defaultTimeoutMs: number) {
		this.ws = ws;
		this.defaultTimeoutMs = defaultTimeoutMs;
		ws.onmessage = (event: MessageEvent) => this.onMessage(String(event.data));
		ws.onclose = () => this.onClose(new CdpError("DevTools connection closed"));
		ws.onerror = () => this.onClose(new CdpError("DevTools connection error"));
	}

	static async open(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpConnection> {
		const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		if (!WS) throw new CdpError("this Node has no global WebSocket (Node ≥ 22 required)");
		const ws = new WS(url);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new CdpError(`DevTools websocket did not open within ${timeoutMs} ms`)), timeoutMs);
			ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new CdpError(`DevTools websocket failed to open (${url})`));
			};
		});
		return new CdpConnection(ws, timeoutMs);
	}

	private onMessage(raw: string): void {
		let msg: any;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id === "number" && this.pending.has(msg.id)) {
			const entry = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.error) entry.reject(new CdpError(`${entry.method}: ${msg.error.message ?? "error"}${msg.error.data ? ` (${msg.error.data})` : ""}`, entry.method));
			else entry.resolve(msg.result ?? {});
			return;
		}
		if (typeof msg.method === "string") {
			for (const listener of this.listeners.get(msg.method) ?? []) {
				try {
					listener(msg.params ?? {}, msg.sessionId);
				} catch {
					/* a listener never breaks the stream */
				}
			}
		}
	}

	private onClose(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = this.defaultTimeoutMs): Promise<T> {
		if (this.closed) return Promise.reject(new CdpError(`${method}: connection closed`, method));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(`${method}: no reply within ${timeoutMs} ms`, method));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
			try {
				this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new CdpError(`${method}: ${error instanceof Error ? error.message : String(error)}`, method));
			}
		});
	}

	on(method: string, listener: EventListener): () => void {
		const set = this.listeners.get(method) ?? new Set<EventListener>();
		set.add(listener);
		this.listeners.set(method, set);
		return () => set.delete(listener);
	}

	close(): void {
		this.onClose(new CdpError("closed"));
		try {
			this.ws.close();
		} catch {}
	}
}

// ═══ Pages ══════════════════════════════════════════════════════════════════

export interface ConsoleEntry {
	level: string;
	text: string;
	ts: number;
	source: "console" | "log" | "exception";
}

export interface NetworkEntry {
	requestId: string;
	url: string;
	method: string;
	status?: number;
	type?: string;
	ts: number;
	failed?: string;
}

export interface GotoOptions {
	waitUntil?: "load" | "networkidle";
	timeoutMs?: number;
}

const SNAPSHOT_SCRIPT = String.raw`(() => {
	const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
	const lines = [];
	lines.push("title: " + document.title);
	lines.push("url: " + location.href);
	const body = (document.body && document.body.innerText) || "";
	lines.push("--- text ---");
	lines.push(body.replace(/\n{3,}/g, "\n\n").trim());
	lines.push("--- interactive ---");
	for (const h of document.querySelectorAll("h1,h2,h3")) lines.push("[" + h.tagName.toLowerCase() + "] " + text(h));
	for (const a of document.querySelectorAll("a[href]")) lines.push("[link] " + (text(a) || a.getAttribute("aria-label") || a.id || "(no text)") + " -> " + a.getAttribute("href"));
	for (const b of document.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")) lines.push("[button] " + (text(b) || b.value || b.getAttribute("aria-label") || b.id || "(no text)"));
	for (const i of document.querySelectorAll("input:not([type=submit]):not([type=button]):not([type=hidden]),textarea,select")) lines.push("[input] " + (i.id ? "#" + i.id : i.name ? "[name=" + i.name + "]" : i.tagName.toLowerCase()) + (i.type ? " type=" + i.type : "") + (i.placeholder ? " placeholder=" + JSON.stringify(i.placeholder) : "") + (i.value ? " value=" + JSON.stringify(String(i.value).slice(0, 80)) : ""));
	return lines.join("\n");
})()`;

const FIND_SCRIPT = String.raw`(target) => {
	const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
	let el = null;
	try { el = document.querySelector(target); } catch {}
	if (!el) {
		const wanted = norm(target);
		const candidates = Array.from(document.querySelectorAll("a,button,[role=button],input[type=submit],input[type=button],label,summary,li,span,div,p,h1,h2,h3,td,th"));
		el = candidates.find((c) => norm(c.innerText || c.textContent || c.value) === wanted) || candidates.find((c) => norm(c.innerText || c.textContent || c.value).includes(wanted) && (c.matches("a,button,[role=button],input,label,summary")));
		if (!el) el = candidates.find((c) => norm(c.innerText || c.textContent || c.value).includes(wanted));
	}
	return el;
}`;

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
	Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	Delete: { key: "Delete", code: "Delete", vk: 46 },
	Space: { key: " ", code: "Space", vk: 32, text: " " },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	Home: { key: "Home", code: "Home", vk: 36 },
	End: { key: "End", code: "End", vk: 35 },
	PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
	PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpPage {
	private readonly consoleEntries: ConsoleEntry[] = [];
	private readonly networkEntries = new Map<string, NetworkEntry>();
	private readonly networkOrder: string[] = [];
	private inFlight = 0;
	private lastNetworkActivity = Date.now();
	private loadedAt = 0;
	private navigations = 0; // main-frame navigations seen (clicks that navigate are settled before the next step)
	private readonly unsubscribe: Array<() => void> = [];

	private readonly conn: CdpConnection;
	readonly targetId: string;
	readonly sessionId: string;
	readonly timeoutMs: number;

	constructor(conn: CdpConnection, targetId: string, sessionId: string, timeoutMs: number) {
		this.conn = conn;
		this.targetId = targetId;
		this.sessionId = sessionId;
		this.timeoutMs = timeoutMs;
		const only = (fn: EventListener): EventListener => (params, sid) => {
			if (sid === sessionId) fn(params, sid);
		};
		this.unsubscribe.push(
			conn.on(
				"Runtime.consoleAPICalled",
				only((p) => {
					const text = (p.args ?? []).map((arg: any) => (arg.value !== undefined ? (typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value)) : (arg.description ?? arg.type ?? ""))).join(" ");
					this.consoleEntries.push({ level: String(p.type ?? "log"), text, ts: Date.now(), source: "console" });
				}),
			),
			conn.on(
				"Log.entryAdded",
				only((p) => {
					const entry = p.entry ?? {};
					this.consoleEntries.push({ level: String(entry.level ?? "info"), text: String(entry.text ?? ""), ts: Date.now(), source: "log" });
				}),
			),
			conn.on(
				"Runtime.exceptionThrown",
				only((p) => {
					const details = p.exceptionDetails ?? {};
					const text = details.exception?.description ?? details.text ?? "uncaught exception";
					this.consoleEntries.push({ level: "error", text: String(text), ts: Date.now(), source: "exception" });
				}),
			),
			conn.on(
				"Network.requestWillBeSent",
				only((p) => {
					const id = String(p.requestId);
					if (!this.networkEntries.has(id)) {
						this.networkOrder.push(id);
						this.inFlight++;
					}
					this.networkEntries.set(id, { requestId: id, url: String(p.request?.url ?? ""), method: String(p.request?.method ?? "GET"), type: p.type, ts: Date.now() });
					this.lastNetworkActivity = Date.now();
				}),
			),
			conn.on(
				"Network.responseReceived",
				only((p) => {
					const entry = this.networkEntries.get(String(p.requestId));
					if (entry) entry.status = Number(p.response?.status ?? 0) || undefined;
					this.lastNetworkActivity = Date.now();
				}),
			),
			conn.on(
				"Network.loadingFinished",
				only((p) => {
					if (this.networkEntries.has(String(p.requestId))) this.inFlight = Math.max(0, this.inFlight - 1);
					this.lastNetworkActivity = Date.now();
				}),
			),
			conn.on(
				"Network.loadingFailed",
				only((p) => {
					const entry = this.networkEntries.get(String(p.requestId));
					if (entry) {
						entry.failed = String(p.errorText ?? "failed");
						this.inFlight = Math.max(0, this.inFlight - 1);
					}
					this.lastNetworkActivity = Date.now();
				}),
			),
			conn.on(
				"Page.loadEventFired",
				only(() => {
					this.loadedAt = Date.now();
				}),
			),
			conn.on(
				"Page.frameStartedLoading",
				only(() => {
					this.navigations += 1;
				}),
			),
		);
	}

	/** Enable the domains every method relies on. */
	async init(): Promise<void> {
		for (const domain of ["Page", "Runtime", "Network", "Log"]) await this.conn.send(`${domain}.enable`, {}, this.sessionId, this.timeoutMs);
	}

	private async waitForLoad(since: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.loadedAt >= since) return;
			await sleep(50);
		}
		throw new CdpError(`page did not finish loading within ${timeoutMs} ms`);
	}

	/** Page.captureScreenshot, retried once after a load when the page was mid-navigation. */
	private async capture(timeoutMs: number): Promise<Buffer> {
		try {
			const result = await this.conn.send("Page.captureScreenshot", { format: "png" }, this.sessionId, timeoutMs);
			return Buffer.from(String(result.data ?? ""), "base64");
		} catch (error) {
			await this.settle(this.navigations - 1, timeoutMs);
			const result = await this.conn.send("Page.captureScreenshot", { format: "png" }, this.sessionId, timeoutMs);
			void error;
			return Buffer.from(String(result.data ?? ""), "base64");
		}
	}

	private async waitForNetworkIdle(timeoutMs: number, quietMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.inFlight === 0 && Date.now() - this.lastNetworkActivity >= quietMs) return;
			await sleep(50);
		}
		throw new CdpError(`network did not go idle within ${timeoutMs} ms (${this.inFlight} request(s) in flight)`);
	}

	/** A marker for settle(): the navigation count now. */
	mark(): number {
		return this.navigations;
	}

	/**
	 * After an interaction: when a navigation started since `marker`, wait for its load event
	 * and a short network-idle window; otherwise return at once. Never throws past the timeout —
	 * the next step's own call reports what is really wrong.
	 */
	async settle(marker: number, timeoutMs = this.timeoutMs): Promise<boolean> {
		const deadline = Date.now() + Math.min(timeoutMs, 3_000);
		while (Date.now() < deadline && this.navigations === marker) await sleep(50); // a click's navigation starts asynchronously
		if (this.navigations === marker) return false;
		try {
			await this.waitForLoad(Date.now() - 1, timeoutMs);
			await this.waitForNetworkIdle(Math.min(timeoutMs, 5_000), 300);
		} catch {
			/* a slow page is reported by the next step */
		}
		return true;
	}

	async goto(url: string, opts: GotoOptions = {}): Promise<{ url: string; status?: number }> {
		const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
		const since = Date.now() - 1;
		const result = await this.conn.send("Page.navigate", { url }, this.sessionId, timeoutMs);
		if (result.errorText) throw new CdpError(`navigation to ${url} failed: ${result.errorText}`);
		await this.waitForLoad(since, timeoutMs);
		if (opts.waitUntil === "networkidle") await this.waitForNetworkIdle(timeoutMs);
		const main = this.networkOrder.map((id) => this.networkEntries.get(id)!).find((entry) => entry.url === url || entry.type === "Document");
		return { url: await this.eval<string>("location.href"), status: main?.status };
	}

	/** Evaluate an expression in the page and return its value (promises awaited; exceptions thrown as CdpError). */
	async eval<T = unknown>(expression: string, timeoutMs = this.timeoutMs): Promise<T> {
		const result = await this.conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId, timeoutMs);
		if (result.exceptionDetails) {
			const details = result.exceptionDetails;
			throw new CdpError(`eval failed: ${details.exception?.description ?? details.text ?? "exception"}`);
		}
		return result.result?.value as T;
	}

	/** Call a page-side function with JSON arguments. */
	private async call<T = unknown>(fnSource: string, ...args: unknown[]): Promise<T> {
		return this.eval<T>(`(${fnSource})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
	}

	/** Title, URL, visible text and an interactive-element list — what a sim-user worker reads. */
	async snapshot(maxChars = 12_000): Promise<string> {
		const text = await this.eval<string>(SNAPSHOT_SCRIPT);
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]` : text;
	}

	/** Click a CSS selector, or the first element whose text matches. */
	async click(selectorOrText: string): Promise<{ tag: string; text: string }> {
		const found = await this.call<{ tag: string; text: string } | null>(
			`(target) => { const find = ${FIND_SCRIPT}; const el = find(target); if (!el) return null; el.scrollIntoView({ block: "center" }); el.click(); return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 80) }; }`,
			selectorOrText,
		);
		if (!found) throw new CdpError(`click: nothing matches ${JSON.stringify(selectorOrText)}`);
		return found;
	}

	/** Fill an input/textarea/select (native setter + input/change events so frameworks notice). */
	async fill(selector: string, value: string): Promise<void> {
		const ok = await this.call<boolean>(
			`(selector, value) => {
				const el = document.querySelector(selector);
				if (!el) return false;
				el.focus();
				const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
				const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
				if (setter) setter.call(el, value); else el.value = value;
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				return true;
			}`,
			selector,
			value,
		);
		if (!ok) throw new CdpError(`fill: no element matches ${JSON.stringify(selector)}`);
	}

	/** Press a key (Enter, Tab, Escape, arrows, …) or type a single character. */
	async press(key: string): Promise<void> {
		const known = KEYS[key];
		const spec = known ?? (key.length === 1 ? { key, code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key } : undefined);
		if (!spec) throw new CdpError(`press: unknown key ${JSON.stringify(key)}`);
		const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
		await this.conn.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) }, this.sessionId, this.timeoutMs);
		await this.conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, this.sessionId, this.timeoutMs);
	}

	/** Wait until a selector exists or the page text contains `selectorOrText`. */
	async waitFor(selectorOrText: string, timeoutMs = this.timeoutMs): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = await this.call<boolean>(
				`(target) => { try { if (document.querySelector(target)) return true; } catch {} return ((document.body && document.body.innerText) || "").toLowerCase().includes(String(target).toLowerCase()); }`,
				selectorOrText,
			);
			if (found) return;
			await sleep(100);
		}
		throw new CdpError(`waitFor: ${JSON.stringify(selectorOrText)} did not appear within ${timeoutMs} ms`);
	}

	/** Page.captureScreenshot → a PNG file (evidence); optionally a JPEG copy too (video frames: the only image input Playwright's ffmpeg decodes). */
	async screenshot(file: string, opts: { jpegFile?: string; quality?: number } = {}): Promise<{ path: string; bytes: number; jpeg?: string }> {
		const buffer = await this.capture(Math.min(this.timeoutMs, 10_000));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, buffer, { mode: 0o600 });
		const result: { path: string; bytes: number; jpeg?: string } = { path: file, bytes: buffer.length };
		if (opts.jpegFile) {
			try {
				const jpeg = await this.conn.send("Page.captureScreenshot", { format: "jpeg", quality: opts.quality ?? 80 }, this.sessionId, Math.min(this.timeoutMs, 10_000));
				fs.mkdirSync(path.dirname(opts.jpegFile), { recursive: true });
				fs.writeFileSync(opts.jpegFile, Buffer.from(String(jpeg.data ?? ""), "base64"), { mode: 0o600 });
				result.jpeg = opts.jpegFile;
			} catch {
				/* the PNG is the evidence; a missing video frame only shortens the video */
			}
		}
		return result;
	}

	consoleLog(): ConsoleEntry[] {
		return [...this.consoleEntries];
	}

	networkLog(): NetworkEntry[] {
		return this.networkOrder.map((id) => ({ ...this.networkEntries.get(id)! }));
	}

	async close(): Promise<void> {
		for (const off of this.unsubscribe) off();
		try {
			await this.conn.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5_000);
		} catch {}
	}
}

// ═══ Browser process ════════════════════════════════════════════════════════

export interface LaunchOptions {
	chromium?: string;
	userDataDir: string;
	width?: number;
	height?: number;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export class CdpBrowser {
	private readonly proc: ChildProcess;
	private readonly conn: CdpConnection;
	readonly wsUrl: string;
	readonly binary: ChromiumBinary;
	readonly timeoutMs: number;

	private constructor(proc: ChildProcess, conn: CdpConnection, wsUrl: string, binary: ChromiumBinary, timeoutMs: number) {
		this.proc = proc;
		this.conn = conn;
		this.wsUrl = wsUrl;
		this.binary = binary;
		this.timeoutMs = timeoutMs;
	}

	static async launch(opts: LaunchOptions): Promise<CdpBrowser> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const binary = opts.chromium ? { path: opts.chromium, kind: (/headless[-_]shell/.test(opts.chromium) ? "headless-shell" : /brave/.test(opts.chromium) ? "brave" : "chrome") as ChromiumKind } : findChromium(opts.env ?? process.env);
		if (!binary) throw new CdpError("no Chromium found (Playwright cache, brave-browser or chrome); set TITAN_CHROMIUM");
		fs.mkdirSync(opts.userDataDir, { recursive: true, mode: 0o700 });
		const args = [
			"--headless=new",
			"--no-sandbox", // AppArmor on Ubuntu 23.10+ blocks the userns sandbox for unprivileged binaries
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--remote-debugging-port=0",
			`--user-data-dir=${opts.userDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--hide-scrollbars",
			`--window-size=${opts.width ?? 1280},${opts.height ?? 800}`,
			"about:blank",
		];
		const proc = spawn(binary.path, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", env: { ...(opts.env ?? process.env) } });
		let stderr = "";
		const wsUrl = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				const fromFile = readActivePort(opts.userDataDir);
				if (fromFile) resolve(fromFile);
				else reject(new CdpError(`Chromium did not announce a DevTools endpoint within ${timeoutMs} ms: ${stderr.trim().slice(-500)}`));
			}, timeoutMs);
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
				if (match) {
					clearTimeout(timer);
					resolve(match[1]);
				}
			});
			proc.on("exit", (code) => {
				clearTimeout(timer);
				reject(new CdpError(`Chromium exited with code ${code} before opening DevTools: ${stderr.trim().slice(-500)}`));
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				reject(new CdpError(`failed to spawn ${binary.path}: ${error.message}`));
			});
		});
		try {
			const conn = await CdpConnection.open(wsUrl, timeoutMs);
			return new CdpBrowser(proc, conn, wsUrl, binary, timeoutMs);
		} catch (error) {
			killTree(proc);
			throw error;
		}
	}

	/** A fresh tab with Page/Runtime/Network/Log enabled. */
	async page(): Promise<CdpPage> {
		const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" }, undefined, this.timeoutMs);
		const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true }, undefined, this.timeoutMs);
		const page = new CdpPage(this.conn, String(targetId), String(sessionId), this.timeoutMs);
		await page.init();
		return page;
	}

	async close(): Promise<void> {
		try {
			await this.conn.send("Browser.close", {}, undefined, 3_000);
		} catch {}
		this.conn.close();
		killTree(this.proc);
		await new Promise<void>((resolve) => {
			if (this.proc.exitCode !== null || this.proc.signalCode) return resolve();
			const timer = setTimeout(() => {
				try {
					if (this.proc.pid) process.kill(-this.proc.pid, "SIGKILL");
				} catch {}
				resolve();
			}, 2_000);
			this.proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

function readActivePort(userDataDir: string): string | undefined {
	try {
		const [port, wsPath] = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n");
		if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
	} catch {}
	return undefined;
}

function killTree(proc: ChildProcess): void {
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGTERM");
		else proc.kill("SIGTERM");
	} catch {
		try {
			proc.kill("SIGTERM");
		} catch {}
	}
}

// ═══ Flows ══════════════════════════════════════════════════════════════════

/** One step of a simulated-user flow: exactly one action key. */
export interface FlowStep {
	goto?: string;
	click?: string;
	fill?: { selector: string; value: string } | string;
	press?: string;
	wait?: string | number;
	screenshot?: string | boolean;
	snapshot?: boolean;
	eval?: string;
	/** The page text must contain this after the step (fails the flow otherwise). */
	expect?: string;
	note?: string;
}

export interface FlowSpec {
	name: string;
	url?: string;
	description?: string;
	steps: FlowStep[];
}

export interface FlowStepResult {
	n: number;
	action: string;
	ok: boolean;
	error?: string;
	ms: number;
	screenshot?: string;
	snapshot?: string;
	value?: unknown;
}

export interface FlowResult {
	ok: boolean;
	name: string;
	url?: string;
	startedAt: string;
	endedAt: string;
	steps: FlowStepResult[];
	frames: number;
	console: number;
	network: number;
	error?: string;
	chromium?: string;
}

export interface RunFlowOptions {
	chromium?: string;
	timeoutMs?: number;
	/** Screenshot after every step (default true) — these frames are also the video's input. */
	frameEveryStep?: boolean;
	env?: NodeJS.ProcessEnv;
	width?: number;
	height?: number;
}

const stepAction = (step: FlowStep): string => {
	for (const key of ["goto", "click", "fill", "press", "wait", "screenshot", "snapshot", "eval", "expect"] as const) if (step[key] !== undefined) return key;
	return "noop";
};

/** Execute a flow in a fresh headless browser and write its artifacts under `outDir`. Never throws for a step failure (flow-result.json says). */
export async function runFlow(flow: FlowSpec, outDir: string, opts: RunFlowOptions = {}): Promise<FlowResult> {
	fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const startedAt = new Date().toISOString();
	const steps: FlowStepResult[] = [];
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "titan-cdp-"));
	let browser: CdpBrowser | undefined;
	let page: CdpPage | undefined;
	let frames = 0;
	let flowError: string | undefined;
	const frameEveryStep = opts.frameEveryStep ?? true;
	const writeJson = (name: string, value: unknown) => fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	try {
		browser = await CdpBrowser.launch({ chromium: opts.chromium, userDataDir: profile, timeoutMs: opts.timeoutMs, env: opts.env, width: opts.width, height: opts.height });
		page = await browser.page();
		const all: FlowStep[] = [...(flow.url ? [{ goto: flow.url }] : []), ...flow.steps];
		let n = 0;
		for (const step of all) {
			n += 1;
			const action = stepAction(step);
			const started = Date.now();
			const result: FlowStepResult = { n, action, ok: true, ms: 0 };
			try {
				const marker = page.mark();
				if (step.goto !== undefined) await page.goto(step.goto, { waitUntil: "networkidle", timeoutMs: opts.timeoutMs });
				else if (step.click !== undefined) result.value = await page.click(step.click);
				else if (step.fill !== undefined) {
					const spec = typeof step.fill === "string" ? parseFill(step.fill) : step.fill;
					await page.fill(spec.selector, spec.value);
				} else if (step.press !== undefined) await page.press(step.press);
				else if (step.wait !== undefined) {
					if (typeof step.wait === "number") await sleep(step.wait);
					else await page.waitFor(step.wait, opts.timeoutMs);
				} else if (step.eval !== undefined) result.value = await page.eval(step.eval);
				if (action !== "goto" && action !== "wait" && action !== "snapshot" && action !== "screenshot") await page.settle(marker, opts.timeoutMs);
				if (step.snapshot) {
					const file = path.join(outDir, `snapshot-${n}.txt`);
					fs.writeFileSync(file, await page.snapshot(), { mode: 0o600 });
					result.snapshot = file;
				}
				if (step.expect !== undefined) {
					await page.waitFor(step.expect, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000));
				}
				if (frameEveryStep || step.screenshot) {
					const file = path.join(outDir, `step-${String(n).padStart(3, "0")}.png`);
					await page.screenshot(file, { jpegFile: path.join(outDir, "frames", `frame-${String(n).padStart(3, "0")}.jpg`) });
					result.screenshot = file;
					frames += 1;
				}
			} catch (error) {
				result.ok = false;
				result.error = error instanceof Error ? error.message : String(error);
				try {
					const file = path.join(outDir, `step-${String(n).padStart(3, "0")}-failed.png`);
					await page.screenshot(file, { jpegFile: path.join(outDir, "frames", `frame-${String(n).padStart(3, "0")}-failed.jpg`) });
					result.screenshot = file;
					frames += 1;
				} catch {}
			}
			result.ms = Date.now() - started;
			steps.push(result);
			if (!result.ok) break;
		}
		// The final state, always: a snapshot the reviewer can read without the browser.
		try {
			fs.writeFileSync(path.join(outDir, "snapshot-final.txt"), await page.snapshot(), { mode: 0o600 });
		} catch {}
	} catch (error) {
		flowError = error instanceof Error ? error.message : String(error);
	} finally {
		const consoleEntries = page?.consoleLog() ?? [];
		const networkEntries = page?.networkLog() ?? [];
		writeJson("console.json", consoleEntries);
		writeJson("network.json", networkEntries);
		try {
			await page?.close();
		} catch {}
		try {
			await browser?.close();
		} catch {}
		try {
			fs.rmSync(profile, { recursive: true, force: true });
		} catch {}
		const result: FlowResult = {
			ok: !flowError && steps.length > 0 && steps.every((step) => step.ok),
			name: flow.name,
			url: flow.url,
			startedAt,
			endedAt: new Date().toISOString(),
			steps,
			frames,
			console: consoleEntries.length,
			network: networkEntries.length,
			error: flowError,
			chromium: browser?.binary.path,
		};
		writeJson("flow-result.json", result);
		return result;
	}
}

/** "selector=value" or "selector: value" → {selector, value}. */
export function parseFill(text: string): { selector: string; value: string } {
	// The first `=` or `:` outside [attribute] brackets and quotes splits selector from value.
	let depth = 0;
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[") depth++;
		else if (ch === "]") depth = Math.max(0, depth - 1);
		else if ((ch === "=" || ch === ":") && depth === 0 && i > 0) {
			return { selector: text.slice(0, i).trim(), value: text.slice(i + 1).replace(/^\s+/, "") };
		}
	}
	throw new CdpError(`fill: expected "selector=value", got ${JSON.stringify(text)}`);
}

/** Parse and lightly validate a flow document (a FlowSpec or {flows:[…]} takes the first). */
export function parseFlow(value: unknown): FlowSpec {
	const raw = (value && typeof value === "object" && Array.isArray((value as { flows?: unknown }).flows) ? (value as { flows: unknown[] }).flows[0] : value) as Partial<FlowSpec> | undefined;
	if (!raw || typeof raw !== "object") throw new CdpError("flow: expected an object with name and steps");
	if (typeof raw.name !== "string" || !raw.name.trim()) throw new CdpError("flow: name is required");
	if (!Array.isArray(raw.steps)) throw new CdpError("flow: steps must be an array");
	const steps = raw.steps.map((step, i) => {
		if (!step || typeof step !== "object") throw new CdpError(`flow: step ${i + 1} is not an object`);
		if (stepAction(step as FlowStep) === "noop") throw new CdpError(`flow: step ${i + 1} has no action (goto|click|fill|press|wait|screenshot|snapshot|eval|expect)`);
		return step as FlowStep;
	});
	return { name: raw.name.trim(), url: typeof raw.url === "string" ? raw.url : undefined, description: typeof raw.description === "string" ? raw.description : undefined, steps };
}
