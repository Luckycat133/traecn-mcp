'use strict';

function generateOpenAPISpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'TraeCN CDP HTTP Bridge',
      description: 'Local HTTP bridge for TraeCN desktop automation via CDP and DOM',
      version: '0.1.0'
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
