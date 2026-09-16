# Multi-edit Codex 开发手册

## 1. 目的

本目录用于在 `pi-mono-extensions` 的 `multi-edit` 基线上开发以下能力：

1. 支持 Codex 原生 patch 的 `*** Move to:`。
2. 支持 Codex 原生 patch 的 `*** End of File`，并实现真正的 EOF 约束，而不是只接受语法。
3. 在支持该能力的 pi-ai / Responses provider 上，把 `apply_patch` 声明为 custom tool，并使用 Lark grammar 做 constrained sampling。
4. 保持普通模型上的 JSON function tool 行为，以及 mono 原有的 `multi_file_edit` 和 native `edit` 协作方式。

本目录是独立开发副本，不继承源基线的 Git 元数据。

## 2. 基线

- 来源：`/tmp/applypatch-compare/mono`
- 来源分支：`main`
- 来源提交：`e4e047a5a203cac78f5e420c92a3115ccd2fe6bb`
- 目标目录：`/mnt/projects/repos/pi-extensions/multi-edit-codex`
- 当前扩展：`extensions/multi-edit`
- 当前包版本：`2.0.0`

基线当前已经具备：

- `multi_file_edit`：跨文件和单文件重复出现的 exact replacement。
- `apply_patch`：Add、Delete、Update 三类操作。
- virtual workspace preflight。
- real workspace 写入、删除、diff 和 `context-guard:file-modified` 事件。
- update hunk 的 `@@` context prefix 和 trailing-whitespace fallback。
- patch tool 的 TypeBox schema 与测试。

基线当前明确不支持：

- `*** Move to:`。
- `*** End of File`。
- provider-side custom tool。
- Lark / CFG constrained sampling。
- Codex Responses transport 的自定义实现。

## 3. 设计结论

### 3.1 Patch parser 与 provider transport 分离

`Move to` 和 `End of File` 属于本地 patch 协议和文件应用语义，应在以下模块完成：

- `extensions/multi-edit/patch.ts`
- `extensions/multi-edit/types.ts`
- `extensions/multi-edit/workspace.ts`

custom tool、grammar 和 Responses API 属于模型适配层，不应让 patch parser 直接依赖 HTTP、SSE 或某个模型 id。

### 3.2 优先使用 pi-ai 原生 constrained sampling

当前 pi-ai 具备以下原生能力：

- `Tool.constrainedSampling`。
- `Model.compat.supportsOpenAIGrammarTools`。
- `openai-codex-responses` provider。
- Responses custom tool 的输入增量、tool result 和上下文回放。

因此优先在 `apply_patch` 的工具定义上增加 grammar metadata：

```ts
constrainedSampling: {
  type: "grammar",
  variants: {
    openai_lark: APPLY_PATCH_GRAMMAR,
  },
}
```

不先复制旧版 `codex-provider.ts`。自定义 provider 只有在当前运行时没有原生 constrained sampling，或需要接入非标准 Codex 网关时才建立。

### 3.3 普通模型必须继续工作

模型支持 grammar 时：

```text
apply_patch -> Responses custom tool + Lark grammar
```

模型不支持 grammar 时：

```text
apply_patch -> 普通 JSON function tool，参数为 { patch: string }
```

不能只因为模型 id 以 `gpt-` 开头就假定支持 custom tool。能力应由 provider/model metadata 决定。

## 4. 目标协议

### 4.1 完整 patch envelope

```text
*** Begin Patch
[one or more file operations]
*** End Patch
```

必须满足：

- 第一行是 `*** Begin Patch`。
- 最后一条有效 envelope 指令是 `*** End Patch`。
- 至少包含一个文件操作。
- `*** End Patch` 后只能有空白。
- CRLF 输入归一化为 LF。

### 4.2 Add File

```text
*** Add File: src/new.ts
+export const value = 1;
```

要求：

- 目标不存在。
- 每个内容行以 `+` 开头。
- 目标父目录不存在时创建父目录。
- 保持 mono 当前文件末尾换行策略，除非测试明确规定不同协议行为。

### 4.3 Delete File

```text
*** Delete File: src/old.ts
```

要求：

- 目标存在。
- 目标必须是文件。
- 删除成功后发出文件修改事件。

### 4.4 Update File

```text
*** Update File: src/old.ts
@@ function value()
-old
+new
```

要求：

