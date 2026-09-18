import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "fs";
import { dirname } from "path";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	stat as fsStat,
	unlink as fsUnlink,
	writeFile as fsWriteFile,
} from "fs/promises";

import type { Workspace } from "./types.ts";

async function statOrUndefined(absolutePath: string) {
	try {
		return await fsStat(absolutePath);
	} catch (error: unknown) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

async function checkDirectoryWriteAccess(dirPath: string): Promise<void> {
	// Creating or deleting an entry inside a directory requires write+execute
	// on that directory. Walk up to the nearest existing ancestor so nested
	// destinations still fail fast during virtual preflight.
	let dir = dirPath;
	while (true) {
		const st = await statOrUndefined(dir);
		if (st !== undefined) {
			if (!st.isDirectory()) {
				throw new Error(`Not a directory: ${dir}`);
			}
			await fsAccess(dir, constants.W_OK | constants.X_OK);
			return;
		}
		const parent = dirname(dir);
		if (parent === dir) return; // reached filesystem root, nothing else to check
		dir = parent;
	}
}

async function checkFileOrParentWriteAccess(absolutePath: string): Promise<void> {
	const st = await statOrUndefined(absolutePath);
	if (st === undefined) {
		// New file: need write+execute on the containing directory.
		await checkDirectoryWriteAccess(dirname(absolutePath));
		return;
	}
	if (st.isDirectory()) {
		throw new Error(`Not a file: ${absolutePath}`);
	}
	// Existing file: need the file itself writable (for overwrite) and the
	// containing directory writable+executable (for delete/replace).
	await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
	await checkDirectoryWriteAccess(dirname(absolutePath));
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

export function createRealWorkspace(pi: ExtensionAPI): Workspace {
	const readCache = new Map<string, string>();
	return {
		readText: async (absolutePath: string) => {
			if (readCache.has(absolutePath)) return readCache.get(absolutePath)!;
			const content = await fsReadFile(absolutePath, "utf-8");
			readCache.set(absolutePath, content);
			return content;
		},
		writeText: async (absolutePath: string, content: string) => {
			// Skip the write (and the file-modified event) when content is
			// identical to what we last read. Prevents thrashing downstream
			// consumers (watchers, context-guard) after no-op dedups.
			const existing = readCache.get(absolutePath);
			if (existing === content) return;
			readCache.delete(absolutePath);
			await fsMkdir(dirname(absolutePath), { recursive: true });
			await fsWriteFile(absolutePath, content, "utf-8");
			pi.events.emit("context-guard:file-modified", { path: absolutePath });
		},
		deleteFile: async (absolutePath: string) => {
			readCache.delete(absolutePath);
			await fsUnlink(absolutePath);
			pi.events.emit("context-guard:file-modified", { path: absolutePath });
		},
		exists: async (absolutePath: string) => {
			try {
				await fsAccess(absolutePath, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		checkWriteAccess: checkFileOrParentWriteAccess,
	};
}

export function createVirtualWorkspace(cwd: string): Workspace {
	const state = new Map<string, string | null>();

	async function ensureLoaded(absolutePath: string): Promise<void> {
		if (state.has(absolutePath)) return;
		try {
			const content = await fsReadFile(absolutePath, "utf-8");
			state.set(absolutePath, content);
		} catch {
			state.set(absolutePath, null);
		}
	}

	return {
		readText: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			const content = state.get(absolutePath);
			if (content === null || content === undefined) {
				throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, "")}`);
			}
			return content;
		},
		writeText: async (absolutePath, content) => {
			state.set(absolutePath, content);
		},
		deleteFile: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			if (state.get(absolutePath) === null) {
				throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, "")}`);
			}
			state.set(absolutePath, null);
		},
		exists: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			// A file that cannot be reached because its parent directory lacks
			// execute permission is not "absent"; surface the access error so
			// delete/move preflights report the real failure instead of
			// "file does not exist".
			await checkFileOrParentWriteAccess(absolutePath).catch((error) => {
				if (isMissingPathError(error)) return;
				throw error;
			});
			return state.get(absolutePath) !== null;
		},
		checkWriteAccess: checkFileOrParentWriteAccess,
	};
}
