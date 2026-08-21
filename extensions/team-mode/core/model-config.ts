/**
 * Pi Team-Mode — Model Configuration
 *
 * Explicit role × tier × provider model catalog, matching the team-mode
 * convention. Stored at `~/.pi/agent/extensions/team-mode/model-config.json`.
 *
 * This is the PRIMARY way team-mode picks models. The regex step-down logic
 * in `model-picker.ts` is now only the fallback (for cases where no config
 * file exists, or the resolved provider has no catalog entry).
 *
 * Schema (all fields optional; defaults are merged in):
 *
 *   {
 *     "version": 2,
 *     "defaultTier": "md",
 *     "tiers": {
 *       "sm": { "name": "Small",  "thinkingLevel": "low",    "description": "Simple tasks" },
 *       "md": { "name": "Medium", "thinkingLevel": "medium", "description": "Moderate complexity" },
 *       "lg": { "name": "Large",  "thinkingLevel": "high",   "description": "Strong reasoning" },
 *       "xl": { "name": "Deep",   "thinkingLevel": "xhigh",  "description": "Complex domains" }
 *     },
 *     "roles": {
 *       "researcher": "sm",
 *       "docs":       "xs",
 *       "backend":    "md",
 *       "frontend":   "md",
 *       "tester":     "md",
 *       "planner":    "lg",
 *       "reviewer":   "md"
 *     },
 *     "provider": "openai-codex" | "anthropic" | "auto",
 *     "providers": {
 *       // v1: tier → fully-qualified model string (still supported)
 *       "anthropic": { "sm": "anthropic/claude-haiku-4-5", "md": "anthropic/claude-sonnet-4-6" },
 *       // v2: tier → array of entries. Multiple entries act as a weighted
 *       // round-robin pool for load distribution AND an ordered fallback
 *       // chain when a model fails to start.
 *       "openai-codex": {
 *         "xs": [{ "model": "openai-codex/gpt-5.3-codex", "effort": "medium" }],
 *         "md": [
 *           { "model": "openai-codex/gpt-5.6-terra", "effort": "medium", "weight": 3 },
 *           { "model": "openai-codex/gpt-5.5",        "effort": "medium", "weight": 1 }
 *         ]
 *       }
 *     }
 *   }
 *
 * Entry fields (v2): `model` (required, fully-qualified `provider/id`),
 * `effort` (alias of thinkingLevel: off/minimal/low/medium/high/xhigh),
 * `thinkingLevel` (explicit spelling), `provider` (override; defaults to the
 * model prefix), `weight` (round-robin weight, default 1), `enabled` (set
 * false to keep an entry configured but skip it).
 *
 * Resolution order inside `resolveModel`:
 *   1. tierOverride (from caller's `model` param if it matches a configured tier)
 *   2. roles[role] / legacy roleTiers[role]
 *   3. defaultTier
 *
 * Thinking-level resolution:
 *   1. caller/spec explicit override (applied by AgentManager)
 *   2. v2 entry `effort`/`thinkingLevel` on the selected model
 *   3. legacy roleThinkingLevels[role]
 *   4. tiers[selectedTier].thinkingLevel
 *   5. `:<thinking>` suffix in the selected catalog model (back compat)
 *   6. legacy tierThinkingLevels[selectedTier]
 *   7. defaultThinkingLevel
 *   8. unset — let pi inherit its own defaultThinkingLevel
 *
 * Provider resolution:
 *   1. config.provider when not "auto"
 *   2. PI_TEAM_MATE_MODEL_PROVIDER env override
 *   3. pi settings.json defaultProvider (if that provider exists in catalogs)
 *   4. anthropic fallback
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getStorageRoot } from "./store.js";
import type { ThinkingLevel } from "./types.js";

export type ModelTier = string;

/**
 * v2 per-tier catalog entry. `effort` and `thinkingLevel` are aliases
 * (same off/minimal/low/medium/high/xhigh scale). Multiple entries per tier form
 * a weighted round-robin pool (load distribution) and an ordered fallback
 * chain for spawn failures.
 */
