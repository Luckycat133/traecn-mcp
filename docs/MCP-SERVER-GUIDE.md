# MCP 服务器配置

TRAECNclaw 自带零依赖 stdio MCP 服务器：`mcp-server.js`。MCP 客户端连接 MCP 服务器，MCP 服务器再调用本地 TraeCNclaw HTTP 网关（默认 `http://127.0.0.1:8788`）。TraeCN 桌面的 CDP 端口仍由网关配置管理，通常不需要暴露给 MCP 客户端。

## 快速开始

### 1. Cursor 配置

创建 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

### 2. Claude Desktop 配置

编辑 `~/.claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

### 3. Cline/Roo Code 配置

在设置中添加 MCP 服务器：

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"]
    }
  }
}
```

### 4. Windsurf 配置

在 `.windsurfrc` 或 MCP 设置中：

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"]
    }
  }
}
```

## MCP 工具定义

运行 `node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t => t.name))"` 可查看当前工具列表。核心工具包括：

- `run_task`: 委派任务并尽量等待最终结果
- `queue_task`: 提交后台队列任务并返回 `taskId`
- `poll_task`: 查询队列任务状态
- `review_code`: 对代码、diff 或指定文件范围生成 findings-first 审查
- `check_status`, `check_queue`, `check_dialog`: 状态、队列、确认弹窗检查
- `switch_model`, `switch_mode`, `new_chat`, `open_project`: TraeCN 控制
- `get_settings`, `set_setting`, `approve_dialog`: 设置与确认操作
- `traecn_capabilities`: 返回低 token 能力目录，包括命令、端点、模型、设置分区和建议调用顺序
- `preflight`: 一次调用返回状态、就绪度、队列、弹窗和可选命令确认计划
- `plan_operation`: 在执行有副作用命令前生成风险、确认和预检计划，不操作 TraeCN
- `traecn_command_set`, `traecn_command`: 枚举并调用完整稳定命令集

## 环境变量

```bash
# TraeCNclaw 网关连接
export TRAECN_HOST=127.0.0.1
export TRAECN_PORT=8788

# 认证（可选）
export TRAECN_GATEWAY_TOKEN=your_gateway_token

# 日志
export TRAECN_LOG_LEVEL=info
export TRAECN_LOG_FORMAT=json

# 超时设置（毫秒）
export TRAECN_TIMEOUT=120000
```

## 故障排除

### 连接失败

```bash
# 检查 TraeCN 是否运行
curl http://localhost:9222/json

# 检查端口占用
lsof -i :9222
netstat -an | grep 9222
```

### MCP 服务器不工作

```bash
# 测试网关直接连接
curl http://127.0.0.1:8788/api/status

# 检查日志
tail -f logs/app-*.log
```

## 安全建议

1. **使用 API 密钥**：启用 `TRAECN_API_KEY` 环境变量
2. **限制来源**：使用 CORS 配置限制跨域请求
3. **审计日志**：启用审计日志记录所有操作
4. **定期轮换**：定期更换 API 密钥

## 性能优化

```javascript
// 使用队列模式处理长时间任务
const taskId = await queueTask('Long running task');

// 使用轮询检查状态
const status = await pollTask(taskId);

// 批量操作时使用 queueTask 减少等待
for (const task of tasks) {
  await queueTask(task);
}
```

---

**配置完成后重启 IDE 或 MCP 客户端使配置生效。**
