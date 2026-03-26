# Security Guide -- Sonic Pi Web

## Overview

Sonic Pi Web runs untrusted student code in the browser. This document covers
the security measures in place and how to configure Content Security Policy (CSP)
headers, sandbox behavior, and session logging for institutional deployment.

This guide is written for IT administrators deploying Sonic Pi Web on university
or school networks. No JavaScript knowledge is required.

---

## Sandboxed Execution

Student code runs inside a Proxy-based sandbox that intercepts all global variable
lookups. The sandbox prevents student code from accessing browser APIs that could
be used to exfiltrate data, modify the page, or communicate with external servers.

### How it works

1. Student code is wrapped in a `with(scope)` block where `scope` is a JavaScript
   Proxy object.
2. Every variable lookup in student code goes through the Proxy.
3. The Proxy returns `undefined` for blocked globals, effectively making dangerous
   APIs invisible to student code.
4. The code executes via `new Function()` (which is why `unsafe-eval` is required
   in the CSP -- see below).

### Blocked globals

The following browser APIs are blocked in student code. Any attempt to use them
silently returns `undefined`:

| Category | Blocked APIs |
|----------|-------------|
| Network | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` |
| Storage | `localStorage`, `sessionStorage`, `indexedDB` |
| DOM / Browser | `document`, `window`, `navigator`, `location`, `history` |
| Timers | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` |
| Workers | `Worker`, `SharedWorker`, `ServiceWorker` |
| Code execution | `eval`, `Function`, `importScripts` |
| Messaging | `postMessage`, `globalThis` |

### What IS accessible

Student code can use:

- **Math and data structures:** `Math`, `Array`, `Object`, `Map`, `Set`, `JSON`,
  `Number`, `String`, `Date`, `RegExp`, `Promise`, `console`
- **DSL functions:** `play`, `sleep`, `sample`, `live_loop`, `use_synth`,
  `use_bpm`, `sync`, `cue`, and all other Sonic Pi DSL functions
- **User variables:** Students can define and use their own variables freely

### Known limitations

The sandbox has one known escape path: accessing the `constructor` property chain
on any object can potentially reach the `Function` constructor and break out of
the sandbox. This is mitigated by `validateCode()`, which scans student code for
`constructor` and `__proto__` access before execution and issues warnings.

This is a defense-in-depth measure, not a hard boundary. Sonic Pi Web is designed
for educational environments where students are not adversarial. It is not suitable
as a general-purpose untrusted code execution sandbox.

---

## Content Security Policy (CSP)

CSP headers tell the browser which resources the application is allowed to load.
Setting these headers on your web server is the single most important security
configuration for deployment.

### Recommended CSP (with CDN)

This policy allows the application to load its editor and audio engine from CDN
while blocking everything else:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' https://esm.sh https://unpkg.com; connect-src 'self' https://esm.sh https://unpkg.com; worker-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline';
```

For readability, here is the same policy broken across lines (your server
configuration must send it as a single header value):

```
default-src 'self';
script-src 'self' 'unsafe-eval' https://esm.sh https://unpkg.com;
connect-src 'self' https://esm.sh https://unpkg.com;
worker-src 'self' blob:;
media-src 'self' blob:;
style-src 'self' 'unsafe-inline';
```

### Directive explanations

| Directive | Value | Why it is needed |
|-----------|-------|-----------------|
| `default-src` | `'self'` | Only allow resources from the same origin by default |
| `script-src` | `'self' 'unsafe-eval'` | `'unsafe-eval'` is required because the sandbox uses `new Function()` to execute student code. There is no way to avoid this. |
| `script-src` | `https://esm.sh` | CodeMirror editor components are loaded from esm.sh CDN |
| `script-src` | `https://unpkg.com` | SuperSonic (scsynth WebAssembly audio engine) is loaded from unpkg CDN |
| `connect-src` | `https://esm.sh https://unpkg.com` | Allows the browser to fetch ES module dependencies from CDN |
| `worker-src` | `'self' blob:` | AudioWorklet processors run as blob: URLs in Web Workers |
| `media-src` | `'self' blob:` | Audio recording exports use blob: URLs for download |
| `style-src` | `'self' 'unsafe-inline'` | The editor and app shell use inline styles for theming |

### nginx configuration

Add this to your `server` block or `location` block:

```nginx
server {
    # ... your existing configuration ...

    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' https://esm.sh https://unpkg.com; connect-src 'self' https://esm.sh https://unpkg.com; worker-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline';" always;
}
```

### Apache configuration

Add this to your `.htaccess` file or virtual host configuration:

```apache
<IfModule mod_headers.c>
    Header always set Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' https://esm.sh https://unpkg.com; connect-src 'self' https://esm.sh https://unpkg.com; worker-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline';"
</IfModule>
```

Make sure `mod_headers` is enabled: `a2enmod headers && systemctl reload apache2`

### Strict CSP (no CDN)

Some institutional networks block all external CDN traffic. Sonic Pi Web can run
without CDN access if you bundle the dependencies locally.

To remove CDN requirements:

1. **Bundle CodeMirror** -- Install `codemirror`, `@codemirror/view`, `@codemirror/state`,
   `@codemirror/language`, and `@lezer/highlight` as local dependencies and import
   them from your bundle. This adds approximately 50KB (gzipped) to your build.

2. **Bundle SuperSonic** -- Install `supersonic-scsynth` locally. Note that
   SuperSonic's core (scsynth) is licensed under GPL. Bundling it means your
   deployment must comply with GPL terms. Consult your institution's legal team
   if distributing the bundle outside your network.