export type TierModelEntry = {
	/** Fully-qualified model id, e.g. "openai-codex/gpt-5.4" (may carry a `:thinking` suffix). */
	model: string;
	/** Thinking level for this model — alias of thinkingLevel. */
	effort?: ThinkingLevel;
	/** Thinking level for this model (explicit spelling). */
	thinkingLevel?: ThinkingLevel;
	/** Provider override; defaults to the `model` prefix. */
	provider?: string;
	/** Round-robin weight (default 1). Larger = selected more often. */
	weight?: number;
	/** Set false to keep the entry configured but exclude it from selection. */
	enabled?: boolean;
};

/** v1: tier → fqn string. v2: tier → ordered entry list. Mixed per tier is fine. */
export type ProviderCatalog = Record<string, string | TierModelEntry[]>;

/** A concrete model choice produced from a tier entry. */
export type ResolvedCandidate = {
	/** Pi `--provider` value. */
	provider: string;
	/** Bare model id (no `provider/` prefix). Pi `--model` value. */
	model: string;
	/** Thinking level for this candidate (entry effort, else tier/role fallbacks). */
	thinkingLevel?: ThinkingLevel;
};

export type TierConfig = {
	name?: string;
	thinkingLevel?: ThinkingLevel;
	description?: string;
};

export type ModelConfig = {
	/** Config schema version. 1 = legacy strings, 2 = entry arrays. Optional; inferred from shape when absent. */
	version?: number;
	/** Provider to use for all teammates. Use "auto" to detect from settings. */
	provider: string;
	/** Per-provider tier → fully-qualified model id. */
	providers: Record<string, ProviderCatalog>;
	/** Tier metadata keyed by tier id (for example xs/sm/md/lg/xl). */
	tiers: Record<string, TierConfig>;
	/** Role (subagent_type) → default tier. Preferred spelling. */
	roles: Record<string, ModelTier>;
	/** Role (subagent_type) → default tier. Legacy spelling; merged into roles. */
	roleTiers: Record<string, ModelTier>;
	/** Fallback tier for roles not in roleTiers. */
	defaultTier: ModelTier;
	/** Fallback thinking level when no role/tier/model-specific thinking is configured. Undefined = inherit pi default. */
	defaultThinkingLevel?: ThinkingLevel;
	/** Per-tier thinking defaults. Legacy spelling; merged into tiers[tier].thinkingLevel. */
	tierThinkingLevels?: Record<string, ThinkingLevel>;
	/** Role (subagent_type) → default thinking level. */
	roleThinkingLevels?: Record<string, ThinkingLevel>;
	/** Shell command run after a task transitions to completed. Non-zero exit reverts the task to failed. */
	taskCompletedHook?: string;
};

export type ResolvedModel = {
	/** Bare model id (no `provider/` prefix). Pi `--model` value. */
	model: string;
	/** Pi `--provider` value. */
	provider: string;
	/** Tier that was selected. */
	tier: ModelTier;
	/** Thinking level selected from role/tier/default config or model suffix. */
	thinkingLevel?: ThinkingLevel;
	/** Ordered model choices for the tier (v2). [0] is the primary pick; the rest are fallbacks. */
	candidates?: ResolvedCandidate[];
	/** One-line explanation of the resolution path. */
	rationale: string;
};

