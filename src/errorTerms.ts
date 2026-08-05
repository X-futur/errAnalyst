/**
 * Authoritative Chinese translations for common error types.
 * Keys are exception names without module prefixes.
 */
export const ERROR_TERM_TRANSLATIONS: Record<string, string> = {
  AssertionError: '断言错误',
  AttributeError: '属性错误',
  EOFError: '输入结束错误',
  FileNotFoundError: '文件未找到错误',
  ImportError: '导入错误',
  IndentationError: '缩进错误',
  IndexError: '索引错误',
  KeyError: '键错误',
  KeyboardInterrupt: '键盘中断',
  MemoryError: '内存错误',
  ModuleNotFoundError: '未找到模块错误',
  NameError: '名称错误',
  NotImplementedError: '未实现错误',
  OSError: '操作系统错误',
  OverflowError: '溢出错误',
  PermissionError: '权限错误',
  RecursionError: '递归深度错误',
  RuntimeError: '运行时错误',
  StopIteration: '迭代停止错误',
  SyntaxError: '语法错误',
  SystemExit: '系统退出',
  TabError: '制表符错误',
  TimeoutError: '超时错误',
  TypeError: '类型错误',
  UnicodeDecodeError: 'Unicode 解码错误',
  UnicodeEncodeError: 'Unicode 编码错误',
  UnicodeError: 'Unicode 错误',
  ValueError: '值错误',
  ZeroDivisionError: '除零错误',
  ConnectionError: '连接错误',
  ResponseError: '响应错误',
  OptionalError: '可选值错误',
};

/**
 * Resolve the canonical Chinese translation for a core error term.
 * Returns null when the term has no valid translation.
 */
export function resolveCoreTerm(en: string, llmCn?: string): string | null {
  const term = en.trim();
  if (!term) return null;

  const dictCn = ERROR_TERM_TRANSLATIONS[term];
  if (dictCn) return dictCn;

  const cn = llmCn ? llmCn.trim() : '';
  if (!cn || cn.toLowerCase() === term.toLowerCase()) return null;
  return cn;
}
