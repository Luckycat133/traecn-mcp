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
  for (const tool of toolDefinitions) {
    openClaw.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      handler: tool.handler
    });
  }

  for (const cmd of slashCommands) {
    openClaw.registerSlashCommand({
      command: cmd.command,
      description: cmd.description,
      handler: cmd.handler
    });
  }

  console.log(`[TraeCNclaw] Registered ${toolDefinitions.length} tools and ${slashCommands.length} slash commands`);
}

module.exports = {
  PLUGIN_ID,
  toolDefinitions,
  slashCommands,
  formatResult,
  register
};
