import { App } from './App'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app element')

const app = new App(root)
app.init().catch(console.error)
