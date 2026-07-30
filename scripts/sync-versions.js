#!/usr/bin/env node
'use strict';

const { syncVersions } = require('./lib/version-surfaces');

const version = syncVersions();
console.log(`Synchronized distribution surfaces to ${version}`);
