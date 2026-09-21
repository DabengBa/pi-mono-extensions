import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { withFusedFileQueue } from "../src/file-queue.ts";
import { resolveFusionPath } from "../src/path.ts";

let workspace: string;

before(async () => {
	workspace = await realpath(await mkdtemp(join(tmpdir(), "action-fusion-paths-")));
});

after(async () => {
	await rm(workspace, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one fused operation per key and report the highest number of work
 * callbacks that were active at the same time. Aliases of a single file must
 * report 1; independent files must report the full key count.
 */
async function measureConcurrency(keys: readonly string[]): Promise<number> {
	let active = 0;
	let maxActive = 0;
	await Promise.all(
		keys.map(async (key) => {
			await withFusedFileQueue(key, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await delay(20);
				active -= 1;
			});
		}),
	);
	return maxActive;
}

describe("resolveFusionPath", () => {
	test("resolves relative paths against the session cwd", () => {
		assert.equal(resolveFusionPath(workspace, "src/app.ts"), join(workspace, "src/app.ts"));
	});

	test("keeps absolute paths", () => {
		assert.equal(resolveFusionPath(workspace, "/tmp/app.ts"), "/tmp/app.ts");
	});

	test("strips the @ prefix like the native tools", () => {
		assert.equal(resolveFusionPath(workspace, "@src/app.ts"), join(workspace, "src/app.ts"));
	});

	test("expands ~ and ~/...", () => {
		assert.equal(resolveFusionPath(workspace, "~"), homedir());
		assert.equal(resolveFusionPath(workspace, "~/src/app.ts"), join(homedir(), "src/app.ts"));
	});

	test("normalizes unicode spaces like the native tools", () => {
		assert.equal(resolveFusionPath(workspace, "\u2009src/app.ts"), join(workspace, " src/app.ts"));
	});

	test("resolves percent-encoded file URLs", () => {
		const target = join(workspace, "100% #name.txt");
		assert.equal(resolveFusionPath(workspace, pathToFileURL(target).href), target);
	});

	test("resolves file URLs that contain unencoded spaces", () => {
		const target = join(workspace, "with space.txt");
		assert.equal(resolveFusionPath(workspace, `file://${target}`), target);
	});

	test("strips the @ prefix before resolving a file URL", () => {
		const target = join(workspace, "prefixed.txt");
		assert.equal(resolveFusionPath(workspace, `@${pathToFileURL(target).href}`), target);
	});

	test("fails on a malformed file URL instead of guessing a path", () => {
		assert.throws(
			() => resolveFusionPath(workspace, "file:///tmp/%ZZ.txt"),
			(error: unknown) => error instanceof URIError,
		);
	});

	test("resolves one target to one path across relative, absolute, @, and file URL input", () => {
		const target = join(workspace, "queue-real", "app.txt");
		assert.equal(resolveFusionPath(workspace, "queue-real/app.txt"), target);
		assert.equal(resolveFusionPath(workspace, target), target);
		assert.equal(resolveFusionPath(workspace, `@${target}`), target);
		assert.equal(resolveFusionPath(workspace, pathToFileURL(target).href), target);
	});
});

describe("withFusedFileQueue", () => {
	test("serializes aliases of one existing file", { timeout: 10_000 }, async () => {
		await mkdir(join(workspace, "queue-real"), { recursive: true });
		await writeFile(join(workspace, "queue-real", "app.txt"), "content", "utf-8");
		await symlink(join(workspace, "queue-real"), join(workspace, "queue-link"), "dir");

		const viaRealDir = resolveFusionPath(workspace, "queue-real/app.txt");
		const viaSymlinkDir = resolveFusionPath(workspace, "queue-link/app.txt");
		const viaFileUrl = resolveFusionPath(workspace, pathToFileURL(join(workspace, "queue-real", "app.txt")).href);

		assert.notEqual(viaRealDir, viaSymlinkDir);

		const maxActive = await measureConcurrency([viaRealDir, viaSymlinkDir, viaFileUrl]);
		assert.equal(maxActive, 1);
	});

	test("serializes aliases of a file that does not exist yet", { timeout: 10_000 }, async () => {
		await mkdir(join(workspace, "new-real"), { recursive: true });
		await symlink(join(workspace, "new-real"), join(workspace, "new-link"), "dir");

		const viaRealDir = resolveFusionPath(workspace, "new-real/fresh.txt");
		const viaSymlinkDir = resolveFusionPath(workspace, "new-link/fresh.txt");

		assert.notEqual(viaRealDir, viaSymlinkDir);

		const maxActive = await measureConcurrency([viaRealDir, viaSymlinkDir]);
		assert.equal(maxActive, 1);
	});

	test("runs fused work for different files in parallel", { timeout: 10_000 }, async () => {
		const keys = ["parallel-a.txt", "parallel-b.txt", "parallel-c.txt"].map((name) =>
			resolveFusionPath(workspace, name),
		);
		const maxActive = await measureConcurrency(keys);
		assert.equal(maxActive, keys.length);
	});

	test("releases the queue when the work throws", { timeout: 10_000 }, async () => {
		const key = resolveFusionPath(workspace, "released-after-throw.txt");

		await assert.rejects(
			withFusedFileQueue(key, async () => {
				throw new Error("queue work failed");
			}),
			/queue work failed/,
		);

		let ranAgain = false;
		await withFusedFileQueue(key, async () => {
			ranAgain = true;
		});
		assert.equal(ranAgain, true);
	});
});
