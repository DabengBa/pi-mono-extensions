import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a tool `path` argument the way Pi's native edit/write resolve it.
 *
 * The fused queue key, the post-mutation hash check, and the native mutation
 * must all target the same file, so this mirrors Pi's path normalization
 * (unicode-space normalization, `@` prefix, `~` expansion, `file://` URLs)
 * instead of importing a helper Pi does not export publicly.
 *
 * A malformed `file://` URL throws here, before any mutation or command.
 */
export function resolveFusionPath(cwd: string, filePath: string): string {
	const normalized = filePath.replace(UNICODE_SPACES, " ");
	const withoutAtPrefix = normalized.startsWith("@") ? normalized.slice(1) : normalized;
	if (withoutAtPrefix === "~") return homedir();
	if (withoutAtPrefix.startsWith("~/")) return join(homedir(), withoutAtPrefix.slice(2));
	if (withoutAtPrefix.startsWith("file://")) return fileURLToPath(withoutAtPrefix);
	return resolve(cwd, withoutAtPrefix);
}
