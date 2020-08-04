import rollupPluginAlias from '@rollup/plugin-alias';
import rollupPluginCommonjs, {RollupCommonJSOptions} from '@rollup/plugin-commonjs';
import rollupPluginJson from '@rollup/plugin-json';
import rollupPluginNodeResolve from '@rollup/plugin-node-resolve';
import rollupPluginReplace from '@rollup/plugin-replace';
import {init as initESModuleLexer} from 'es-module-lexer';
import findUp from 'find-up';
import fs from 'fs';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import ora from 'ora';
import path from 'path';
import {performance} from 'perf_hooks';
import rimraf from 'rimraf';
import {InputOptions, OutputOptions, rollup, RollupError} from 'rollup';
import validatePackageName from 'validate-npm-package-name';
import {resolveTargetsFromRemoteCDN} from '../resolve-remote.js';
import {rollupPluginCatchUnresolved} from '../rollup-plugins/rollup-plugin-catch-unresolved.js';
import {rollupPluginCatchFetch} from '../rollup-plugins/rollup-plugin-catch-fetch';
import {rollupPluginCss} from '../rollup-plugins/rollup-plugin-css';
import {rollupPluginDependencyCache} from '../rollup-plugins/rollup-plugin-remote-cdn.js';
import {rollupPluginDependencyStats} from '../rollup-plugins/rollup-plugin-stats.js';
import {rollupPluginWrapInstallTargets} from '../rollup-plugins/rollup-plugin-wrap-install-targets';
import {scanDepList, scanImports, scanImportsFromFiles} from '../scan-imports.js';
import {printStats} from '../stats-formatter.js';
import {
  CommandOptions,
  DependencyStatsOutput,
  EnvVarReplacements,
  ImportMap,
  InstallTarget,
  SnowpackConfig,
  SnowpackSourceFile,
} from '../types/snowpack';
import {
  isTruthy,
  MISSING_PLUGIN_SUGGESTIONS,
  parsePackageImportSpecifier,
  resolveDependencyManifest,
  sanitizePackageName,
  writeLockfile,
  isPackageAliasEntry,
  findMatchingAliasEntry,
  IMPORT_MAP_FILE,
  LOCK_FILE,
} from '../util.js';

type InstallResultCode = 'SUCCESS' | 'ASSET' | 'FAIL';

interface DependencyLoc {
  type: 'JS' | 'ASSET' | 'IGNORE';
  loc: string;
}

class ErrorWithHint extends Error {
  constructor(message: string, public readonly hint: string) {
    super(message);
  }
}

// Add popular CJS packages here that use "synthetic" named imports in their documentation.
// CJS packages should really only be imported via the default export:
//   import React from 'react';
// But, some large projects use named exports in their documentation:
//   import {useState} from 'react';
//
// We use "/index.js here to match the official package, but not any ESM aliase packages
// that the user may have installed instead (ex: react-esm).
const CJS_PACKAGES_TO_AUTO_DETECT = [
  'react/index.js',
  'react-dom/index.js',
  'react-dom/server.js',
  'react-is/index.js',
  'prop-types/index.js',
  'scheduler/index.js',
  'react-table',
];

const cwd = process.cwd();
const banner = colors.bold(`snowpack`) + ` installing... `;
let spinner;
let spinnerHasError = false;
/** the list of results (2nd element) for each `targetName`/`installSpecifier` (1st element) */
let installResults: [string, InstallResultCode][] = [];
let dependencyStats: DependencyStatsOutput | null = null;

function defaultLogError(msg: string) {
  if (spinner && !spinnerHasError) {
    spinner.stopAndPersist({symbol: colors.cyan('⠼')});
  }
  spinnerHasError = true;
  spinner = ora(colors.red(msg));
  spinner.fail();
}

function defaultLogUpdate(msg: string) {
  spinner.text = banner + msg;
}

function formatInstallResults(): string {
  return installResults
    .map(([d, result]) => {
      if (result === 'SUCCESS') {
        return colors.green(d);
      }
      if (result === 'ASSET') {
        return colors.yellow(d);
      }
      if (result === 'FAIL') {
        return colors.red(d);
      }
      return d;
    })
    .join(', ');
}

