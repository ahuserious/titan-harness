import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBrowser, CdpError, findChromium, findFfmpeg, parseFill, parseFlow, runFlow } from "../modules/cdp-browser.ts";
import { runProcess } from "../modules/workflow-runtime.ts";
import { buildEvidence, hashArtifact } from "../modules/workflow/evidence.ts";
import { cdpBrowserRunner, flowSlug, flowsFromSpec, kindForDriverFile, scriptPath } from "../modules/workflow/runners/cdp-browser.ts";
import { isRunnerName, type RunnerContext, RUNNERS } from "../modules/workflow/runners/index.ts";
import type { VerifySpec } from "../modules/workflow/schema.ts";

// ═══ Scaffolding: a temp-dir pool and the fixture site on an ephemeral port ═══

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-cdp-test-"));
	dirs.push(dir);
	return dir;
};

const SITE = join(import.meta.dir, "fixtures", "site");
let server: http.Server;
let base = "";
beforeAll(async () => {
	server = http.createServer((req, res) => {
		if (req.url === "/api/ping") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ pong: true }));
			return;
		}
		const file = join(SITE, req.url === "/" ? "index.html" : (req.url ?? "").replace(/^\//, "").split("?")[0]);
		if (!existsSync(file)) {
			res.statusCode = 404;
			res.end("not found");
			return;
		}
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(readFileSync(file));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as { port: number };
	base = `http://127.0.0.1:${address.port}/`;
});
afterAll(() => {
	server?.close();
});

const chromium = findChromium();
const withChromium = chromium ? test : test.skip;
if (!chromium) console.log("cdp-browser tests: no Chromium on this machine (Playwright cache, brave-browser, chrome) — driver tests skipped");

const CLI = scriptPath("cdp-browser.mjs");
const STITCH = scriptPath("stitch-video.mjs");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ═══ Binaries ═══════════════════════════════════════════════════════════════

describe("findChromium / findFfmpeg", () => {
	test("TITAN_CHROMIUM wins and must be executable; kind from the name", () => {
		const dir = scratch();
		const fake = join(dir, "chrome-headless-shell");
		writeFileSync(fake, "#!/bin/sh\n");
		chmodSync(fake, 0o755);
		expect(findChromium({ TITAN_CHROMIUM: fake, PATH: "", HOME: dir })).toEqual({ path: fake, kind: "headless-shell" });
		const brave = join(dir, "brave-browser");
		writeFileSync(brave, "#!/bin/sh\n");
		chmodSync(brave, 0o755);
		expect(findChromium({ TITAN_CHROMIUM: brave, PATH: "", HOME: dir })?.kind).toBe("brave");
		expect(findChromium({ TITAN_CHROMIUM: join(dir, "missing"), PATH: "", HOME: dir })).toBeUndefined();
	});

	test("an empty PATH and HOME find nothing; Playwright's cache layout and PATH names are searched", () => {
		const home = scratch();
		expect(findChromium({ PATH: "", HOME: home })).toBeUndefined();
		expect(findFfmpeg({ PATH: "", HOME: home })).toBeUndefined();
		const shell = join(home, ".cache", "ms-playwright", "chromium_headless_shell-9999", "chrome-headless-shell-linux64");
		mkdirSync(shell, { recursive: true });
		writeFileSync(join(shell, "chrome-headless-shell"), "#!/bin/sh\n");
		chmodSync(join(shell, "chrome-headless-shell"), 0o755);
		expect(findChromium({ PATH: "", HOME: home })).toEqual({ path: join(shell, "chrome-headless-shell"), kind: "headless-shell" });
		const ff = join(home, ".cache", "ms-playwright", "ffmpeg-9999");
		mkdirSync(ff, { recursive: true });
		writeFileSync(join(ff, "ffmpeg-linux"), "#!/bin/sh\n");
		chmodSync(join(ff, "ffmpeg-linux"), 0o755);
		expect(findFfmpeg({ PATH: "", HOME: home })).toBe(join(ff, "ffmpeg-linux"));
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "google-chrome"), "#!/bin/sh\n");
		chmodSync(join(bin, "google-chrome"), 0o755);
		expect(findChromium({ PATH: bin, HOME: scratch() })).toEqual({ path: join(bin, "google-chrome"), kind: "chrome" });
		expect(findFfmpeg({ TITAN_FFMPEG: join(home, "nope"), PATH: bin, HOME: home })).toBeUndefined();
	});
});

