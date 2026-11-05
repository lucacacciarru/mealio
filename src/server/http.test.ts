import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestHasSameOrigin } from './http'

const request = (url: string, origin?: string) => new Request(url, origin ? { headers: { origin } } : {})

test('same-origin check survives a proxy that terminates HTTPS and rejects other sites', () => {
  // Railway terminates TLS: the server sees http:// while the browser sends https://.
  assert.equal(requestHasSameOrigin(request('http://mealio.example/api/auth/setup', 'https://mealio.example')), true)
  assert.equal(requestHasSameOrigin(request('http://localhost:5009/api/weeks', 'http://localhost:5009')), true)
  assert.equal(requestHasSameOrigin(request('http://localhost:5009/api/weeks')), true)

  assert.equal(requestHasSameOrigin(request('http://mealio.example/api/auth/setup', 'https://evil.example')), false)
  assert.equal(requestHasSameOrigin(request('http://mealio.example/api/auth/setup', 'https://mealio.example.evil.example')), false)
  assert.equal(requestHasSameOrigin(request('http://localhost:5009/api/weeks', 'http://localhost:5010')), false)
  assert.equal(requestHasSameOrigin(request('http://mealio.example/api/auth/setup', 'null')), false)
})