/** checks if the `importUrl` is under the `packageName` */
function isImportOfPackage(importUrl: string, packageName: string) {
  return packageName === importUrl || importUrl.startsWith(packageName + '/');
}

/**
 * Formats the snowpack dependency name from a "webDependencies" input value:
 * 2. Remove any ".js"/".mjs" extension (will be added automatically by Rollup)
 */
function getWebDependencyName(dep: string): string {
  return validatePackageName(dep).validForNewPackages
    ? dep.replace(/\.js$/i, 'js') // if this is a top-level package ending in .js, replace with js (e.g. tippy.js -> tippyjs)
    : dep.replace(/\.m?js$/i, ''); // otherwise simply strip the extension (Rollup will resolve it)
}

/**
 * Takes object of env var mappings and converts it to actual
 * replacement specs as expected by @rollup/plugin-replace. The
 * `optimize` arg is used to derive NODE_ENV default.
 *
 * @param env
 * @param optimize
 */
function getRollupReplaceKeys(env: EnvVarReplacements): Record<string, string> {
  const result = Object.keys(env).reduce(
    (acc, id) => {
      const val = env[id];
      acc[`process.env.${id}`] = `${JSON.stringify(val === true ? process.env[id] : val)}`;
      return acc;
    },
    {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      'process.versions.node': 'undefined',
      'process.platform': JSON.stringify('browser'),
      'process.env.': '({}).',
      'typeof process.versions.node': JSON.stringify('undefined'),
      'typeof process.versions': JSON.stringify('undefined'),
      'typeof process': JSON.stringify('undefined'),
    },
  );
  return result;
}

/**
 * Resolve a "webDependencies" input value to the correct absolute file location.
 * Supports both npm package names, and file paths relative to the node_modules directory.
 * Follows logic similar to Node's resolution logic, but using a package.json's ESM "module"
 * field instead of the CJS "main" field.
 */
