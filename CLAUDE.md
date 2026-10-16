# imsgweb 开发约定

本文件与 `CLAUDE.md` / `AGENTS.md` 中的另一份文档保持完全一致。
修改任意一份时，必须同步另一份；提交前使用 `cmp AGENTS.md CLAUDE.md` 验证。

## 仓库归属

- 项目独立维护于 [scqy2000/imsgweb](https://github.com/scqy2000/imsgweb)，集成分支为 `origin/main`。
- 提交、推送和拉取请求仅面向本仓库，保留原作者署名和许可证。
- 除非所有者明确要求，否则不得向 `PeronGH/imsgweb` 推送、发起拉取请求、恢复上游 remote 或同步上游改动。
- `imsg/` 是只读参考依赖，当前固定在 `v0.17.0`，不是本项目的开发远程仓库。

## 安全与隐私

- 默认仅监听 `127.0.0.1`，启动真实服务时设置强随机 `IMSGWEB_PASSWORD`；不得擅自开放公网或路由器端口。
- 保持 SIP 开启，不直接修改 Messages 数据库，不自动执行 `imsg launch` 或更改 macOS 隐私权限。
- 真实环境的验证默认只读。未经用户明确要求，不向联系人发送消息，不修改群聊、消息、已读状态或共享资料。
- 打开会话不应自动标为已读，输入状态必须手动开启。删除、撤回及资料共享等操作保留明确确认。
- 修改前检查工作区，保留用户已有改动。不得擅自停止运行中的真实服务；必要重启应说明原因并恢复服务。
- 不提交密码、令牌、真实聊天内容、数据库、附件、日志或生成的二进制文件；截图和测试数据使用 mock。
- 已发布 Release 的构建产物与源码提交分开管理；当前不通过 CI 自动发布。

## 常用命令

使用 Bun 作为运行、依赖和构建工具，不引入 npm、Vite 或 Jest 等平行工具链。

```bash
bun install --frozen-lockfile
bun run check                  # TypeScript 和 Svelte 检查
bun run lint                   # ESLint
bun test                       # 单元测试和接口测试
bunx prettier --check .        # 只检查格式，不改写文件
bun run build                  # 生成 dist/imsgweb
cmp AGENTS.md CLAUDE.md         # 验证两份代理文档一致
```

开发服务支持热更新。真实环境仍须遵守只读验证和权限边界：

```bash
HOST=127.0.0.1 PORT=3000 IMSGWEB_PASSWORD='<强随机密码>' bun run dev
```

优先使用 mock 开发和验证写操作；`--interval 4000` 每 4 秒生成一条模拟新消息：

```bash
HOST=127.0.0.1 PORT=3100 IMSGWEB_PASSWORD='<测试密码>' \
IMSGWEB_RPC_CMD="bun server/rpc/mock.ts --interval 4000" bun run dev
```

`bun run format` 会执行全仓库格式改写，不是检查命令。只修复相关文件时使用
`bunx prettier --write <文件路径>`，避免无关变动。

## 架构与职责

- `index.ts`：通过 `Bun.serve()` 提供 `web/index.html`，将 `/api/*` 交给 Hono。
- `server/index.ts`：Hono 路由，使用 Zod 校验请求。保持链式路由定义，以保留 `AppType` 的类型推导。
- `server/actions.ts`：操作白名单、严格参数校验、必要确认和运行时能力检查。不得提供任意 RPC 透传接口。
- `server/sends.ts`：发送模式校验和上传文件暂存。文件来自浏览器上传，不接受任意服务器路径；成功或失败后均须清理暂存文件。
- `server/reads.ts`：搜索、分页及受控并发读取。保留结果截断提示，不把有限搜索结果描述为完整结果。
- `server/payloads.ts`：RPC 数据到前端载荷的转换；`server/attachments.ts`：路径校验及附件响应。
- `server/auth.ts`：密码认证和会话 Cookie。EventSource 使用 Cookie 认证，不依赖自定义请求头。
- `server/rpc/`：管理 `imsg rpc` 子进程，通过标准输入输出交换 NDJSON 格式的 JSON-RPC 2.0 消息。
  RPC 方法类型在 `types.ts` 中维护，升级参考依赖时应对照实际源码和测试。
- 服务端没有独立业务数据库，imsg 是消息数据来源；但会维护 RPC 进程、待处理请求、订阅和缓冲队列等内存状态。
- `web/api.ts`：Hono 类型化客户端，目前用于登录；`web/service.ts`：功能接口的 JSON/FormData 请求和结构化错误处理。
  两者均需处理 401。泛型 `request<T>` 不等于运行时响应校验或自动端到端契约保证。
- `web/`：Svelte 5 客户端页面，使用 runes；`model.ts` 放纯逻辑，`store.svelte.ts` 管理状态和操作，
  `events.ts` 管理 SSE，`components/` 放组件。
- `web/history.ts`：协调同一会话的历史分页和替换请求，保留请求顺序，避免旧响应覆盖刷新或搜索上下文。
- `imsg/`：参考源码和文档，不由本仓库构建，排除在应用 lint 和格式化范围之外。

## 能力检测与发送语义

- 按 `status.methods` 判断当前可用能力。`supported_methods` 仅表示编译支持，不能据此启用操作。
- bridge 未就绪时禁用依赖它的功能并解释原因，不通过隐式启动或降低系统安全设置解决。
- 保留错误中的 `code`、`disposition`、`retry_safe`；修改请求期间发生传输中断时，结果可能已经生效。
- 不自动重试发送或其他修改操作。`may_have_completed` 等不确定结果应保留草稿并阻止重复操作；
  `still_in_flight` 需要独立核对结果，再安排恢复服务。
- 追踪发送使用浏览器生成的 UUID，查询原消息状态不能变成重新发送；“尚未找到”不代表“未发送”。
- 实时消息使用 SSE，不改为 WebSocket。保留 Last-Event-ID 恢复、溢出处理和取消订阅清理。
- 历史消息按 ID 合并去重；保留 ROWID、时间戳游标及同时间戳分页边界，不简单拼接响应。
- 原生搜索最多返回最新 100 条全局匹配，会话筛选和分页仅作用于该结果集，必须保留不完整提示。
- “稍后发送”只读、附件每次一个等边界见 [兼容性说明](docs/imsg-017.md)。

## 界面与错误处理

- 图标使用 `@lucide/svelte/icons/<名称>` 按需导入，不从总入口批量导入；仅图标按钮提供可访问名称和提示。
- 普通操作失败使用 `toasts.error(...)`；表单校验、持续故障和需人工处理的不确定状态使用内联提示，不能仅靠短暂 toast。
- 持续刷新和 SSE 更新不能重置用户正在编辑的表单或确认框；必要时通过稳定 ID 和 `untrack` 限定响应式依赖。
- 使用 Tailwind 工具类。`web/app.css` 使用 Tailwind v4，无独立配置文件；组件 `<style>` 内不使用未经处理的 `@apply`。
- 保持现有 Bun、Svelte、Hono 和 Zod 模式，优先使用现有帮助函数，不引入重复抽象。

## 构建注意事项

- 开发时由 `bunfig.toml` 配置 Svelte 和 Tailwind 插件；生产构建由 `build.ts` 调用 `Bun.build()`。
- 保留生产构建中 `process.env.NODE_ENV = "production"` 的内联定义，避免发布包含开发热更新的资源。
- 普通构建从 PATH 调用 imsg；内嵌构建通过 `IMSGWEB_EMBED_IMSG` 指向真正的二进制文件，而非 Homebrew 包装脚本。
- 内嵌过程会暂时写入 `server/rpc/imsg.embedded`，构建后必须恢复为空占位文件，禁止把内嵌内容提交到 Git。
- 内嵌版本始终使用自带的 imsg，不允许通过 `IMSGWEB_RPC_CMD` 覆盖。
- `messages.history` 的排序及时间边界以固定版本源码和回归测试为准，不盲信与实现不一致的文档。
- Bun 自动读取 `.env`，无需引入 dotenv；Bun API 的本地参考位于 `node_modules/bun-types/docs/`。

## 验证与 CI

- 应用逻辑变更运行类型检查、lint、格式检查、相关测试和完整测试；涉及构建或运行路径时补做构建和启动验证。
- 纯文档变更检查格式、链接目标和两份代理文档一致性；CI 变更额外校验 YAML 及关键步骤。
- 测试失败时查明原因，不删除功能、跳过测试或隐藏错误来换取通过。记录未验证的原生能力和人工测试项。
- `.github/workflows/ci.yml` 保留推送到 `main` 后的文档一致性检查、格式检查、类型检查、lint、测试和内嵌构建。
- CI 仅上传工作流构建产物，不打标签、不创建 GitHub Release，不申请 `contents: write`。
- 当前已暂停 CI 自动发布；未经所有者明确要求，不恢复发布任务。
