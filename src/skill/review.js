'use strict';

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return [String(value)];
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
    diff ? `待审查 diff:\n\`\`\`diff\n${diff}\n\`\`\`` : '',
    code ? `待审查代码:\n\`\`\`\n${code}\n\`\`\`` : '',
    '',
    '输出格式:',
    '1. Findings first, ordered by severity.',
    '2. Open questions or assumptions.',
    '3. Brief change/test summary only after findings.'
  ].filter(Boolean).join('\n');
}

module.exports = { buildCodeReviewTask };
