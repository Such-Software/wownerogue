'use strict';

const path = require('path');
const { createRequire } = require('module');

// The application is the package boundary; top-level tests must resolve its dependencies from
// src/package.json instead of accidentally using an unrelated repository-root node_modules tree.
module.exports = createRequire(path.join(__dirname, '..', '..', 'src', 'package.json'));
