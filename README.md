# imsgweb

在浏览器中使用 Mac 上的 iMessage：查看会话、浏览历史消息、实时接收新消息，并发送文字和附件。
项目通过 [imsg](https://github.com/openclaw/imsg) 访问本机“信息”应用的数据，支持编译为单个可执行文件。

本仓库 [scqy2000/imsgweb](https://github.com/scqy2000/imsgweb) 基于
[PeronGH/imsgweb](https://github.com/PeronGH/imsgweb) 独立维护，当前适配 **imsg 0.17.0**。
后续开发和发布仅在本仓库进行，不自动同步原仓库的更新。

## 功能

- 会话筛选、未读数量、仅显示未读会话，以及加载更多会话。
- 全局和会话内消息搜索，并可跳转到消息上下文。
- 查看会话标识、参与者、已读状态、消息统计，以及原生“稍后发送”消息列表。
- 引用回复、编辑、撤回、本地删除、消息回应（Tapback）和“仍然通知”。
- 发送文字和文件，选择消息服务，并显式允许或禁止回退到短信。
- 富文本、主题、消息效果、链接卡片、原生语音附件、贴纸、多段文本，以及投票和取消投票。
- 创建群聊、修改群名、管理成员、上传或移除群头像，以及退出群聊。
- 手动共享姓名与照片，并检查收件地址是否支持 iMessage。
- 动态检测运行时能力，不可用的操作会被禁用并说明原因。
- 打开会话不会自动标为已读，也不会发送“正在输入”状态；输入状态需要手动开启。
- 删除等破坏性操作和资料共享需要确认。发送结果不确定时会暂停后续修改操作，避免重复发送，且不会自动重试。

部分高级功能依赖已经就绪的 bridge，仅安装新版 imsg 并不代表这些功能可用。
请保持 SIP 开启。本项目不会运行 `imsg launch`、修改 SIP 或直接修改 Messages 数据库。

原生搜索最多返回最新 100 条全局匹配，结果可能不完整，界面会显示提示。
“稍后发送”仅支持查看；附件每次发送一个。详细边界和验证记录见
[imsg 0.17 兼容性说明](docs/imsg-017.md)。

## 环境与权限

- 使用 macOS，并已在“信息”应用中登录账号。
- 为运行 imsgweb 的终端或可执行程序授予“完全磁盘访问权限”，以读取 Messages 数据库：
  **系统设置 → 隐私与安全性 → 完全磁盘访问权限**。
- 发送消息可能需要允许对应程序控制“信息”应用。如果出现 AppleEvents 或 `-1743` 错误，前往：
  **系统设置 → 隐私与安全性 → 自动化**。
- 从源码运行需要安装 [Bun](https://bun.sh)，并确保 `imsg` 在 `PATH` 中。

## 运行已编译版本

本仓库发布可执行文件后，可从 [发布页面](https://github.com/scqy2000/imsgweb/releases) 下载。
内嵌 imsg 的版本无需额外安装 imsg；尚未发布时，请使用下方的源码运行方式。

下载后，在终端中执行：

```bash
cd ~/Downloads
chmod +x imsgweb
HOST=127.0.0.1 PORT=3000 IMSGWEB_PASSWORD='请替换为强随机密码' ./imsgweb
```

在浏览器中打开 <http://127.0.0.1:3000>，输入启动时设置的密码。
可通过 `PORT` 更改端口。登录后，浏览器会保存有效期为 30 天的会话 Cookie。

如果 macOS 因下载隔离属性阻止运行，请先确认文件来自可信来源；确认后才可移除该文件的隔离属性：

```bash
xattr -d com.apple.quarantine ./imsgweb
```

默认仅监听本机回环地址。请保持 `HOST=127.0.0.1`，不要开放路由器端口。
设置 `HOST=0.0.0.0` 会监听所有 IPv4 网络接口，不适合默认的本机使用场景；
密码认证不能替代 HTTPS 或网络访问控制。

## 从源码运行

```bash
brew install steipete/tap/imsg
git clone https://github.com/scqy2000/imsgweb.git
cd imsgweb
bun install
HOST=127.0.0.1 PORT=3000 IMSGWEB_PASSWORD='请替换为强随机密码' bun run dev
```

开发服务支持热更新，访问地址同样为 <http://127.0.0.1:3000>。
在终端中按 `Ctrl+C` 停止服务。

## 开发与检查

使用 `scqy2000/imsgweb` 的 `main` 作为集成分支。提交、推送和拉取请求仅面向本仓库。
除非仓库所有者明确要求，否则不要添加原仓库的推送目标，也不要自动同步原仓库。

```bash
bun run check        # 类型和 Svelte 检查
bun run lint         # ESLint 检查
bun test             # 使用 mock imsg 的单元测试和接口测试
bun run build        # 生成独立可执行文件 dist/imsgweb
bun run format       # 使用 Prettier 格式化代码
```

发布前应检查暂存文件，确保不包含密码、真实聊天内容、Messages 数据库、附件或运行日志。
真实环境的集成验证默认只读；发送消息和修改群聊等操作应由使用者手动确认和测试。

### 内嵌 imsg 构建

如需生成内嵌 imsg 的可执行文件，让目标机器无需单独安装 imsg，
将 `IMSGWEB_EMBED_IMSG` 指向真正的 imsg 可执行文件，而不是 Homebrew 的启动包装脚本：

```bash
IMSGWEB_EMBED_IMSG="$(brew --prefix imsg)/libexec/imsg" bun run build
```

内嵌版本始终使用自带的 imsg，不允许通过 `IMSGWEB_RPC_CMD` 覆盖。

### 使用模拟数据开发

不安装 imsg、不授予完全磁盘访问权限，也可以通过项目自带的 mock RPC 开发和测试。
以下命令每 4 秒生成一条模拟新消息，不会向真实联系人发送消息：

```bash
HOST=127.0.0.1 PORT=3100 IMSGWEB_PASSWORD='请替换为测试密码' \
IMSGWEB_RPC_CMD="bun server/rpc/mock.ts --interval 4000" bun run dev
```

访问 <http://127.0.0.1:3100> 体验模拟会话。
