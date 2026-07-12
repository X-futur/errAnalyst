"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorParser = void 0;
/**
 * Python traceback parser.
 * Parses Python error output into structured data.
 */
class ErrorParser {
    /**
     * Parse a Python traceback string into structured data.
     */
    static parse(traceback, workspaceFolders) {
        const lines = traceback.split('\n');
        const stackFrames = [];
        let errorType = '';
        let errorMessage = '';
        let firstFrameIndex = -1;
        let errorLineIndex = -1;
        // Find the start of traceback
        const tracebackStart = lines.findIndex(l => l.trim().startsWith('Traceback'));
        if (tracebackStart === -1) {
            // Try matching standalone error patterns (no traceback)
            return this.parseStandaloneError(lines, workspaceFolders);
        }
        // Parse stack frames
        const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;
        for (let i = tracebackStart + 1; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(fileLinePattern);
            if (match) {
                const file = this.resolvePath(match[1], workspaceFolders);
                stackFrames.push({
                    file,
                    line: parseInt(match[2]),
                    function: match[3] || '<module>',
                    codeLine: ''
                });
                if (firstFrameIndex === -1)
                    firstFrameIndex = i;
            }
            else {
                // Check if this line is a code line (indented, no File/line prefix)
                const trimmed = line.trim();
                if (stackFrames.length > 0 && trimmed && !trimmed.startsWith('File "') && !trimmed.startsWith('Traceback')) {
                    const lastFrame = stackFrames[stackFrames.length - 1];
                    if (!lastFrame.codeLine) {
                        lastFrame.codeLine = trimmed;
                    }
                }
            }
            // Check for error type at end
            const errorMatch = line.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
            if (errorMatch) {
                errorType = errorMatch[1];
                errorMessage = errorMatch[2];
                errorLineIndex = i;
                break;
            }
        }
        if (!errorType && errorLineIndex === -1) {
            // Try last non-empty line as error
            for (let i = lines.length - 1; i >= 0; i--) {
                const trimmed = lines[i].trim();
                if (trimmed) {
                    const errorMatch = trimmed.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
                    if (errorMatch) {
                        errorType = errorMatch[1];
                        errorMessage = errorMatch[2];
                        errorLineIndex = i;
                    }
                    else {
                        errorType = 'Error';
                        errorMessage = trimmed;
                        errorLineIndex = i;
                    }
                    break;
                }
            }
        }
        if (!errorType && stackFrames.length === 0)
            return null;
        // Primary file/line: use the last stack frame (where error originated)
        const primaryFrame = stackFrames.length > 0 ? stackFrames[stackFrames.length - 1] : null;
        return {
            errorType,
            errorMessage,
            filePath: primaryFrame?.file || '',
            lineNumber: primaryFrame?.line || 0,
            stackFrames,
            fullTraceback: traceback,
            timestamp: Date.now()
        };
    }
    /**
     * Parse standalone error (no traceback).
     */
    static parseStandaloneError(lines, workspaceFolders) {
        let errorType = '';
        let errorMessage = '';
        let filePath = '';
        let lineNumber = 0;
        const stackFrames = [];
        // Try to find <file>:<line>: <error> pattern (common in linters/compilers)
        for (const line of lines) {
            const match = line.match(/^([^:]+):(\d+):\s*(.+)/);
            if (match) {
                filePath = this.resolvePath(match[1], workspaceFolders);
                lineNumber = parseInt(match[2]);
                const rest = match[3];
                const errorMatch = rest.match(/^([A-Za-z.]+(?:Error|Exception|Warning)):\s*(.*)/);
                if (errorMatch) {
                    errorType = errorMatch[1];
                    errorMessage = errorMatch[2];
                }
                else {
                    errorType = 'Error';
                    errorMessage = rest;
                }
                break;
            }
        }
        if (!errorType) {
            // Try parsing File "..." line N format (SyntaxError, no Traceback)
            const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)/;
            for (const line of lines) {
                const fileMatch = line.match(fileLinePattern);
                if (fileMatch) {
                    filePath = this.resolvePath(fileMatch[1], workspaceFolders);
                    lineNumber = parseInt(fileMatch[2]);
                }
                const errorMatch = line.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
                if (errorMatch) {
                    errorType = errorMatch[1];
                    errorMessage = errorMatch[2];
                }
            }
        }
        if (!errorType) {
            // Try last non-empty line
            for (let i = lines.length - 1; i >= 0; i--) {
                const trimmed = lines[i].trim();
                if (trimmed) {
                    const errorMatch = trimmed.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
                    if (errorMatch) {
                        errorType = errorMatch[1];
                        errorMessage = errorMatch[2];
                    }
                    else if (/(?:Error|Exception|Warning|Traceback|SyntaxError|at\s|Failed|failed|Error:|Exception:)/.test(trimmed)) {
                        errorType = 'Error';
                        errorMessage = trimmed;
                    }
                    break;
                }
            }
        }
        if (!errorType)
            return null;
        return {
            errorType,
            errorMessage,
            filePath,
            lineNumber,
            stackFrames,
            fullTraceback: lines.join('\n'),
            timestamp: Date.now()
        };
    }
    /**
     * Resolve file path against workspace folders.
     */
    static resolvePath(file, workspaceFolders) {
        if (file.startsWith('/'))
            return file;
        if (file.startsWith('~')) {
            const homedir = require('os').homedir();
            return file.replace('~', homedir);
        }
        // Try to find in any workspace folder
        for (const folder of workspaceFolders) {
            const potential = require('path').join(folder, file);
            if (require('fs').existsSync(potential))
                return potential;
        }
        return file;
    }
    /**
     * Normalize error for cache key matching.
     */
    static normalizeErrorKey(errorType, stackFrameTop) {
        const base = errorType.toLowerCase().replace(/[^a-z0-9]/g, '');
        return stackFrameTop ? `${base}:${stackFrameTop}` : base;
    }
    /**
     * Extract "Traceback..." block from terminal output buffer.
     */
    static extractErrorBlock(buffer) {
        // Try Traceback pattern first
        const tb = this.extractTraceback(buffer);
        if (tb)
            return tb;
        // Try SyntaxError/error without Traceback
        const fileErrorPattern = /(?:File\s+"[^"]+",\s+line\s+\d+[^\n]*\n(?:.*\n)*?[A-Za-z.]+(?:Error|Exception|Warning|StopIteration):)/;
        const match = buffer.match(fileErrorPattern);
        if (match)
            return match[0];
        return null;
    }
    static extractTraceback(buffer) {
        const tracebackStart = buffer.lastIndexOf('Traceback (most recent call last)');
        if (tracebackStart === -1)
            return null;
        // From traceback start to end of buffer (or next prompt)
        const afterTraceback = buffer.slice(tracebackStart);
        const lines = afterTraceback.split('\n');
        // Collect lines until we hit what looks like a new command prompt
        let endIdx = lines.length;
        for (let i = 1; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && (trimmed.startsWith('$') || trimmed.startsWith('%') || trimmed.startsWith('>>>'))) {
                endIdx = i;
                break;
            }
        }
        return lines.slice(0, endIdx).join('\n');
    }
}
exports.ErrorParser = ErrorParser;
//# sourceMappingURL=errorParser.js.map