type PiSettings = {
	defaultProvider?: string;
	defaultModel?: string;
	enabledModels?: string[];
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
	version: 1,
	provider: "auto",
	providers: {
		anthropic: {
			xs: "anthropic/claude-haiku-4-5",
			sm: "anthropic/claude-haiku-4-5",
			md: "anthropic/claude-sonnet-4-6",
			lg: "anthropic/claude-opus-4-7",
			xl: "anthropic/claude-opus-4-7",
			cheap: "anthropic/claude-haiku-4-5",
			mid: "anthropic/claude-sonnet-4-6",
			deep: "anthropic/claude-opus-4-7",
		},
		"openai-codex": {
			xs: "openai-codex/gpt-5.4-mini",
			sm: "openai-codex/gpt-5.4-mini",
			md: "openai-codex/gpt-5.4",
			lg: "openai-codex/gpt-5.4",
			xl: "openai-codex/gpt-5.4",
			cheap: "openai-codex/gpt-5.4-mini",
			mid: "openai-codex/gpt-5.4",
			deep: "openai-codex/gpt-5.4",
		},
	},
	tiers: {
		xs: {
			name: "Extra Small",
			thinkingLevel: "minimal",
			description: "Very small tasks, simple rewrites, classification, and mechanical edits.",
		},
		sm: {
			name: "Small",
			thinkingLevel: "low",
			description: "Simple tasks, deterministic outputs. Use for formatting, rewriting, classification.",
		},
		md: {
			name: "Medium",
			thinkingLevel: "medium",
			description: "Handles moderate complexity. Use for workflows, APIs, structured tasks.",
		},
		lg: {
			name: "Large",
			thinkingLevel: "high",
			description: "Strong reasoning, multi-step tasks. Use for reasoning, planning, debugging, decision support.",
		},
		xl: {
			name: "Deep",
			thinkingLevel: "xhigh",
			description: "Near-frontier capability for complex domains, planning, abstraction, and ambiguous problems.",
		},
		cheap: { name: "Cheap", thinkingLevel: "minimal" },
		mid: { name: "Mid", thinkingLevel: "medium" },
		deep: { name: "Deep", thinkingLevel: "high" },
	},
	roles: {
		researcher: "sm",
		docs: "xs",
		backend: "md",
		frontend: "md",
		tester: "md",
		planner: "lg",
		reviewer: "md",
	},
	roleTiers: {
		researcher: "cheap",
		docs: "cheap",
		backend: "mid",
		frontend: "mid",
		tester: "mid",
		planner: "deep",
		reviewer: "deep",
	},
	defaultTier: "md",
	tierThinkingLevels: {
		cheap: "minimal",
		mid: "medium",
		deep: "high",
	},
};

const CONFIG_FILENAME = "model-config.json";
const SETTINGS_FILENAME = "settings.json";
const AUTH_FILENAME = "auth.json";

