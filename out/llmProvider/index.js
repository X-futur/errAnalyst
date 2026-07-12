"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAiResponse = exports.buildAnalysisPrompts = exports.OpenAICompatibleProvider = exports.CommandAction = exports.FileEdit = exports.FixActionType = exports.FixAction = void 0;
exports.createProvider = createProvider;
var types_1 = require("./types");
Object.defineProperty(exports, "FixAction", { enumerable: true, get: function () { return types_1.FixAction; } });
Object.defineProperty(exports, "FixActionType", { enumerable: true, get: function () { return types_1.FixActionType; } });
Object.defineProperty(exports, "FileEdit", { enumerable: true, get: function () { return types_1.FileEdit; } });
Object.defineProperty(exports, "CommandAction", { enumerable: true, get: function () { return types_1.CommandAction; } });
var openaiCompatible_1 = require("./openaiCompatible");
Object.defineProperty(exports, "OpenAICompatibleProvider", { enumerable: true, get: function () { return openaiCompatible_1.OpenAICompatibleProvider; } });
Object.defineProperty(exports, "buildAnalysisPrompts", { enumerable: true, get: function () { return openaiCompatible_1.buildAnalysisPrompts; } });
Object.defineProperty(exports, "parseAiResponse", { enumerable: true, get: function () { return openaiCompatible_1.parseAiResponse; } });
const openaiCompatible_2 = require("./openaiCompatible");
/**
 * Create the appropriate LLM provider for a given config.
 * Currently all providers use OpenAI-compatible API format.
 */
function createProvider(config) {
    if (!config.apiKey)
        return null;
    return new openaiCompatible_2.OpenAICompatibleProvider(config);
}
//# sourceMappingURL=index.js.map