// ═══ Flow parsing + runner helpers ═════════════════════════════════════════

describe("flow helpers", () => {
	test("parseFlow accepts a flow or {flows:[…]} and rejects junk", () => {
		expect(parseFlow({ name: " hello ", url: "http://x/", steps: [{ click: "Go" }] })).toEqual({ name: "hello", url: "http://x/", description: undefined, steps: [{ click: "Go" }] });
		expect(parseFlow({ flows: [{ name: "a", steps: [{ snapshot: true }] }] }).name).toBe("a");
		expect(() => parseFlow({ steps: [] })).toThrow(CdpError);
		expect(() => parseFlow({ name: "a", steps: "no" })).toThrow("steps must be an array");
		expect(() => parseFlow({ name: "a", steps: [{ note: "nothing to do" }] })).toThrow("has no action");
	});

	test("parseFill, flowSlug, kindForDriverFile, flowsFromSpec", () => {
		expect(parseFill("#name=Ada")).toEqual({ selector: "#name", value: "Ada" });
		expect(parseFill("input[name=q]: two words")).toEqual({ selector: "input[name=q]", value: "two words" });
		expect(() => parseFill("nonsense")).toThrow(CdpError);
		expect(flowSlug("Sign up with an EMPTY email!", 0)).toBe("01-sign-up-with-an-empty-email");
		expect(flowSlug("###", 11)).toBe("12-flow");
		expect(kindForDriverFile("/x/step-001.png")).toBe("screenshot");
		expect(kindForDriverFile("/x/step-003-failed.png")).toBe("screenshot");
		expect(kindForDriverFile("/x/snapshot-final.txt")).toBe("snapshot");
		expect(kindForDriverFile("/x/console.json")).toBe("console-log");
		expect(kindForDriverFile("/x/network.json")).toBe("network-log");
		expect(kindForDriverFile("/x/flow-result.json")).toBe("report");
		expect(kindForDriverFile("/x/flow.json")).toBe("script");
		expect(kindForDriverFile("/x/flow.mp4")).toBe("video");
		const dir = scratch();
		writeFileSync(join(dir, "flows.json"), JSON.stringify({ flows: [{ name: "a", steps: [{ click: "x" }] }, { name: "b", url: "http://b/", steps: [{ snapshot: true }] }] }));
		const fromFile = flowsFromSpec({ flows_file: "flows.json", url: "http://default/" }, dir);
		expect(fromFile.error).toBeUndefined();
		expect(fromFile.flows.map((f) => [f.name, f.url])).toEqual([
			["a", "http://default/"],
			["b", "http://b/"],
		]);
		expect(flowsFromSpec({ flows: [{ name: "", steps: [{ click: "x" }] }] }, dir).error).toContain("has no name");
		expect(flowsFromSpec({ flows: [{ name: "a", steps: [] }] }, dir).error).toContain("no steps");
		expect(flowsFromSpec({ flows_file: "missing.json" }, dir).error).toContain("missing.json");
		expect(flowsFromSpec({}, dir).error).toContain("must be a list");
	});

	test("the runner is registered under its name", () => {
		expect(isRunnerName("cdp-browser")).toBe(true);
		expect(RUNNERS["cdp-browser"]).toBe(cdpBrowserRunner);
		expect(existsSync(CLI)).toBe(true);
		expect(existsSync(STITCH)).toBe(true);
	});
});

// ═══ The driver against the fixture site (real headless Chromium) ══════════

