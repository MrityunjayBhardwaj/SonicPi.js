import { defineConfig } from 'vitepress'
import { fileURLToPath, URL } from 'node:url'

// Repo root — so the docs theme can import the engine from ../src.
// #604/SV80: the engine self-loads its tree-sitter wasm + rand-stream from the
// CDN, so the docs no longer host those at the root (the old serve-root-wasm dev
// middleware + the docs:assets rand-stream copy are gone).
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  title: 'SonicWeb',
  description: 'Browser-native Sonic Pi with real SuperCollider synthesis via WebAssembly.',
  base: '/docs/',
  outDir: '../dist/docs',

  vite: {
    server: { fs: { allow: [repoRoot] } },
  },

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.svg' }],
  ],

  themeConfig: {
    logo: { src: '/docs/favicon.svg', alt: 'SonicWeb' },

    nav: [
      { text: 'Try it', link: 'https://sonicweb.cc' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@mjayb/sonicweb' },
      { text: 'GitHub', link: 'https://github.com/MrityunjayBhardwaj/SonicWeb' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Architecture', link: '/architecture' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'DSL Reference', link: '/dsl-reference' },
          { text: 'API Reference', link: '/api' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/MrityunjayBhardwaj/SonicWeb' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Based on Sonic Pi by Sam Aaron.',
    },

    search: { provider: 'local' },
  },
})
