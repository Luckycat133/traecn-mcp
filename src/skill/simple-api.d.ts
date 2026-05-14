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
  RunTaskOptions
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
export declare function queueTask(task: string, opts?: { projectPath?: string }): Promise<string>;

/**
 * 轮询任务状态
 * @param taskId - 任务 ID（可选）
 */
export declare function pollTask(taskId?: string | null): Promise<PollResult>;

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
 * 取消任务
 */
export declare const cancel: typeof cancelTask;

/**
 * 检查状态（s = checkStatus）
 */
export declare const s: typeof checkStatus;

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
