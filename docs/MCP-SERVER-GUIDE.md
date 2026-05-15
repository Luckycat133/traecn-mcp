# MCP 服务器配置

## 快速开始

### 1. Cursor 配置

创建 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/traecnclaw/mcp-server.js"],
      "env": {
        "TRAECN_URL": "http://localhost:9222"
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
      "args": ["/absolute/path/to/traecnclaw/mcp-server.js"],
      "env": {
        "TRAECN_URL": "http://localhost:9222"
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
      "args": ["/absolute/path/to/traecnclaw/mcp-server.js"]
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
      "args": ["/absolute/path/to/traecnclaw/mcp-server.js"]
    }
  }
}
```

## MCP 工具定义

```javascript
// 完整 MCP 工具列表
const MCP_TOOLS = [
  {
    name: 'run_task',
    description: 'Execute a task in TraeCN IDE',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description' },
        model: { type: 'string', description: 'Model name (optional)' }
      }
    }
  },
  {
    name: 'switch_model',
    description: 'Switch the AI model',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name (fuzzy matching supported)' }
      }
    }
  },
  {
    name: 'check_status',
    description: 'Check TraeCN connection status'
  },
  {
    name: 'poll_task',
    description: 'Poll task status',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID (optional)' }
      }
    }
  },
  {
    name: 'get_settings',
    description: 'Get TraeCN settings',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Settings section (optional)' }
      }
    }
  },
  {
    name: 'set_setting',
    description: 'Update a setting',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Setting label' },
        value: { type: 'string', description: 'New value' },
        section: { type: 'string', description: 'Section (optional)' }
      }
    }
  },
  {
    name: 'new_chat',
    description: 'Start a new conversation'
  },
  {
    name: 'approve_dialog',
    description: 'Approve a dialog',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: trust, deny, auto' },
        wait: { type: 'boolean', description: 'Wait before approving' }
      }
    }
  },
  {
    name: 'open_project',
    description: 'Open a project in TraeCN',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project path' }
      }
    }
  },
  {
    name: 'switch_mode',
    description: 'Switch mode (solo/ide)',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['solo', 'ide'], description: 'Mode' }
      }
    }
  }
];
```

## 环境变量

```bash
# TraeCN 连接
export TRAECN_URL=http://localhost:9222
export TRAECN_BRIDGE_PORT=9333

# 认证（可选）
export TRAECN_API_KEY=your_api_key

# 日志
export TRAECN_LOG_LEVEL=info
export TRAECN_LOG_FORMAT=json

# 超时设置（毫秒）
export TRAECN_TIMEOUT=60000
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
# 测试 API 直接连接
curl -X POST http://localhost:9222/jsonrpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"TraeAPI.status","params":{},"id":1}'

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