3. **Update CSP** -- With all dependencies bundled, you can use a stricter policy:

```
default-src 'self';
script-src 'self' 'unsafe-eval';
worker-src 'self' blob:;
media-src 'self' blob:;
style-src 'self' 'unsafe-inline';
```

The editor has a built-in fallback: if CodeMirror fails to load (CDN blocked or
network unavailable), it automatically switches to a styled `<textarea>` with
the same keyboard shortcuts. Students can still write and run code.

---

## CDN Dependencies

All runtime CDN dependencies with their pinned versions:

| Package | Version | CDN | Purpose |
|---------|---------|-----|---------|
| `@codemirror/view` | 6.36.5 | esm.sh | Code editor view layer |
| `@codemirror/state` | 6.5.2 | esm.sh | Code editor state management |
| `codemirror` | 6.0.1 | esm.sh | Code editor base setup |
| `@codemirror/language` | 6.10.8 | esm.sh | Syntax highlighting framework |
| `@lezer/highlight` | 1.2.1 | esm.sh | Syntax highlighting styles |
| `supersonic-scsynth` | 0.4.0 | unpkg | WebAssembly audio synthesis engine |

Versions are pinned in the source code. Updates require a code change and redeployment.

---

## Subresource Integrity (SRI)

SRI allows the browser to verify that a fetched resource has not been tampered with
by checking it against a known cryptographic hash.

**Current status:** SRI is not applied to CDN dependencies. JavaScript's dynamic
`import()` does not support `integrity` attributes -- there is no browser API to
pass an SRI hash when dynamically importing an ES module. The fetch-then-blob-URL
workaround breaks CORS and CSP in many configurations.

**Mitigation:** Versions are pinned to exact version numbers (not ranges), reducing
the window for CDN compromise to the specific version URL.

**For maximum security:** Bundle all dependencies locally (see "Strict CSP" above).
This eliminates CDN as an attack vector entirely.

**Future:** The TC39 Import Attributes proposal and Import Maps with integrity
support may eventually allow SRI for dynamic imports. When browser support is
available, this will be adopted.

---

## Session Logging

Session logging records every action a student takes (run, stop, edit, load example)
with timestamps and cryptographic hashes of the code. This creates a verifiable
audit trail for academic integrity.

### How it works

1. Every time a student runs, stops, edits code, or loads an example, an entry is
   recorded with:
   - **Action type:** `run`, `stop`, `edit`, or `load_example`
   - **Timestamp:** ISO 8601 format (e.g., `2024-03-15T14:30:00.000Z`)
   - **Code hash:** SHA-256 hash of the code at that moment
   - **Detail:** Additional context (e.g., example name for `load_example`)

2. Code content is never stored in the log -- only its SHA-256 hash. This means
   the log is small and does not contain the actual student work, only proof of
   what was submitted and when.

### Signing

The session log is cryptographically signed before export:

- **Primary:** Ed25519 digital signatures (when browser supports it)
- **Fallback:** HMAC-SHA256 (when Ed25519 is unavailable)
- **Last resort:** Unsigned (if Web Crypto API is unavailable)

The signing algorithm used is recorded in the export file. A signing key pair is
generated per session using the browser's Web Crypto API.

### Export format

The session exports as a JSON file with this structure:

```json
{
  "entries": [
    {
      "action": "run",
      "timestamp": "2024-03-15T14:30:00.000Z",
      "codeHash": "a1b2c3d4e5f6..."
    }
  ],
  "signature": "deadbeef...",
  "algorithm": "Ed25519",
  "publicKey": "cafe1234..."
}
```

### How students export

Students press **Ctrl+Shift+S** to export their session log. This downloads a
JSON file named `sonic-pi-session-YYYY-MM-DD.json`.

### How teachers verify submissions

1. Collect the exported JSON file from the student.
2. The `entries` array shows the chronological record of all actions.
3. The `signature` and `publicKey` fields allow cryptographic verification that
   the log has not been tampered with after export.
4. To verify: re-hash the `entries` array with the same algorithm and check
   against the signature using the included public key.
5. Compare `codeHash` values against submitted code by hashing the student's
   final submission with SHA-256 and checking it matches the last `run` entry.

Note: The signing key is generated fresh each session. This proves the log is
internally consistent (not modified after export), but does not prove identity.
For identity verification, combine with your institution's authentication system.

---

## Deployment Checklist

Use this checklist when deploying Sonic Pi Web on your institution's servers.

- [ ] **Set CSP headers** on your web server (see nginx/Apache examples above)
- [ ] **Pin CDN versions** -- already done in the source code, no action needed
- [ ] **Enable HTTPS** -- required for Web Crypto API (session signing) and
      AudioContext to work in modern browsers
- [ ] **Test the sandbox** -- open the app, type `fetch('https://example.com')`
      in the editor, and press Run. It should fail silently (no network request
      in the browser's Network tab)
- [ ] **Test session export** -- press Ctrl+Shift+S. A JSON file should download.
- [ ] **Test CSP** -- open browser DevTools Console. There should be no CSP
      violation warnings during normal use (run code, stop, load examples)
- [ ] **Test offline fallback** -- block esm.sh and unpkg.com at the network
      level. The editor should fall back to a plain textarea. Audio will be
      unavailable but the app should not crash.
- [ ] **Review firewall rules** -- if your network has an allowlist, add:
  - `esm.sh` (port 443) -- CodeMirror editor
  - `unpkg.com` (port 443) -- SuperSonic audio engine
- [ ] **Consider bundling** -- for highest security or air-gapped networks,
      bundle all dependencies locally (see "Strict CSP" section)