describe("CdpBrowser + CdpPage", () => {
	withChromium(
		"goto, snapshot, fill, click, expect, press, eval, screenshot, console and network logs, navigation by link",
		async () => {
			const profile = scratch();
			const browser = await CdpBrowser.launch({ userDataDir: profile, timeoutMs: 20_000 });
			try {
				const page = await browser.page();
				const nav = await page.goto(base, { waitUntil: "networkidle", timeoutMs: 20_000 });
				expect(nav.status).toBe(200);
				expect(nav.url).toBe(base);
				const snapshot = await page.snapshot();
				expect(snapshot).toContain("title: Titan fixture site");
				expect(snapshot).toContain("[button] Say hello");
				expect(snapshot).toContain("[input] #name");
				expect(snapshot).toContain("[link] About this site -> about.html");
				expect(snapshot).toContain("api: ok"); // the fetch to /api/ping resolved before networkidle returned
				await page.fill("#name", "Dan");
				const clicked = await page.click("Say hello");
				expect(clicked.tag).toBe("button");
				await page.waitFor("Hello, Dan!", 5_000);
				// Enter inside the input submits the form again with a new value.
				await page.fill("#name", "Ann");
				await page.eval("document.getElementById('name').focus()");
				await page.press("Enter");
				await page.waitFor("Hello, Ann!", 5_000);
				expect(await page.eval<string>("document.title")).toBe("Titan fixture site");
				const shot = await page.screenshot(join(profile, "shot.png"));
				expect(shot.bytes).toBeGreaterThan(100);
				expect(readFileSync(shot.path).subarray(0, 4).equals(PNG)).toBe(true);
				const consoleLog = page.consoleLog();
				expect(consoleLog.map((entry) => entry.text)).toContain("fixture: page ready");
				expect(consoleLog.some((entry) => entry.level === "info" && entry.text.includes("greeted Ann"))).toBe(true);
				const network = page.networkLog();
				expect(network.some((entry) => entry.url.endsWith("/api/ping") && entry.status === 200)).toBe(true);
				// A click that navigates settles before the next call.
				const marker = page.mark();
				await page.click("About this site");
				expect(await page.settle(marker, 10_000)).toBe(true);
				expect(await page.eval<string>("document.title")).toBe("About the fixture");
				await expect(page.click("Nothing like this")).rejects.toThrow(/click: nothing matches/);
				await expect(page.fill("#nope", "x")).rejects.toThrow(/fill: no element/);
				await expect(page.waitFor("#never-there", 300)).rejects.toThrow(/did not appear/);
				await expect(page.press("NoSuchKey")).rejects.toThrow(/unknown key/);
				await page.close();
			} finally {
				await browser.close();
			}
		},
		60_000,
	);

	withChromium(
		"runFlow writes frames, snapshots, logs and flow-result.json; a failing step ends the flow with its own screenshot",
		async () => {
			const out = join(scratch(), "flow");
			const result = await runFlow(
				{ name: "hello", url: base, steps: [{ snapshot: true }, { fill: { selector: "#name", value: "Ada" } }, { click: "Say hello" }, { expect: "Hello, Ada!" }, { click: "About this site" }, { wait: "#about-text" }, { eval: "document.title" }] },
				out,
				{ timeoutMs: 20_000 },
			);
			expect(result.ok).toBe(true);
			expect(result.steps.map((step) => step.action)).toEqual(["goto", "snapshot", "fill", "click", "expect", "click", "wait", "eval"]);
			expect(result.steps.every((step) => step.ok)).toBe(true);
			expect(result.steps.at(-1)?.value).toBe("About the fixture");
			expect(result.frames).toBe(8);
			const files = readdirSync(out).sort();
			expect(files).toContain("step-001.png");
			expect(files).toContain("step-008.png");
			expect(files).toContain("snapshot-2.txt");
			expect(files).toContain("snapshot-final.txt");
			expect(files).toContain("console.json");
			expect(files).toContain("network.json");
			expect(files).toContain("flow-result.json");
			expect(readFileSync(join(out, "snapshot-final.txt"), "utf8")).toContain("About the fixture");
			expect(JSON.parse(readFileSync(join(out, "console.json"), "utf8")).length).toBeGreaterThan(0);
			expect(JSON.parse(readFileSync(join(out, "network.json"), "utf8")).some((entry: { url: string }) => entry.url.endsWith("/api/ping"))).toBe(true);
			expect(JSON.parse(readFileSync(join(out, "flow-result.json"), "utf8")).ok).toBe(true);

			const bad = join(scratch(), "bad");
			const failed = await runFlow({ name: "bad", url: base, steps: [{ click: "Say hello" }, { click: "This button does not exist" }, { expect: "never" }] }, bad, { timeoutMs: 20_000 });
			expect(failed.ok).toBe(false);
			expect(failed.steps).toHaveLength(3); // goto, click, the failing click — the rest never ran
			expect(failed.steps[2]).toMatchObject({ action: "click", ok: false });
			expect(failed.steps[2].error).toContain("nothing matches");
			expect(readdirSync(bad)).toContain("step-003-failed.png");
			expect(JSON.parse(readFileSync(join(bad, "flow-result.json"), "utf8")).ok).toBe(false);
		},
		90_000,
	);

	withChromium(
		"the CLI mirrors the module: run writes the same artifacts (exit 0 / 1), snapshot prints the page, doctor reports, bad input is exit 2",
		async () => {
			const dir = scratch();
			const flowFile = join(dir, "flow.json");
			writeFileSync(flowFile, JSON.stringify({ name: "cli", url: base, steps: [{ fill: { selector: "#name", value: "Cli" } }, { click: "#submit" }, { expect: "Hello, Cli!" }] }));
			const out = join(dir, "out");
			const run = await runProcess("node", [CLI, "run", "--flow", flowFile, "--out", out, "--timeout", "20000"], { cwd: dir, timeoutMs: 60_000 });
			expect(run.code).toBe(0);
			const summary = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
			expect(summary).toMatchObject({ ok: true, name: "cli", steps: 4, failed: [] });
			expect(readdirSync(out)).toContain("flow-result.json");
			expect(readdirSync(out).filter((name) => name.startsWith("step-") && name.endsWith(".png"))).toHaveLength(4);

			const snapshot = await runProcess("node", [CLI, "snapshot", "--url", base, "--out", join(dir, "snap")], { cwd: dir, timeoutMs: 60_000 });
			expect(snapshot.code).toBe(0);
			expect(snapshot.stdout).toContain("[button] Say hello");
			expect(readFileSync(join(dir, "snap", "snapshot-0.txt"), "utf8")).toContain("title: Titan fixture site");

			const doctor = await runProcess("node", [CLI, "doctor"], { cwd: dir, timeoutMs: 30_000 });
			expect(doctor.code).toBe(0);
			expect(JSON.parse(doctor.stdout).chromium.path).toBe(chromium!.path);

			writeFileSync(join(dir, "bad.json"), JSON.stringify({ name: "x", steps: "nope" }));
			const bad = await runProcess("node", [CLI, "run", "--flow", join(dir, "bad.json"), "--out", join(dir, "bad")], { cwd: dir, timeoutMs: 30_000 });
			expect(bad.code).toBe(2);
			expect(bad.stderr).toContain("bad flow file");

			writeFileSync(join(dir, "failing.json"), JSON.stringify({ name: "failing", url: base, steps: [{ click: "No such thing" }] }));
			const failing = await runProcess("node", [CLI, "run", "--flow", join(dir, "failing.json"), "--out", join(dir, "failing")], { cwd: dir, timeoutMs: 60_000 });
			expect(failing.code).toBe(1);
			expect(JSON.parse(failing.stdout.trim().split("\n").at(-1)!).failed[0]).toContain("nothing matches");

			const noChromium = await runProcess(process.execPath, [CLI, "run", "--flow", flowFile, "--out", join(dir, "none")], { cwd: dir, timeoutMs: 30_000, env: { TITAN_CHROMIUM: join(dir, "missing"), PATH: "", HOME: dir } });
			expect(noChromium.code).toBe(3);
		},
		120_000,
	);
});

