# TraeCN 设置操作指南

## 概述

本指南用于操控 TraeCN 的设置面板。所有设置操作通过 `traecn_settings_action` 工具完成，支持导航、读取、写入等操作。

## 基本流程

操作设置面板的标准流程是：**导航 → 读取 → 操作**

```
1. traecn_settings_action {action: "navigate", params: {section: "<栏目名>"}}
2. traecn_settings_action {action: "read"}
3. traecn_settings_action {action: "<操作>", params: {label: "...", text: "...", value: "..."}}
4. traecn_settings_action {action: "back"}  ← 操作完成回到聊天
```

## 所有栏目

| 别名 | 中文名 | 说明 |
|------|--------|------|
| `general` | 通用 | 通用设置（语言、主题等） |
| `account` | 账号 | 账号信息、登录状态 |
| `agents` | 智能体 | 智能体/Agent 管理、场景配置 |
| `mcp` | MCP | MCP Server 管理 |
| `flow` | 对话流 | 对话流/Flow 配置 |
| `model` / `models` | 模型 | 模型选择、自定义模型 |
| `context` | 上下文 | 上下文引用、代码索引 |
| `rules` / `skills` | 规则和技能 | 规则管理、技能管理 |
| `beta` | Beta | 实验性功能 |
| `about` | 关于 TRAE | 版本信息、开源协议 |

## 可用操作

### navigate — 导航到栏目

```
{action: "navigate", params: {section: "mcp"}}
{action: "navigate", params: {section: "规则和技能"}}
```

- 支持别名和中文名
- 导航后会自动切换到设置面板

### read — 读取当前栏目内容

```
{action: "read"}
```

返回当前栏目的所有设置项列表，包含：
- label: 设置项名称
- description: 描述
- hasToggle: 是否有开关
- hasDropdown: 是否有下拉菜单
- toggleChecked: 开关状态
- currentValue: 当前选中值

### type — 输入文本

```
{action: "type", params: {label: "名称", text: "my-mcp-server"}}
```

- 按设置项的 label 找到输入框（自动识别 input/textarea）
- 填入指定文本
- 用于填写 MCP Server 名称、Command、环境变量等

### click — 点击元素

```
{action: "click", params: {text: "添加 MCP Server"}}
{action: "click", params: {text: "保存"}}
{action: "click", params: {text: "删除"}}
{action: "click", params: {text: "确认"}}
```

- 按可见文本查找并点击按钮、链接、标签
- 支持模糊匹配（包含即可）
- 自动跳过隐藏元素

### clickTab — 点击子标签页

```
{action: "clickTab", params: {text: "MCP Server"}}
{action: "clickTab", params: {text: "安装链接"}}
```

- 点击栏目内的子标签页（如 MCP 下的子 tab）

### toggle — 切换开关

```
{action: "toggle", params: {label: "启用自动补全", enabled: true}}
{action: "toggle", params: {label: "隐私模式", enabled: false}}
```

### dropdown — 下拉选择

```
{action: "dropdown", params: {label: "默认模型", value: "DeepSeek-V3.1"}}
{action: "dropdown", params: {label: "语言", value: "简体中文"}}
```

- value 支持完整匹配和部分匹配

### set — 自动识别并设置值

```
{action: "set", params: {label: "启用自动补全", value: false}}  ← boolean → toggle
{action: "set", params: {label: "默认模型", value: "GLM-5.1"}}    ← string → dropdown
```

- boolean value 自动走 toggle
- string value 自动走 dropdown

### readTables — 读取表格内容

```
{action: "readTables"}
```

- 读取当前页面的所有表格数据
- 用于查看 MCP Server 列表、自定义模型列表等

### back — 回到聊天

```
{action: "back"}
```

- 从设置面板切回聊天界面

## 常见场景示例

### 1. 添加 MCP Server

```
→ traecn_settings_action {action: "navigate", params: {section: "mcp"}}
→ traecn_settings_action {action: "read"}  ← 确认已进入 MCP 页面
→ traecn_settings_action {action: "click", params: {text: "添加 MCP Server"}}
→ traecn_settings_action {action: "type", params: {label: "名称", text: "my-server"}}
→ traecn_settings_action {action: "type", params: {label: "Command", text: "npx -y @modelcontextprotocol/server-filesystem /path"}}
→ traecn_settings_action {action: "type", params: {label: "环境变量/Env", text: "KEY=VALUE"}}
→ traecn_settings_action {action: "click", params: {text: "添加"}}
→ traecn_settings_action {action: "back"}
```

### 2. 切换模型

```
→ traecn_switch_model {model: "GLM-5.1"}
```

（模型切换有专用工具，不走设置面板）

### 3. 查看当前规则

```
→ traecn_settings_action {action: "navigate", params: {section: "rules"}}
→ traecn_settings_action {action: "read"}
→ traecn_settings_action {action: "back"}
```

### 4. 启用/禁用技能

```
→ traecn_settings_action {action: "navigate", params: {section: "skills"}}
→ traecn_settings_action {action: "read"}
→ traecn_settings_action {action: "toggle", params: {label: "UI Designer", enabled: true}}
→ traecn_settings_action {action: "back"}
```

### 5. 配置上下文引用

```
→ traecn_settings_action {action: "navigate", params: {section: "context"}}
→ traecn_settings_action {action: "read"}
→ 查看 #符号、忽略文件、代码索引等配置
→ traecn_settings_action {action: "back"}
```

### 6. 读取所有设置的完整快照

```
→ traecn_settings_read  ← 返回当前设置（不指定 section）
→ traecn_settings_read {section: "mcp"}  ← 读取特定栏目
```

## 注意事项

1. **导航必须正确**: 操作前先 navigate 到目标栏目，否则可能操作到错误的设置项
2. **每步之间需要时间**: 设置面板渲染需要约 2-3 秒，不要在 navigate 后立即操作
3. **Label 匹配**: type/click/toggle/dropdown 的 label 需要输入完整的可见文本（UI 上显示的文字）
4. **导航出错时**: 如果 navigate 后读取内容不对（比如始终显示相同内容），可能是侧边栏点击没生效，可以尝试用 switch-mode 切回 SOLO 模式再试
5. **连接前提**: gateway 需要正确连接到 TraeCN 的 CDP（Chrome DevTools Protocol），主窗口必须暴露为 CDP target
