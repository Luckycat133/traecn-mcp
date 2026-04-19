'use strict';

const { generateOpenAPISpec } = require('../src/http/openapi');
const fs = require('fs');
const path = require('path');

const spec = generateOpenAPISpec();
const outputPath = path.resolve(__dirname, '..', 'openapi.json');
fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`[export-openapi] OpenAPI spec exported to ${outputPath}`);
