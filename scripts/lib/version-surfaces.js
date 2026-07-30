'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readVersions() {
  const packageJson = readJson('package.json');
  const lock = readJson('package-lock.json');
  const pluginPackage = readJson('integrations/openclaw-traecn-plugin/package.json');
  const pluginManifest = readJson('integrations/openclaw-traecn-plugin/openclaw.plugin.json');
  const skillPath = path.join(ROOT, 'skills/traecnclaw-mcp/SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const skillVersion = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];

  return {
    package: packageJson.version,
    lockfile: lock.version,
    lockfileRoot: lock.packages?.['']?.version,
    skill: skillVersion,
    pluginPackage: pluginPackage.version,
    pluginManifest: pluginManifest.version
  };
}

function syncVersions() {
  const version = readJson('package.json').version;
  const lock = readJson('package-lock.json');
  lock.version = version;
  lock.packages[''].version = version;
  writeJson('package-lock.json', lock);

  const pluginPackage = readJson('integrations/openclaw-traecn-plugin/package.json');
  pluginPackage.version = version;
  writeJson('integrations/openclaw-traecn-plugin/package.json', pluginPackage);

  const pluginManifest = readJson('integrations/openclaw-traecn-plugin/openclaw.plugin.json');
  pluginManifest.version = version;
  writeJson('integrations/openclaw-traecn-plugin/openclaw.plugin.json', pluginManifest);

  const skillPath = path.join(ROOT, 'skills/traecnclaw-mcp/SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const skillVersionPattern = /^(\s*version:\s*)["']?[^"'\s]+["']?\s*$/m;
  if (!skillVersionPattern.test(skill)) throw new Error('Portable skill version field was not found');
  const updatedSkill = skill.replace(skillVersionPattern, `$1"${version}"`);
  fs.writeFileSync(skillPath, updatedSkill, 'utf8');
  return version;
}

module.exports = {
  ROOT,
  readVersions,
  syncVersions
};
