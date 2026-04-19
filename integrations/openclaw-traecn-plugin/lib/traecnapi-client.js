'use strict';

const http = require('http');

const PLUGIN_ID = 'traecnclaw';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8788';

class TraeCNApiClient {
  constructor(context) {
    this.baseUrl = (context && context.baseUrl) || DEFAULT_BASE_URL;
    this.token = (context && context.token) || '';
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 60000
      };

      if (this.token) {
        options.headers['Authorization'] = `Bearer ${this.token}`;
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch {
            resolve({ statusCode: res.statusCode, data: { raw: data } });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async getStatus(allowAutoStart = false) {
    const { statusCode, data } = await this._request('GET', '/api/status');
    if (statusCode !== 200) {
      return { error: data.error || 'Failed to get status', status: 'error' };
    }

    if (data.status !== 'connected' && allowAutoStart) {
      return { ...data, note: 'TraeCN auto-start is not yet supported via API. Please start TraeCN manually.' };
    }

    return data;
  }

  async newChat(allowAutoStart = false) {
    const { statusCode, data } = await this._request('POST', '/api/new-chat');
    if (statusCode !== 200) {
      return { error: data.error || 'Failed to create new chat' };
    }
    return data;
  }

  async delegate(task, options = {}) {
    let sessionId = options.sessionId;

    if (!sessionId) {
      const sessionBody = {};
      if (options.projectPath) sessionBody.projectPath = options.projectPath;

      const { statusCode, data } = await this._request('POST', '/api/sessions', sessionBody);
      if (statusCode !== 201) {
        return { error: data.error || 'Failed to create session' };
      }
      sessionId = data.sessionId;
    }

    const delegateBody = {
      task,
      includeProcessText: options.includeProcessText || false
    };

    const { statusCode, data } = await this._request('POST', `/api/sessions/${sessionId}/delegate`, delegateBody);
    if (statusCode !== 200) {
      return { error: data.error || 'Failed to delegate task' };
    }

    return data;
  }

  async switchMode(mode, allowAutoStart = false) {
    const { statusCode, data } = await this._request('POST', '/api/switch-mode', { mode });
    if (statusCode !== 200) {
      return { error: data.error || 'Failed to switch mode' };
    }
    return data;
  }

  async openProject(projectPath) {
    const { statusCode, data } = await this._request('POST', '/api/open-project', { projectPath });
    if (statusCode !== 200) {
      return { error: data.error || 'Failed to open project' };
    }
    return data;
  }

  async updateSelf(force = false) {
    return {
      pluginId: PLUGIN_ID,
      message: 'Self-update is not yet implemented. Please update manually via: openclaw plugins install traecnclaw',
      force
    };
  }
}

module.exports = { TraeCNApiClient, PLUGIN_ID };
