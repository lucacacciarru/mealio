import { hashPassword } from '../src/server/password'

function readHiddenPassword(prompt: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) throw new Error('Run this command in an interactive terminal.')

  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let value = ''
  process.stdout.write(prompt)
  input.setRawMode(true)
  input.setEncoding('utf8')
  input.resume()

  const finish = (error?: Error) => {
    input.setRawMode(false)
    input.pause()
    input.removeListener('data', onData)
    process.stdout.write('\n')
    if (error) reject(error)
    else resolve(value)
  }

  const onData = (chunk: string) => {
    for (const character of chunk) {
      if (character === '\u0003') {
        finish(new Error('Cancelled.'))
        return
      }
      if (character === '\r' || character === '\n') {
        finish()
        return
      }
      if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1)
      } else {
        value += character
      }
    }
  }

  input.on('data', onData)
  return promise
}

async function main() {
  const password = await readHiddenPassword('New password: ')
  const confirmation = await readHiddenPassword('Confirm password: ')
  if (!password || password !== confirmation) {
    throw new Error('Passwords must match and cannot be empty.')
  }
  process.stdout.write(`${await hashPassword(password)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Password hashing failed.'}\n`)
  process.exitCode = 1
})
