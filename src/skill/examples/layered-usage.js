'use strict';

/**
 * TraeCNSkill 分层加载使用示例
 * 展示如何按需加载不同层级的功能
 */

// ============ Level 1: 基础层 (Basic Layer) ============
// 所有AI都应该使用这层，覆盖90%场景

const { runTask, switchModel, checkStatus } = require('../index');

async function basicExample() {
  console.log('=== 基础层示例 ===');

  // 检查连接
  const connected = await checkStatus();
  if (!connected) {
    console.log('未连接到 TraeCN，请先启动 IDE');
    return;
  }

  // 切换模型（模糊匹配）
  await switchModel('glm');  // 自动匹配 GLM-5.2

  // 执行任务
  const result = await runTask('分析这个函数的性能');
  console.log('结果:', result);
}

// ============ Level 2: 进阶层 (Advanced Layer) ============
// 需要更多控制时按需导入

async function advancedExample() {
  console.log('\n=== 进阶层示例 ===');

  const { advanced } = require('../index');

  // 打开项目
  await advanced.openProject('/path/to/project');

  // 切换模式
  await advanced.switchMode('ide');

  // 新建对话
  await advanced.newChat();
}

// ============ Level 3: 配置层 (Config Layer) ============
// 需要修改设置时导入

async function configExample() {
  console.log('\n=== 配置层示例 ===');

  const { config } = require('../index');

  // 读取设置
  const settings = await config.getSettings('model');
  console.log('当前模型设置:', settings);

  // 修改设置
  await config.setSetting('温度', '0.7', 'model');
}

// ============ Level 4: 对话框层 (Dialog Layer) ============
// 处理对话框时导入

async function dialogExample() {
  console.log('\n=== 对话框层示例 ===');

  const { dialog, runTask } = require('../index');

  // 执行任务
  const taskPromise = runTask('需要确认的操作');

  // 检查并处理对话框
  const dlg = await dialog.checkDialog();
  if (dlg.hasDialog) {
    console.log('发现对话框:', dlg.question);
    await dialog.approveDialog('trust', true);
  }

  await taskPromise;
}

// ============ Level 5: 批量层 (Batch Layer) ============
// 批量处理时导入

async function batchExample() {
  console.log('\n=== 批量层示例 ===');

  const { batch } = require('../index');

  const tasks = [
    '分析文件1.js',
    '分析文件2.js',
    '分析文件3.js'
  ];

  // 批量队列任务
  const results = await batch.queueTasks(tasks);
  console.log('批量结果:', results);
}

// ============ 错误处理示例 ============

async function errorHandlingExample() {
  console.log('\n=== 错误处理示例 ===');

  try {
    throw new Error('Connection refused');
  } catch (error) {
    console.error('发生错误:', error.message);
    console.log('建议: 检查 TraeCN IDE 是否启动，端口是否正确');
  }
}

// ============ 完整工作流示例 ============

async function completeWorkflow() {
  console.log('\n=== 完整工作流示例 ===');

  // 只导入需要的层
  const { runTask, switchModel, checkStatus } = require('../index');
  const { dialog } = require('../index');

  try {
    // 1. 检查状态
    if (!await checkStatus()) {
      throw new Error('TraeCN 未连接');
    }

    // 2. 设置模型
    await switchModel('deepseek');

    // 3. 执行任务
    const result = await runTask('优化这段代码', {
      autoWait: true  // 自动处理队列
    });

    console.log('任务完成:', result);

    // 4. 检查对话框
    const dlg = await dialog.checkDialog();
    if (dlg.hasDialog) {
      await dialog.approveDialog('auto');
    }

  } catch (error) {
    console.error('发生错误:', error.message);
    console.log('建议: 检查 TraeCN IDE 连接状态');

    if (error.message.includes('未连接') || error.message.includes('Connection')) {
      console.log('尝试重新连接...');
    }
  }
}

// ============ 运行示例 ============

async function main() {
  console.log('TraeCNSkill 分层加载示例\n');

  try {
    await basicExample();
    // await advancedExample();
    // await configExample();
    // await dialogExample();
    // await batchExample();
    await errorHandlingExample();
    // await completeWorkflow();
  } catch (error) {
    console.error('示例执行失败:', error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  basicExample,
  advancedExample,
  configExample,
  dialogExample,
  batchExample,
  errorHandlingExample,
  completeWorkflow
};
