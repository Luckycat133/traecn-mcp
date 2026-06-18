// Shared model catalogue — single source of truth for model lists used across the codebase.

const KNOWN_MODELS = [
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-Code',
  'Doubao-Seed-1.8',
  'GLM-5.2',
  'GLM-5.1',
  'DeepSeek-V3.1-Terminus',
  'DeepSeek-V4-Flash',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'Kimi-K2.6',
  'Kimi-K2.5',
  'Qwen3.6-Plus',
  'Qwen3.5-Plus'
];

const DEFAULT_FALLBACK_MODELS = KNOWN_MODELS.filter(m =>
  m !== 'Doubao-Seed-1.8' && m !== 'MiniMax-M2.5'
);

module.exports = { KNOWN_MODELS, DEFAULT_FALLBACK_MODELS };
