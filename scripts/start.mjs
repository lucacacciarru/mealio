import { spawn } from 'node:child_process'

const children = new Set()
let stopping = false

function stop(signal) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill(signal)
}

function launch(script) {
  const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env })
  children.add(child)
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) {
      stop('SIGTERM')
      process.exitCode = code ?? (signal ? 1 : 0)
    }
  })
  child.once('error', (error) => {
    process.stderr.write(`[start] ${script} failed to launch: ${error.message}\n`)
    stop('SIGTERM')
    process.exitCode = 1
  })
  return child
}

process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))
launch('.output/server/index.mjs')
launch('scripts/scheduler.mjs')
