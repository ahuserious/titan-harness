#!/usr/bin/env node
/**
 * stitch-video.mjs — turn a flow's screenshot frames into a video (plan H8: `video` evidence
 * kind "when Momentic is enabled or ffmpeg is on PATH"; P8).
 *
 *   node scripts/stitch-video.mjs --frames <dir> --out <file.webm> [--fps 2] [--pattern 'step-*.png']
 *
 * ffmpeg is looked up on PATH (or TITAN_FFMPEG), then in Playwright's cache
 * (~/.cache/ms-playwright/ffmpeg-<version>/ffmpeg-linux). That bundled build is minimal — the
 * only demuxers are image2pipe and matroska/webm, the only video decoders mjpeg and libvpx,
 * the only video encoder libvpx (VP8), the only muxer WebM — so the driver also saves a JPEG
 * copy of every step (frames/frame-<n>.jpg) and this script pipes those through
 * image2pipe/mjpeg into WebM/VP8, which every full ffmpeg build accepts as well. Without
 * JPEG frames it decodes the PNGs itself (zlib + the five PNG filters) and feeds rawvideo,
 * which needs a full build. A requested .mp4 name is rewritten to .webm; the JSON on stdout
 * names the real file.
 *
 * Exit codes: 0 ok · 1 ffmpeg failed / no decodable frame · 2 usage / no frames · 3 ffmpeg unavailable.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateSync } from "node:zlib";

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			out[arg.slice(2)] = next;
			i++;
		} else out[arg.slice(2)] = true;
	}
	return out;
}

const executable = (file) => {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
};

/** ffmpeg on PATH (or TITAN_FFMPEG), else Playwright's bundled ffmpeg-linux — mirrors modules/cdp-browser.ts findFfmpeg. */
export function findFfmpeg(env = process.env) {
	if (env.TITAN_FFMPEG) return executable(env.TITAN_FFMPEG) ? env.TITAN_FFMPEG : undefined;
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(dir, "ffmpeg");
		if (executable(candidate)) return candidate;
	}
	const cache = path.join(env.HOME ?? os.homedir(), ".cache", "ms-playwright");
	let entries = [];
	try {
		entries = fs.readdirSync(cache).filter((name) => name.startsWith("ffmpeg-")).sort().reverse();
	} catch {}
	for (const entry of entries) {
		for (const rel of ["ffmpeg-linux", "ffmpeg"]) {
			const candidate = path.join(cache, entry, rel);
			if (executable(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Frame files under `dir` matching a simple `prefix*.ext` pattern, sorted. */
export function listFrames(dir, pattern = "step-*.png") {
	const [prefix, suffix] = pattern.split("*");
	let names = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith(prefix ?? "") && name.endsWith(suffix ?? ""))
		.sort()
		.map((name) => path.join(dir, name));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit non-interlaced PNG (gray, gray+alpha, RGB, RGBA) into {width, height, rgba}. Throws on anything else. */
export function decodePng(buffer) {
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat = [];
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	if (!width || !height) throw new Error("PNG without IHDR");
	if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
	if (interlace !== 0) throw new Error("interlaced PNG not supported");
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
	if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rgba = Buffer.alloc(width * height * 4);
	let prev = Buffer.alloc(stride);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++];
		const row = Buffer.from(raw.subarray(pos, pos + stride)); // copy: unfiltered in place
		pos += stride;
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? row[i - channels] : 0;
			const b = prev[i];
			const c = i >= channels ? prev[i - channels] : 0;
			let value = row[i];
			if (filter === 1) value += a;
			else if (filter === 2) value += b;
			else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			} else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
			row[i] = value & 0xff;
		}
		for (let x = 0; x < width; x++) {
			const src = x * channels;
			const dst = (y * width + x) * 4;
			if (channels === 1) {
				rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = row[src];
				rgba[dst + 3] = 255;
			} else if (channels === 2) {
				rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = row[src];
				rgba[dst + 3] = row[src + 1];
			} else {
				rgba[dst] = row[src];
				rgba[dst + 1] = row[src + 1];
				rgba[dst + 2] = row[src + 2];
				rgba[dst + 3] = channels === 4 ? row[src + 3] : 255;
			}
		}
		prev = row;
	}
	return { width, height, rgba };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("stitch-video.mjs")) {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.frames !== "string" || typeof args.out !== "string") {
		process.stderr.write("usage: stitch-video.mjs --frames <dir> --out <file.webm> [--fps 2] [--pattern 'step-*.png']\n");
		process.exit(2);
	}
	const ffmpeg = findFfmpeg();
	if (!ffmpeg) {
		process.stderr.write("stitch-video.mjs: ffmpeg unavailable (not on PATH, no TITAN_FFMPEG, no ~/.cache/ms-playwright/ffmpeg-*)\n");
		process.exit(3);
	}
	const frames = listFrames(args.frames, typeof args.pattern === "string" ? args.pattern : "step-*.png");
	if (!frames.length) {
		process.stderr.write(`stitch-video.mjs: no frames under ${args.frames}\n`);
		process.exit(2);
	}
	const fps = Math.max(1, Number(args.fps) || 2);
	const out = /\.webm$/i.test(args.out) ? args.out : args.out.replace(/\.[A-Za-z0-9]+$/, "") + ".webm";
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const jpegs = listFrames(path.join(args.frames, "frames"), "frame-*.jpg");
	const encode = ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libvpx", "-auto-alt-ref", "0", "-b:v", "1M", "-r", String(fps), "-f", "webm", out];
	let result;
	let count;
	let mode;
	const skipped = [];
	if (jpegs.length) {
		mode = "mjpeg";
		const input = Buffer.concat([...jpegs, jpegs[jpegs.length - 1]].map((file) => fs.readFileSync(file))); // hold the last frame one tick
		count = jpegs.length;
		result = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-r", String(fps), "-i", "pipe:0", ...encode], { input, encoding: "buffer", timeout: 180_000, maxBuffer: 1024 * 1024 * 1024 });
	} else {
		mode = "rawvideo";
		let width = 0;
		let height = 0;
		const raws = [];
		for (const file of frames) {
			try {
				const decoded = decodePng(fs.readFileSync(file));
				if (!width) {
					width = decoded.width;
					height = decoded.height;
				}
				if (decoded.width !== width || decoded.height !== height) {
					skipped.push(`${path.basename(file)}: ${decoded.width}x${decoded.height} ≠ ${width}x${height}`);
					continue;
				}
				raws.push(decoded.rgba);
			} catch (error) {
				skipped.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!raws.length) {
			process.stderr.write(`stitch-video.mjs: no decodable frame (${skipped.join("; ")})\n`);
			process.exit(1);
		}
		raws.push(raws[raws.length - 1]);
		count = raws.length - 1;
		result = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", ...encode], { input: Buffer.concat(raws), encoding: "buffer", timeout: 180_000, maxBuffer: 1024 * 1024 * 1024 });
	}
	if (result.status !== 0) {
		process.stderr.write(`stitch-video.mjs: ffmpeg exited ${result.status ?? "signal"}: ${(result.stderr ? result.stderr.toString() : "").trim().slice(-400)}\n`);
		process.exit(1);
	}
	let bytes = 0;
	try {
		bytes = fs.statSync(out).size;
	} catch {}
	process.stdout.write(`${JSON.stringify({ ok: true, out, frames: count, mode, skipped, fps, bytes, codec: "vp8", container: "webm" })}\n`);
	process.exit(0);
}
