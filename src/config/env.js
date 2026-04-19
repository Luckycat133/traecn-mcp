'use strict';

const fs = require('fs');

function parseEnv(content) {
  const result = {};
  const lines = content.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1);

    if (value.startsWith('"')) {
      let end = -1;
      let searchFrom = 1;
      while (searchFrom < value.length) {
        end = value.indexOf('"', searchFrom);
        if (end === -1) break;
        if (value[end - 1] === '\\') {
          searchFrom = end + 1;
          continue;
        }
        break;
      }

      if (end !== -1) {
        result[key] = value.slice(1, end).replace(/\\"/g, '"');
      } else {
        let combined = value.slice(1);
        let nextLine = lineNum + 1;
        while (nextLine < lines.length) {
          combined += '\n' + lines[nextLine];
          nextLine++;
          if (lines[nextLine - 1].includes('"')) {
            break;
          }
        }
        lineNum = nextLine - 1;
        const finalEnd = combined.lastIndexOf('"');
        if (finalEnd !== -1) {
          result[key] = combined.slice(0, finalEnd).replace(/\\"/g, '"');
        } else {
          result[key] = combined.replace(/\\"/g, '"');
        }
      }
    } else if (value.startsWith("'")) {
      let end = value.indexOf("'", 1);
      if (end !== -1) {
        result[key] = value.slice(1, end);
      } else {
        let combined = value.slice(1);
        let nextLine = lineNum + 1;
        while (nextLine < lines.length) {
          combined += '\n' + lines[nextLine];
          nextLine++;
          if (lines[nextLine - 1].includes("'")) {
            break;
          }
        }
        lineNum = nextLine - 1;
        const finalEnd = combined.lastIndexOf("'");
        if (finalEnd !== -1) {
          result[key] = combined.slice(0, finalEnd);
        } else {
          result[key] = combined;
        }
      }
    } else {
      const commentIndex = value.indexOf('#');
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex);
      }
      result[key] = value.trim();
    }
  }

  return result;
}

function loadEnv(envPath) {
  if (!envPath) {
    envPath = require('path').resolve(process.cwd(), '.env');
  }

  let content;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  const parsed = parseEnv(content);

  for (const key of Object.keys(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = parsed[key];
    }
  }

  return parsed;
}

module.exports = { loadEnv, parseEnv };