export function isModelTier(value: string): value is ModelTier {
	return value === "cheap" || value === "mid" || value === "deep";
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

/** Path to the model-config file for team-mode. */
export function modelConfigPath(storageRoot: string = getStorageRoot()): string {
	return join(storageRoot, CONFIG_FILENAME);
}

let cachedConfig: { root: string; config: ModelConfig } | null = null;

/**
 * Load model config from disk, merging with built-in defaults so missing keys
 * are always populated. Returns DEFAULT_MODEL_CONFIG when no file exists.
 *
 * Cached for process lifetime (user-edited config rarely changes mid-session);
 * call `invalidateModelConfigCache()` after `saveModelConfig` if you edit it.
 */
export async function loadModelConfig(
	storageRoot: string = getStorageRoot(),
): Promise<ModelConfig> {
	if (cachedConfig && cachedConfig.root === storageRoot) return cachedConfig.config;
	try {
		const raw = await readFile(modelConfigPath(storageRoot), "utf8");
		const parsed = JSON.parse(raw) as Partial<ModelConfig>;
		const merged = mergeWithDefaults(parsed);
		cachedConfig = { root: storageRoot, config: merged };
		return merged;
	} catch {
		cachedConfig = { root: storageRoot, config: DEFAULT_MODEL_CONFIG };
		return DEFAULT_MODEL_CONFIG;
	}
}

export function invalidateModelConfigCache(): void {
	cachedConfig = null;
}

/** Persist a full model config to disk. Creates the storage dir if needed. */
export async function saveModelConfig(
	config: ModelConfig,
	storageRoot: string = getStorageRoot(),
): Promise<void> {
	await mkdir(storageRoot, { recursive: true });
	await writeFile(modelConfigPath(storageRoot), JSON.stringify(config, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	invalidateModelConfigCache();
}

/**
 * Resolve the concrete `{ provider, model }` for a role + optional tier.
 * Returns `null` if the resolved provider has no catalog entry.
 *
 * v2 tiers with multiple entries return `candidates` ordered by the
 * weighted round-robin rotation (primary first, rest as fallback chain).
 *
 * @param config          The loaded model config.
 * @param role            The teammate's role (subagent_type). Empty string = use defaultTier.
 * @param tierOverride    Optional tier to force, regardless of role mapping.
 */
export function resolveModel(
	config: ModelConfig,
	role: string,
	tierOverride?: ModelTier,
): ResolvedModel | null {
	const provider = detectProvider(config.provider);
	const catalog = config.providers[provider];
	if (!catalog) return null;

	const tier = tierOverride ?? config.roles[role] ?? config.roleTiers[role] ?? config.defaultTier;
	const entries = normalizeTierEntries(catalog[tier]).filter((e) => e.enabled !== false);
	if (entries.length === 0) return null;

	const ordered = orderCandidates(`${provider}:${tier}`, entries);
	const candidates = ordered.map((entry) => toCandidate(entry, config, role, tier));
	const primary = candidates[0];

	const rationale =
		buildRationale(role, tier, tierOverride, provider, config) +
		(candidates.length > 1 ? ` (candidate 1/${candidates.length} via round-robin)` : "");

	return {
		provider: primary.provider,
		model: primary.model,
		tier,
		thinkingLevel: primary.thinkingLevel,
		candidates: candidates.length > 1 ? candidates : undefined,
		rationale,
	};
}

/**
 * Resolve a caller-provided bare model id (for example `gpt-5.5`) to a
 * provider-qualified selection before spawning a teammate subprocess.
 *
 * Without this, team-mode would pass only `--model gpt-5.5` to pi and pi's
 * global model matcher could choose a same-named model on an unauthenticated
 * gateway (for example Azure or OpenCode) instead of the user's configured
 * provider (`openai-codex/gpt-5.5`, `opencode-go/glm-5.2`, etc.).
 */
export function resolveBareModelOverride(
	config: ModelConfig,
	override: string,
): ResolvedModel | null {
	const requested = splitThinkingSuffix(override.trim());
	if (!requested.model || requested.model.includes("/")) return null;

	const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const settings = readJsonFileSync<PiSettings>(join(piAgentDir, SETTINGS_FILENAME));
	const detectedProvider = detectProvider(config.provider);
	const candidates: Array<{
		provider: string;
		model: string;
		thinkingLevel?: ThinkingLevel;
		source: string;
	}> = [];

	for (const [providerKey, catalog] of Object.entries(config.providers)) {
		for (const { entry } of catalogEntries(catalog)) {
			const split = splitFqn(entry.model);
			const candidate = splitThinkingSuffix(split.id);
			if (candidate.model !== requested.model) continue;
			candidates.push({
				provider: entry.provider ?? split.provider ?? providerKey,
				model: candidate.model,
				thinkingLevel: candidate.thinkingLevel,
				source: "model-config catalog",
			});
		}
	}

	for (const fqn of settings?.enabledModels ?? []) {
		const split = splitFqn(fqn);
		if (!split.provider) continue;
		const candidate = splitThinkingSuffix(split.id);
		if (candidate.model !== requested.model) continue;
		candidates.push({
			provider: split.provider,
			model: candidate.model,
			thinkingLevel: candidate.thinkingLevel,
			source: "pi settings enabledModels",
		});
	}

	const defaultModel = settings?.defaultModel ? splitThinkingSuffix(settings.defaultModel) : null;
	if (
		settings?.defaultProvider &&
		defaultModel &&
		!settings.defaultModel.includes("/") &&
		defaultModel.model === requested.model
	) {
		candidates.push({
			provider: settings.defaultProvider,
			model: defaultModel.model,
			thinkingLevel: defaultModel.thinkingLevel,
			source: "pi settings defaultProvider/defaultModel",
		});
	}

	const unique = dedupeCandidates(candidates);
	const preferred =
		unique.find((c) => c.provider === detectedProvider) ??
		unique.find((c) => c.provider === settings?.defaultProvider) ??
		unique[0];

	if (preferred) {
		return {
			provider: preferred.provider,
			model: preferred.model,
			tier: "explicit",
			thinkingLevel: requested.thinkingLevel ?? preferred.thinkingLevel,
			rationale: `bare model override "${requested.model}" → ${preferred.provider}/${preferred.model} via ${preferred.source}`,
		};
	}

	const hintedProvider = providerFromModelHint(requested.model);
	if (hintedProvider) {
		return {
			provider: hintedProvider,
			model: requested.model,
			tier: "explicit",
			thinkingLevel: requested.thinkingLevel,
			rationale: `bare model override "${requested.model}" → ${hintedProvider}/${requested.model} via model-name hint`,
		};
	}

	return null;
}

/**
 * Infer which provider to use when `config.provider === "auto"`.
 * Priority: env > pi settings.json defaultProvider > auth.json > api keys > anthropic.
 */
export function detectProvider(explicit?: string): string {
	if (explicit && explicit !== "auto") return explicit;

	const envOverride = process.env.PI_TEAM_MATE_MODEL_PROVIDER;
	if (envOverride) return envOverride;

	const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

	const settings = readJsonFileSync<{ defaultProvider?: string; defaultModel?: string }>(
		join(piAgentDir, SETTINGS_FILENAME),
	);
	if (settings?.defaultProvider && settings.defaultProvider in DEFAULT_MODEL_CONFIG.providers) {
		return settings.defaultProvider;
	}
	const hintedFromModel = providerFromModelHint(settings?.defaultModel ?? "");
	if (hintedFromModel) return hintedFromModel;

	const auth = readJsonFileSync<Record<string, unknown>>(join(piAgentDir, AUTH_FILENAME));
	if (auth) {
		if (settings?.defaultProvider && auth[settings.defaultProvider]) {
			return settings.defaultProvider;
		}
		if (auth["openai-codex"]) return "openai-codex";
		if (auth.anthropic) return "anthropic";
	}

	if (process.env.ANTHROPIC_API_KEY) return "anthropic";
	if (process.env.OPENAI_API_KEY) return "openai-codex";

	return "anthropic";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a provider catalog into `{ tier, entry }` pairs, accepting both
 * v1 string tiers and v2 entry arrays.
 */
export function catalogEntries(
	catalog: ProviderCatalog,
): Array<{ tier: string; entry: TierModelEntry }> {
	const out: Array<{ tier: string; entry: TierModelEntry }> = [];
	for (const [tier, value] of Object.entries(catalog)) {
		for (const entry of normalizeTierEntries(value)) out.push({ tier, entry });
	}
	return out;
}

/** Normalize a tier catalog value (v1 string or v2 entry array) into entries. */
function normalizeTierEntries(value: string | TierModelEntry[] | undefined): TierModelEntry[] {
	if (!value) return [];
	if (typeof value === "string") return [{ model: value }];
	return value.filter((entry) => typeof entry?.model === "string" && entry.model.length > 0);
}

// Weighted round-robin rotation state, keyed by "provider:tier".
// Module-level like the config cache; process lifetime is the rotation window.
const candidateRotation = new Map<string, number>();

/** Test seam: reset round-robin rotation state. */
export function resetCandidateRotation(): void {
	candidateRotation.clear();
}

/**
 * Order entries for one selection: expand entries into weight slots, advance
 * the rotation cursor, and return distinct entries starting at the cursor.
 */
function orderCandidates(key: string, entries: TierModelEntry[]): TierModelEntry[] {
	const slots: TierModelEntry[] = [];
	for (const entry of entries) {
		const weight = Math.max(1, Math.floor(entry.weight ?? 1));
		for (let i = 0; i < weight; i++) slots.push(entry);
	}
	if (slots.length === 0) return [];

	const cursor = candidateRotation.get(key) ?? 0;
	candidateRotation.set(key, (cursor + 1) % slots.length);

	const ordered: TierModelEntry[] = [];
	const seen = new Set<TierModelEntry>();
	for (let i = 0; i < slots.length; i++) {
		const entry = slots[(cursor + i) % slots.length];
		if (seen.has(entry)) continue;
		seen.add(entry);
		ordered.push(entry);
	}
	return ordered;
}

/** Convert one tier entry into a concrete candidate with resolved thinking level. */
function toCandidate(
	entry: TierModelEntry,
	config: ModelConfig,
	role: string,
	tier: ModelTier,
): ResolvedCandidate {
	const { provider: splitProvider, id } = splitFqn(entry.model);
	const { model, thinkingLevel: suffixThinkingLevel } = splitThinkingSuffix(id);
	const thinkingLevel =
		entry.effort ??
		entry.thinkingLevel ??
		config.roleThinkingLevels?.[role] ??
		config.tiers[tier]?.thinkingLevel ??
		suffixThinkingLevel ??
		config.tierThinkingLevels?.[tier] ??
		config.defaultThinkingLevel;
	return {
		provider: entry.provider ?? splitProvider ?? "",
		model,
		thinkingLevel,
	};
}

function mergeWithDefaults(partial: Partial<ModelConfig>): ModelConfig {
	const mergedTiers = mergeTiers(partial.tiers, partial.tierThinkingLevels);
	const mergedRoles = {
		...DEFAULT_MODEL_CONFIG.roles,
		...(partial.roles ?? {}),
		...(partial.roleTiers ?? {}),
	};
	const base: ModelConfig = {
		provider: partial.provider ?? DEFAULT_MODEL_CONFIG.provider,
		providers: {
			...DEFAULT_MODEL_CONFIG.providers,
			...(partial.providers ?? {}),
		},
		tiers: mergedTiers,
		roles: mergedRoles,
		roleTiers: {
			...DEFAULT_MODEL_CONFIG.roleTiers,
			...(partial.roleTiers ?? {}),
		},
		defaultTier: partial.defaultTier ?? DEFAULT_MODEL_CONFIG.defaultTier,
		defaultThinkingLevel: partial.defaultThinkingLevel ?? DEFAULT_MODEL_CONFIG.defaultThinkingLevel,
		tierThinkingLevels: {
			...(DEFAULT_MODEL_CONFIG.tierThinkingLevels ?? {}),
			...(partial.tierThinkingLevels ?? {}),
		},
		roleThinkingLevels: {
			...(DEFAULT_MODEL_CONFIG.roleThinkingLevels ?? {}),
			...(partial.roleThinkingLevels ?? {}),
		},
	};
	if (partial.taskCompletedHook !== undefined) {
		base.taskCompletedHook = partial.taskCompletedHook;
	}
	base.version = partial.version ?? inferModelConfigVersion(partial.providers);
	return base;
}

function inferModelConfigVersion(providers: Partial<ModelConfig>["providers"]): number {
	if (!providers) return 1;
	return Object.values(providers).some((catalog) =>
		Object.values(catalog).some(Array.isArray),
	)
		? 2
		: 1;
}

function mergeTiers(
	tiers: Partial<ModelConfig>["tiers"],
	tierThinkingLevels: Partial<ModelConfig>["tierThinkingLevels"],
): Record<string, TierConfig> {
	const merged: Record<string, TierConfig> = { ...DEFAULT_MODEL_CONFIG.tiers };
	for (const [tier, config] of Object.entries(tiers ?? {})) {
		merged[tier] = { ...(merged[tier] ?? {}), ...config };
	}
	for (const [tier, thinkingLevel] of Object.entries(tierThinkingLevels ?? {})) {
		merged[tier] = { ...(merged[tier] ?? {}), thinkingLevel };
	}
	return merged;
}

function providerFromModelHint(modelHint: string): string | null {
	if (!modelHint) return null;
	if (/claude|anthropic|haiku|sonnet|opus/i.test(modelHint)) return "anthropic";
	if (/gpt|codex|openai/i.test(modelHint)) return "openai-codex";
	return null;
}

function readJsonFileSync<T>(filePath: string): T | null {
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

function splitFqn(fqn: string): { provider?: string; id: string } {
	const idx = fqn.indexOf("/");
	if (idx < 0) return { id: fqn };
	return { provider: fqn.slice(0, idx), id: fqn.slice(idx + 1) };
}

function dedupeCandidates<T extends { provider: string; model: string }>(candidates: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.provider}/${candidate.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}

export function splitThinkingSuffix(model: string): { model: string; thinkingLevel?: ThinkingLevel } {
	const idx = model.lastIndexOf(":");
	if (idx < 0) return { model };
	const suffix = model.slice(idx + 1);
	if (!isThinkingLevel(suffix)) return { model };
	return { model: model.slice(0, idx), thinkingLevel: suffix };
}

function buildRationale(
	role: string,
	tier: ModelTier,
	tierOverride: ModelTier | undefined,
	provider: string,
	config: ModelConfig,
): string {
	if (tierOverride) {
		return `tier override "${tier}" on provider "${provider}"`;
	}
	if (role && (config.roles[role] || config.roleTiers[role])) {
		return `role "${role}" → tier "${tier}" on provider "${provider}"`;
	}
	return `default tier "${tier}" on provider "${provider}"`;
}
