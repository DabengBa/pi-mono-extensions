/**
 * Pi Team-Mode — Model Config Tests
 *
 * Covers loadModelConfig / resolveModel / detectProvider and asserts the
 * exact shape the user keeps at ~/.pi/agent/extensions/team-mode/model-config.json
 * resolves to openai-codex/gpt-5.4-{mini,regular,:high} by role/tier.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	DEFAULT_MODEL_CONFIG,
	detectProvider,
	invalidateModelConfigCache,
	isModelTier,
	loadModelConfig,
	modelConfigPath,
	resetCandidateRotation,
	resolveBareModelOverride,
	resolveModel,
	saveModelConfig,
	type ModelConfig,
} from "../core/model-config.ts";

function withEnv<T>(patch: NodeJS.ProcessEnv, fn: () => T): T {
	const prev: NodeJS.ProcessEnv = {};
	for (const k of Object.keys(patch)) {
		prev[k] = process.env[k];
		if (patch[k] === undefined) delete process.env[k];
		else process.env[k] = patch[k];
	}
	try {
		return fn();
	} finally {
		for (const k of Object.keys(patch)) {
			if (prev[k] === undefined) delete process.env[k];
			else process.env[k] = prev[k];
		}
	}
}

const USER_CONFIG: ModelConfig = {
	version: 1,
	provider: "openai-codex",
	providers: {
		anthropic: {
			cheap: "anthropic/claude-haiku-4-5",
			mid: "anthropic/claude-sonnet-4-6",
			deep: "anthropic/claude-opus-4-7:high",
		},
		"openai-codex": {
			cheap: "openai-codex/gpt-5.4-mini",
			mid: "openai-codex/gpt-5.4",
			deep: "openai-codex/gpt-5.4:high",
		},
	},
	tiers: {
		...DEFAULT_MODEL_CONFIG.tiers,
		cheap: { name: "Cheap", thinkingLevel: "minimal" },
		mid: { name: "Mid", thinkingLevel: "medium" },
		deep: { name: "Deep", thinkingLevel: "high" },
	},
	roles: {
		...DEFAULT_MODEL_CONFIG.roles,
		researcher: "cheap",
		docs: "cheap",
		backend: "mid",
		frontend: "mid",
		tester: "mid",
		planner: "deep",
		reviewer: "deep",
		leader: "mid",
	},
	roleTiers: {
		researcher: "cheap",
		docs: "cheap",
		backend: "mid",
		frontend: "mid",
		tester: "mid",
		planner: "deep",
		reviewer: "deep",
		leader: "mid",
	},
	defaultTier: "mid",
	defaultThinkingLevel: undefined,
	tierThinkingLevels: {
		...(DEFAULT_MODEL_CONFIG.tierThinkingLevels ?? {}),
		cheap: "minimal",
		mid: "medium",
		deep: "high",
	},
	roleThinkingLevels: {},
};

describe("isModelTier", () => {
	test("accepts the three tiers", () => {
		assert.equal(isModelTier("cheap"), true);
		assert.equal(isModelTier("mid"), true);
		assert.equal(isModelTier("deep"), true);
	});

	test("rejects anything else", () => {
		assert.equal(isModelTier("MID"), false);
		assert.equal(isModelTier("fast"), false);
		assert.equal(isModelTier(""), false);
	});
});

describe("loadModelConfig / saveModelConfig", () => {
	test("round-trips a config to disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await saveModelConfig(USER_CONFIG, dir);
			const loaded = await loadModelConfig(dir);
			assert.deepEqual(loaded, USER_CONFIG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns defaults when config file is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			const loaded = await loadModelConfig(dir);
			assert.deepEqual(loaded, DEFAULT_MODEL_CONFIG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("merges partial config with defaults", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await writeFile(
				modelConfigPath(dir),
				JSON.stringify({ provider: "openai-codex", defaultTier: "cheap" }),
				"utf8",
			);
			const loaded = await loadModelConfig(dir);
			assert.equal(loaded.provider, "openai-codex");
			assert.equal(loaded.defaultTier, "cheap");
			// defaults are still there
			assert.equal(loaded.roleTiers.researcher, "cheap");
			assert.ok(loaded.providers.anthropic);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("accepts compact tiers/roles config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await writeFile(
				modelConfigPath(dir),
				JSON.stringify({
					provider: "openai-codex",
					defaultTier: "md",
					tiers: {
						sm: { name: "Small", thinkingLevel: "low" },
						md: { name: "Medium", thinkingLevel: "medium" },
						lg: { name: "Large", thinkingLevel: "high" },
					},
					roles: {
						researcher: "sm",
						backend: "md",
						planner: "lg",
					},
				}),
				"utf8",
			);
			const loaded = await loadModelConfig(dir);
			assert.equal(loaded.roles.researcher, "sm");
			assert.equal(loaded.tiers.sm?.thinkingLevel, "low");
			const resolved = resolveModel(loaded, "planner");
			assert.ok(resolved);
			assert.equal(resolved.tier, "lg");
			assert.equal(resolved.model, "gpt-5.4");
			assert.equal(resolved.thinkingLevel, "high");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveModel — user's real config", () => {
	test("researcher → openai-codex/gpt-5.4-mini", () => {
		const resolved = resolveModel(USER_CONFIG, "researcher");
		assert.ok(resolved);
		assert.equal(resolved.provider, "openai-codex");
		assert.equal(resolved.model, "gpt-5.4-mini");
		assert.equal(resolved.tier, "cheap");
		assert.match(resolved.rationale, /researcher/);
	});

	test("backend → openai-codex/gpt-5.4", () => {
		const resolved = resolveModel(USER_CONFIG, "backend");
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.4");
		assert.equal(resolved.tier, "mid");
	});

	test("reviewer → openai-codex/gpt-5.4 with high thinking (deep)", () => {
		const resolved = resolveModel(USER_CONFIG, "reviewer");
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.4");
		assert.equal(resolved.tier, "deep");
		assert.equal(resolved.thinkingLevel, "high");
	});

	test("roleThinkingLevels overrides tier defaults", () => {
		const resolved = resolveModel(
			{
				...USER_CONFIG,
				roleThinkingLevels: { reviewer: "xhigh" },
			},
			"reviewer",
		);
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.4");
		assert.equal(resolved.thinkingLevel, "xhigh");
	});

	test("unknown role falls back to defaultTier (mid)", () => {
		const resolved = resolveModel(USER_CONFIG, "unknown-role");
		assert.ok(resolved);
		assert.equal(resolved.tier, "mid");
		assert.match(resolved.rationale, /default tier/);
	});

	test("tierOverride wins over role", () => {
		const resolved = resolveModel(USER_CONFIG, "reviewer", "cheap");
		assert.ok(resolved);
		assert.equal(resolved.tier, "cheap");
		assert.equal(resolved.model, "gpt-5.4-mini");
		assert.match(resolved.rationale, /override/);
	});

	test("returns null when resolved provider has no catalog", () => {
		const noOpenAI: ModelConfig = {
			...USER_CONFIG,
			provider: "missing-provider",
		};
		assert.equal(resolveModel(noOpenAI, "backend"), null);
	});
});

describe("resolveBareModelOverride", () => {
	test("qualifies a bare GPT override through the configured catalog", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-agent-dir-"));
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await writeFile(
				join(dir, "settings.json"),
				JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.5" }),
				"utf8",
			);
			const resolved = resolveBareModelOverride(
				{
					...USER_CONFIG,
					provider: "auto",
					providers: {
						...USER_CONFIG.providers,
						"openai-codex": { md: "openai-codex/gpt-5.5" },
					},
				},
				"gpt-5.5",
			);
			assert.ok(resolved);
			assert.equal(resolved.provider, "openai-codex");
			assert.equal(resolved.model, "gpt-5.5");
			assert.match(resolved.rationale, /openai-codex\/gpt-5\.5/);
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("uses pi settings enabledModels for bare provider aliases", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-agent-dir-"));
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await writeFile(
				join(dir, "settings.json"),
				JSON.stringify({
					defaultProvider: "openai-codex",
					enabledModels: ["openai-codex/gpt-5.5", "opencode-go/glm-5.2"],
				}),
				"utf8",
			);
			const resolved = resolveBareModelOverride(USER_CONFIG, "glm-5.2");
			assert.ok(resolved);
			assert.equal(resolved.provider, "opencode-go");
			assert.equal(resolved.model, "glm-5.2");
			assert.match(resolved.rationale, /enabledModels/);
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("preserves explicit thinking suffixes", () => {
		const resolved = resolveBareModelOverride(
			{
				...USER_CONFIG,
				providers: { "openai-codex": { md: "openai-codex/gpt-5.5" } },
			},
			"gpt-5.5:xhigh",
		);
		assert.ok(resolved);
		assert.equal(resolved.provider, "openai-codex");
		assert.equal(resolved.thinkingLevel, "xhigh");
	});
});

describe("v2 entry arrays", () => {
	const V2_CONFIG: ModelConfig = {
		version: 2,
		provider: "openai-codex",
		providers: {
			"openai-codex": {
				xs: [{ model: "openai-codex/gpt-5.3-codex", effort: "medium" }],
				md: [
					{ model: "openai-codex/gpt-5.6-terra", effort: "medium" },
					{ model: "openai-codex/gpt-5.5", effort: "high" },
				],
			},
		},
		tiers: DEFAULT_MODEL_CONFIG.tiers,
		roles: { researcher: "xs", backend: "md" },
		roleTiers: {},
		defaultTier: "md",
	};

	test("resolves entry effort as thinkingLevel", () => {
		resetCandidateRotation();
		const resolved = resolveModel(V2_CONFIG, "researcher");
		assert.ok(resolved);
		assert.equal(resolved.provider, "openai-codex");
		assert.equal(resolved.model, "gpt-5.3-codex");
		assert.equal(resolved.thinkingLevel, "medium");
		assert.equal(resolved.candidates, undefined);
	});

	test("entry effort wins over tier thinkingLevel and roleThinkingLevels", () => {
		resetCandidateRotation();
		const config: ModelConfig = {
			...V2_CONFIG,
			roleThinkingLevels: { researcher: "high" },
		};
		const resolved = resolveModel(config, "researcher");
		assert.ok(resolved);
		assert.equal(resolved.thinkingLevel, "medium");
	});

	test("round-robin rotates the primary across multi-entry tiers", () => {
		resetCandidateRotation();
		const first = resolveModel(V2_CONFIG, "backend");
		const second = resolveModel(V2_CONFIG, "backend");
		assert.ok(first);
		assert.ok(second);
		assert.equal(first.model, "gpt-5.6-terra");
		assert.equal(second.model, "gpt-5.5");
		// Both candidates are always present, primary first.
		assert.equal(first.candidates?.length, 2);
		assert.equal(second.candidates?.[0].model, "gpt-5.5");
		assert.equal(second.candidates?.[1].model, "gpt-5.6-terra");
	});

	test("weight skews round-robin toward heavier entries", () => {
		resetCandidateRotation();
		const weighted: ModelConfig = {
			...V2_CONFIG,
			providers: {
				"openai-codex": {
					md: [
						{ model: "openai-codex/gpt-5.6-terra", weight: 3 },
						{ model: "openai-codex/gpt-5.5", weight: 1 },
					],
				},
			},
		};
		const picks = [0, 1, 2, 3].map(() => resolveModel(weighted, "backend")?.model);
		const terra = picks.filter((m) => m === "gpt-5.6-terra").length;
		assert.equal(terra, 3); // weight 3 vs 1 → 3 of every 4 slots
	});

	test("disabled entries are skipped", () => {
		resetCandidateRotation();
		const config: ModelConfig = {
			...V2_CONFIG,
			providers: {
				"openai-codex": {
					xs: [
						{ model: "openai-codex/gpt-disabled", enabled: false },
						{ model: "openai-codex/gpt-enabled" },
					],
				},
			},
		};
		const resolved = resolveModel(config, "researcher");
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-enabled");
		assert.equal(resolved.candidates, undefined); // only one usable entry → no chain
	});

	test("v1 string tiers and v2 entry arrays mix in one catalog", () => {
		resetCandidateRotation();
		const config: ModelConfig = {
			...V2_CONFIG,
			// Strip tier-level thinking so the model :suffix path is exercised.
			tiers: { ...DEFAULT_MODEL_CONFIG.tiers, md: { name: "Medium" } },
			providers: {
				"openai-codex": {
					xs: [{ model: "openai-codex/gpt-5.3-codex", effort: "medium" }],
					md: "openai-codex/gpt-5.5:high",
				},
			},
		};
		const resolved = resolveModel(config, "backend");
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.5");
		assert.equal(resolved.thinkingLevel, "high");
		assert.equal(resolved.candidates, undefined);
	});

	test("returns null when a v2 tier is fully disabled", () => {
		resetCandidateRotation();
		const config: ModelConfig = {
			...V2_CONFIG,
			providers: {
				"openai-codex": {
					md: [{ model: "openai-codex/gpt-5.5", enabled: false }],
				},
			},
		};
		assert.equal(resolveModel(config, "backend"), null);
	});

	test("infers v1 or v2 when version is absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await writeFile(
				join(dir, "model-config.json"),
				JSON.stringify({ provider: "openai-codex", providers: V2_CONFIG.providers }),
				"utf8",
			);
			assert.equal((await loadModelConfig(dir)).version, 2);

			await writeFile(
				join(dir, "model-config.json"),
				JSON.stringify({
					provider: "openai-codex",
					providers: { "openai-codex": { md: "openai-codex/gpt-5.5" } },
				}),
				"utf8",
			);
			invalidateModelConfigCache();
			assert.equal((await loadModelConfig(dir)).version, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("version field round-trips through save/load", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await saveModelConfig(V2_CONFIG, dir);
			const loaded = await loadModelConfig(dir);
			assert.equal(loaded.version, 2);
			assert.deepEqual(loaded.providers["openai-codex"], V2_CONFIG.providers["openai-codex"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("bare override matches models inside v2 entry arrays", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-agent-dir-"));
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await writeFile(
				join(dir, "settings.json"),
				JSON.stringify({ defaultProvider: "openai-codex" }),
				"utf8",
			);
			const resolved = resolveBareModelOverride(V2_CONFIG, "gpt-5.6-terra");
			assert.ok(resolved);
			assert.equal(resolved.provider, "openai-codex");
			assert.equal(resolved.model, "gpt-5.6-terra");
			assert.match(resolved.rationale, /model-config catalog/);
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("entry provider override wins over catalog provider", () => {
		resetCandidateRotation();
		const config: ModelConfig = {
			...V2_CONFIG,
			providers: {
				"openai-codex": {
					xs: [{ model: "openai-codex/gpt-5.3-codex", provider: "opencode-go" }],
				},
			},
		};
		const resolved = resolveModel(config, "researcher");
		assert.ok(resolved);
		assert.equal(resolved.provider, "opencode-go");
		assert.equal(resolved.model, "gpt-5.3-codex");
	});
});

describe("detectProvider", () => {
	test("explicit non-auto wins", () => {
		assert.equal(detectProvider("anthropic"), "anthropic");
		assert.equal(detectProvider("openai-codex"), "openai-codex");
	});

	test("auto consults PI_TEAM_MATE_MODEL_PROVIDER env", () => {
		withEnv({ PI_TEAM_MATE_MODEL_PROVIDER: "openai-codex" }, () => {
			assert.equal(detectProvider("auto"), "openai-codex");
		});
	});

	test("auto falls through to anthropic when nothing is configured", () => {
		withEnv(
			{
				PI_TEAM_MATE_MODEL_PROVIDER: undefined,
				PI_CODING_AGENT_DIR: "/tmp/nonexistent-dir-for-test",
				ANTHROPIC_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			() => {
				assert.equal(detectProvider("auto"), "anthropic");
			},
		);
	});
});
