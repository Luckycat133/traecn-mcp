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
                      traeAdapter: {
                        type: 'object',
                        nullable: true,
                        properties: {
                          traeVersion: { type: 'string', nullable: true },
                          platform: { type: 'string' },
                          adapter: { type: 'string' },
                          mode: { type: 'string', nullable: true },
                          compatibility: { type: 'string', enum: ['verified', 'degraded'] },
                          verified: { type: 'boolean' },
                          capabilities: { type: 'object' },
                          warnings: { type: 'array', items: { type: 'string' } },
                          evidence: { type: 'string', nullable: true },
                          versionSource: { type: 'string' }
                        }
                      },
                      surface: { type: 'object' },
                      durability: {
                        type: 'object',
                        properties: {
                          taskStoreWritable: { type: 'boolean', nullable: true },
                          lastSuccessfulPersistAt: { type: 'string', nullable: true },
                          lastPersistError: { type: 'object', nullable: true },
                          durabilityDegraded: { type: 'boolean' },
                          terminalReplayCount: { type: 'integer', minimum: 0 },
                          terminalReplayTtlMs: { type: 'number', minimum: 1 },
                          taskEvents: {
                            type: 'object',
                            nullable: true,
                            properties: {
                              persistenceEnabled: { type: 'boolean' },
                              eventStoreWritable: { type: 'boolean', nullable: true },
                              lastSuccessfulPersistAt: { type: 'string', nullable: true },
                              lastPersistError: { type: 'object', nullable: true },
                              lastLoadError: { type: 'object', nullable: true },
                              lastRecovery: { type: 'object', nullable: true },
                              durabilityDegraded: { type: 'boolean' }
                            }
                          },
                          taskHistory: {
                            type: 'object',
                            nullable: true,
                            properties: {
                              persistenceEnabled: { type: 'boolean' },
                              historyStoreWritable: { type: 'boolean', nullable: true },
                              lastSuccessfulPersistAt: { type: 'string', nullable: true },
                              lastPersistError: { type: 'object', nullable: true },
                              lastLoadError: { type: 'object', nullable: true },
                              lastRecovery: { type: 'object', nullable: true },
                              durabilityDegraded: { type: 'boolean' }
                            }
                          }
                        }
                      },
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
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Current config and recent audit log' }
          }
        }
      },
      '/api/config/schema': {
        get: {
          summary: 'Read runtime configuration schema and defaults',
          operationId: 'getConfigSchema',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Config schema and default values' }
          }
        }
      },
      '/api/config/update': {
        post: {
          summary: 'Update runtime gateway configuration',
          operationId: 'updateConfig',
          security: [{ bearerAuth: [] }],
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
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Config reset result' }
          }
        }
      },
      '/api/config/diff': {
        get: {
          summary: 'Compare current config with defaults or a previous audit entry',
          operationId: 'getConfigDiff',
          security: [{ bearerAuth: [] }],
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
                    projectPath: {
                      type: 'string',
                      description: 'Optional workspace guard. The path must match the project open in TraeCN.'
                    }
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
                    projectPath: {
                      type: 'string',
                      description: 'Optional workspace guard. The path must match the project open in TraeCN; it is never added to the model prompt.'
                    },
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
      '/api/tasks/submit': {
        post: {
          summary: 'Submit gateway-managed work for TraeCN',
          operationId: 'submitManagedTask',
          security: [{ bearerAuth: [] }],
          parameters: [{
            in: 'header',
            name: 'Idempotency-Key',
            required: false,
            schema: { type: 'string', maxLength: 256 },
            description: 'Stable retry key retained with active work and terminal results for the configured 24-hour default TTL.'
          }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: { type: 'string', maxLength: 100000 },
                    model: { type: 'string' },
                    mode: { type: 'string', enum: ['solo', 'ide'] },
                    workspace: { type: 'string', description: 'Folder opened and verified by the gateway; never inserted into the message.' },
                    conversationId: { type: 'string' },
                    newConversation: { type: 'boolean' },
                    reviewRequired: { type: 'boolean', default: false, description: 'Pause the managed task at its final result until an explicit review decision.' },
                    steps: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } },
                    completionChecks: completionChecksSchema
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Terminal idempotency replay with the original task status and result' },
            '202': { description: 'Task accepted after its active-queue snapshot is durable', content: { 'application/json': { schema: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['accepted'] } } } } } },
            '400': { description: 'Invalid task payload or Idempotency-Key longer than 256 characters' },
            '409': { description: 'Idempotency-Key was already used for different semantic work' },
            '503': { description: 'TaskStore is unwritable or owned by another gateway; no task was accepted' }
          }
        }
      },
      '/api/conversations': {
        get: {
          summary: 'List conversations for the current TraeCN mode',
          operationId: 'listConversations',
          security: [{ bearerAuth: [] }],
          responses: { '200': { description: 'Conversation list' } }
        }
      },
      '/api/models': {
        get: {
          summary: 'List currently offered TraeCN models',
          operationId: 'listModels',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Current and available models',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      current: { type: 'string' },
                      models: { type: 'array', items: { type: 'string' } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/conversations/manage': {
        post: {
          summary: 'Create, select, or permanently delete a TraeCN conversation',
          operationId: 'manageConversation',
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['action'], properties: {
            action: { type: 'string', enum: ['create', 'select', 'delete'] },
            conversationId: { type: 'string' },
            expectedTitle: { type: 'string', description: 'Required for delete; exact title returned by the conversation list.' },
            acknowledgePermanentDeletion: { type: 'boolean', description: 'Required true for delete; the gateway has no recovery path.' }
          } } } } },
          responses: { '200': { description: 'Conversation operation result' } }
        }
      },
      '/api/interactions/resolve': {
        post: {
          summary: 'Resolve an exceptional TraeCN question or unsafe approval',
          operationId: 'resolveInteraction',
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['action'], properties: {
            action: { type: 'string', enum: ['approve', 'deny', 'answer', 'dismiss'] },
            answer: { type: 'string' },
            expectedCommand: { type: 'string', description: 'Required for approve; must exactly match the currently visible exceptional command.' },
            acknowledgeRisk: { type: 'boolean', description: 'Required true for approve after checking user-authorized scope.' },
            reason: { type: 'string', maxLength: 500, description: 'Required for approve and recorded in the local security audit log.' }
          } } } } },
          responses: { '200': { description: 'Interaction resolution result' } }
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
                    projectPath: {
                      type: 'string',
                      description: 'Optional workspace guard. The folder name must match the project open in TraeCN; it is never added to the model prompt.'
                    },
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
                    projectPath: { type: 'string', description: 'Optional workspace-path guard; rejected on mismatch and never inserted into the model prompt' },
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
                    projectPath: {
                      type: 'string',
                      description: 'Optional workspace guard. The path must match the project open in TraeCN; it is never added to the model prompt.'
                    },
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
            '404': { description: 'Requested Solo chat not found' },
            '409': { description: 'projectPath does not match the project folder open in TraeCN' },
            '503': { description: 'The open TraeCN workspace could not be identified' }
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
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'detailLevel',
              in: 'query',
              required: false,
              description: 'Return only the final result (default) or the full visible execution trace.',
              schema: { type: 'string', enum: ['result', 'trace'], default: 'result' }
            }
          ],
          responses: {
            '200': { description: 'Task status' },
            '404': { description: 'Task not found' }
          }
        }
      },
      '/api/task-events': {
        get: {
          summary: 'Long-poll compact durable task events for one IDE client cursor',
          operationId: 'listTaskEvents',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'clientId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'after', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'waitMs', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 30000 } }
          ],
          responses: {
            '200': {
              description: 'Client-scoped event batch and replay cursor',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      clientId: { type: 'string' },
                      clientKnown: {
                        type: 'boolean',
                        description: 'Whether this client has a durable acknowledgement cursor.'
                      },
                      acknowledgedCursor: {
                        type: 'string',
                        nullable: true,
                        description: 'The last event durably delivered to this client.'
                      },
                      events: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            eventId: { type: 'string' },
                            type: { type: 'string' },
                            taskId: { type: 'string' },
                            status: { type: 'string' },
                            createdAt: { type: 'string', format: 'date-time' },
                            terminal: { type: 'boolean' },
                            attentionRequired: { type: 'boolean' },
                            resultAvailable: { type: 'boolean' },
                            sessionId: { type: 'string', nullable: true },
                            summary: { type: 'string', maxLength: 240 }
                          }
                        }
                      },
                      cursor: { type: 'string', nullable: true },
                      hasMore: { type: 'boolean' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/task-events/ack': {
        post: {
          summary: 'Advance one IDE client task-event cursor after successful delivery',
          operationId: 'ackTaskEvent',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['clientId', 'eventId'],
                  properties: {
                    clientId: { type: 'string' },
                    eventId: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Event cursor acknowledged' },
            '400': { description: 'Missing clientId or eventId' },
            '404': { description: 'Event no longer exists' },
            '503': { description: 'Event cursor could not be durably acknowledged' }
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
      '/api/task/{taskId}/interaction': {
        post: {
          summary: 'Resolve the exact current interaction for one tracked task',
          operationId: 'resolveTaskInteraction',
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
                  required: ['interactionRequestId', 'action'],
                  properties: {
                    interactionRequestId: {
                      type: 'string',
                      description: 'Exact current interaction identity returned by the task endpoint.'
                    },
                    action: { type: 'string', enum: ['approve', 'deny', 'answer', 'dismiss'] },
                    answer: { type: 'string', description: 'Exact current option label for answer.' },
                    expectedCommand: { type: 'string', description: 'Exact visible command required for approve.' },
                    acknowledgeRisk: { type: 'boolean', description: 'Must be true for command approval.' },
                    reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Required security audit reason for command approval.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'The identity-bound interaction was resolved' },
            '400': { description: 'Malformed action or missing action-specific authorization context' },
            '401': { description: 'Gateway authentication is required' },
            '404': { description: 'Task not found' },
            '409': { description: 'Task, interaction identity, command, or visible dialog changed; no action applied' },
            '501': { description: 'The active adapter cannot verify the visible interaction' }
          }
        }
      },
      '/api/trae/stop-generation': {
        post: {
          summary: 'Stop the visible generation only in a verified active Solo conversation',
          operationId: 'stopTraeGeneration',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['conversationId', 'acknowledgeUntrackedWork', 'reason'],
                  properties: {
                    conversationId: { type: 'string', description: 'Active ID returned by the conversation list.' },
                    acknowledgeUntrackedWork: { type: 'boolean', description: 'Must be true because visible work may not belong to the gateway.' },
                    reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Security audit reason.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'The verified active conversation generation was stopped' },
            '409': { description: 'Conversation scope mismatch or stop action unavailable' }
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
      '/api/workspace': {
        get: {
          summary: 'Read the authenticated TraeCN workspace context',
          operationId: 'getWorkspaceContext',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Sanitized workspace context and exact-path verification state',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['folderName', 'rootPath', 'selectedPath', 'title', 'hasExplorer', 'verified'],
                    properties: {
                      folderName: { type: 'string', nullable: true },
                      rootPath: { type: 'string', nullable: true },
                      selectedPath: { type: 'string', nullable: true },
                      title: { type: 'string', nullable: true },
                      hasExplorer: { type: 'boolean' },
                      verified: {
                        type: 'boolean',
                        description: 'True only when the selected workspace guard matches an exact detected root path.'
                      }
                    }
                  }
                }
              }
            },
            '401': { description: 'Gateway authentication is required' },
            '501': { description: 'The active adapter cannot read workspace context' },
            '503': { description: 'Workspace context is temporarily unavailable' }
          }
        }
      },
      '/api/open-project': {
        post: {
          summary: 'Open or switch the active TraeCN project',
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
                    projectPath: { type: 'string', description: 'Absolute local project directory' },
                    newInstance: { type: 'boolean', description: 'Open a separate window instead of reusing the active TraeCN window', default: false }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Project opened and exact workspace path verified' },
            '404': { description: 'TraeCN binary or bundled CLI was not found' }
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
            { name: 'section', in: 'query', required: false, schema: { type: 'string' }, description: 'Settings sidebar section to navigate to first (e.g. 通用, 模型, Beta)' },
            { name: 'restoreChat', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Return to the chat UI after reading settings' }
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
      '/api/settings/sections': {
        get: {
          summary: 'List settings sections visible in the TraeCN UI',
          operationId: 'settingsListSections',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'restoreChat', in: 'query', required: false, schema: { type: 'boolean' } }
          ],
          responses: {
            '200': {
              description: 'Visible settings sections',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { sections: { type: 'array', items: { type: 'string' } } }
                  }
                }
              }
            }
          }
        }
      },
      '/api/settings/options': {
        get: {
          summary: 'List visible options for one dropdown setting',
          operationId: 'settingsListOptions',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'section', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'label', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'restoreChat', in: 'query', required: false, schema: { type: 'boolean' } }
          ],
          responses: {
            '200': {
              description: 'Dropdown choices read from the TraeCN UI',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      section: { type: 'string' },
                      label: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } }
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
          summary: 'Set one TraeCN UI setting using its exact control type',
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
                    kind: { type: 'string', enum: ['auto', 'toggle', 'option', 'text'] },
                    restoreChat: { type: 'boolean' },
                    value: {
                      oneOf: [
                        { type: 'string', description: 'For dropdowns: exact option text to select' },
                        { type: 'boolean', description: 'For toggles: true=on, false=off' },
                        { type: 'number', description: 'For numeric text inputs' }
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
                                  hasTextInput: { type: 'boolean' },
                                  controlType: { type: 'string', enum: ['toggle', 'option', 'text', 'display'] },
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
                      canAutoApprove: { type: 'boolean' },
                      approvalDecision: { type: 'string', enum: ['agent_review'], nullable: true },
                      commandRisk: { type: 'string', enum: ['low', 'high', 'unknown'], nullable: true },
                      riskReasons: { type: 'array', items: { type: 'string' } },
                      command: { type: 'string', nullable: true }
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
      },
      // Driver endpoints — added 2026-06-21
      '/api/editor': {
        post: {
          summary: 'Invoke an editor driver action',
          operationId: 'invokeEditor',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Editor action name. One of: acceptAll, rejectAll, acceptNext, rejectNext, readApplyState, save, saveAll, saveAs, revertFile, revertAll, closeActive, closeAll, newFile, revealInExplorer, copyPathOfActive, reloadWindow, toggleSidebar, togglePanel, splitEditor, showCommands, undo, redo, formatDocument, formatSelection, commentLine, copyLinesDown, copyLinesUp, moveLinesDown, moveLinesUp, insertCursorAbove, insertCursorBelow, insertCursorAtEachMatchSelection, expandLineSelection, shrinkSelection, addSelectionToNextFindMatch, addSelectionToPreviousFindMatch, selectAll, triggerSuggest, showHover, gotoLine, revealDefinition, peekDefinition, showReferences, renameSymbol, findAllReferences, implementInterface, quickFix, refactor, fold, unfold, foldAll, unfoldAll, foldRecursively, unfoldRecursively, readActive, writeActive, listActive.'
                    },
                    value: { type: 'string', description: 'Used by writeActive to set the active editor buffer contents.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/file': {
        post: {
          summary: 'Invoke a file driver action',
          operationId: 'invokeFile',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'File action name. One of: closeActive, closeAll, closeOthers, newFile, revertFile, revealInExplorer, copyPath, save, saveAll, saveAs, openFileByPath, listOpenEditors, listExplorerVisible, readDisk, writeDisk, deleteDisk, mkdirDisk, listTreeDisk, renameDisk.'
                    },
                    filePath: { type: 'string', description: 'Used by openFileByPath, readDisk, writeDisk, deleteDisk.' },
                    content: { type: 'string', description: 'Used by writeDisk.' },
                    dirPath: { type: 'string', description: 'Used by mkdirDisk.' },
                    rootPath: { type: 'string', description: 'Used by listTreeDisk.' },
                    opts: { description: 'Options bag passed through to listTreeDisk.', oneOf: [{ type: 'object' }, { type: 'string' }] },
                    oldPath: { type: 'string', description: 'Used by renameDisk.' },
                    newPath: { type: 'string', description: 'Used by renameDisk.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/terminal': {
        post: {
          summary: 'Invoke a terminal driver action',
          operationId: 'invokeTerminal',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Terminal action name. One of: toggleTerminal, newTerminal, killTerminal, clearTerminal, splitTerminal, focusTerminal, snapshot, tail, send, sendLine, sendKey, sendCtrlC, sendCtrlD, sendCtrlL, sendCtrlZ, selectTab.'
                    },
                    lines: { type: 'number', description: 'Used by tail to specify how many trailing lines to read.' },
                    text: { type: 'string', description: 'Used by send and sendLine.' },
                    key: { type: 'string', description: 'Used by sendKey.' },
                    code: { type: 'string', description: 'Used by sendKey.' },
                    wvk: { description: 'Used by sendKey.' },
                    modifiers: { type: 'array', items: { type: 'string' }, description: 'Used by sendKey.' },
                    title: { type: 'string', description: 'Used by selectTab.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/git': {
        post: {
          summary: 'Invoke a git driver action',
          operationId: 'invokeGit',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Git action name. One of: openSCM, focusSCM, refreshSCM, stageAll, unstageAll, commit, commitAmend, commitSignedOff, push, pull, sync, fetch, clone, init, checkout, branch, merge, rebase, stash, stashPop, stashApply, showOutput, showLog, diff, commitWithMessage, readStatus, readCurrentBranch, execGit.'
                    },
                    message: { type: 'string', description: 'Used by commitWithMessage.' },
                    args: { type: 'array', items: { type: 'string' }, description: 'Used by execGit to pass arbitrary git CLI arguments.' },
                    opts: { type: 'object', description: 'Options bag for execGit.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/search': {
        post: {
          summary: 'Invoke a search driver action',
          operationId: 'invokeSearch',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Search action name. One of: openSearch, findInFiles, closeSearch, toggleCaseSensitive, toggleWholeWord, toggleRegex, collapseAll, find, readResults.'
                    },
                    query: { type: 'string', description: 'Used by find to specify the search query.' },
                    opts: { type: 'object', description: 'Search options for find (e.g. include/exclude globs, maxResults).' },
                    maxResults: { type: 'number', description: 'Used by readResults to cap returned matches.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/diagnostics': {
        post: {
          summary: 'Invoke a diagnostics driver action',
          operationId: 'invokeDiagnostics',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Diagnostics action name. One of: openProblems, focusProblems, nextProblem, prevProblem, nextInFiles, showErrors, readAll, readModelMarkers, count, hover.'
                    },
                    max: { type: 'number', description: 'Maximum number of problems or markers to return for readAll/readModelMarkers.' },
                    line: { type: 'number', description: 'Line coordinate for hover.' },
                    column: { type: 'number', description: 'Column coordinate for hover.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/snapshot': {
        post: {
          summary: 'Invoke a snapshot driver action',
          operationId: 'invokeSnapshot',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Snapshot action name. One of: dom, text, layout, pageHash, screenshot, screenshotElement.'
                    },
                    selector: { type: 'string', description: 'CSS selector for dom/text/screenshotElement.' },
                    opts: { type: 'object', description: 'Layout options for layout (e.g. include/exclude, regions).' },
                    targetPath: { type: 'string', description: 'Filesystem path for screenshot/screenshotElement output.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/extension': {
        post: {
          summary: 'Invoke an extension driver action',
          operationId: 'invokeExtension',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Extension action name. One of: openExtensions, focusExtensions, openMarketplace, install, uninstall, enable, enableAll, enableAllWorkspace, disable, disableAll, disableAllWorkspace, showInstalled, showEnabled, showDisabled, showOutdated, updateAll, searchMarketplace, readVisible, listViaCLI, installViaCLI, uninstallViaCLI.'
                    },
                    query: { type: 'string', description: 'Search query for searchMarketplace.' },
                    opts: { description: 'Options bag for searchMarketplace/listViaCLI.', oneOf: [{ type: 'object' }, { type: 'string' }] },
                    max: { type: 'number', description: 'Maximum results returned by readVisible.' },
                    extensionId: { type: 'string', description: 'Extension identifier for installViaCLI/uninstallViaCLI.' },
                    version: { type: 'string', description: 'Extension version for installViaCLI.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
          }
        }
      },
      '/api/command': {
        post: {
          summary: 'Invoke a command palette action',
          operationId: 'invokeCommand',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Command action name. One of: open, close, run, runSequence.'
                    },
                    commandId: { type: 'string', description: 'Command identifier used by run.' },
                    commandIds: { type: 'array', items: { type: 'string' }, description: 'Ordered list of command identifiers used by runSequence.' },
                    opts: { type: 'object', description: 'Options bag for run.' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Action result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      driver: { type: 'string' },
                      action: { type: 'string' },
                      result: {}
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing or unknown action, or invalid JSON body' },
            '500': { description: 'Driver invocation failed' }
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
