'use strict';

function generateOpenAPISpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'TraeCN CDP HTTP Bridge',
      description: 'Local HTTP bridge for TraeCN desktop automation via CDP and DOM',
      version: '0.2.0'
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
                      uptime: { type: 'number' }
                    }
                  }
                }
              }
            }
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
                    includeProcessText: { type: 'boolean', description: 'Include process information in response' }
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
                    includeProcessText: { type: 'boolean', default: false }
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
                    chatId: { type: 'string', description: 'Optional chat ID for notification callback' }
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
                    model: { type: 'string', description: 'Model name (e.g. GLM-5.1, DeepSeek-V3.1-Terminus)' }
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
      '/api/settings/action': {
        post: {
          tags: ['Settings'],
          summary: 'Perform a generic action on the settings panel',
          description: 'navigate/read/type/click/toggle/dropdown/back. Navigate to section, read content, type into inputs, click buttons, toggle switches, select dropdowns.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: { type: 'string', enum: ['navigate', 'read', 'type', 'click', 'clickTab', 'toggle', 'dropdown', 'set', 'readTables', 'back'] },
                    params: {
                      type: 'object',
                      properties: {
                        section: { type: 'string' },
                        label: { type: 'string' },
                        text: { type: 'string' },
                        value: { type: 'string' },
                        enabled: { type: 'boolean' }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Action result' },
            '400': { description: 'Invalid action or params' }
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
}

module.exports = { generateOpenAPISpec };
