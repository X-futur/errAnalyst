'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ERR_DIR = path.join(os.homedir(), '.errAnalyst');
const MEMORY_FILE = path.join(ERR_DIR, 'memory.json');

function ensureDir(file) {
  const dir = path.dirname(file || MEMORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readMemory(file) {
  try {
    const target = file || MEMORY_FILE;
    if (!fs.existsSync(target)) return null;
    const data = JSON.parse(fs.readFileSync(target, 'utf-8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeMemory(data, file) {
  const target = file || MEMORY_FILE;
  ensureDir(target);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
}

function clearMemory(file) {
  writeMemory({ format: 'memory-v1', preferences: [], errorStats: {} }, file);
}

module.exports = {
  ERR_DIR,
  MEMORY_FILE,
  ensureDir,
  readMemory,
  writeMemory,
  clearMemory,
};
