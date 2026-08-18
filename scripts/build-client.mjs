/**
 * 把 tsc 产出的 lib/client.js（ESM）改写成 web 壳的 __ModuleLoader__ 包裹格式：
 * 工厂内以同步 require 取宿主的 react，注册 inject/apply 两个导出。
 * （格式对照 dsh-client-modules 的 bundle 契约，参考 MIT 实现 dsh-weixin 的打包脚本。）
 */

import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../lib/client.js', import.meta.url)
let source = await readFile(path, 'utf8')

const reactImport = "import { createElement, useEffect, useRef, useState } from 'react';"
if (!source.includes(reactImport)) throw new Error('client 入口的 React import 形态与预期不符')
source = source.replace(reactImport, 'const { createElement, useEffect, useRef, useState } = require("react");')
source = source.replace('export const inject =', 'const inject =')
source = source.replace('export function apply(', 'function apply(')
source = source.replace(/\n?\/\/# sourceMappingURL=client\.js\.map\s*$/, '')
if (/\b(?:import|export)\s/.test(source)) throw new Error('client 产物仍含 ESM 语法')

const bundle = `window.__ModuleLoader__.load({
  id: "dsh-wechat-gateway",
  factory: (require) => {
    const module = { exports: {} };
${source.split('\n').map(line => `    ${line}`).join('\n')}
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  }
});
`
if (!bundle.includes('const { createElement, useEffect, useRef, useState } = require("react");')) {
  throw new Error('client 包裹缺少 React 运行时引入')
}

await writeFile(path, bundle)
