/**
 * TraeCN Simple API Type Definitions
 * 提供简化的函数调用接口
 */

import {
  TraeCNSkill,
  StatusResult,
  RunResult,
  QueueResult,
  PollResult,
  CancelResult,
  SettingsResult,
  SetSettingResult,
  ApproveResult,
  DialogStatus,
  QueueStatus,
  SkillOptions,
  RunTaskOptions,
  ReviewInput,
  VibeWorkflowOptions,
  OperationPlan,
  PreflightResult,
  WaitTaskOptions,
  WaitResult
} from './traecn-skill';

// 导出 TraeCNSkill
export { TraeCNSkill };

/**
 * 获取 Skill 实例（单例模式）
 * @param context - 上下文配置对象
 */
export declare function getSkill(context?: SkillOptions): TraeCNSkill;

/**
 * 重置 Skill 单例
 */
export declare function reset(): void;

// ==================== 描述性函数名 ====================

/**
 * 运行任务
 * @param task - 任务描述
 * @param opts - 运行选项
 */
export declare function runTask(task: string, opts?: RunTaskOptions): Promise<string>;

/**
 * 队列任务（异步执行）
 * @param task - 任务描述
 * @param opts - 运行选项
 */
export declare function queueTask(task: string, opts?: RunTaskOptions): Promise<string>;

/**
 * 轮询任务状态
 * @param taskId - 任务 ID（可选）
 */
export declare function pollTask(taskId?: string | null): Promise<PollResult>;

/**
 * 本地等待任务直到终态或需要代码决策的停点
 * @param taskId - 任务 ID（可选）
 * @param opts - 等待选项
 */
export declare function waitTask(taskId?: string | null, opts?: WaitTaskOptions): Promise<WaitResult>;

/**
 * 取消任务
 * @param taskId - 任务 ID（可选）
 */
export declare function cancelTask(taskId?: string | null): Promise<CancelResult>;

/**
 * 检查连接状态
 */
export declare function checkStatus(): Promise<boolean>;

/**
 * 获取面向 agent 的紧凑能力目录
 */
export declare function getCapabilities(): Promise<any>;

/**
 * 生成操作确认/预检计划
 * @param command - 命令名
 * @param params - 命令参数
 * @param opts - 选项
 */
export declare function planOperation(command: string, params?: object, opts?: { forceConfirm?: boolean }): Promise<OperationPlan>;

/**
 * 获取低 token 预检摘要
 * @param options - 可选 command/params/forceConfirm
 */
export declare function preflight(options?: { command?: string; params?: object; forceConfirm?: boolean }): Promise<PreflightResult>;

/**
 * 切换模型
 * @param name - 模型名称
 */
export declare function switchModel(name: string): Promise<any>;

/**
 * 切换模式
 * @param mode - 模式名称
 */
export declare function switchMode(mode: string): Promise<any>;

/**
 * 创建新对话
 */
export declare function newChat(): Promise<any>;

/**
 * 获取设置
 * @param section - 设置区域（可选）
 */
export declare function getSettings(section?: string | null): Promise<SettingsResult>;

/**
 * 设置项
 * @param label - 设置标签
 * @param value - 设置值
 * @param section - 设置区域（可选）
 */
export declare function setSetting(label: string, value: any, section?: string | null): Promise<SetSettingResult>;

/**
 * 批准对话框
 * @param action - 批准动作
 * @param wait - 是否等待
 */
export declare function approveDialog(action?: string, wait?: boolean): Promise<ApproveResult>;

/**
 * 检查对话框状态
 */
export declare function checkDialog(): Promise<DialogStatus>;

/**
 * 检查队列状态
 */
export declare function checkQueue(): Promise<QueueStatus>;

/**
 * 打开项目
 * @param path - 项目路径
 */
export declare function openProject(path: string): Promise<any>;

/**
 * 代码审查辅助
 * @param input - 审查说明或结构化审查输入
 * @param opts - 运行选项；queue=true 时返回 taskId
 */
export declare function reviewCode(input: string | ReviewInput, opts?: RunTaskOptions): Promise<string>;

/**
 * 启动无人值守 vibe coding 工作流，返回后台 taskId
 * @param input - 初始任务、项目路径和后续步骤
 * @param opts - 额外运行选项
 */
export declare function vibeWorkflow(input: VibeWorkflowOptions, opts?: RunTaskOptions): Promise<string>;

// ==================== 单字母函数别名（向后兼容）====================

/**
 * 运行任务（t = runTask）
 */
export declare const t: typeof runTask;

/**
 * 队列任务（q = queueTask）
 */
export declare const q: typeof queueTask;

/**
 * 轮询任务（p = pollTask）
 */
export declare const p: typeof pollTask;

/**
 * 等待任务（w = waitTask）
 */
export declare const w: typeof waitTask;

/**
 * 取消任务
 */
export declare const cancel: typeof cancelTask;

/**
 * 检查状态（s = checkStatus）
 */
export declare const s: typeof checkStatus;

/**
 * 能力目录
 */
export declare const capabilities: typeof getCapabilities;

/**
 * 操作确认计划
 */
export declare const plan: typeof planOperation;

/**
 * 低 token 预检（pf = preflight）
 */
export declare const pf: typeof preflight;

/**
 * 切换模型
 */
export declare const model: typeof switchModel;

/**
 * 切换模式
 */
export declare const mode: typeof switchMode;

/**
 * 获取设置
 */
export declare const settings: typeof getSettings;

/**
 * 设置项
 */
export declare const set: typeof setSetting;

/**
 * 批准对话框
 */
export declare const approve: typeof approveDialog;

/**
 * 检查对话框
 */
export declare const dialog: typeof checkDialog;

/**
 * 检查队列
 */
export declare const queueCheck: typeof checkQueue;

/**
 * 打开项目
 */
export declare const open: typeof openProject;

/**
 * 代码审查辅助
 */
export declare const review: typeof reviewCode;

/**
 * 无人值守工作流（vibe = vibeWorkflow）
 */
export declare const vibe: typeof vibeWorkflow;
