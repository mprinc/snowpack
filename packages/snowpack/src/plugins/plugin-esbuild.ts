import {Service, startService} from 'esbuild';
import * as colors from 'kleur/colors';
import path from 'path';
import {promises as fs} from 'fs';
import {SnowpackPlugin, SnowpackConfig} from '../types/snowpack';

let esbuildService: Service | null = null;

const IS_PREACT = /from\s+['"]preact['"]/;
function checkIsPreact(filePath: string, contents: string) {
  return filePath.endsWith('.jsx') && IS_PREACT.test(contents);
}

function getLoader(filePath: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  const ext = path.extname(filePath);
  if (ext === '.mjs') {
    return 'js';
  }
  return ext.substr(1) as 'jsx' | 'ts' | 'tsx';
}

export function esbuildPlugin(_: SnowpackConfig, {input}: {input: string[]}): SnowpackPlugin {
  return {
    name: '@snowpack/plugin-esbuild',
    resolve: {
      input,
      output: ['.js'],
    },
    async load({filePath}) {
      esbuildService = esbuildService || (await startService());
      // console.log("[@snowpack/plugin-esbuild::load] fileExt: %s, filePath: %s", fileExt, filePath);
      let contents = await fs.readFile(filePath, 'utf-8');

      // console.log("[@snowpack/plugin-esbuild::load] initial contents: ", contents);

      // fix with the esbuild "bug": 
      // [TypeScript parsing bug - cascading issue with exporting of nihilated TS interface #314](https://github.com/evanw/esbuild/issues/314)
      // const searchColaboPuzzleRegExp = /export interface ([^\s\{]+)/g;
      // const replaceWithColaboPrefix = 'export class $1{}; export interface _$1';
      // contents = contents.replace(searchColaboPuzzleRegExp, replaceWithColaboPrefix);
      // console.log("[@snowpack/plugin-esbuild::load] patched: contents: %s", contents);

      const isPreact = checkIsPreact(filePath, contents);
      const {js, warnings} = await esbuildService!.transform(contents, {
        loader: getLoader(filePath),
        jsxFactory: isPreact ? 'h' : undefined,
        jsxFragment: isPreact ? 'Fragment' : undefined,
      });
      for (const warning of warnings) {
        console.error(colors.bold('! ') + filePath);
        console.error('  ' + warning.text);
      }
      // console.log("[@snowpack/plugin-esbuild::load] transformed contents ['JS']: ", contents);
      return {'.js': js || ''};
    },
  };
}

export function stopEsbuild() {
  esbuildService && esbuildService.stop();
}
