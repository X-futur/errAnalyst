 import * as fs from 'fs';
 import * as path from 'path';
 import type { ParsedTraceback, ErrorCategory } from '../parser';
 
 // ── Parsed rule structure ──
 
 interface CategoryRule {
   category: ErrorCategory;
   patterns: RegExp[];
 }
 
 // ── CategoryClassifier ──
 
 export class CategoryClassifier {
   private rules: CategoryRule[] = [];
   private fallback: 'ai' = 'ai';
   private loaded = false;
 
   /**
    * Load rules from a YAML file path.
    * If not called, `classify()` returns UNKNOWN (safe default).
    */
   loadFromYaml(yamlPath: string): void {
     try {
       const raw = fs.readFileSync(yamlPath, 'utf-8');
       this.parseYamlContent(raw);
       this.loaded = true;
     } catch (e) {
       console.error('ErrAnalyst: Failed to load category rules from', yamlPath, e);
       this.rules = [];
       this.fallback = 'ai';
       this.loaded = false;
     }
   }
 
   /**
    * Classify a parsed traceback into an error category.
    * Rules are matched first; if none match, returns UNKNOWN
    * (the caller may request AI fallback separately).
    */
   classify(traceback: ParsedTraceback): ErrorCategory {
     // Try each rule's patterns against the error type
     for (const rule of this.rules) {
       for (const pattern of rule.patterns) {
         if (pattern.test(traceback.errorType)) {
           return rule.category;
         }
       }
     }
     return 'UNKNOWN';
   }
 
   /**
   * Check if AI fallback is configured (for caller to decide prompt).
    */
   get hasAiFallback(): boolean {
     return this.fallback === 'ai';
   }
 
   // ── Simple YAML parser (no dependency) ──
   //
   // Handles only the subset of YAML we need:
   //   category_name:
   //     - pattern: "regex"
   //     - pattern: "regex"
   //   fallback: ai
 
   private parseYamlContent(raw: string): void {
     const lines = raw.split('\n');
     const rules: CategoryRule[] = [];
     let fallback: 'ai' = 'ai';
     let currentCategory: ErrorCategory | null = null;
 
     // Pattern: matches "some_key:" or "  - pattern: "regex""
     const keyLinePat = /^([a-z_]+):/;
     const patternItemPat = /^\s*-\s+pattern:\s+"((?:\\.|[^"\\])*)"/;
     const fallbackPat = /^fallback:\s*(\w+)/;
 
     for (const line of lines) {
       const trimmed = line.trim();
       if (!trimmed || trimmed.startsWith('#')) continue;
 
       // Check for fallback line
       const fbMatch = trimmed.match(fallbackPat);
       if (fbMatch) {
         fallback = fbMatch[1] as 'ai';
         continue;
       }
 
       // Check for category key line
       const keyMatch = trimmed.match(keyLinePat);
       if (keyMatch) {
         const key = keyMatch[1];
         if (key !== 'fallback' && this.isErrorCategory(key)) {
           currentCategory = key;
         }
         continue;
       }
 
       // Check for pattern item
       const patMatch = trimmed.match(patternItemPat);
       if (patMatch && currentCategory) {
         const rawPattern = patMatch[1];
         try {
           const regex = new RegExp(rawPattern);
           // Find existing rule for this category or create one
           let rule = rules.find(r => r.category === currentCategory);
           if (!rule) {
             rule = { category: currentCategory, patterns: [] };
             rules.push(rule);
           }
           rule.patterns.push(regex);
         } catch (e) {
           console.error(`ErrAnalyst: Invalid regex in category rule: ${rawPattern}`, e);
         }
       }
     }
 
     this.rules = rules;
     this.fallback = fallback;
   }
 
   private isErrorCategory(key: string): key is ErrorCategory {
     const valid: ErrorCategory[] = [
       'COMPILATION_ERROR', 'DEPENDENCY_ERROR',
       'SYSTEM_ERROR', 'RUNTIME_ERROR', 'UNKNOWN',
     ];
     return valid.includes(key as ErrorCategory);
   }
 }
