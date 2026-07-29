/**
 * TraeCN Skill Module Type Definitions
 */

import { TraeCNApiClient } from '../client/traecnapi-client';

// 已知模型列表
export declare const KNOWN_MODELS: string[];

// 设置区域别名映射
export declare const SETTINGS_SECTIONS: { [key: string]: string };

// Skill 配置选项
export interface SkillOptions {
  [key: string]: any;
}

// 运行任务选项
export interface RunTaskOptions {
  projectPath?: string;
  sessionId?: string;
  chatId?: string;
  includeProcess?: boolean;
  includeProcessText?: boolean;
  autoWait?: boolean;
  mode?: string;
  queue?: boolean;
  waitForQueue?: boolean;
  background?: boolean;
  forceBackground?: boolean;
  reviewRequired?: boolean;
  autoContinue?: boolean;
  followupTasks?: WorkflowStep[];
  completionChecks?: CompletionChecks;
  autoApproveDialog?: boolean | string;
  notifyUrl?: string;
  fallbackModels?: string[];
  autoModelFallback?: boolean;
  modelProbeIntervalMs?: number;
  maxQueueWaitMs?: number;
  queueMaxWaitMs?: number;
  /** _delegateWithPoll 最大轮询次数（默认 40） */
  pollMaxAttempts?: number;
  /** _delegateWithPoll 轮询间隔毫秒（默认 5000） */
  pollIntervalMs?: number;
  soloChat?: { index?: number; titleIncludes?: string; textIncludes?: string };
  soloChatIndex?: number;
  soloChatTitleIncludes?: string;
  soloChatTextIncludes?: string;
  newChat?: boolean;
  files?: string[];
  focus?: string[];
  code?: string;
  diff?: string;
}

export interface WaitTaskOptions {
  pollMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  autoApproveDialog?: boolean | string;
  approveDialogAction?: string;
}

export interface CompletionChecks {
  requiredFiles?: string[];
  requiredText?: Array<{
    filePath: string;
    includes: string | string[];
  }>;
}

export interface WorkflowStep {
  task: string;
  reviewRequired?: boolean;
  autoContinue?: boolean;
  includeProcessText?: boolean;
  completionChecks?: CompletionChecks;
}

export interface VibeWorkflowOptions extends RunTaskOptions {
  task: string;
  steps?: Array<string | WorkflowStep>;
}

// 代码审查输入
export interface ReviewInput {
  instruction: string;
  files?: string[];
  focus?: string[];
  code?: string;
  diff?: string;
}

// 状态结果
export interface StatusResult {
  ok: boolean;
  status: string;
  connected: boolean;
  version: string | null;
  mock: boolean;
}

// 运行任务结果
export interface RunResult {
  ok: boolean;
  text: string;
  status: string;
  elapsed: number;
  process: string | null;
  queued?: boolean;
  taskId?: string;
}

// 队列结果
export interface QueueResult {
  ok: boolean;
  queued: boolean;
  taskId: string;
  status: string;
  queue: any | null;
}

// 轮询结果
export interface PollResult {
  ok: boolean;
  status: string;
  text?: string;
  elapsed?: number;
  error?: string;
}

export interface WaitResult {
  ok: boolean;
  taskId: string;
  status: string;
  wait: {
    terminal: boolean;
    timedOut: boolean;
    attempts: number;
    elapsedMs: number;
    pollMs: number;
    timeoutMs: number;
  };
  result?: any;
  error?: string;
  lastSnapshot?: any;
}

// 取消结果
export interface CancelResult {
  ok: boolean;
  cancelled: boolean;
}

// 设置结果
export interface SettingsResult {
  ok: boolean;
  section: string | null;
  content: any;
}

// 设置项结果
export interface SetSettingResult {
  ok: boolean;
  label: string;
  value: any;
}

// 批准对话框结果
export interface ApproveResult {
  ok: boolean;
  success: boolean;
  action: string;
  clicked: string | null;
}

// 对话框状态
export interface DialogStatus {
  ok: boolean;
  hasDialog: boolean;
  type: string | null;
  question: string | null;
  buttons: string[];
}

// 队列状态
export interface QueueStatus {
  ok: boolean;
  queued: boolean;
  position: number | null;
  message: string | null;
}

// 操作确认计划
export interface OperationPlan {
  command: string;
  risk: 'low' | 'medium' | 'high' | 'unknown';
  requiresConfirmation: boolean;
  confirmationId: string;
  sideEffects: string[];
  preflight: string[];
  recommendedFlow: string[];
  tokenHint: string;
}

