import {ImportSpecifier, init as initESModuleLexer, parse} from 'es-module-lexer';
import fs from 'fs';
import glob from 'glob';
import * as colors from 'kleur/colors';
import mime from 'mime-types';
import nodePath from 'path';
import stripComments from 'strip-comments';
import validatePackageName from 'validate-npm-package-name';
import {InstallTarget, SnowpackConfig, SnowpackSourceFile} from './types/snowpack';
import {findMatchingAliasEntry, getExt, HTML_JS_REGEX, isTruthy} from './util';

const WEB_MODULES_TOKEN = 'web_modules/';
const WEB_MODULES_TOKEN_LENGTH = WEB_MODULES_TOKEN.length;

// [@\w] - Match a word-character or @ (valid package name)
// (?!.*(:\/\/)) - Ignore if previous match was a protocol (ex: http://)
const BARE_SPECIFIER_REGEX = /^[@\w](?!.*(:\/\/))/;

const ESM_IMPORT_REGEX = /import(?:["'\s]*([\w*${}\n\r\t, ]+)\s*from\s*)?\s*["'](.*?)["']/gm;
const ESM_DYNAMIC_IMPORT_REGEX = /import\((?:['"].+['"]|`[^$]+`)\)/gm;
const HAS_NAMED_IMPORTS_REGEX = /^[\w\s\,]*\{(.*)\}/s;
const STRIP_AS = /\s+as\s+.*/; // for `import { foo as bar }`, strips “as bar”
const DEFAULT_IMPORT_REGEX = /import\s+(\w)+(,\s\{[\w\s]*\})?\s+from/s;

function stripJsExtension(dep: string): string {
  return dep.replace(/\.m?js$/i, '');
}

function createInstallTarget(specifier: string, all = true): InstallTarget {
  return {
    specifier,
    all,
    default: false,
    namespace: false,
    named: [],
  };
}

function removeSpecifierQueryString(specifier: string) {
  const queryStringIndex = specifier.indexOf('?');
  if (queryStringIndex >= 0) {
    specifier = specifier.substring(0, queryStringIndex);
  }
  return specifier;
}

/**
 * Gets web module specifier from code
 * @param code code to parse
 * @param imp reference to the import, with the type described within `es-module-lexer`
 * @returns module specifiers, like `rxjs`
 */
function getWebModuleSpecifierFromCode(code: string, imp: ImportSpecifier):string | null {
  // import.meta: we can ignore
  if (imp.d === -2) {
    return null;
  }
  // Static imports: easy to parse
  if (imp.d === -1) {
    return code.substring(imp.s, imp.e);
  }
  // Dynamic imports: a bit trickier to parse. Today, we only support string literals.
  const importStatement = code.substring(imp.s, imp.e);
  const importSpecifierMatch = importStatement.match(/^\s*['"](.*)['"]\s*$/m);
  return importSpecifierMatch ? importSpecifierMatch[1] : null;
}

/**
 * parses an import specifier, looking for a web modules to install. If a web module is not detected,
 * null is returned.
 * mPrinC-TODO: Understand what exactly it returns
 * returns null for `./lib/dataset-entry.service`, `./select/select.js`
 * returns `@colabo-flow/i-dataset`, etc
 */
function parseWebModuleSpecifier(specifier: string | null): null | string {
  console.log("[parseWebModuleSpecifier] specifier: '%s'", specifier);
  if (!specifier) {
    return null;
  }
  // If specifier is a "bare module specifier" (ie: package name) just return it directly
  if (BARE_SPECIFIER_REGEX.test(specifier)) {
    console.log("[parseWebModuleSpecifier] \t -> BARE_SPECIFIER_REGEX, specifier: '%s'", specifier);
    return specifier;
  }
  // Clean the specifier, remove any query params that may mess with matching
  const cleanedSpecifier = removeSpecifierQueryString(specifier);
  // Otherwise, check that it includes the "web_modules/" directory
  const webModulesIndex = cleanedSpecifier.indexOf(WEB_MODULES_TOKEN);
  if (webModulesIndex === -1) {
    console.log("[parseWebModuleSpecifier] \t -> no WEB_MODULES_TOKEN in '%s'", cleanedSpecifier);
    return null;
  }

  // Check if this matches `@scope/package.js` or `package.js` format.
  // If it is, assume that this is a top-level package that should be installed without the “.js”
  const resolvedSpecifier = cleanedSpecifier.substring(webModulesIndex + WEB_MODULES_TOKEN_LENGTH);
  const resolvedSpecifierWithoutExtension = stripJsExtension(resolvedSpecifier);
  if (validatePackageName(resolvedSpecifierWithoutExtension).validForNewPackages) {
    console.log("[parseWebModuleSpecifier] \t -> resolvedSpecifierWithoutExtension: '%s'", specifier, resolvedSpecifierWithoutExtension);
    return resolvedSpecifierWithoutExtension;
  }
  // Otherwise, this is an explicit import to a file within a package.
  console.log("[parseWebModuleSpecifier] \t -> resolvedSpecifier: '%s'", specifier, resolvedSpecifier);
  return resolvedSpecifier;
}

/**
 * Parses import statement and returns the targets to be installed
 * @param code code to parse
 * @param imp reference to the import (the `ImportSpecifier` type described within `es-module-lexer`
 * @returns import statement 
 */
function parseImportStatement(code: string, imp: ImportSpecifier): null | InstallTarget {
  const webModuleSpecifier = parseWebModuleSpecifier(getWebModuleSpecifierFromCode(code, imp));
  console.log("[parseImportStatement] webModuleSpecifier: ", webModuleSpecifier);

  if (!webModuleSpecifier) {
    return null;
  }

  const importStatement = code.substring(imp.ss, imp.se);
  // skip @types
  if (/^import\s+type/.test(importStatement)) {
    return null;
  }

  const isDynamicImport = imp.d > -1;
  const hasDefaultImport = !isDynamicImport && DEFAULT_IMPORT_REGEX.test(importStatement);
  const hasNamespaceImport = !isDynamicImport && importStatement.includes('*');

  const namedImports = (importStatement.match(HAS_NAMED_IMPORTS_REGEX)! || [, ''])[1]
    .split(',') // split `import { a, b, c }` by comma
    .map((name) => name.replace(STRIP_AS, '').trim()) // remove “ as …” and trim
    .filter(isTruthy);

  let installTarget:InstallTarget = {
      specifier: webModuleSpecifier,
      all: isDynamicImport || (!hasDefaultImport && !hasNamespaceImport && namedImports.length === 0),
      default: hasDefaultImport,
      namespace: hasNamespaceImport,
      named: namedImports,
    }
    console.log("[parseImportStatement] installTarget: ", installTarget);
  return installTarget;
}

/** for non-standard JS files extracts only import-like code sections
 * increasing the chance that `es-module-lexer` will not crash
 */
function cleanCodeForParsing(code: string): string {
  code = stripComments(code);
  const allMatches: string[] = [];
  let match;
  const importRegex = new RegExp(ESM_IMPORT_REGEX);
  while ((match = importRegex.exec(code))) {
    allMatches.push(match);
  }
  const dynamicImportRegex = new RegExp(ESM_DYNAMIC_IMPORT_REGEX);
  while ((match = dynamicImportRegex.exec(code))) {
    allMatches.push(match);
  }
  return allMatches.map(([full]) => full).join('\n');
}

/**
 * Parses code for install targets
 * 
 * Extracts all import statements from the `contents` code and returns for each `InstallTarget`
 * containing dependency specifier and other import meta-data
 * @param {
 *   locOnDisk,
 *   baseExt,
 *   contents,
 * } 
 * @returns code for install targets 
 */
function parseCodeForInstallTargets({
  locOnDisk,
  baseExt,
  contents,
}: SnowpackSourceFile): InstallTarget[] {
  let imports: ImportSpecifier[];
  // Attempt #1: Parse the file as JavaScript. JSX and some decorator
  // syntax will break this.
  try {
    if (baseExt === '.jsx' || baseExt === '.tsx') {
      // We know ahead of time that this will almost certainly fail.
      // Just jump right to the secondary attempt.
      throw new Error('JSX must be cleaned before parsing');
    }
    // calls `es-module-lexer` and retrieves all imports found in the code
    [imports] = parse(contents) || [];
  } catch (err) {
    // Attempt #2: Parse only the import statements themselves.
    // This lets us guarantee we aren't sending any broken syntax to our parser,
    // but at the expense of possible false +/- caused by our regex extractor.
    try {
      contents = cleanCodeForParsing(contents);
      [imports] = parse(contents) || [];
    } catch (err) {
      // Another error! No hope left, just abort.
      console.error(colors.red(`! Error parsing for imports in the file: ${locOnDisk}`));
      throw err;
    }
  }
  const allImports: InstallTarget[] = imports
    .map((imp) => parseImportStatement(contents, imp))
    .filter(isTruthy)
    // Babel macros are not install targets!
    .filter((imp) => !/[./]macro(\.js)?$/.test(imp.specifier));
  return allImports;
}

export function scanDepList(depList: string[], cwd: string): InstallTarget[] {
  return depList
    .map((whitelistItem) => {
      if (!glob.hasMagic(whitelistItem)) {
        return [createInstallTarget(whitelistItem, true)];
      } else {
        const nodeModulesLoc = nodePath.join(cwd, 'node_modules');
        return scanDepList(glob.sync(whitelistItem, {cwd: nodeModulesLoc, nodir: true}), cwd);
      }
    })
    .reduce((flat, item) => flat.concat(item), []);
}

/** 
 * Scans for all dependencies to import
 * 
 * 1. starts with all available project application paths (provided in the snowpack config file as the `mount` dictionary), then
 * 2. gets all source code from the recognized files, like
 * + js, jsx, mjs, ts - file content
 * + html, vue, svetle - <script> sections
 * 3. parses file for the import constructs
 * 4. extract dependencies for each import construct
 * 5. returns all dependencies recognized
 * + it doesn't return internal imports, like: `./lib/dataset-entry.service`, `./select/select.js'`
 * + it does return package imports like`@colabo-flow/i-dataset`, etc)
 * @param cwd the project folder
 * @param config the config file
 * @returns all discovered dependencies that should be installed
 */
export async function scanImports(cwd: string, config: SnowpackConfig): Promise<InstallTarget[]> {
  await initESModuleLexer;
  // get all files to which mapping folders point to
  // excluding folders and files that are explicitly excluded from the `config.exclude` and `web_modules`
  const includeFileSets = await Promise.all(
    Object.keys(config.mount).map((fromDisk) => {
      const dirDisk = nodePath.resolve(cwd, fromDisk);
      return glob.sync(`**/*`, {
        /** mPrinC-TODO: better to provide global constant 
         * as `config.buildOptions.webModulesUrl` might change, as 
         * it is in the config, although not publically available and part of 
         * the config schema
         * */
        ignore: config.exclude.concat(['**/web_modules/**/*']),
        cwd: dirDisk,
        absolute: true,
        nodir: true,
      });
    }),
  );
  const includeFiles = Array.from(new Set(([] as string[]).concat.apply([], includeFileSets)));
  if (includeFiles.length === 0) {
    return [];
  }

  // Scan every matched JS file for web dependency imports
  const loadedFiles: (SnowpackSourceFile | null)[] = await Promise.all(
    includeFiles.map(async (filePath) => {
      const {baseExt, expandedExt} = getExt(filePath);
      // Always ignore dotfiles
      if (filePath.startsWith('.')) {
        return null;
      }

      switch (baseExt) {
        // Probably a license, a README, etc
        case '': {
          return null;
        }
        // Our import scanner can handle normal JS & even TypeScript without a problem.
        case '.js':
        case '.jsx':
        case '.mjs':
        case '.ts':
        case '.tsx': {
          return {
            baseExt,
            expandedExt,
            locOnDisk: filePath,
            contents: await fs.promises.readFile(filePath, 'utf-8'),
          };
        }
        // in the case of html files, extract all the <script> code from them
        case '.html':
        case '.vue':
        case '.svelte': {
          const result = await fs.promises.readFile(filePath, 'utf-8');
          // TODO: Replace with matchAll once Node v10 is out of TLS.
          // const allMatches = [...result.matchAll(new RegExp(HTML_JS_REGEX))];
          const allMatches: string[][] = [];
          let match;
          const regex = new RegExp(HTML_JS_REGEX);
          while ((match = regex.exec(result))) {
            allMatches.push(match);
          }
          return {
            baseExt,
            expandedExt,
            locOnDisk: filePath,
            // match[2] is the code inside the <script></script> element
            contents: allMatches
              .map((match) => match[2])
              .filter((s) => s.trim())
              .join('\n'),
          };
        }
      }

      // If we don't recognize the file type, it could be source. Warn just in case.
      if (!mime.lookup(baseExt)) {
        console.warn(
          colors.dim(`ignoring unsupported file "${nodePath.relative(process.cwd(), filePath)}"`),
        );
      }
      return null;
    }),
  );
  return scanImportsFromFiles(loadedFiles.filter(isTruthy), config);
}

/**
 * Scans imports from files
 * @param loadedFiles list of loaded files which contents we should scan for imports
 * @param config snowpack config
 * @returns dependencies to install sorted for `specifier`
 * it returns package imports like `@colabo-flow/i-dataset`, etc
 * but it doesn't return internal imports, like: `./lib/dataset-entry.service`, `./select/select.js'`
 */
export async function scanImportsFromFiles(
  loadedFiles: SnowpackSourceFile[],
  config: SnowpackConfig,
): Promise<InstallTarget[]> {
  return loadedFiles
    .map(parseCodeForInstallTargets)
    .reduce((flat, item) => flat.concat(item), [])
    .filter((target) => {
      const aliasEntry = findMatchingAliasEntry(config, target.specifier);
      return !aliasEntry || aliasEntry.type === 'package';
    })
    .sort((impA, impB) => impA.specifier.localeCompare(impB.specifier));
}
