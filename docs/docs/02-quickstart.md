## Get Started

### Install Snowpack

``` bash
# using npm
npm install --save-dev snowpack

# using yarn
yarn add --dev snowpack
```

Snowpack can also be installed globally via `npm install -g snowpack`. But, <span class='important'>we recommend installing locally</span> in every project via `--save-dev`/`--dev`. You can run the Snowpack CLI locally via package.json "scripts", npm's `npx snowpack`, or via `yarn snowpack`.

### Create Snowpack App (CSA)

The easiest way to get started with Snowpack is via [Create Snowpack App (CSA)](https://github.com/pikapkg/snowpack/tree/master/packages/create-snowpack-app). CSA automatically initializes a starter application for you with a pre-configured, Snowpack-powered dev environment.

If you've ever used Create React App, this is a lot like that!

``` bash
npx create-snowpack-app new-dir --template [SELECT FROM BELOW] [--use-yarn]
```

### Official App Templates

- [@snowpack/app-template-blank](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-blank)
- [@snowpack/app-template-react](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-react)
- [@snowpack/app-template-react-typescript](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-react-typescript)
- [@snowpack/app-template-preact](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-preact)
- [@snowpack/app-template-svelte](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-svelte)
- [@snowpack/app-template-vue](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-vue)
- [@snowpack/app-template-lit-element](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-lit-element)
- [@snowpack/app-template-11ty](https://github.com/pikapkg/create-snowpack-app/tree/master/templates/app-template-11ty)
- **[See all community templates](https://github.com/pikapkg/create-snowpack-app)**

<!--
### Tutorial: Starting from Scratch

While CSA is a great all-in-one starter dev environment, you may prefer to learn <span class='important'>exactly how it works under the hood</span>. In that case, we have this tutorial that walks you through how you can build your own Create React App -like dev environment with Snowpack and only a few lines of configuration.

**Coming Soon!**
-->

### Migrating an Existing App

Migrating an existing app to Snowpack is meant to be <span class='important'>painless, since Snowpack supports most features and build tools that you're already using today</span> (Babel, PostCSS, etc). If this is your first time using Snowpack you should start with a Create Snowpack App (CSA) template, copy over your "src" & "public" files from your old app, and then <span class='comment' data-comment='the problem is that it overwrites errors, example, add import with missing package, not installed, and the error will be overwritten'>run `snowpack dev`, troubleshooting any remaining issues</span>.

CSA is a good starting point for an existing application because it has a few common tools (like Babel) built in by default to replicate the full feature set of a traditional bundled app. CSA is also meant to be a drop-in replacement for Create React App, so any existing Create React App project should run via CSA with zero changes needed.

If you run into issues, search the rest of our docs site for information about importing CSS [from JS](#import-css) and [from CSS](#css-%40import-support), [asset references](#import-images-%26-other-assets), and more.
