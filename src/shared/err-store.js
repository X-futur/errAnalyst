'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ERR_DIR = path.join(os.homedir(), '.errAnalyst');
const CACHE_FILE = path.join(ERR_DIR, 'cache.json');

function ensureDir() {
  if (!fs.existsSync(ERR_DIR)) {
    fs.mkdirSync(ERR_DIR, { recursive: true });
  }
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeCache(entries) {
  ensureDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

function clearCache() {
  writeCache([]);
}

module.exports = {
  ERR_DIR,
  CACHE_FILE,
  ensureDir,
  readCache,
  writeCache,
  clearCache,
};