function resolveWebDependency(dep: string): DependencyLoc {
  // console.log("[resolveWebDependency] dep: ", dep);
  // if dep points directly to a file within a package, return that reference.
  // No other lookup required.
  // console.log("[resolveWebDependency] dep: ", dep);
  // CASE 1)
  if (path.extname(dep) && !validatePackageName(dep).validForNewPackages) {
    const isJSFile = ['.js', '.mjs', '.cjs'].includes(path.extname(dep));
    const loc = require.resolve(dep, {paths: [cwd]});
    // console.log("[resolveWebDependency] CASE 1) loc: ", loc);
    return {
      type: isJSFile ? 'JS' : 'ASSET',
      loc: loc,
    };
  }
  // If dep is a path within a package (but without an extension), we first need
  // to check for an export map in the package.json. If one exists, resolve to it.
  const [packageName, packageEntrypoint] = parsePackageImportSpecifier(dep);
  if (packageEntrypoint) {
    const [packageManifestLoc, packageManifest] = resolveDependencyManifest(packageName, cwd);
    // console.log("[resolveWebDependency] packageManifestLoc: ", packageManifestLoc);
    // CASE 2) package manifest has `exports`
    if (packageManifestLoc && packageManifest && packageManifest.exports) {
      const exportMapEntry = packageManifest.exports['./' + packageEntrypoint];
      const exportMapValue =
        exportMapEntry?.browser ||
        exportMapEntry?.import ||
        exportMapEntry?.default ||
        exportMapEntry?.require ||
        exportMapEntry;
      if (typeof exportMapValue !== 'string') {
        throw new Error(
          `Package "${packageName}" exists but package.json "exports" does not include entry for "./${packageEntrypoint}".`,
        );
      }
      let loc = path.join(packageManifestLoc, '..', exportMapValue);
      // console.log("[resolveWebDependency] CASE 2) loc: ", loc);
      return {
        type: 'JS',
        loc: loc,
      };
    }
  }

  // Otherwise, resolve directly to the dep specifier. Note that this supports both
  // "package-name" & "package-name/some/path" where "package-name/some/path/package.json"
  // exists at that lower path, that must be used to resolve. In that case, export
  // maps should not be supported.
  // CASE 3) there is `package.json` UNDER the `dep` path
  const [depManifestLoc, depManifest] = resolveDependencyManifest(dep, cwd);
  if (!depManifest) {
    // CASE 4) try to load file directly
    try {
      const maybeLoc = require.resolve(dep, {paths: [cwd]});
      // console.log("[resolveWebDependency] CASE 4) loc: ", maybeLoc);
      return {
        type: 'JS',
        loc: maybeLoc,
      };
    } catch (err) {
      // Oh well, was worth a try
      // console.log("[resolveWebDependency] CASE 4) Oh well, was worth a try: ", dep);
    }
  }
  if (!depManifestLoc || !depManifest) {
    throw new ErrorWithHint(
      `Package "${dep}" not found. Have you installed it?`,
      depManifestLoc ? colors.italic(depManifestLoc) : '',
    );
  }
  // CASE 5) React workaround packages
  if (
    depManifest.name &&
    (depManifest.name.startsWith('@reactesm') || depManifest.name.startsWith('@pika/react'))
  ) {
    // console.log("[resolveWebDependency] CASE 5) React workaround packages depManifest.name: ", depManifest.name);
    throw new Error(
      `React workaround packages no longer needed! Revert back to the official React & React-DOM packages.`,
    );
  }
  // CASE 3) there is `package.json` UNDER the `dep` path
  // TODO: shouldn't `browser` precede `module`, that is how webpack works, and expected for web-focused "bundler"
  let foundEntrypoint: string =
    depManifest['browser:module'] ||
    depManifest.module ||
    depManifest['main:esnext'] ||
    depManifest.browser;
  // Some packages define "browser" as an object. We'll do our best to find the
  // right entrypoint in an entrypoint object, or fail otherwise.
  // See: https://github.com/defunctzombie/package-browser-field-spec
  if (typeof foundEntrypoint === 'object') {
    foundEntrypoint =
      foundEntrypoint[dep] ||
      foundEntrypoint['./index.js'] ||
      foundEntrypoint['./index'] ||
      foundEntrypoint['./'] ||
      foundEntrypoint['.'];
  }
  // If browser object is not set or no relevant entrypoint is found, fall back to "main".
  if (!foundEntrypoint) {
    foundEntrypoint = depManifest.main;
  }
  // Sometimes packages don't give an entrypoint, assuming you'll fall back to "index.js".
  const isImplicitEntrypoint = !foundEntrypoint;
  if (isImplicitEntrypoint) {
    foundEntrypoint = 'index.js';
  }
  if (typeof foundEntrypoint !== 'string') {
    throw new Error(`"${dep}" has unexpected entrypoint: ${JSON.stringify(foundEntrypoint)}.`);
  }
  try {
    const loc = require.resolve(path.join(depManifestLoc || '', '..', foundEntrypoint));
    // console.log("[resolveWebDependency] CASE 3) loc: ", loc);
    return {
      type: 'JS',
      loc: loc,
    };
  } catch (err) {
    // Type only packages! Some packages are purely for TypeScript (ex: csstypes).
    // If no JS entrypoint was given or found, but a TS "types"/"typings" entrypoint
    // was given, assume a TS-types only package and ignore.
    if (isImplicitEntrypoint && (depManifest.types || depManifest.typings)) {
      return {type: 'IGNORE', loc: ''};
    }
    // Otherwise, file truly doesn't exist.
    throw err;
  }
}

interface InstallOptions {
  lockfile: ImportMap | null;
  logError: (msg: string) => void;
  logUpdate: (msg: string) => void;
}

type InstallResult = {success: false; importMap: null} | {success: true; importMap: ImportMap};

const FAILED_INSTALL_RETURN: InstallResult = {
  success: false,
  importMap: null,
};

/** Installs all package dependencies
 * @param installTargets dependencies that should be installed
 */
