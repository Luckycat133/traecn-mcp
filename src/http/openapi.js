'use strict';

const packageInfo = require('../../package.json');

const completionChecksSchema = {
  type: 'object',
  properties: {
    requiredFiles: { type: 'array', items: { type: 'string' } },
    requiredText: {
      type: 'array',
      items: {
        type: 'object',
        required: ['filePath', 'includes'],
        properties: {
          filePath: { type: 'string' },
          includes: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ]
          }
        }
      }
    }
  }
};

function generateOpenAPISpec() {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'TraeCN CDP HTTP Bridge',
      description: 'Local HTTP bridge for TraeCN desktop automation via CDP and DOM',
      version: packageInfo.version
    },
    servers: [
      { url: 'http://127.0.0.1:8788', description: 'Local TraeCNclaw gateway' }
    ],
    paths: {
      '/api/status': {
        get: {
          summary: 'Check gateway and TraeCN connection status',
          operationId: 'getStatus',
          responses: {
            '200': {
              description: 'Status information',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['connected', 'disconnected'] },
                      service: { type: 'string' },
                      version: { type: 'string' },
                      mockBridge: { type: 'boolean' },
                      cdp: { type: 'object' },
                      surface: { type: 'object' },
                      uptime: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/capabilities': {
        get: {
          summary: 'Return compact agent-facing capability catalog',
          operationId: 'getCapabilities',
          responses: {
            '200': {
              description: 'Compact command, endpoint, MCP, and token strategy metadata',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      version: { type: 'string' },
                      contractVersion: { type: 'number' },
                      tokenStrategy: { type: 'object' },
                      coverage: { type: 'object' },
                      apiFamilies: { type: 'object' },
                      http: { type: 'array', items: { type: 'object' } },
                      commands: { type: 'array', items: { type: 'object' } },
                      mcp: { type: 'object' },
                      traeCN: { type: 'object' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/metrics': {
        get: {
          summary: 'Return Prometheus metrics for the local gateway',
          operationId: 'getMetrics',
          responses: {
            '200': {
              description: 'Prometheus text exposition',
              content: {
                'text/plain': {
                  schema: { type: 'string' }
                }
              }
            }
          }
        }
      },
      '/metrics.json': {
        get: {
          summary: 'Return gateway metrics as JSON for diagnostics',
          operationId: 'getMetricsJson',
          responses: {
            '200': {
              description: 'Metrics snapshot',
              content: {
                'application/json': {
                  schema: { type: 'object' }
                }
              }
            }
          }
        }
      },
      '/api/config': {
        get: {
          summary: 'Read runtime gateway configuration',
          operationId: 'getConfig',
          responses: {
            '200': { description: 'Current config and recent audit log' }
          }
        }
      },
      '/api/config/schema': {
        get: {
          summary: 'Read runtime configuration schema and defaults',
          operationId: 'getConfigSchema',
          responses: {
            '200': { description: 'Config schema and default values' }
          }
        }
      },
      '/api/config/update': {
        post: {
          summary: 'Update runtime gateway configuration',
          operationId: 'updateConfig',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          },
          responses: {
            '200': { description: 'Config update result' },
            '400': { description: 'Validation error' }
          }
        }
      },
      '/api/config/reset': {
        post: {
          summary: 'Reset runtime configuration to defaults',
          operationId: 'resetConfig',
          responses: {
            '200': { description: 'Config reset result' }
          }
        }
      },
      '/api/config/diff': {
        get: {
          summary: 'Compare current config with defaults or a previous audit entry',
          operationId: 'getConfigDiff',
          parameters: [
            { name: 'previous', in: 'query', required: false, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Config diff and history' }
          }
        }
      },
      '/api/sessions': {
        post: {
          summary: 'Create a new chat session',
          operationId: 'createSession',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    projectPath: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Session created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      sessionId: { type: 'string' },
                      createdAt: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        },
        get: {
          summary: 'List all sessions',
          operationId: 'listSessions',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Session list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      sessions: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            createdAt: { type: 'string' },
                            messageCount: { type: 'number' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/sessions/{sessionId}': {
        get: {
          summary: 'Get session details',
          operationId: 'getSession',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Session details' },
            '404': { description: 'Session not found' }
          }
        }
      },
      '/api/sessions/{sessionId}/delegate': {
        post: {
          summary: 'Delegate a task to TraeCN',
          operationId: 'delegateTask',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['task'],
                  properties: {
                    task: { type: 'string', description: 'The task to delegate' },
                    projectPath: { type: 'string' },
                    includeProcessText: { type: 'boolean', description: 'Include process information in response' },
                    waitForQueue: { type: 'boolean', default: true },
                    autoApproveDialog: {
                      oneOf: [{ type: 'boolean' }, { type: 'string' }],
                      description: 'Automatically handle code-answerable dialogs if the task is tracked in the background.'
                    },
                    fallbackModels: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Ordered model candidates to probe when the current model is queued.'
                    },
                    autoModelFallback: { type: 'boolean', default: false },
                    modelProbeIntervalMs: { type: 'number', default: 60000 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Task result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      stable: { type: 'boolean' },
                      elapsedMs: { type: 'number' },
                      timedOut: { type: 'boolean' },
                      processText: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/delegate': {
        post: {
          summary: 'Delegate a task (auto-creates session)',
          operationId: 'delegate',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['task'],
                  properties: {
                    task: { type: 'string', description: 'The task to delegate', maxLength: 100000 },
                    projectPath: { type: 'string' },
                    sessionId: { type: 'string' },
                    includeProcessText: { type: 'boolean', default: false },
                    waitForQueue: { type: 'boolean', default: true },
                    autoApproveDialog: {
                      oneOf: [{ type: 'boolean' }, { type: 'string' }],
                      description: 'Automatically handle code-answerable dialogs if the task is tracked in the background.'
                    },
                    fallbackModels: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Ordered model candidates to probe when the current model is queued.'
                    },
                    autoModelFallback: { type: 'boolean', default: false },
                    modelProbeIntervalMs: { type: 'number', default: 60000 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Task result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      stable: { type: 'boolean' },
                      elapsedMs: { type: 'number' },
                      timedOut: { type: 'boolean' },
                      processText: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/delegate-async': {
        post: {
          summary: 'Delegate a task asynchronously',
          operationId: 'delegateAsync',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['task'],
                  properties: {
                    task: { type: 'string', description: 'The task to delegate', maxLength: 100000 },
                    projectPath: { type: 'string', description: 'Optional local project path TraeCN should work in' },
                    sessionId: { type: 'string', description: 'Logical session to append the user prompt and eventual assistant result to' },
                    chatId: { type: 'string', description: 'Optional chat ID for notification callback' },
                    soloChat: {
                      type: 'object',
                      properties: {
                        index: { type: 'number' },
                        titleIncludes: { type: 'string' },
                        textIncludes: { type: 'string' }
                      },
                      description: 'Target a real Solo conversation for result ownership and later collection.'
                    },
                    soloChatIndex: { type: 'number' },
                    soloChatTitleIncludes: { type: 'string' },
                    soloChatTextIncludes: { type: 'string' },
                    newChat: { type: 'boolean', description: 'When false, reuse the selected or targeted Solo conversation.' },
                    waitForQueue: { type: 'boolean', default: true },
                    background: { type: 'boolean', default: false },
                    forceBackground: { type: 'boolean', default: false },
                    includeProcessText: { type: 'boolean', default: false },
                    fallbackModels: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Ordered model candidates to probe while the task waits in the local background queue.'
                    },
                    autoModelFallback: { type: 'boolean', default: false },
                    modelProbeIntervalMs: { type: 'number', default: 60000 },
                    maxQueueWaitMs: { type: 'number', description: 'Optional maximum local queue wait before timeout' },
                    queueMaxWaitMs: { type: 'number', description: 'Alias for maxQueueWaitMs' },
                    reviewRequired: { type: 'boolean', default: false },
                    autoContinue: { type: 'boolean', default: false, description: 'Automatically approve stable review checkpoints and continue follow-up tasks.' },
                    autoApproveDialog: {
                      oneOf: [{ type: 'boolean' }, { type: 'string' }],
                      description: 'Automatically handle code-answerable dialogs while this task is running.'
                    },
                    completionChecks: completionChecksSchema,
                    notifyUrl: { type: 'string', description: 'Optional webhook URL for task lifecycle notifications' },
                    followupTasks: {
                      type: 'array',
                      items: {
                        oneOf: [
                          { type: 'string' },
                          {
                            type: 'object',
                            required: ['task'],
                            properties: {
                              task: { type: 'string' },
                              reviewRequired: { type: 'boolean' },
                              autoContinue: { type: 'boolean' },
                              includeProcessText: { type: 'boolean' },
                              autoApproveDialog: {
                                oneOf: [{ type: 'boolean' }, { type: 'string' }]
                              },
                              completionChecks: completionChecksSchema
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '202': {
              description: 'Task accepted for async processing',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      taskId: { type: 'string' },
                      status: { type: 'string', enum: ['queued', 'running'] }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/new-chat': {
        post: {
          summary: 'Create a new chat in TraeCN',
          operationId: 'newChat',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'New chat result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { type: 'boolean' } }
                  }
                }
              }
            }
          }
        }
      },
      '/api/solo/chats': {
        get: {
          summary: 'List real Solo-mode conversations from the TraeCN sidebar',
          operationId: 'listSoloChats',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Solo conversation list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      mode: { type: 'string' },
                      count: { type: 'number' },
                      reason: { type: 'string' },
                      chats: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            index: { type: 'number' },
                            title: { type: 'string' },
                            text: { type: 'string' },
                            status: { type: 'string' },
                            active: { type: 'boolean' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/solo/chats/switch': {
        post: {
          summary: 'Switch to a real Solo-mode conversation by index or visible text',
          operationId: 'switchSoloChat',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    index: { type: 'number' },
                    titleIncludes: { type: 'string' },
                    textIncludes: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Switch result' },
            '404': { description: 'Solo chat not found or Solo sidebar unavailable' }
          }
        }
      },
      '/api/solo/chats/cleanup-foreign-queue': {
        post: {
          summary: 'Find and optionally delete foreign queue-probe Solo conversations',
          operationId: 'cleanupForeignSoloQueue',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dryRun: { type: 'boolean', description: 'List matches without deleting them' },
                    execute: { type: 'boolean', description: 'Delete matched queue-probe conversations when true' },
                    maxPasses: { type: 'integer', minimum: 1, maximum: 20, description: 'Repeat list/stop/delete passes to catch queue-probe chats revealed after earlier deletions' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Delay between cleanup passes' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Cleanup result' },
            '501': { description: 'Current driver cannot delete Solo chats' }
          }
        }
      },
      '/api/solo/chats/cleanup_foreign_solo_queue': {
        post: {
          summary: 'Find and optionally delete foreign queue-probe Solo conversations',
          operationId: 'cleanupForeignSoloQueueAlias',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dryRun: { type: 'boolean', description: 'List matches without deleting them' },
                    execute: { type: 'boolean', description: 'Delete matched queue-probe conversations when true' },
                    maxPasses: { type: 'integer', minimum: 1, maximum: 20, description: 'Repeat list/stop/delete passes to catch queue-probe chats revealed after earlier deletions' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Delay between cleanup passes' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Cleanup result' },
            '501': { description: 'Current driver cannot delete Solo chats' }
          }
        }
      },
      '/api/solo/chats/submit': {
        post: {
          summary: 'Submit a task into a real Solo-mode conversation and track it for queued-result collection',
          operationId: 'submitSoloChatTask',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['task'],
                  properties: {
                    task: { type: 'string' },
                    projectPath: { type: 'string' },
                    soloChat: {
                      type: 'object',
                      properties: {
                        index: { type: 'number' },
                        titleIncludes: { type: 'string' },
                        textIncludes: { type: 'string' }
                      }
                    },
                    soloChatIndex: { type: 'number' },
                    soloChatTitleIncludes: { type: 'string' },
                    soloChatTextIncludes: { type: 'string' },
                    newChat: { type: 'boolean' },
                    includeProcessText: { type: 'boolean' },
                    reviewRequired: { type: 'boolean' },
                    autoContinue: { type: 'boolean' },
                    followupTasks: { type: 'array' },
                    completionChecks: { type: 'object' },
                    autoApproveDialog: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
                    notifyUrl: { type: 'string' },
                    fallbackModels: { type: 'array', items: { type: 'string' } },
                    autoModelFallback: { type: 'boolean' },
                    modelProbeIntervalMs: { type: 'number' },
                    maxQueueWaitMs: { type: 'number' },
                    queueMaxWaitMs: { type: 'number', description: 'Alias for maxQueueWaitMs' }
                  }
                }
              }
            }
          },
          responses: {
            '202': { description: 'Submitted task tracking result' },
            '400': { description: 'Invalid task payload' },
            '404': { description: 'Requested Solo chat not found' }
          }
        }
      },
      '/api/detect-mode': {
        get: {
          summary: 'Detect the current TraeCN UI mode',
          operationId: 'detectMode',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Mode detection result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      mode: { type: 'string', enum: ['solo', 'ide'] },
                      confidence: { type: 'number' },
                      indicators: { type: 'array', items: { type: 'string' } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/switch-mode': {
        post: {
          summary: 'Switch TraeCN mode (SOLO/IDE)',
          operationId: 'switchMode',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['mode'],
                  properties: {
                    mode: { type: 'string', enum: ['solo', 'ide'] }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Mode switch result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { type: 'boolean' }, mode: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      },
      '/api/switch-model': {
        post: {
          summary: 'Switch the AI model used by TraeCN',
          operationId: 'switchModel',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model'],
                  properties: {
                    model: { type: 'string', description: 'Model name (e.g. GLM-5.1, DeepSeek-V3.1-Terminus)' },
                    waitForQueue: { type: 'boolean', description: 'When false, return immediately after switching with queue details instead of waiting for the model queue to clear.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Model switch result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      model: { type: 'string' },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/queue-status': {
        get: {
          summary: 'Check if the current AI model is in a queued/busy state',
          operationId: 'checkQueueStatus',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Queue status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      queued: { type: 'boolean' },
                      position: { type: 'number', nullable: true },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/queue/status': {
        get: {
          summary: 'List queued background tasks',
          operationId: 'listQueueTasks',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Queued task list' }
          }
        }
      },
      '/api/task/adopt-current': {
        post: {
          summary: 'Adopt the currently queued or running Trae request as a tracked background task without resending the prompt',
          operationId: 'adoptCurrentTask',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'Optional task text to store with the recovered background task' },
                    reviewRequired: { type: 'boolean' },
                    followupTasks: { type: 'array', items: { type: 'object' } },
                    chatId: { type: 'string' },
                    includeProcessText: { type: 'boolean' },
                    autoApproveDialog: {
                      oneOf: [{ type: 'boolean' }, { type: 'string' }],
                      description: 'Automatically handle code-answerable dialogs while the adopted task is running.'
                    },
                    notifyUrl: { type: 'string' },
                    fallbackModels: { type: 'array', items: { type: 'string' } },
                    autoModelFallback: { type: 'boolean' },
                    modelProbeIntervalMs: { type: 'number' },
                    submittedAt: { type: 'number' },
                    force: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: {
            '202': { description: 'Current Trae request adopted and will be tracked in the background' },
            '409': { description: 'No queued or running Trae request is visible' }
          }
        }
      },
      '/api/task/{taskId}': {
        get: {
          summary: 'Get background task status',
          operationId: 'getTaskStatus',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Task status' },
            '404': { description: 'Task not found' }
          }
        }
      },
      '/api/task/{taskId}/review': {
        post: {
          summary: 'Approve or reject a background result before continuing follow-up work',
          operationId: 'reviewTaskResult',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['decision'],
                  properties: {
                    decision: { type: 'string', enum: ['approve', 'continue', 'reject'] },
                    notes: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Review decision applied' },
            '400': { description: 'Invalid review request' },
            '404': { description: 'Task not found' }
          }
        }
      },
      '/api/task/{taskId}/cancel': {
        post: {
          summary: 'Cancel a queued background task',
          operationId: 'cancelTask',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Task cancelled' },
            '400': { description: 'Task cannot be cancelled' },
            '404': { description: 'Task not found' }
          }
        }
      },
      '/api/trae/stop-generation': {
        post: {
          summary: 'Stop the current Trae generation or queued model request in the visible UI',
          operationId: 'stopTraeGeneration',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Stop button clicked or no generation is active' },
            '409': { description: 'Stop generation action is not currently available' }
          }
        }
      },
      '/api/trae/review-gate': {
        get: {
          summary: 'Inspect whether Trae is blocked on its internal task review gate',
          operationId: 'getTraeReviewGate',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Review gate state' }
          }
        },
        post: {
          summary: 'Resolve Trae internal task review gate by keeping or reverting generated changes',
          operationId: 'resolveTraeReviewGate',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['keep_all', 'revert_all', 'keep', 'discard'] }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Review gate resolved or not present' },
            '409': { description: 'Review gate could not be resolved' }
          }
        }
      },
      '/api/confirm/plan': {
        post: {
          summary: 'Create a side-effect and confirmation plan before executing a command',
          operationId: 'createConfirmationPlan',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['command'],
                  properties: {
                    command: { type: 'string' },
                    params: { type: 'object' },
                    forceConfirm: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Confirmation and preflight plan' },
            '400': { description: 'Invalid command plan request' }
          }
        }
      },
      '/api/preflight': {
        post: {
          summary: 'Return compact live preflight state before operating TraeCN',
          operationId: 'preflight',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    command: { type: 'string', description: 'Optional command to assess' },
                    params: { type: 'object', description: 'Optional command parameters for confirmation planning' },
                    forceConfirm: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Compact status/readiness/queue/dialog summary and optional command plan',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      connected: { type: 'boolean' },
                      ready: { type: 'boolean' },
                      canDelegate: { type: 'boolean' },
                      nextAction: { type: 'string' },
                      tokenHint: { type: 'string' },
                      status: { type: 'object' },
                      surface: { type: 'object' },
                      readiness: { type: 'object' },
                      queue: { type: 'object' },
                      dialog: { type: 'object' },
                      localQueue: { type: 'object' },
                      commandPlan: { type: 'object', nullable: true },
                      capabilities: { type: 'object' }
                    }
                  }
                }
              }
            },
            '400': { description: 'Invalid preflight request' }
          }
        }
      },
      '/api/trae/restart-debug': {
        post: {
          summary: 'Restart Trae CN with remote debugging enabled and the existing logged-in profile',
          operationId: 'restartTraeDebug',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    confirmationPhrase: {
                      type: 'string',
                      description: 'Required unless confirmationId matches the generated restart_trae_debug confirmation plan.'
                    },
                    confirmationId: { type: 'string' },
                    projectPath: { type: 'string' },
                    quitTimeoutMs: { type: 'number' },
                    cdpWaitMs: { type: 'number' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Restart attempted and CDP wait result returned' },
            '409': { description: 'Explicit confirmation required before closing Trae CN' }
          }
        }
      },
      '/api/tasks/history': {
        get: {
          summary: 'Search task history',
          operationId: 'getTasksHistory',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'keyword', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'sessionId', in: 'query', required: false, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Paginated task history' }
          }
        },
        delete: {
          summary: 'Clear task history',
          operationId: 'clearTasksHistory',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'olderThanHours', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'beforeDate', in: 'query', required: false, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Clear result' }
          }
        }
      },
      '/api/tasks/{taskId}': {
        get: {
          summary: 'Get a task history entry',
          operationId: 'getHistoryTask',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Task history entry' },
            '404': { description: 'Task not found' }
          }
        }
      },
      '/api/tasks/{taskId}/replay': {
        get: {
          summary: 'Get replay information for a task history entry',
          operationId: 'getTaskReplay',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Task replay data' },
            '404': { description: 'Task not found' }
          }
        }
      },
      '/api/tasks/batch': {
        post: {
          summary: 'Submit a batch of tasks',
          operationId: 'submitTaskBatch',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tasks'],
                  properties: {
                    tasks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['task'],
                        properties: {
                          task: { type: 'string' },
                          priority: { type: 'number' }
                        }
                      }
                    },
                    strategy: { type: 'string', enum: ['parallel', 'sequential', 'priority'] },
                    maxConcurrency: { type: 'integer' },
                    onComplete: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '202': { description: 'Batch accepted' },
            '400': { description: 'Invalid batch request' }
          }
        }
      },
      '/api/tasks/batch/{batchId}': {
        get: {
          summary: 'Get batch task status',
          operationId: 'getBatchStatus',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Batch status' },
            '404': { description: 'Batch not found' }
          }
        },
        delete: {
          summary: 'Cancel a running batch',
          operationId: 'cancelBatch',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Batch cancelled' },
            '400': { description: 'Batch cannot be cancelled' },
            '404': { description: 'Batch not found' }
          }
        }
      },
      '/api/open-project': {
        post: {
          summary: 'Open a project in TraeCN',
          operationId: 'openProject',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['projectPath'],
                  properties: {
                    projectPath: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Project open result' }
          }
        }
      },
      '/api/update-self': {
        post: {
          summary: 'Report self-update support status',
          operationId: 'updateSelf',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    force: { type: 'boolean', default: false }
                  }
                }
              }
            }
          },
          responses: {
            '501': {
              description: 'Automatic self-update is not enabled',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      version: { type: 'string' },
                      force: { type: 'boolean' },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/readiness': {
        get: {
          summary: 'Check TraeCN automation readiness',
          operationId: 'checkReadiness',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Readiness information',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ready: { type: 'boolean' },
                      composer: { type: 'object' },
                      sendButton: { type: 'object' },
                      responseRegion: { type: 'object' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/settings/read': {
        get: {
          summary: 'Read current settings section content',
          operationId: 'settingsRead',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'section', in: 'query', required: false, schema: { type: 'string' }, description: 'Settings sidebar section to navigate to first (e.g. 通用, 模型, Beta)' }
          ],
          responses: {
            '200': {
              description: 'Settings content for the section',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      section: { type: 'string' },
                      sections: { type: 'array' },
                      items: { type: 'array' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/settings/set': {
        post: {
          summary: 'Set a settings value (dropdown or toggle)',
          operationId: 'settingsSet',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['label', 'value'],
                  properties: {
                    section: { type: 'string', description: 'Sidebar section to navigate to first' },
                    label: { type: 'string', description: 'Exact label text of the setting item' },
                    value: {
                      oneOf: [
                        { type: 'string', description: 'For dropdowns: exact option text to select' },
                        { type: 'boolean', description: 'For toggles: true=on, false=off' }
                      ]
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Set operation result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      value: {},
                      result: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/settings/read-all': {
        get: {
          summary: 'Read all TraeCN settings sections',
          operationId: 'settingsReadAll',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Full settings snapshot of all sections',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      sections: { type: 'array', items: { type: 'string' } },
                      data: {
                        type: 'object',
                        additionalProperties: {
                          type: 'object',
                          properties: {
                            sections: { type: 'array' },
                            items: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  label: { type: 'string' },
                                  desc: { type: 'string' },
                                  currentValue: { type: 'string' },
                                  hasToggle: { type: 'boolean' },
                                  hasDropdown: { type: 'boolean' },
                                  toggleChecked: { type: 'boolean' }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/settings/switch-tab': {
        post: {
          summary: 'Navigate to a settings section',
          operationId: 'settingsSwitchTab',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['section'],
                  properties: {
                    section: { type: 'string', enum: ['账号', '通用', '智能体', 'MCP', '对话流', 'CUE', '模型', '上下文', '规则和技能', 'Beta', '关于 TRAE'], description: 'Sidebar section name' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Navigation result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tab: { type: 'string' },
                      section: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/settings/back-to-chat': {
        post: {
          summary: 'Navigate back to Chat (Editor) tab',
          operationId: 'settingsBackToChat',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Navigation result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { result: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      },
      '/api/dialog/status': {
        get: {
          summary: 'Check whether TraeCN is showing an approval dialog',
          operationId: 'getDialogStatus',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Dialog status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      hasDialog: { type: 'boolean' },
                      dialogType: { type: 'string', nullable: true },
                      question: { type: 'string', nullable: true },
                      buttons: { type: 'array', items: { type: 'string' } },
                      canAutoApprove: { type: 'boolean' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/dialog/approve': {
        post: {
          summary: 'Approve or deny the current TraeCN dialog',
          operationId: 'approveDialog',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['auto', 'trust', 'allow', 'confirm', 'approve', 'deny', 'cancel', 'dismiss', 'answer'] },
                    answer: { type: 'string', description: 'Answer text or option label for Trae question cards, e.g. Uncommitted changes' },
                    option: { type: 'string', description: 'Alias for answer' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Dialog action result' },
            '400': { description: 'Invalid action' }
          }
        }
      },
      '/api/dialog/dismiss': {
        post: {
          summary: 'Dismiss the current TraeCN dialog',
          operationId: 'dismissDialog',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Dismiss result' }
          }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token or X-TraeCN-Token header'
        }
      }
    }
  };

  spec.paths['/api/settings'] = {
    get: spec.paths['/api/settings/read'].get,
    post: spec.paths['/api/settings/set'].post
  };

  spec.paths['/openapi.json'] = {
    get: {
      summary: 'Read the OpenAPI document',
      operationId: 'getOpenAPI',
      responses: {
        '200': { description: 'OpenAPI document' }
      }
    }
  };

  spec.paths['/'] = {
    get: {
      summary: 'Open the built-in chat UI',
      operationId: 'getChatUI',
      responses: {
        '200': { description: 'HTML chat UI' }
      }
    }
  };

  return spec;
}

module.exports = { generateOpenAPISpec };
