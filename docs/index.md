---
layout: home

hero:
  name: SonicWeb
  text: Sonic Pi in the browser.
  tagline: Real SuperCollider synthesis via WebAssembly. No install. Just open and play.
  image:
    src: /docs/favicon.svg
    alt: SonicWeb
  actions:
    - theme: brand
      text: Try it at sonicweb.cc
      link: https://sonicweb.cc
    - theme: alt
      text: Get Started
      link: /getting-started
    - theme: alt
      text: API Reference
      link: /api

features:
  - title: Real SuperCollider
    details: The same SynthDefs and sample library as desktop Sonic Pi, running via SuperSonic (scsynth compiled to WebAssembly).
  - title: Virtual Time Scheduler
    details: sleep() returns a Promise only the scheduler can resolve — cooperative concurrency with virtual time in pure JavaScript.
  - title: ~95% DSL compatible
    details: live_loop, sync/cue, with_fx, use_bpm, density, time_warp, and more — Ruby syntax transpiled automatically.
  - title: Embeddable library
    details: Use the engine in your own app via npm install @mjayb/sonicweb with full TypeScript types.
---