export async function install(
  installTargets: InstallTarget[],
  {lockfile, logError, logUpdate}: InstallOptions,
  config: SnowpackConfig,
): Promise<InstallResult> {
  // console.log("[install] installTargets:  );", installTargets);
  // console.log("[install] lockfile:  );", lockfile);
  // console.log("[install] config:  );", config);
  const {
    webDependencies,
    alias: installAlias,
    installOptions: {
      /** TypeScript types */
      installTypes,
      dest: destLoc,
      /** mPrinC-TODO: undocumented in
       * https://www.snowpack.dev/#configuration
       * https://www.snowpack.dev/#config-files
      */
      externalPackage: externalPackages,
      sourceMap,
      env,
      rollup: userDefinedRollup,
      treeshake: isTreeshake,
    },
  } = config;

  const nodeModulesInstalled = findUp.sync('node_modules', {cwd, type: 'directory'});
  // process.versions.pnp: https://yarnpkg.com/advanced/pnpapi#processversionspnp
  if (!webDependencies && !(process.versions as any).pnp && !nodeModulesInstalled) {
    logError('no "node_modules" directory exists. Did you run "npm install" first?');
    return FAILED_INSTALL_RETURN;
  }
  const allInstallSpecifiers = new Set(
    installTargets
      // remove the dependencies that are under the `externalPackages` packages and
      .filter(
        (dep) =>
          !externalPackages.some((packageName) => isImportOfPackage(dep.specifier, packageName)),
      )
      .map((dep) => dep.specifier)
      // resolves aliases
      .map((specifier) => {
        const aliasEntry = findMatchingAliasEntry(config, specifier);
        return (aliasEntry && aliasEntry.type === 'package') ? aliasEntry.to : specifier;
      })
      .sort(),
  );
  // console.log("[install:install] allInstallSpecifiers: ", allInstallSpecifiers);

  /** the list of entry points resolved (from the installTargets->allInstallSpecifiers) we should install 
   * will be fed to rollup for installing
  */
  const installEntrypoints: {[targetName: string]: string} = {};
  /** the list of resolved assets, it will be just carbon-copied after the rollup section */
  const assetEntrypoints: {[targetName: string]: string} = {};
  /** the list of mappings for the dependencies provided
   * will be saved to the snowpack lock file
   */
  const importMap: ImportMap = {imports: {}};
  /** reversed mappings from targetLoc location of the location into the list of install targets that have the same specifier
   * mPrinC-TODO: a bit strange and not used at the moment?!
    */
  const installTargetsMap: {[targetLoc: string]: InstallTarget[]} = {};
  const skipFailures = false;
  const autoDetectNamedExports = [
    ...CJS_PACKAGES_TO_AUTO_DETECT,
    ...config.installOptions.namedExports,
  ];

  for (const installSpecifier of allInstallSpecifiers) {
    const targetName = getWebDependencyName(installSpecifier);
    const proxiedName = sanitizePackageName(targetName); // sometimes we need to sanitize webModule names, as in the case of tippy.js -> tippyjs
    // all good if already imported
    if (lockfile && lockfile.imports[installSpecifier]) {
      installEntrypoints[targetName] = lockfile.imports[installSpecifier];
      importMap.imports[installSpecifier] = `./${proxiedName}.js`;
      installResults.push([targetName, 'SUCCESS']);
      logUpdate(formatInstallResults());
      continue;
    }
    try {
      const {type: targetType, loc: targetLoc} = resolveWebDependency(installSpecifier);
      if (targetType === 'JS') {
        installEntrypoints[targetName] = targetLoc;
        importMap.imports[installSpecifier] = `./${proxiedName}.js`;
        // console.log("[install:targetType === 'JS'] targetLoc: '%s', targetName: '%s', importMap.imports[installSpecifier]: '%s'", 
          // targetLoc, targetName, importMap.imports[installSpecifier]);
        // expand to all aliases if applies
        Object.entries(installAlias)
          .filter(([, value]) => value === installSpecifier)
          .forEach(([key]) => {
            importMap.imports[key] = `./${targetName}.js`;
          });
        installTargetsMap[targetLoc] = installTargets.filter(
          (t) => installSpecifier === t.specifier,
        );
        installResults.push([installSpecifier, 'SUCCESS']);
      } else if (targetType === 'ASSET') {
        assetEntrypoints[targetName] = targetLoc;
        importMap.imports[installSpecifier] = `./${proxiedName}`;
        installResults.push([installSpecifier, 'ASSET']);
      }
      logUpdate(formatInstallResults());
    } catch (err) {
      console.error("[install:install:resolveWebDependency] err: ", err);
      installResults.push([installSpecifier, 'FAIL']);
      logUpdate(formatInstallResults());
      if (skipFailures) {
        continue;
      }
      // An error occurred! Log it.
      logError(err.message || err);
      if (err.hint) {
        // Note: Wait 1ms to guarantee a log message after the spinner
        setTimeout(() => console.log(err.hint), 1);
      }
      return FAILED_INSTALL_RETURN;
    }
  }
  // nothing to install?! :(
  if (Object.keys(installEntrypoints).length === 0 && Object.keys(assetEntrypoints).length === 0) {
    // mPrinC-TODO: this eliminates this silly scenario when no dependencise but those matching `config.installOptions.externalPackage` parameter
    return {success: true, importMap};
    // logError(`Neither ESM dependencies nor ASSETS found!`);
    // console.log(
    //   colors.dim(
    //     `  At least one dependency must have an ESM "module" entrypoint. You can find modern, web-ready packages at ${colors.underline(
    //       'https://www.pika.dev',
    //     )}`,
    //   ),
    // );
    // return FAILED_INSTALL_RETURN;
  }

  await initESModuleLexer;
  let isCircularImportFound = false;
  // rollup input options
  // https://rollupjs.org/guide/en/#inputoptions-object
  // https://rollupjs.org/guide/en/#big-list-of-options
  const inputOptions: InputOptions = {
    /** The bundle's entry point(s) 
     * https://rollupjs.org/guide/en/#input
    */
    input: installEntrypoints,
    /** lookup method for external modules
     * https://rollupjs.org/guide/en/#external
     */
    external: (id) => externalPackages.some((packageName) => isImportOfPackage(id, packageName)),
    /** 
     * treat external modules as if they have side-effects
     * https://rollupjs.org/guide/en/#treeshake */
    treeshake: {moduleSideEffects: 'no-external'},
    // mPrinC-TODO: should we provide `preservesymlinks` for the list of packages
    // https://rollupjs.org/guide/en/#preservesymlinks
    plugins: [
      rollupPluginReplace(getRollupReplaceKeys(env)),
      !!webDependencies &&
        rollupPluginDependencyCache({
          installTypes,
          log: (url) => logUpdate(colors.dim(url)),
        }),
        // handle aliases
      rollupPluginAlias({
        entries: Object.entries(installAlias)
          .filter(([, val]) => isPackageAliasEntry(val))
          .map(([key, val]) => ({
            find: key,
            replacement: val,
          })),
      }),
      rollupPluginCatchFetch(),
      rollupPluginNodeResolve({
        // https://www.npmjs.com/package/@rollup/plugin-node-resolve
        // mPrinC- TODO: Again `module` is preferred over `browser`
        mainFields: ['browser:module', 'module', 'browser', 'main'].filter(isTruthy),
        extensions: ['.mjs', '.cjs', '.js', '.json'], // Default: [ '.mjs', '.js', '.json', '.node' ]
        // whether to prefer built-in modules (e.g. `fs`, `path`) or local ones with the same names
        preferBuiltins: true, // Default: true
        dedupe: userDefinedRollup.dedupe,
      }),
      rollupPluginJson({
        // https://www.npmjs.com/package/@rollup/plugin-json
        preferConst: true,
        // mPrinC-TODO: why not `\t` as smaller and easier to read and search for
        indent: '  ',
        compact: false,
        namedExports: true,
      }),
      rollupPluginCss(),
      rollupPluginCommonjs({
        // https://www.npmjs.com/package/@rollup/plugin-commonjs
        extensions: ['.js', '.cjs'],
        // Workaround: CJS -> ESM isn't supported yet by the plugin, so we needed
        // to add our own custom workaround here. Requires a fork of
        // rollupPluginCommonjs that supports the "externalEsm" option.
        externalEsm: process.env.EXTERNAL_ESM_PACKAGES || [],
      } as RollupCommonJSOptions),
      /** 
       * mPrinC-TODO: I think it is to handle all packages that snowpack is aware and has them already in cache
       * so it can provide them on demand as a single pre-packed file, rather than letting rollup to dwell into 
       * the original non-packed ones, not sure
       * */ 
      rollupPluginWrapInstallTargets(!!isTreeshake, autoDetectNamedExports, installTargets),
      rollupPluginDependencyStats((info) => (dependencyStats = info)),
      ...userDefinedRollup.plugins, // load user-defined plugins last
      rollupPluginCatchUnresolved(),
    ].filter(Boolean) as Plugin[],
    onwarn(warning, warn) {
      // Warn about the first circular dependency, but then ignore the rest.
      if (warning.code === 'CIRCULAR_DEPENDENCY') {
        if (!isCircularImportFound) {
          isCircularImportFound = true;
          logUpdate(`Warning: 1+ circular dependencies found via "${warning.importer}".`);
        }
        return;
      }
      // Log "unresolved" import warnings as an error, causing Snowpack to fail at the end.
      if (
        warning.code === 'PLUGIN_WARNING' &&
        warning.plugin === 'snowpack:rollup-plugin-catch-unresolved'
      ) {
        // Display posix-style on all environments, mainly to help with CI :)
        if (warning.id) {
          const fileName = path.relative(cwd, warning.id).replace(/\\/g, '/');
          logError(`${fileName}\n   ${warning.message}`);
        } else {
          logError(`${warning.message}. See https://www.snowpack.dev/#troubleshooting`);
        }
        return;
      }
      warn(warning);
    },
  };
  // https://rollupjs.org/guide/en/#big-list-of-options
  // https://rollupjs.org/guide/en/#outputoptions-object
  const outputOptions: OutputOptions = {
    dir: destLoc,
    // https://rollupjs.org/guide/en/#outputformat
    format: 'esm',
    // https://rollupjs.org/guide/en/#outputsourcemap
    sourcemap: sourceMap,
    // https://rollupjs.org/guide/en/#outputexports
    exports: 'named',
    // the location and format of files where will be stored
    // the dependencies that are required from multiple modules 
    chunkFileNames: 'common/[name]-[hash].js',
  };
  if (Object.keys(installEntrypoints).length > 0) {
    try {
      // console.log("[install] trying rollup for inputOptions.input: ", inputOptions.input);
      // run rollup https://rollupjs.org/guide/en/#rolluprollup
      const packageBundle = await rollup(inputOptions);
      logUpdate(formatInstallResults());
      // writes all generated files
      await packageBundle.write(outputOptions);
    } catch (_err) {
      const err: RollupError = _err;
      // console.log("[install] RollupError: ", err);
      const errFilePath = err.loc?.file || err.id;
      if (!errFilePath) {
        throw err;
      }
      // NOTE: Rollup will fail instantly on most errors. Therefore, we can
      // only report one error at a time. `err.watchFiles` also exists, but
      // for now `err.loc.file` and `err.id` have all the info that we need.
      const failedExtension = path.extname(errFilePath);
      const suggestion = MISSING_PLUGIN_SUGGESTIONS[failedExtension] || err.message;
      // Display posix-style on all environments, mainly to help with CI :)
      const fileName = path.relative(cwd, errFilePath).replace(/\\/g, '/');
      logError(
        `${colors.bold('snowpack')} failed to load ${colors.bold(fileName)}\n  ${suggestion}`,
      );
      return FAILED_INSTALL_RETURN;
    }
  }

  await writeLockfile(path.join(destLoc, IMPORT_MAP_FILE), importMap);
  // carbon copy discovered assets 
  for (const [assetName, assetLoc] of Object.entries(assetEntrypoints)) {
    const assetDest = `${destLoc}/${sanitizePackageName(assetName)}`;
    mkdirp.sync(path.dirname(assetDest));
    fs.copyFileSync(assetLoc, assetDest);
  }

  return {success: true, importMap};
}

