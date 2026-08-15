import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './index');
    
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // 固定 VS Code 版本，避免每次解析最新稳定版；与本仓库 .vscode-test 缓存一致
      version: '1.132.0',
      launchArgs: ['--disable-extensions']
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
