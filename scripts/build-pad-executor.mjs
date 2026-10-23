#!/usr/bin/env node
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const zodLicense = readFileSync('node_modules/zod/LICENSE', 'utf8').replaceAll('*/', '* /');
await build({ entryPoints: ['src/remote/windows.ts'], outfile: '.build/pad-executor.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', footer: { js: `/* Bundled Zod license:\n${zodLicense}\n*/` } });
console.log('Built .build/pad-executor.mjs; copy to Windows with Node 22+ and an operator-owned flow map.');