// ═══ stitch-video ═══════════════════════════════════════════════════════════

describe("stitch-video.mjs", () => {
	test("exits 3 when ffmpeg is unavailable and 2 without frames", async () => {
		const dir = scratch();
		const noFfmpeg = { PATH: "", HOME: dir, TITAN_FFMPEG: join(dir, "missing") };
		const result = await runProcess(process.execPath, [STITCH, "--frames", dir, "--out", join(dir, "flow.mp4")], { cwd: dir, timeoutMs: 30_000, env: noFfmpeg });
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("ffmpeg unavailable");
		const usage = await runProcess("node", [STITCH], { cwd: dir, timeoutMs: 30_000 });
		expect(usage.code).toBe(2);
	});

	const ffmpeg = findFfmpeg();
	(ffmpeg && chromium ? test : test.skip)(
		"stitches the driver's JPEG frames into a WebM (a requested .mp4 name is rewritten)",
		async () => {
			const dir = join(scratch(), "flow");
			const flow = await runFlow({ name: "frames", url: base, steps: [{ click: "Say hello" }, { expect: "Hello, stranger!" }] }, dir, { timeoutMs: 20_000 });
			expect(flow.ok).toBe(true);
			expect(readdirSync(join(dir, "frames")).filter((name) => name.endsWith(".jpg"))).toHaveLength(3);
			const result = await runProcess("node", [STITCH, "--frames", dir, "--out", join(dir, "flow.mp4"), "--fps", "2"], { cwd: dir, timeoutMs: 180_000 });
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			const summary = JSON.parse(result.stdout);
			expect(summary).toMatchObject({ ok: true, frames: 3, mode: "mjpeg", fps: 2, container: "webm", out: join(dir, "flow.webm") });
			expect(statSync(summary.out).size).toBeGreaterThan(0);
			expect(readFileSync(summary.out).subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true); // EBML header: WebM
		},
		200_000,
	);
});

