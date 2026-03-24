#!/usr/bin/env node

/**
 * sonic-pi-web CLI — starts the dev server and opens the browser.
 * Usage: npx sonic-pi-web
 */

import { createServer } from 'vite'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

async function main() {
  const port = parseInt(process.env.PORT || '3000', 10)

  console.log('')
  console.log('  ♫ Sonic Pi Web')
  console.log('  The Live Coding Music Synth for Everyone')
  console.log('')

  const server = await createServer({
    root,
    server: {
      port,
      open: true,
      host: true,
    },
  })

  await server.listen()

  const address = server.resolvedUrls?.local?.[0] ?? `http://localhost:${port}`
  console.log(`  → ${address}`)
  console.log('')
  console.log('  Press Ctrl+C to stop')
  console.log('')
}

main().catch((err) => {
  console.error('Failed to start:', err.message)
  process.exit(1)
})
