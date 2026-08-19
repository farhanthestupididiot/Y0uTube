#!/usr/bin/env node
/**
 * Diagnostics helper: scans a TS file for unclosed template literals,
 * string literals, or block comments (the classic cause of cascading
 * "',' expected" parser errors). Usage: node scripts/scan-templates.js <file>
 */

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/scan-templates.js <file.ts>');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

const INSIDE_TEMPLATE = 'tpl';
const tokens = [];
let i = 0;
let line = 1;
let state = 'code';
let tplStack = [];

while (i < src.length) {
  const c = src[i];
  if (c === '\n') line++;

  if (state === 'code') {
    if (c === '/' && src[i + 1] === '/') {
      state = 'lineComment';
      i += 2;
    } else if (c === '/' && src[i + 1] === '*') {
      state = 'blockComment';
      i += 2;
    } else if (c === "'" || c === '"') {
      const closer = src.indexOf(c, i + 1);
      if (closer < 0) {
        console.log(`UNTERMINATED ${c} STRING at line ${line}`);
        process.exit(1);
      }
      i = closer + 1;
    } else if (c === '`') {
      state = INSIDE_TEMPLATE;
      tplStack = [{ startLine: line }];
      i++;
    } else {
      i++;
    }
  } else if (state === 'lineComment') {
    if (c === '\n') state = 'code';
    i++;
  } else if (state === 'blockComment') {
    if (c === '*' && src[i + 1] === '/') {
      state = 'code';
      i += 2;
    } else {
      i++;
    }
  } else if (state === INSIDE_TEMPLATE) {
    if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      state = 'code';
      tplStack.pop();
      i++;
    } else if (c === '$' && src[i + 1] === '{') {
      // `${` opens an expression; the template resumes at its matching `}`.
      // For a lightweight balance check, treat the whole interpolation as
      // template text and just track braces here.
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        if (src[j] === '}') depth--;
        j++;
      }
      i = j;
    } else {
      i++;
    }
  }
}

if (state === INSIDE_TEMPLATE) {
  console.log(`UNTERMINATED TEMPLATE starting at line ${tplStack[0]?.startLine ?? '?'}`);
  process.exit(1);
}
if (state === 'blockComment') {
  console.log('UNTERMINATED BLOCK COMMENT');
  process.exit(1);
}
console.log('lexically balanced: all strings, templates and comments closed');