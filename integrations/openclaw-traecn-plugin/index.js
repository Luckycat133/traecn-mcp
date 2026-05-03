'use strict';

const { TraeCNApiClient } = require('./lib/traecnapi-client');

const PLUGIN_ID = 'traecnclaw';

const toolDefinitions = [
  {
    name: 'traecn_status',
    description: 'Check if TraeCNclaw gateway is reachable and TraeCN automation is ready.',
    parameters: {
      type: 'object',
      properties: {
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.getStatus(params.allowAutoStart);
    }
  },
  {
    name: 'traecn_new_chat',
    description: 'Create a new chat in TraeCN and switch the UI to it.',
    parameters: {
      type: 'object',
      properties: {
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.newChat(params.allowAutoStart);
    }
  },
  {
    name: 'traecn_delegate',
    description: 'Delegate an IDE task to TraeCN desktop app and return the AI response.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'The task description to delegate to TraeCN' },
        projectPath: { type: 'string', description: 'Path to the project to open in TraeCN' },
        sessionId: { type: 'string', description: 'Existing session ID to use instead of creating a new one' },
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false },
        includeProcessText: { type: 'boolean', description: 'Include process/thinking information in the response', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.delegate(params.task, {
        projectPath: params.projectPath,
        sessionId: params.sessionId,
        allowAutoStart: params.allowAutoStart,
        includeProcessText: params.includeProcessText
      });
    }
  },
  {
    name: 'traecn_switch_mode',
    description: 'Switch TraeCN between SOLO and IDE modes.',
    parameters: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['solo', 'ide'], description: 'The mode to switch to' },
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.switchMode(params.mode, params.allowAutoStart);
    }
  },
  {
    name: 'traecn_switch_model',
    description: 'Switch the AI model used by TraeCN. Available models include: Doubao-Seed-2.0-Code, Doubao-Seed-1.8, GLM-5.1, DeepSeek-V3.1-Terminus, etc.',
    parameters: {
      type: 'object',
      required: ['model'],
      properties: {
        model: { type: 'string', description: 'The model name to switch to (e.g. "GLM-5.1", "DeepSeek-V3.1-Terminus")' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.switchModel(params.model);
    }
  },
  {
    name: 'traecn_queue_status',
    description: 'Check if the current TraeCN AI model is in a queued/busy state.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.checkQueueStatus();
    }
  },
  {
    name: 'traecn_open_project',
    description: 'Open a project in TraeCN.',
    parameters: {
      type: 'object',
      required: ['projectPath'],
      properties: {
        projectPath: { type: 'string', description: 'Path to the project to open' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.openProject(params.projectPath);
    }
  },
  {
    name: 'traecn_chat',
    description: 'Quickly trigger a task via trae-cn chat CLI (fire-and-forget, does not return AI response). Use traecn_delegate instead when you need to read the response.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to TraeCN via CLI' },
        mode: { type: 'string', enum: ['ask', 'edit', 'agent'], description: 'CLI mode: ask, edit, or agent (default agent)' },
        addFile: { type: 'string', description: 'Add file as context' },
        maximize: { type: 'boolean', description: 'Maximize chat window', default: false },
        reuseWindow: { type: 'boolean', description: 'Reuse last window', default: false },
        newWindow: { type: 'boolean', description: 'Open new window', default: false }
      }
    },
    handler: async (params, context) => {
      const { spawn } = require('child_process');
      const args = ['chat'];
      if (params.mode) args.push('--mode', params.mode);
      if (params.maximize) args.push('--maximize');
      if (params.reuseWindow) args.push('--reuse-window');
      if (params.newWindow) args.push('--new-window');
      if (params.addFile) args.push('--add-file', params.addFile);
      args.push('--', params.prompt);

      const child = spawn('trae-cn', args, { stdio: 'pipe' });
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('close', (code) => {
          resolve({
            launched: true,
            exitCode: code,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            note: 'CLI mode does not return AI response. Use traecn_delegate for full interaction.'
          });
        });
        child.on('error', (err) => {
          resolve({ launched: false, error: err.message, note: 'trae-cn CLI not available' });
        });
      });
    }
  },
  {
    name: 'traecn_update_self',
    description: 'Update the TraeCNclaw plugin to the latest version.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force update even if already up to date', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.updateSelf(params.force);
    }
  }
];

const slashCommands = [
  {
    command: '/TraeCN',
    description: 'Create a new chat and delegate a task to TraeCN, returning only the final response',
    handler: async (args, context) => {
      const task = args.trim();
      if (!task) return 'Usage: /TraeCN <task>';
      const client = new TraeCNApiClient(context);
      const result = await client.delegate(task, { includeProcessText: false });
      return formatResult(result);
    }
  },
  {
    command: '/TraeCN process',
    description: 'Create a new chat and delegate a task to TraeCN, returning the full output including process information',
    handler: async (args, context) => {
      const task = args.trim();
      if (!task) return 'Usage: /TraeCN process <task>';
      const client = new TraeCNApiClient(context);
      const result = await client.delegate(task, { includeProcessText: true });
      return formatResult(result);
    }
  }
];

function formatResult(result) {
  if (result.error) {
    return `[TraeCN Error] ${result.error}`;
  }

  let output = result.text || 'No response from TraeCN';

  if (result.processText && result.processText !== result.text) {
    output += '\n\n--- Process ---\n' + result.processText;
  }

  if (result.timedOut) {
    output += '\n\n[Warning: Response timed out, result may be incomplete]';
  }

  return output;
}

function register(openClaw) {
  if (typeof openClaw.registerTool === 'function') {
    for (const tool of toolDefinitions) {
      openClaw.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        handler: tool.handler
      });
    }
  }

  // registerSlashCommand was removed in OpenClaw 2026.4
  // Slash commands are handled via openclaw.plugin.json
  console.log(`[TraeCNclaw] Registered ${toolDefinitions.length} tools`);
}

module.exports = {
  PLUGIN_ID,
  toolDefinitions,
  slashCommands,
  formatResult,
  register
};
