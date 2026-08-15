'use strict';

// tsc 不会把 model-catalog.json 复制到 out/，而扩展运行时在 out/src/shared 下读取它。
// 编译时把快照同步到 out，保证扩展运行时自包含。
const fs = require('fs');
const path = require('path');

const srcFile = path.join(__dirname, '..', 'src', 'shared', 'model-catalog.json');
const destDir = path.join(__dirname, '..', 'out', 'src', 'shared');
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(srcFile, path.join(destDir, 'model-catalog.json'));
