import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { Hono } from 'hono'
import { JevRouter, type JevRequest } from '../src/index.ts'

// Stands in for Jev: a route matches when its description mentions the User-Agent or the method
const run = async (_c: unknown, request: JevRequest) => {
  const { method, headers } = request.state
  const ua = headers['user-agent']
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([key, { instructions }]) => {
      const description = instructions.match(/"(.*)"/)?.[1] ?? ''
      const matches = description.includes(ua) || description.includes(`any ${method}`)
      return [key, { noul: matches ? 0.9 : 0.1 }]
    })
  )
  return { answers }
}

const createApp = (threshold?: number) => {
  const app = new Hono<{ Variables: { jev: { route: string } } }>({
    router: new JevRouter({ run, threshold }),
  })
  app.use(async (c, next) => {
    await next()
    c.header('x-middleware', 'ran')
  })
  app.get('/health', (c) => c.text('ok'))
  app.on('jev', 'a request from agent', (c) => c.text(`agent ${c.req.method} ${c.req.path}`))
  app.on('jev', 'a request from browser', (c) => c.text(`browser: ${c.get('jev').route}`))
  return app
}

const withJevServer = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  testCase: (baseURL: string) => Promise<void>
) => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Jev test server did not bind to a TCP port')
  }
  try {
    await testCase(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

test('routes by meaning', async () => {
  const app = createApp()
  const agent = await app.request('/docs', {
    method: 'POST',
    body: 'hi',
    headers: { 'User-Agent': 'agent' },
  })
  assert.equal(await agent.text(), 'agent POST /docs')
  const browser = await app.request('/docs', { headers: { 'User-Agent': 'browser' } })
  assert.equal(await browser.text(), 'browser: a request from browser')
  assert.equal(browser.headers.get('x-middleware'), 'ran')
})

test('path routes still work', async () => {
  const res = await createApp().request('/health', { headers: { 'User-Agent': 'agent' } })
  assert.equal(await res.text(), 'ok')
})

test('the first registered route that matches wins', async () => {
  const app = new Hono({ router: new JevRouter({ run }) })
  app.on('jev', 'any GET request', (c) => c.text('all!'))
  app.on('jev', 'a request from browser', (c) => c.text('browser'))
  const get = await app.request('/', { headers: { 'User-Agent': 'browser' } })
  assert.equal(await get.text(), 'all!')
  const post = await app.request('/', { method: 'POST', headers: { 'User-Agent': 'browser' } })
  assert.equal(await post.text(), 'browser')
})

test('falls through to notFound when no route reaches the threshold', async () => {
  const unknown = await createApp().request('/docs', { headers: { 'User-Agent': 'unknown' } })
  assert.equal(unknown.status, 404)
  const strict = await createApp(0.95).request('/docs', { headers: { 'User-Agent': 'agent' } })
  assert.equal(strict.status, 404)
})

test('falls through to notFound when the Jev API returns an error', async () => {
  await withJevServer(
    (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('model unavailable')
    },
    async (baseURL) => {
      const app = new Hono({ router: new JevRouter({ apiKey: 'test', baseURL }) })
      app.on('jev', 'any GET request', (c) => c.text('matched'))

      const res = await app.request('/')

      assert.equal(res.status, 404)
    }
  )
})

test('falls through to notFound when the Jev API times out', async () => {
  await withJevServer(
    () => {},
    async (baseURL) => {
      const app = new Hono({ router: new JevRouter({ apiKey: 'test', baseURL, timeoutMs: 50 }) })
      app.on('jev', 'any GET request', (c) => c.text('matched'))

      const res = await Promise.race<Response | 'hung'>([
        app.request('/'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 250)),
      ])

      assert.notEqual(res, 'hung', 'request hung instead of timing out the Jev call')
      assert.equal((res as Response).status, 404)
    }
  )
})

test('reports a missing apiKey instead of calling Jev', async () => {
  let called = false
  await withJevServer(
    (_req, res) => {
      called = true
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('unauthorized')
    },
    async (baseURL) => {
      const app = new Hono({ router: new JevRouter({ baseURL }) })
      app.on('jev', 'any GET request', (c) => c.text('matched'))
      app.onError((err, c) => c.text(err.message, 500))

      const res = await app.request('/')

      assert.equal(res.status, 500)
      assert.match(await res.text(), /apiKey/)
      assert.equal(called, false)
    }
  )
})

test('rejects duplicate Jev route descriptions', () => {
  const app = new Hono({ router: new JevRouter({ run }) })
  app.on('jev', 'same description', (c) => c.text('first'))

  assert.throws(
    () => app.on('jev', 'same description', (c) => c.text('second')),
    /Duplicate Jev route description: same description/
  )
})

test('handlers can still read the body, even a binary one', async () => {
  const app = new Hono({ router: new JevRouter({ run }) })
  app.on('jev', 'a request from agent', async (c) => c.body(await c.req.arrayBuffer()))
  app.on('jev', 'a request from json', async (c) => c.json(await c.req.json()))

  const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0xfe, 0x80])
  const binary = await app.request('/upload', {
    method: 'POST',
    body: bytes,
    headers: { 'User-Agent': 'agent', 'Content-Type': 'image/jpeg' },
  })
  assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), bytes)

  const json = await app.request('/api', {
    method: 'POST',
    body: JSON.stringify({ hello: 'jev' }),
    headers: { 'User-Agent': 'json', 'Content-Type': 'application/json' },
  })
  assert.deepEqual(await json.json(), { hello: 'jev' })
})

test('only textual bodies are shown to Jev', async () => {
  const bodies: Record<string, string | undefined> = {}
  const app = new Hono({
    router: new JevRouter({
      run: (c, request) => {
        bodies[request.state.headers['content-type']] = request.state.body
        return run(c, request)
      },
    }),
  })
  app.on('jev', 'anything', (c) => c.text('ok'))

  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const contentTypes = [
    'Application/JSON; charset=utf-8',
    'application/ld+json',
    'image/svg+xml',
    'application/x-www-form-urlencoded',
    xlsx,
    'application/octet-stream',
  ]
  await Promise.all(
    contentTypes.map((contentType) =>
      app.request('/', { method: 'POST', body: 'hello', headers: { 'Content-Type': contentType } })
    )
  )
  assert.deepEqual(bodies, {
    'Application/JSON; charset=utf-8': 'hello',
    'application/ld+json': 'hello',
    'image/svg+xml': 'hello',
    'application/x-www-form-urlencoded': 'hello',
    [xlsx]: `[5 bytes of ${xlsx}]`,
    'application/octet-stream': '[5 bytes of application/octet-stream]',
  })
})

test('sensitive header values are not shown to Jev', async () => {
  let headers: Record<string, string> = {}
  const app = new Hono({
    router: new JevRouter({
      run: (c, request) => {
        headers = request.state.headers
        return run(c, request)
      },
    }),
  })
  app.on('jev', 'any GET request', (c) => c.text(c.req.header('Authorization') ?? ''))

  const res = await app.request('/', {
    headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', Accept: 'text/html' },
  })
  assert.deepEqual(headers, {
    authorization: '[redacted]',
    cookie: '[redacted]',
    accept: 'text/html',
  })
  // The handler still sees the real value
  assert.equal(await res.text(), 'Bearer secret')
})
