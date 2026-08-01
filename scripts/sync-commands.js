#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'commands.json');
const packagePath = path.join(root, 'package.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

pkg.contributes.commands = manifest
  .filter(entry => entry.vscodeId)
  .map(entry => ({ command: entry.vscodeId, title: entry.title }));

fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Synced ${pkg.contributes.commands.length} commands to package.json`);
