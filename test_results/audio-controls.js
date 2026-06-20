// Shared across every parity dashboard (loaded via <script src="audio-controls.js">,
// the same file://-safe classic-script pattern as nav.js). It gives every Ruby
// snippet two controls:
//
//   ▶ Run / ■ Stop      plays the snippet in-page through ONE shared engine
//                        (same-origin spw-engine.mjs). #604/SV80: the engine is
//                        self-sufficient — it loads SuperSonic, the tree-sitter
//                        wasm, and the rand-stream from the CDN itself, so the
//                        dashboard hosts nothing but the engine bundle. Only
//                        shown over http(s); file:// can't load an ES module.
//   ↗ Open in sonicpi.cc opens the snippet in the live editor, ready to run.
//                        Pure link, no deps — shown everywhere (file:// included).
//
// The engine bundle is produced by `npm run dashboard:audio` and served from
// test_results/ as the web root (`npm run dashboard:serve`, or the Vercel publish
// bundle). Without it the Run button surfaces a clear error; the link always works.
(function () {
  'use strict'

  var SONICPI_CC = 'https://sonicpi.cc/'

  // Resolve sibling assets relative to THIS script (currentScript is only valid
  // during synchronous top-level execution — capture it now, not in callbacks).
  var BASE = (function () {
    var s = document.currentScript
    return new URL('.', s ? s.src : location.href).href
  })()

  // Inline play needs http(s): browsers block ES-module imports (the same-origin
  // spw-engine.mjs) from file://, and the engine's WASM needs cross-origin
  // isolation a file:// page can't get. There we offer only the link.
  var HTTP_SERVED = location.protocol === 'http:' || location.protocol === 'https:'

  // --- share-link encoder (must stay byte-identical to src/app/ShareLink.ts) ---
  function encodeShareCode(code) {
    var bytes = new TextEncoder().encode(code)
    var bin = ''
    var CHUNK = 0x8000
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return '#c=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  // --- one shared engine for the whole page -----------------------------------
  var engine = null
  var enginePromise = null
  var currentBtn = null

  function getEngine() {
    if (engine) return Promise.resolve(engine)
    if (!enginePromise) {
      enginePromise = (async function () {
        var mod = await import(BASE + 'spw-engine.mjs')
        // #604/SV80: the engine self-loads SuperSonic (GPL, never bundled), the
        // tree-sitter wasm, and the rand-stream from the CDN — no wiring, no asset
        // hosting, no warm-up loop. init() resolves only once the transpiler is
        // ready, so the first Run works immediately.
        var e = new mod.SonicPiEngine()
        await e.init()
        engine = e
        window.__spwEngine = e
        return e
      })().catch(function (err) {
        // A failed init (CDN blocked, WASM error) must not poison the cache —
        // null it so the NEXT Run retries from scratch instead of replaying the
        // rejection forever.
        enginePromise = null
        throw err
      })
    }
    return enginePromise
  }

  function setState(btn, state) {
    btn.dataset.state = state
    if (state === 'loading') {
      // Animated spinner in place of the label until the engine can play.
      btn.innerHTML = '<span class="spw-spinner" aria-hidden="true"></span>Loading'
    } else {
      btn.textContent =
        state === 'playing' ? '■ Stop' :
        state === 'error' ? '⚠ Error' : '▶ Run'
    }
  }

  function stopCurrent() {
    if (engine) engine.stop()
    if (currentBtn) { setState(currentBtn, 'idle'); currentBtn = null }
  }

  function showError(bar, msg) {
    var box = bar.parentNode.querySelector(':scope > .spw-error')
    if (!box) {
      box = document.createElement('div')
      box.className = 'spw-error'
      bar.parentNode.insertBefore(box, bar.nextSibling)
    }
    box.textContent = msg
    box.style.display = 'block'
  }
  function clearError(bar) {
    var box = bar.parentNode.querySelector(':scope > .spw-error')
    if (box) box.style.display = 'none'
  }

  async function run(bar, btn) {
    stopCurrent()
    clearError(bar)
    setState(btn, 'loading')
    try {
      // getEngine() awaits init(), which (#604/SV80) resolves only once the
      // engine is fully ready — SuperSonic, tree-sitter, and rand-stream all
      // loaded. So the first evaluate runs for real; no readiness retry needed.
      var e = await getEngine()
      var res = await e.evaluate(btn.__spwCode)
      if (res.error) { setState(btn, 'error'); showError(bar, res.error.message || String(res.error)); return }
      e.play()
      currentBtn = btn
      setState(btn, 'playing')
    } catch (err) {
      setState(btn, 'error')
      showError(bar, (err && err.message) || String(err))
    }
  }

  // --- snippet discovery + decoration -----------------------------------------
  // Every dashboard renders Ruby into one of these <pre> shapes (Family A bakes
  // escaped text server-side; Family B fills pre.snippet client-side from the
  // manifest, hence the MutationObserver below).
  var SNIPPET_SEL = 'pre.snippet, pre.src, details.snippet pre'

  function codeOf(pre) {
    return (pre.textContent || '').replace(/\n$/, '')
  }

  function decorate(pre) {
    var code = codeOf(pre)
    var bar = pre.__spwBar || null

    // Skip placeholders ("loading…") and empty blocks; tear down a stale bar if
    // the snippet emptied out.
    if (!code.trim() || code === 'loading…' || code === 'loading...') {
      if (bar) { bar.style.display = 'none' }
      return
    }

    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'spw-bar'

      if (HTTP_SERVED) {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'spw-run'
        setState(btn, 'idle')
        btn.addEventListener('click', function () {
          var st = btn.dataset.state
          if (st === 'loading') return // already warming up — ignore extra clicks
          if (st === 'playing') stopCurrent()
          else run(bar, btn)
        })
        bar.appendChild(btn)
        bar.__spwBtn = btn
      }

      var link = document.createElement('a')
      link.className = 'spw-link'
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = '↗ Open in sonicpi.cc'
      bar.appendChild(link)
      bar.__spwLink = link

      pre.parentNode.insertBefore(bar, pre.nextSibling)
      pre.__spwBar = bar
    }

    // (Re)bind to the current code — Family B reuses one <pre> across fixtures.
    // The MutationObserver re-scans on every frame, so only act when the code
    // ACTUALLY changed; re-encoding (or worse, stopping playback) on every
    // unrelated mutation would kill a snippet the instant it started.
    bar.style.display = ''
    if (bar.__spwCode !== code) {
      var wasNew = bar.__spwCode === undefined
      bar.__spwCode = code
      bar.__spwLink.href = SONICPI_CC + encodeShareCode(code)
      if (bar.__spwBtn) {
        bar.__spwBtn.__spwCode = code
        // Code swapped under a playing block (Family B fixture change) → reset it.
        if (!wasNew && currentBtn === bar.__spwBtn) stopCurrent()
      }
    }
  }

  function scan(root) {
    var pres = (root || document).querySelectorAll(SNIPPET_SEL)
    for (var i = 0; i < pres.length; i++) decorate(pres[i])
  }

  function injectStyleOnce() {
    if (document.getElementById('spw-audio-style')) return
    var css =
      '.spw-bar{display:flex;gap:8px;margin:8px 0 2px;flex-wrap:wrap}' +
      '.spw-run,.spw-link{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#9ecbff;background:rgba(120,160,255,.10);border:1px solid rgba(120,160,255,.35);' +
      'border-radius:6px;padding:6px 11px;cursor:pointer;text-decoration:none;display:inline-flex;' +
      'align-items:center;transition:background .15s,color .15s,border-color .15s}' +
      '.spw-run:hover,.spw-link:hover{background:rgba(120,160,255,.22);border-color:#7aa2f7}' +
      '.spw-run[data-state="playing"]{color:#0b0d12;background:#7aa2f7;border-color:#7aa2f7}' +
      '.spw-run[data-state="loading"]{cursor:progress;opacity:.85}' +
      '.spw-spinner{display:inline-block;width:11px;height:11px;margin-right:6px;' +
      'border:2px solid rgba(158,203,255,.30);border-top-color:#9ecbff;border-radius:50%;' +
      'animation:spw-spin .7s linear infinite}' +
      '@keyframes spw-spin{to{transform:rotate(360deg)}}' +
      '.spw-run[data-state="error"]{color:#ff8585;border-color:#ff8585;background:rgba(255,80,80,.10)}' +
      '.spw-error{display:none;margin:4px 0 8px;padding:8px 11px;white-space:pre-wrap;' +
      'font:12px/1.5 ui-monospace,Menlo,monospace;color:#ff8585;background:rgba(255,80,80,.08);' +
      'border:1px solid rgba(255,80,80,.3);border-radius:6px}'
    var el = document.createElement('style')
    el.id = 'spw-audio-style'
    el.textContent = css
    document.head.appendChild(el)
  }

  // Opened from disk (file://), browsers block the ES-module engine load, so only
  // the "open in sonicpi.cc" link works. Show a one-time banner explaining how to
  // get the in-page Run/Stop controls.
  function injectFileHintOnce() {
    if (HTTP_SERVED || document.getElementById('spw-file-hint')) return
    var bar = document.createElement('div')
    bar.id = 'spw-file-hint'
    bar.style.cssText = 'position:sticky;top:0;z-index:9999;padding:7px 14px;font:600 12px/1.4 ' +
      'ui-monospace,Menlo,monospace;color:#0b0d12;background:#e0af68;text-align:center'
    bar.innerHTML = '▶ Run/Stop needs the dashboards served over http — run ' +
      '<code style="background:rgba(0,0,0,.15);padding:1px 5px;border-radius:4px">npm run dashboard:serve</code>' +
      ' (or use the live site). Opened from disk, only the ↗ open-in-sonicpi.cc link works.'
    document.body.insertBefore(bar, document.body.firstChild)
  }

  function init() {
    injectStyleOnce()
    injectFileHintOnce()
    scan(document)
    // Family B (examples-sweep / book / fx-inspector) renders the snippet client
    // -side and swaps it on fixture selection — re-scan on DOM/text mutations.
    var pending = false
    var obs = new MutationObserver(function () {
      if (pending) return
      pending = true
      requestAnimationFrame(function () { pending = false; scan(document) })
    })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
