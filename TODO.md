# TODO - 需要真机/人工验证

## P0 - 必须真机验证
- [ ] 真实 Trae IDE 环境下端到端测试：启动网关（`npm run start:gateway`），通过 HTTP API 调用各端点验证
- [ ] MCP stdio server 真机验证：`echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | npm run mcp`，确认 tools/list 返回正确数量工具
- [ ] Solo 对话完整流程：submitSoloChatTask → poll → wait 返回正确结果
- [ ] 对话框处理：触发需要授权的操作，approveDialog 能正确点击"信任"按钮
- [ ] 真实 CDP 连接：`npm run doctor` 全部检查通过

## P1 - 需要人工操作
- [ ] 配置 `.env` 文件：复制 `.env.example`，填入 `TRAECN_GATEWAY_TOKEN`、`TRAECN_API_KEY`（如需）
- [ ] 验证 ws WebSocket 模块实际可用（已加入 dependencies）
- [ ] 运行 `npm run test:live` 真机 UAT 测试
- [ ] 运行 `npm run acceptance:audit -- --require-complete` 验证工作流完整性
- [ ] ESLint 检查：`npm run lint:eslint` 并修复所有警告
- [ ] 格式检查：`npm run format:check`

## P2 - Git 操作
- [ ] `git add -A && git commit -m "..."` 提交本次修改
- [ ] `git push` 推送到远程（需要配置远程仓库权限）
- [ ] 创建 PR 并合并到 main 分支

## 本次已完成的代码修改
- 删除死代码：src/skill/config.js、src/skill/ai-errors.js、utils.escapeJsString
- 修复 simple-api.js checkQueue 路由错误：layered.batch → layered.dialog
- 修复 submitSoloChatTask 返回类型不一致问题（统一返回完整对象而非仅 taskId）
- errors.js 补充 TASK_REQUIRED factory 方法
- 移除 openclaw-plugin 废弃的 slashCommands 导出及测试
- mcp-server.js 元数据表合并：TOOL_METADATA 为单一数据源，PUBLIC/OPS/DESTRUCTIVE 列表从其派生
- package.json exports["./errors"] 指向主错误文件 errors.js 而非已删除的 ai-errors.js
- package.json lint 脚本移除已删除文件的检查
- examples/layered-usage.js 清理 AIErrorHandler 引用
