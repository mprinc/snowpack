#### Who's Using Snowpack?

<div class="company-logos">
{% for user in usersList %}
  <a href="{{ user.url }}" target="_blank">
    {% if user.img %}<img class="company-logo" src="{{ user.img }}" alt="{{ user.name }}" />
    {% else %}<span>{{ user.name }}</span>
    {% endif %}
  </a>
{% endfor %}
<a href="https://github.com/pikapkg/snowpack/edit/master/docs/docs/00.md" target="_blank" title="Add Your Project/Company!" class="add-company-button" >
  <svg style="height: 22px; margin-right: 8px;" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="plus" class="company-logo" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M416 208H272V64c0-17.67-14.33-32-32-32h-32c-17.67 0-32 14.33-32 32v144H32c-17.67 0-32 14.33-32 32v32c0 17.67 14.33 32 32 32h144v144c0 17.67 14.33 32 32 32h32c17.67 0 32-14.33 32-32V304h144c17.67 0 32-14.33 32-32v-32c0-17.67-14.33-32-32-32z"></path></svg>
  Add your logo
</a>
</div>

## Overview

### What is Snowpack?

**Snowpack is a modern, lightweight toolchain for faster web development.** <span class='important'>Traditional JavaScript build tools like webpack and Parcel need to rebuild & rebundle entire chunks of your application every time you save a single file</span>. This rebundling step introduces <span class='definition'>lag</span> between hitting save on your changes and seeing them reflected in the browser.

<span class='important'>Snowpack serves your application **unbundled during development.**</span>  Every file only needs to be built once and then is <span class='comment' data-comment='Hm, in code they write that some code is not  possible to cache, and it hit my TS code I think'>cached forever</span>. When a file changes, Snowpack r<span class='important'>ebuilds that single file</span>. There's no time wasted re-bundling every change, just instant updates in the browser (made even faster via [Hot-Module Replacement (HMR)](#hot-module-replacement)). You can read more about this approach in our [Snowpack 2.0 Release Post.](/posts/2020-05-26-snowpack-2-0-release/) 

Snowpack's <span class='definition'>**unbundled development** </span>still supports the same <span class='definition'>**bundled builds**</span> that you're used to for production. When you go to <span class='definition'>build</span> your application for production, you can plug in your favorite bundler via an official Snowpack plugin for Webpack or Rollup (coming soon). <span class='important'>With Snowpack already handling your build, there's no complex bundler config required</span>.

**Snowpack gets you the best of both worlds:** fast, unbundled development with optimized performance in your bundled production builds.

### Key Features

- A frontend dev environment that <span class='comment' data-comment='only real building measured, so overall significantly longer'>starts up in **50ms or less.**</span> 
- Changes reflected [instantly in the browser.](/#hot-module-replacement)
- Integrates your favorite bundler for [production-optimized builds.](/#snowpack-build)
- Out-of-the-box support for [TypeScript, JSX, CSS Modules and more.](/#features)
- Connect your favorite tools with [third-party plugins.](/#build-plugins)

### Library Support

<div class="grid-list">

- React
- Preact
- Svelte
- Vue
- lit-html
- lit-element
- Styled Components
- Tailwind CSS
- and more!
<!-- Missing something? Feel free to add your own! -->

</div>

### Tooling Support

<div class="grid-list">

- Babel
- TypeScript
- PostCSS
- Sass
- esbuild
- 11ty
- and more!
<!-- Missing something? Feel free to add your own! -->

</div>

### Browser Support

**Snowpack builds your site for both modern and legacy browsers. Even IE11 is supported.** You can control and customize this behavior with the ["browserlist" package.json property](https://css-tricks.com/browserlist-good-idea/). 

The only requirement is that *during development* you use a [modern browser](http://caniuse.com/#feat=es6-module). Any recent release of Firefox, Chrome, or Edge will do. This is required to support the modern, <span class='definition'>bundle-free ESM imports</span> that load your application in the browser.
