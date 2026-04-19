'use strict';

const { spawn } = require('child_process');

function chat(prompt, options = {}) {
  const args = ['chat'];
  if (options.mode) args.push('--mode', options.mode);
  if (options.maximize) args.push('--maximize');
  if (options.reuseWindow) args.push('--reuse-window');
  if (options.newWindow) args.push('--new-window');
  if (options.addFile) args.push('--add-file', options.addFile);
  args.push('--', prompt);

  return spawn('trae-cn', args, { stdio: 'inherit' });
}

module.exports = { chat };
