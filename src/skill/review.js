'use strict';

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return [String(value)];
}

/**
 * 选取长度足以包裹给定内容的 markdown 代码围栏。
 *
 * 当 `code` / `diff` 内容本身包含 ```` ``` ```` 这类围栏时，固定长度的
 * 三反引号会被内容提前闭合，导致提示词结构被破坏（甚至被用于提示词
 * 注入）。这里扫描内容中最长的连续反引号序列，返回比它更长的围栏，
 * 从而保证内容无法在内部闭合围栏。
 *
 * @param {string} content - 待包裹的内容
 * @param {number} [min=3] - 最小围栏长度
 * @returns {string} 由反引号组成的围栏字符串
 * @private
 */
function _fenceFor(content, min = 3) {
  let maxRun = 0;
  let run = 0;
  for (const ch of String(content)) {
    if (ch === '`') {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(min, maxRun + 1));
}

function buildCodeReviewTask(input, opts = {}) {
  const payload = typeof input === 'object' && input !== null ? input : { instruction: input };
  const instruction = payload.instruction || opts.instruction || 'Review the supplied code or diff.';
  const files = normalizeList(payload.files || opts.files);
  const focus = normalizeList(payload.focus || opts.focus);
  const code = payload.code || opts.code || '';
  const diff = payload.diff || opts.diff || '';

  return [
    '请作为严格但务实的代码审查助手，审查下面的内容。',
    '',
    '审查目标:',
    `- ${instruction}`,
    '- 优先指出会导致 bug、回归、安全问题、数据丢失、性能退化或缺少测试的事项。',
    '- 对每个问题给出严重级别、位置线索、原因和可执行修复建议。',
    '- 没有明确问题时直接说明未发现高置信问题，并列出剩余风险或建议验证项。',
    '',
    files.length ? `相关文件:\n${files.map(file => `- ${file}`).join('\n')}` : '相关文件: 未指定',
    focus.length ? `重点关注:\n${focus.map(item => `- ${item}`).join('\n')}` : '重点关注: correctness, safety, tests, token-efficient changes',
    '',
    diff ? `待审查 diff:\n${_fenceFor(diff)}diff\n${diff}\n${_fenceFor(diff)}` : '',
    code ? `待审查代码:\n${_fenceFor(code)}\n${code}\n${_fenceFor(code)}` : '',
    '',
    '输出格式:',
    '1. Findings first, ordered by severity.',
    '2. Open questions or assumptions.',
    '3. Brief change/test summary only after findings.'
  ].filter(Boolean).join('\n');
}

module.exports = { buildCodeReviewTask };
