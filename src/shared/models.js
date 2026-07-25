// Shared model catalogue — single source of truth for model lists used across the codebase.
// Last synced from live Trae CN instance on 2026-07-23.

const KNOWN_MODELS = [
  // Doubao family
  'Doubao-Seed-2.1-Pro',
  'Doubao-Seed-2.1-Turbo',
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-Code',
  'Doubao-Seed-1.8',
  // GLM family
  'GLM-5.2',
  'GLM-5.1',
  'GLM-5',
  // DeepSeek family
  'DeepSeek-V4-Pro',
  'DeepSeek-V4-Flash',
  'DeepSeek-V3.1-Terminus',
  // Kimi family
  'Kimi-K3',
  'Kimi-K2.7-Code',
  'Kimi-K2.6',
  'Kimi-K2.5',
  // MiniMax family
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  // Qwen family
  'Qwen3.7-Plus',
  'Qwen3.6-Plus',
  'Qwen3.5-Plus'
];

const DEFAULT_FALLBACK_MODELS = KNOWN_MODELS.filter(m =>
  m !== 'Doubao-Seed-1.8' && m !== 'MiniMax-M2.5'
);

module.exports = { KNOWN_MODELS, DEFAULT_FALLBACK_MODELS };

