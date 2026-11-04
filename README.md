# dsh-llm-router

一个 DeepSeek Harness（dsh）的 **`auto` 路由 provider**：注册一个名为 `auto`
的虚拟模型，按请求内容自动挑选后端模型，并在失败时按链回退。

## 它解决什么问题

在 dsh 里，每个 provider 对应一个固定模型。想「看图用视觉模型、长文用长上下文模型、
其余用便宜的」就得手动切来切去。本插件把这个选择自动化：

```
请求进入 auto
   ├─ 含图片            → visionBackend
   ├─ 输入超阈值字符数   → longContextBackend
   └─ 其余              → defaultBackend
                          ↓ 任一后端「产出首个内容前」失败
                        按 fallbacks 链依次重试
```

**回退只在「首个内容块产出之前」发生。** 一旦后端已吐出内容，它就该自己负责到底——
中途失败会如实报错，不会重试（否则用户会看到重复的半个回答）。

## 安装

```bash
dsh plugin --profile web add dsh-llm-router
```

安装后 dsh 里会多出 `auto` 这个 provider，把它选为当前模型即可。

## ⚠️ 安装后必须做的事：配置你自己的后端

**默认配置里的 provider 名是作者本机环境的**，别人装了不一定存在。
不改配置就使用，大概率路由失败（找不到对应 provider）。

在你的 profile patch 层覆盖（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: llm-router
  config:
    defaultBackend:
      provider: <你的 provider id>
      model: <模型名>
    visionBackend:
      provider: <支持图片的 provider>
      model: <模型名>
    longContextBackend:
      provider: <支持长上下文的 provider>
      model: <模型名>
    fallbacks:
      - provider: <备选1>
        model: <模型名>
      - provider: <备选2>
        model: <模型名>
```

完整可配项与默认值：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `defaultBackend` | `deepseek-official` / `deepseek-v4-pro` | 常规请求 |
| `visionBackend` | `zai-coding-cn` / `glm-5v-turbo` | 含图请求（**不回退**，见下） |
| `longContextBackend` | `longcat` / `LongCat-2.0` | 超长输入 |
| `longContextCharThreshold` | `200000` | 触发长上下文的字符数 |
| `fallbacks` | 6 项（kimi / 智谱 / MiniMax / LongCat） | 回退链 |
| `advertisedContextWindow` | `1000000` | 对外宣称的上下文窗口 |
| `defaultReasoningEffort` | `high` | 默认推理档位 |

**视觉请求刻意不回退** —— 链上只有 `visionBackend` 一个候选。原因是其他后端不接图片，
回退过去只会拿到一个含义不同的报错，不如让失败原因直白。

## 路由日志

插件注册 `GET /api/llm-router/routes?sessionId=&limit=`，返回最近的路由决策
（内存环形缓冲，最多 200 条，不落盘）：

```json
{ "routes": [ { "id": 12, "kind": "vision", "provider": "zai-coding-cn",
                "model": "glm-5v-turbo", "fallbackIndex": 0,
                "affiliate": { "name": "智谱 BigModel", "badge": "2000万Tokens" } } ],
  "total": 12 }
```

`kind` ∈ `default` / `long-context` / `vision`；`fallbackIndex` 为 0 表示首个候选就成功。

## 关于 `affiliate` 字段（如实披露）

`affiliate` 仅在**已选定后端之后**填入，表示该后端对应的平台与作者有推广关系。
它**只为界面提示而存在，不参与任何路由决策**，且这一点是用结构保证的：

- 查询点在 `decide()` 与回退循环**定论之后**，时序上不可能影响本次选择；
- 选择逻辑的各函数体内不含任何返利相关标识符；
- 该字段不含 `weight` / `score` / `priority` 之类排序语义。

可以自行验证：把 `AFFILIATE_HINTS` 改成给所有 provider 都挂上返利，
`decide()` 的输出对同一组输入**逐条不变**。

## 已知边界

- **回退判定只看「首个内容前」的失败**（配额、限流、连接错、缺凭证等）。
  已产出内容后的中断不回退，见上文说明。
- 路由日志是**进程内内存**，重启即清空，不适合当审计账本。
- `longContextCharThreshold` 按**字符数**估算，不是精确 token 数。
- 视觉后端不回退，故 `visionBackend` 必须配一个真实可用的多模态模型。

## 兼容性

- 需要 `@deepseek-ai/dsh`（peer dependency，`*`）。
- 已验证 `dsh` 0.1.5 线。

## License

MIT
