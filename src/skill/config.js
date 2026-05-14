'use strict';

/**
 * TraeCN Skill 配置模块
 * 提供可配置的常量和选项
 */

/** 默认轮询配置 */
const DEFAULT_POLL_CONFIG = {
  /** 最大尝试次数 */
  maxAttempts: 40,
  /** 每次尝试间隔（毫秒） */
  intervalMs: 5000
};

/** 会话管理配置 */
const SESSION_CONFIG = {
  /** 是否自动创建会话 */
  autoCreateSession: true,
  /** 默认会话超时（毫秒） */
  defaultTimeout: 300000
};

/** 性能监控配置 */
const PERFORMANCE_CONFIG = {
  /** 是否启用性能监控 */
  enabled: false,
  /** 慢操作阈值（毫秒） */
  slowThreshold: 1000
};

/**
 * 获取轮询配置
 * @returns {object} 轮询配置
 */
function getPollConfig() {
  return { ...DEFAULT_POLL_CONFIG };
}

/**
 * 获取会话配置
 * @returns {object} 会话配置
 */
function getSessionConfig() {
  return { ...SESSION_CONFIG };
}

/**
 * 获取性能配置
 * @returns {object} 性能配置
 */
function getPerformanceConfig() {
  return { ...PERFORMANCE_CONFIG };
}

/**
 * 合并用户配置与默认配置
 * @param {object} userConfig - 用户配置
 * @param {object} defaultConfig - 默认配置
 * @returns {object} 合并后的配置
 */
function mergeConfig(userConfig, defaultConfig) {
  return { ...defaultConfig, ...userConfig };
}

module.exports = {
  DEFAULT_POLL_CONFIG,
  SESSION_CONFIG,
  PERFORMANCE_CONFIG,
  getPollConfig,
  getSessionConfig,
  getPerformanceConfig,
  mergeConfig
};
