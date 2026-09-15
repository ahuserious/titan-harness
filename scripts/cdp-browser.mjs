#!/usr/bin/env node
/**
 * cdp-browser.mjs — the CLI over extensions/titan-harness/modules/cdp-browser.ts (plan H8, P8).
 * Node ≥ 22.18 imports the TypeScript module directly (built-in type stripping), so the
 * driver has one implementation; the `cdp-browser` verify runner and `/local-dev-verify`
 * shell out to this file.
 *
 *   node scripts/cdp-browser.mjs run --flow <flow.json> --out <dir> [--chromium <path>] [--timeout <ms>]
 *       executes the flow ({name, url?, steps:[{goto|click|fill|press|wait|screenshot|snapshot|eval|expect}]})
 *       and writes step-<n>.png, snapshot-<n>.txt, snapshot-final.txt, console.json,
 *       network.json and flow-result.json {ok, steps:[{n, action, ok, error?}], …} under <dir>
 *   node scripts/cdp-browser.mjs snapshot --url <url> [--out <dir>] [--chromium <path>]
 *       prints the page snapshot (title, url, text, interactive elements); --out also writes snapshot-0.txt
 *   node scripts/cdp-browser.mjs doctor
 *       prints the Chromium and ffmpeg this machine offers
 *
 * Exit codes: 0 ok · 1 the flow failed (flow-result.json says why) · 2 usage · 3 no Chromium.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "..", "extensions", "titan-harness", "modules", "cdp-browser.ts");

function usage(code = 2) {
	process.stderr.write("usage: cdp-browser.mjs run --flow <flow.json> --out <dir> [--chromium <path>] [--timeout <ms>]\n       cdp-browser.mjs snapshot --url <url> [--out <dir>] [--chromium <path>]\n       cdp-browser.mjs doctor\n");
	process.exit(code);
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				out[key] = next;
				i++;
			} else out[key] = true;
		} else out._.push(arg);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || args.help) usage(command ? 0 : 2);

let driver;
try {
	driver = await import(pathToFileURL(modulePath).href);
} catch (error) {
	process.stderr.write(`cdp-browser.mjs: cannot load ${modulePath}: ${error instanceof Error ? error.message : String(error)}\n(Node ≥ 22.18 with built-in type stripping is required)\n`);
	process.exit(2);
}

if (command === "doctor") {
	const chromium = driver.findChromium();
	const ffmpeg = driver.findFfmpeg();
	process.stdout.write(`${JSON.stringify({ chromium: chromium ?? null, ffmpeg: ffmpeg ?? null, node: process.version }, null, 2)}\n`);
	process.exit(chromium ? 0 : 3);
}

const chromium = typeof args.chromium === "string" ? args.chromium : undefined;
if (!chromium && !driver.findChromium()) {
	process.stderr.write("cdp-browser.mjs: no Chromium found (Playwright cache, brave-browser or chrome); set TITAN_CHROMIUM or pass --chromium\n");
	process.exit(3);
}
const timeoutMs = args.timeout ? Number(args.timeout) : undefined;

if (command === "snapshot") {
	if (typeof args.url !== "string") usage();
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "titan-cdp-"));
	let browser;
	try {
		browser = await driver.CdpBrowser.launch({ chromium, userDataDir: profile, timeoutMs });
		const page = await browser.page();
		await page.goto(args.url, { waitUntil: "networkidle", timeoutMs });
		const text = await page.snapshot();
		if (typeof args.out === "string") {
			fs.mkdirSync(args.out, { recursive: true, mode: 0o700 });
			fs.writeFileSync(path.join(args.out, "snapshot-0.txt"), text, { mode: 0o600 });
		}
		process.stdout.write(`${text}\n`);
		await page.close();
	} catch (error) {
		process.stderr.write(`cdp-browser.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	} finally {
		try {
			await browser?.close();
		} catch {}
		fs.rmSync(profile, { recursive: true, force: true });
	}
	process.exit(process.exitCode ?? 0);
}

if (command === "run") {
	if (typeof args.flow !== "string" || typeof args.out !== "string") usage();
	let flow;
	try {
		flow = driver.parseFlow(JSON.parse(fs.readFileSync(args.flow, "utf8")));
	} catch (error) {
		process.stderr.write(`cdp-browser.mjs: bad flow file ${args.flow}: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
	const result = await driver.runFlow(flow, args.out, { chromium, timeoutMs });
	const failed = result.steps.filter((step) => !step.ok);
	process.stdout.write(`${JSON.stringify({ ok: result.ok, name: result.name, steps: result.steps.length, failed: failed.map((step) => `${step.n} ${step.action}: ${step.error}`), frames: result.frames, console: result.console, network: result.network, error: result.error ?? null, out: args.out })}\n`);
	process.exit(result.ok ? 0 : 1);
}

usage();