// ═══ The verify runner ══════════════════════════════════════════════════════

function runnerCtx(options: { env?: Record<string, string>; execEnv?: Record<string, string>; bins?: string[] } = {}): RunnerContext & { execCalls: Array<[string, string[]]> } {
	const cwd = scratch();
	const artifactsDir = join(cwd, "artifacts");
	const evidenceDir = join(artifactsDir, "evidence", "verify");
	mkdirSync(evidenceDir, { recursive: true });
	const execCalls: Array<[string, string[]]> = [];
	return {
		runId: "run-test",
		nodeId: "verify",
		cwd,
		env: options.env ?? {},
		artifactsDir,
		evidenceDir,
		exec: async (command, args, opts) => {
			execCalls.push([command, args]);
			return runProcess(command, args, { cwd: opts?.cwd ?? cwd, timeoutMs: opts?.timeoutMs ?? 60_000, env: { ...(opts?.env ?? {}), ...(options.execEnv ?? {}) } });
		},
		notify: () => {},
		signal: new AbortController().signal,
		timeoutMs: 60_000,
		hash: hashArtifact,
		which: (binary) => (options.bins?.includes(binary) ? `/fake/bin/${binary}` : undefined),
		execCalls,
	};
}

describe("cdp-browser runner", () => {
	test("no Chromium → unavailable without spawning anything; a bad override is a vacancy too", async () => {
		const ctx = runnerCtx({ env: { TITAN_CHROMIUM: "/nonexistent/chrome", PATH: "", HOME: scratch() } });
		const result = await cdpBrowserRunner({ runner: "cdp-browser", flows: [{ name: "a", url: "http://x/", steps: [{ snapshot: true }] }] } as VerifySpec, ctx);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toContain("not executable");
		expect(result.retryable).toBe(false);
		expect(ctx.execCalls).toHaveLength(0);
		const none = runnerCtx({ env: { PATH: "", HOME: scratch() } });
		// The machine's own Chromium is still found through process.env unless HOME/PATH are emptied for the lookup as well.
		const found = await cdpBrowserRunner({ runner: "cdp-browser", flows: [] } as unknown as VerifySpec, none);
		expect(["unavailable", "fail"]).toContain(found.status);
	});

	test("bad flow input fails closed and is not retried", async () => {
		const ctx = runnerCtx();
		const result = await cdpBrowserRunner({ runner: "cdp-browser", flows: [{ name: "", steps: [] }], chromium: process.execPath } as VerifySpec, ctx);
		expect(result.status).toBe("fail");
		expect(result.retryable).toBe(false);
		expect(ctx.execCalls).toHaveLength(0);
	});

	withChromium(
		"a passing flow yields the four evidence kinds (observed, source cdp) and a matched package; video is reported unavailable without ffmpeg",
		async () => {
			const ctx = runnerCtx({ execEnv: { TITAN_FFMPEG: "/nonexistent/ffmpeg" } });
			const spec = { runner: "cdp-browser", video: true, flows: [{ name: "Say hello", url: base, steps: [{ snapshot: true }, { fill: { selector: "#name", value: "Eve" } }, { click: "Say hello" }, { expect: "Hello, Eve!" }] }] } as unknown as VerifySpec;
			const result = await cdpBrowserRunner(spec, ctx);
			expect(result.status).toBe("pass");
			expect(result.devices).toEqual({ "Say hello": "pass" });
			const kinds = new Set(result.artifacts.filter((artifact) => artifact.sha256 && artifact.capturedBy === "observed" && artifact.source === "cdp").map((artifact) => artifact.kind));
			for (const kind of ["screenshot", "snapshot", "console-log", "network-log", "report", "script"]) expect(kinds.has(kind as never)).toBe(true);
			expect(kinds.has("video" as never)).toBe(false);
			expect(result.missing).toEqual(["video: unavailable (ffmpeg not found)"]);
			expect(result.artifacts.some((artifact) => artifact.path.includes("/frames/"))).toBe(false); // JPEG video frames are inputs, not evidence rows
			expect(result.checks).toMatchObject({ screenshotPresent: true, logsPresent: true, userFlowsPassed: true, exitCode: 0 });
			expect(result.summary).toContain("1/1 flow(s) passed");
			const pkg = buildEvidence({ runId: "run-test", nodeId: "verify", artifacts: result.artifacts, checks: result.checks }, ["screenshot", "snapshot", "console-log", "network-log"]);
			expect(pkg.status).toBe("matched");
			// A cdp capture is a simulated-user capture for the production-swe rule.
			const simUser = buildEvidence({ runId: "run-test", nodeId: "verify", artifacts: result.artifacts, checks: result.checks }, { required: [], anyOf: [["video", "screenshot"]], simUser: true });
			expect(simUser.status).toBe("matched");
			expect(ctx.execCalls.map(([command, args]) => `${command} ${args[1]}`)).toEqual(["node run", `node --frames`]);
			expect(existsSync(join(ctx.evidenceDir, "01-say-hello", "flow.json"))).toBe(true);
		},
		90_000,
	);

	withChromium(
		"a failing flow fails the runner but keeps its evidence; flows_file relative to the artifacts dir works",
		async () => {
			const ctx = runnerCtx();
			writeFileSync(join(ctx.artifactsDir, "flows.json"), JSON.stringify({ flows: [{ name: "ok", url: base, steps: [{ expect: "Titan fixture" }] }, { name: "broken", url: base, steps: [{ click: "Not a real button" }] }] }));
			const result = await cdpBrowserRunner({ runner: "cdp-browser", flows_file: "flows.json", video: false } as unknown as VerifySpec, ctx);
			expect(result.status).toBe("fail");
			expect(result.devices).toEqual({ ok: "pass", broken: "fail" });
			expect(result.reason).toContain("broken:");
			expect(result.reason).toContain("nothing matches");
			expect(result.artifacts.some((artifact) => artifact.kind === "screenshot" && artifact.path.includes("02-broken") && artifact.path.endsWith("-failed.png"))).toBe(true);
			expect(result.missing?.some((line) => line.startsWith("video:"))).toBe(false); // video: false → no stitch, no complaint
			expect(ctx.execCalls.filter(([, args]) => args[1] === "--frames")).toHaveLength(0);
		},
		90_000,
	);
});