// 低 token 预检摘要
export interface PreflightResult {
  ok: boolean;
  connected: boolean;
  ready: boolean;
  canDelegate: boolean;
  nextAction: string;
  tokenHint: string;
  status: any;
  readiness: any;
  queue: any;
  dialog: any;
  localQueue: any;
  commandPlan: OperationPlan | null;
  capabilities: any;
}

/**
 * TraeCN Skill 主类
 * 提供 TraeCN 自动化功能的简化接口
 */
export declare class TraeCNSkill {
  context: SkillOptions;
  client: TraeCNApiClient;
  _sessionId: string | null;
  _lastTaskId: string | null;

  /**
   * 创建 TraeCNSkill 实例
   * @param context - 上下文配置对象
   */
  constructor(context?: SkillOptions);

  /**
   * 获取 TraeCN 连接状态
   * @param allowAutoStart - 是否允许自动启动
   */
  status(allowAutoStart?: boolean): Promise<StatusResult>;

  /**
   * 获取面向 agent 的紧凑能力目录
   */
  getCapabilities(): Promise<any>;

  /**
   * 生成操作确认/预检计划
   */
  planOperation(command: string, params?: object, opts?: { forceConfirm?: boolean }): Promise<OperationPlan>;

  /**
   * 获取低 token 预检摘要
   */
  preflight(options?: { command?: string; params?: object; forceConfirm?: boolean }): Promise<PreflightResult>;

  /**
   * 运行任务
   * @param task - 任务描述
   * @param opts - 运行选项
   */
  run(task: string, opts?: RunTaskOptions): Promise<RunResult>;

  /**
   * 队列任务（异步执行）
   * @param task - 任务描述
   * @param opts - 运行选项
   */
  queue(task: string, opts?: RunTaskOptions): Promise<QueueResult>;

  /**
   * 轮询任务状态
   * @param taskId - 任务 ID（可选，默认为最后执行的任务）
   */
  poll(taskId?: string | null): Promise<PollResult>;

  /**
   * 本地等待任务直到终态或需要代码决策的停点
   * @param taskId - 任务 ID（可选，默认为最后执行的任务）
   * @param opts - 等待选项
   */
  wait(taskId?: string | null, opts?: WaitTaskOptions): Promise<WaitResult>;

  /**
   * 取消任务
   * @param taskId - 任务 ID（可选，默认为最后执行的任务）
   */
  cancel(taskId?: string | null): Promise<CancelResult>;

  /**
   * 创建新对话
   */
  newChat(): Promise<any>;

  listSoloChats(): Promise<any>;

  switchSoloChat(criteria?: { index?: number; titleIncludes?: string; textIncludes?: string }): Promise<any>;

  submitSoloChatTask(task: string, opts?: RunTaskOptions): Promise<QueueResult>;

  /**
   * 切换模式
   * @param mode - 模式名称 ('solo' 或 'ide')，忽略大小写
   * @throws {TraeCNSkillError} 当 mode 不是 'solo' 或 'ide' 时抛出 INVALID_MODE
   */
  switchMode(mode: string): Promise<any>;

  /**
   * 切换模型
   * @param model - 模型名称（支持模糊匹配）
   */
  switchModel(model: string): Promise<any>;

  /**
   * 获取设置
   * @param section - 设置区域（可选）
   */
  getSettings(section?: string | null): Promise<SettingsResult>;

  /**
   * 设置项
   * @param label - 设置标签
   * @param value - 设置值
   * @param section - 设置区域（可选）
   */
  setSetting(label: string, value: any, section?: string | null): Promise<SetSettingResult>;

  /**
   * 批准对话框
   * @param action - 批准动作
   * @param wait - 是否等待
   */
  approveDialog(action?: string, wait?: boolean): Promise<ApproveResult>;

  /**
   * 检查对话框状态
   */
  checkDialog(): Promise<DialogStatus>;

  /**
   * 检查队列状态
   */
  queueStatus(): Promise<QueueStatus>;

  /**
   * 打开项目
   * @param projectPath - 项目路径
   */
  openProject(projectPath: string): Promise<any>;

  /**
   * 代码审查辅助
   * @param input - 审查说明或结构化审查输入
   * @param opts - 运行或队列选项
   */
  reviewCode(input: string | ReviewInput, opts?: RunTaskOptions): Promise<RunResult | QueueResult>;

  /**
   * 启动无人值守 vibe coding 工作流
   */
  vibeWorkflow(input: VibeWorkflowOptions): Promise<QueueResult>;
}
