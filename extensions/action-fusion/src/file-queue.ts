import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const queueTails = new Map<string, Promise<void>>();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * Canonical queue key for a target path. Existing targets resolve through
 * symlinks; missing targets keep their real ancestor plus the segments that do
 * not exist yet, so a file URL, a relative path, and a symlinked directory alias
 * of one target share a queue slot.
 */
async function canonicalQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const missingSegments: string[] = [];

	for (;;) {
		try {
			return resolve(await realpath(current), ...missingSegments);
		} catch (error: unknown) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missingSegments.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Serialize fused operations — mutation, hash guard, and follow-up command —
 * for one canonical target path. Different targets still run in parallel.
 *
 * This queue belongs to Action Fusion on purpose: Pi's native edit/write keep
 * their own mutation queue, and nesting the same queue inside itself would
 * deadlock. It only orders operations started by this extension; it is not a
 * global file lock, which is why the hash guard still runs.
 */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
	const key = await canonicalQueueKey(filePath);
	const previous = queueTails.get(key) ?? Promise.resolve();
	let release = () => {};
	const owned = new Promise<void>((resolveOwned) => {
		release = resolveOwned;
	});
	const tail = previous.then(() => owned);
	queueTails.set(key, tail);

	await previous;
	try {
		return await work();
	} finally {
		release();
		if (queueTails.get(key) === tail) {
			queueTails.delete(key);
		}
	}
}