- 源文件存在。
- 每个 update 至少包含一个 hunk。
- hunk 行只能使用空格、`-`、`+` 前缀。
- 保留现有 context prefix 和 trailing-whitespace matching 行为，除非专门的 Codex 兼容测试要求改变。

### 4.5 Move to

```text
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-old
+new
```

语义：

1. 读取源文件并应用所有 hunks。
2. 确认目标不存在。
3. 创建目标父目录。
4. 写入更新后的内容到目标文件。
5. 删除源文件。

必须拒绝：

- 源文件不存在。
- 目标已经存在。
- 源路径和目标路径解析后相同。
- 一个 patch 内出现无法解析的路径冲突。

执行顺序不能先删除源文件。当前基线的 apply path 不是完整事务，因此实现至少要通过 virtual preflight 在真实写入前验证源、目标、hunk 和权限。

### 4.6 End of File

```text
*** Update File: src/file.ts
@@
-last line
+new last line
*** End of File
```

`*** End of File` 是 hunk 的语义标记，不是普通文件操作边界。它表示该 hunk 必须结束在目标文件 EOF。

实现要求：

- parser 将其保存到 hunk，例如 `endOfFile: true`。
- applier 只能接受位于文件末尾的匹配。
- 文件中间存在相同文本时不得误匹配。
- EOF mismatch 必须返回明确错误。
- 无 final newline 的文件、空文件、纯追加 hunk 都要有单独测试。

不能只在 parser 中消费该行。若 apply 阶段忽略该标记，只是语法兼容，不是 Codex 语义兼容。

## 5. 文件职责

### `extensions/multi-edit/types.ts`

建议扩展：

```ts
export interface Hunk {
  contextPrefix?: string;
  oldBlock: string;
  newBlock: string;
  endOfFile?: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };
```

### `extensions/multi-edit/patch.ts`

负责：

- envelope parser。
- Add/Delete/Update/Move 结构解析。
- hunk 的 EOF 元数据。
- path resolve。
- hunk matching 和 EOF matching。
- operation orchestration。
- diff 结果和错误信息。

不负责：

- 模型识别。
- Responses HTTP 请求。
- UI 专属状态。

### `extensions/multi-edit/workspace.ts`

`Workspace` 仍然是 parser/applier 与文件系统之间的边界。

Move 可先组合现有接口：

```text
writeText(destination, updated)
deleteFile(source)
```

virtual workspace 必须能正确表示：

```text
source: content -> deleted
 destination: absent -> updated content
```

真实 workspace 的 source 和 destination 都必须发出 `context-guard:file-modified`。

### `extensions/multi-edit/index.ts`

负责：

- 注册工具。
- preflight 和真实 apply。
- 返回文本、diff 和 `firstChangedLine`。
- 声明 `constrainedSampling`。

不在此处增加基于模型 id 的工具禁用策略。mono 的目标是 additive extension；`edit` / `write` 是否可用属于独立的产品策略。

## 6. 分阶段实施计划

### Phase 0：开发基线和工具链

状态：进行中。

- 基线已复制到本目录。
- 开发手册已建立。
- 确认依赖版本和测试命令。
- 不修改源基线目录。

完成标准：

```bash
cd /mnt/projects/repos/pi-extensions/multi-edit-codex
pnpm install
pnpm --filter pi-mono-multi-edit test
```

### Phase 1：Move / EOF 数据结构和 parser

- 扩展 `Hunk` 和 update operation 类型。
- 支持 `*** Move to:`。
- 支持 hunk 内的 `*** End of File`。
- 保留现有 envelope 和 hunk 错误信息。
- 为 malformed Move/EOF 输入增加 parser 测试。

完成标准：parser 能准确区分：

- 下一文件操作。
- 下一 hunk。
- EOF sentinel。
- envelope end。

### Phase 2：Move / EOF applier

- 实现严格 EOF match。
- 实现 update + move。
- 增加目标父目录创建。
- 增加源/目标冲突 preflight。
- 增加真实 workspace 和 virtual workspace 测试。
- 确认 diff、operation summary 和文件修改事件。

完成标准：所有本地 patch 测试通过，且失败输入不会在真实文件上留下部分修改。

### Phase 3：grammar tool metadata