/**
 * Gets install targets
 * It takes `install` param from snowpack config file, 
 * `webDependencies` from `package.json`, initially provided files `scannedFiles` and
 * all application entry points (provided in the snowpack config file as the `mount` dictionary)
 * and scans for the packages that are imported across all discovered files
 * 
 * The core process is described in the @see{@link{scanImports()}} of the `../scan-imports.js`
 * @param config snowpack config
 * @param [scannedFiles] 
 * @returns all the targets that should be installed (real package dependencies, excluding local imports)
 * + it doesn't return internal imports, like: `./lib/dataset-entry.service`, `./select/select.js'`
 * + it does return package imports like`@colabo-flow/i-dataset`, etc)
 */
export async function getInstallTargets(
  config: SnowpackConfig,
  // mPrinC-NOTE: not provided with local `command` call
  // set of files that should be included for parsing
  scannedFiles?: SnowpackSourceFile[],
):Promise<InstallTarget[]> {
  const {knownEntrypoints, webDependencies} = config;
  const installTargets: InstallTarget[] = [];
  if (knownEntrypoints) {
    // console.log("[install] knownEntrypoints: ", knownEntrypoints);
    // mPrinC-TODO: explore scanDepList
    installTargets.push(...scanDepList(knownEntrypoints, cwd));
  }
  if (webDependencies) {
    // console.log("[install] webDependencies: ", webDependencies);
    installTargets.push(...scanDepList(Object.keys(webDependencies), cwd));
  }
  if (scannedFiles) {
    installTargets.push(...(await scanImportsFromFiles(scannedFiles, config)));
  } else {
    //  it returns package imports like `@colabo-flow/i-dataset`, etc
    // but it doesn't return internal imports, like: `./lib/dataset-entry.service`, `./select/select.js'`
    installTargets.push(...(await scanImports(cwd, config)));
  }
  // console.log("[install] installTargets: ", installTargets);
  return installTargets;
}

