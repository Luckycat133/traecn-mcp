/**
 * TraeCN Skill Module Type Definitions
 */

import { TraeCNApiClient } from '../../integrations/openclaw-traecn-plugin/lib/traecnapi-client';

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
  includeProcess?: boolean;
  autoWait?: boolean;
  mode?: string;
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
  queue(task: string, opts?: { projectPath?: string }): Promise<QueueResult>;

  /**
   * 轮询任务状态
   * @param taskId - 任务 ID（可选，默认为最后执行的任务）
   */
  poll(taskId?: string | null): Promise<PollResult>;

  /**
   * 取消任务
   * @param taskId - 任务 ID（可选，默认为最后执行的任务）
   */
  cancel(taskId?: string | null): Promise<CancelResult>;

  /**
   * 创建新对话
   */
  newChat(): Promise<any>;

  /**
   * 切换模式
   * @param mode - 模式名称 ('solo' 或 'ide')
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
}