- 导出 `APPLY_PATCH_GRAMMAR`。
- 在 `apply_patch` 工具定义增加 `constrainedSampling`。
- 确认 grammar 的唯一参数仍然是必需 string 属性 `patch`。
- 保持不支持 grammar 的模型退回普通 JSON function tool。
- 增加工具 schema 测试。

完成标准：工具定义被 SDK 正确识别；普通 provider 行为不回归。

### Phase 4：Codex Responses 集成验证

优先使用内置 `openai-codex-responses` provider，不新增 custom provider。

验证：

- custom tool payload 使用 Lark grammar。
- custom tool 输入能还原为 `{ patch: string }`。
- tool call 能进入本地 `apply_patch` 执行。
- tool result 能进入下一轮 Responses input。
- interrupted tool call 不会破坏下一轮上下文。
- usage、stop reason、thinking 和 streaming tool-call 事件正常。

完成标准：至少完成一次真实 Codex session 的 add/update/delete/move/EOF 流程，并确认下一轮仍能继续对话。

### Phase 5：可选 custom provider

只有 Phase 3/4 证明运行时 SDK 不支持所需能力时才执行。

独立新增 provider adapter，不能把 HTTP 实现塞进 `patch.ts`。必须覆盖：

- token/account id。
- 请求 URL 和 header。
- function/custom tool 的 context conversion。
- SSE event mapping。
- custom tool input delta。
- tool result output。
- abort、error、retry。
- response id 和 reasoning signature 回放。

如果 provider adapter 只支持 SSE，就必须明确记录 websocket、continuation、prompt cache 等能力不支持，而不能暗中宣称完全兼容。

## 7. 测试矩阵

### Parser

- 空 patch。
- 缺少 Begin/End envelope。
- Add/Delete/Update 基本解析。
- Move 缺少目标路径。
- Move 出现在错误位置。
- EOF sentinel 出现在 hunk 外。
- EOF sentinel 后仍有 hunk 内容。
- CRLF patch。
- patch 末尾空白。

### Applier

- Add nested file。
- Delete existing file。
- Delete missing file。
- Update single hunk。
- Update multiple hunks。
- Move with update。
- Move without content change。
- Move destination exists。
- Move destination parent creation。
- Move source equals destination。
- EOF match。
- EOF mismatch with same block in the middle。
- EOF on file without final newline。
- EOF pure insertion。
- trailing whitespace matching。

### Workspace / orchestration

- virtual preflight 不触碰真实文件内容。
- preflight 失败时真实文件不变。
- multi-operation 中的源/目标状态可被后续 operation 看到。
- write/delete 事件路径完整。
- diff 和 first changed line 正确。
- Abort 在 operation 边界生效。

### Provider integration

- grammar capability 开启时发 custom tool。
- grammar capability关闭时发 function tool。
- custom input 增量保持单调。
- custom tool result 使用正确的 Responses item 类型。
- tool call 后下一轮上下文可继续。
- 普通 provider 和旧 session 不回归。

## 8. 验收标准

交付前必须满足：

1. `extensions/multi-edit` 的现有测试全部通过。
2. 新增 Move / EOF 测试覆盖成功和失败路径。
3. grammar metadata 不影响普通 function tool fallback。
4. 真实文件失败 preflight 不产生修改。
5. move 不会在目标冲突时删除源文件。
6. Codex custom tool 能完成至少一轮 tool call 和下一轮上下文回放。
7. 没有复制旧版 provider transport 造成的未验证兼容层。
8. 文档中的限制与实际实现一致，尤其是 public Responses API 与 ChatGPT Codex backend 的能力差异。

## 9. 明确不做

本次不包含：

- 4-pass fuzzy matching 的完整重写。
- 全 patch 事务日志或跨设备原子提交。
- 根据模型 id 自动禁用 native `edit` / `write`。
- 为所有 OpenAI-compatible 网关强行开启 grammar。
- 为旧 pi-ai 版本增加 fallback provider。
- 修改 mono 仓库源目录。

如果后续需要完整 Codex fuzzy matcher 或全 patch rollback，应作为新的设计主题单独评估。

## 10. 开发命令

```bash
cd /mnt/projects/repos/pi-extensions/multi-edit-codex
pnpm install
pnpm --filter pi-mono-multi-edit test
pnpm --filter pi-mono-multi-edit bench
```

实现代码只改目标副本；每个阶段完成后先运行扩展测试，再进行真实 provider 验证。