/**
 * The entry point for the install command
 * @param commandOptions command options
 */
export async function command(commandOptions: CommandOptions) {
  const {cwd, config} = commandOptions;
  const installTargets = await getInstallTargets(config);
  if (installTargets.length === 0) {
    defaultLogError('Nothing to install.');
    return;
  }
  const finalResult = await run({...commandOptions, installTargets});
  if (finalResult.newLockfile) {
    await writeLockfile(path.join(cwd, LOCK_FILE), finalResult.newLockfile);
  }
  if (finalResult.stats) {
    console.log(printStats(finalResult.stats));
  }
  if (!finalResult.success || finalResult.hasError) {
    console.error("Problem with installing dependencies, quitting.");
    process.exit(1);
  }
}

interface InstalllRunOptions extends CommandOptions {
  installTargets: InstallTarget[];
}

interface InstallRunResult {
  success: boolean;
  hasError: boolean;
  importMap: ImportMap | null;
  newLockfile: ImportMap | null;
  stats: DependencyStatsOutput | null;
}

/** Runs all dependency installs
 * first webDependencies `resolveTargetsFromRemoteCDN()`
 * then package imports `install()`
 */
export async function run({
  config,
  lockfile,
  installTargets,
}: InstalllRunOptions): Promise<InstallRunResult> {
  const {
    installOptions: {dest},
    webDependencies,
  } = config;

  installResults = [];
  dependencyStats = null;
  spinner = ora(banner);
  spinnerHasError = false;

  if (installTargets.length === 0) {
    return {
      success: true,
      hasError: false,
      importMap: {imports: {}} as ImportMap,
      newLockfile: null,
      stats: null,
    };
  }

  // install CDN dependencies
  // not taken under the install time
  let newLockfile: ImportMap | null = null;
  if (webDependencies && Object.keys(webDependencies).length > 0) {
    newLockfile = await resolveTargetsFromRemoteCDN(lockfile, config).catch((err) => {
      defaultLogError(err.message || err);
      process.exit(1);
    });
  }

  rimraf.sync(dest);
  const installStart = performance.now();
  const finalResult = await install(
    installTargets,
    {
      lockfile: newLockfile,
      logError: defaultLogError,
      logUpdate: defaultLogUpdate,
    },
    config,
  ).catch((err) => {
    if (err.loc) {
      console.log('\n' + colors.red(colors.bold(`✘ ${err.loc.file}`)));
    }
    if (err.url) {
      console.log(colors.dim(`👉 ${err.url}`));
    }
    spinner.stop();
    throw err;
  });

  if (finalResult.success) {
    const installEnd = performance.now();
    spinner.succeed(
      colors.bold(`snowpack`) +
        ` install complete${spinnerHasError ? ' with errors.' : '.'}` +
        colors.dim(` [${((installEnd - installStart) / 1000).toFixed(2)}s]`),
    );
  } else {
    spinner.stop();
  }

  return {
    success: finalResult.success,
    hasError: spinnerHasError,
    importMap: finalResult.importMap,
    newLockfile,
    stats: dependencyStats!,
  };
}
