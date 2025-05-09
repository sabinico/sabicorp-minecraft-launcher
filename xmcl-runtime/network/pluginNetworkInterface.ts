import { DefaultRangePolicy } from '@xmcl/file-transfer'
import { PoolStats } from '@xmcl/runtime-api'
import { setTimeout as timeout } from 'timers/promises'
import { Agent, Dispatcher, Pool, buildConnector } from 'undici'
import { kClients, kRunning } from 'undici/lib/core/symbols'
import { LauncherAppPlugin } from '~/app'
import { kSettings } from '~/settings'
import { NetworkAgent, ProxySettingController } from './dispatchers/NetworkAgent'
import { kDownloadOptions, kNetworkInterface } from './networkInterface'

export const pluginNetworkInterface: LauncherAppPlugin = (app) => {
  const logger = app.getLogger('NetworkInterface')
  const userAgent = app.userAgent

  let maxConnection = 64
  const connectorOptions: buildConnector.BuildOptions = {
    timeout: 25_000,
    rejectUnauthorized: false,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 850,
  }

  const globalProxyHttps = process.env.HTTPS_PROXY || process.env.https_proxy

  const proxyControl = new ProxySettingController()
  app.registry.get(kSettings).then((state) => {
    maxConnection = state.maxSockets > 0 ? state.maxSockets : 64
    proxyControl.setProxyEnabled(state.httpProxyEnabled)
    const proxy = state.httpProxy || globalProxyHttps
    if (proxy) {
      try {
        proxyControl.setProxy(new URL(proxy))
        app.setProxy(proxy)
      } catch (e) {
        logger.warn(`Fail to set url as it's not a valid url ${proxy}`, e)
      }
    }

    state.subscribe('maxSocketsSet', (val) => {
      maxConnection = val > 0 ? val : 64
    })
    state.subscribe('httpProxySet', (p) => {
      app.setProxy(p)
      try {
        proxyControl.setProxy(new URL(p))
      } catch (e) {
        logger.warn(`Fail to set url as it's not a valid url ${p}`, e)
      }
    })
    state.subscribe('httpProxyEnabledSet', (e) => {
      proxyControl.setProxyEnabled(e)
      app.setProxy(e ? (state.httpProxy || globalProxyHttps || '') : '')
    })
  })

  const patchIfPool = (dispatcher: Dispatcher) => {
    if (dispatcher instanceof Pool) {
      const keys = Reflect.ownKeys(dispatcher)
      const kConnections = keys.find(k => typeof k === 'symbol' && k.description === 'connections')
      if (kConnections) { Object.defineProperty(dispatcher, kConnections, { get: () => maxConnection }) }
    }
    return dispatcher
  }

  function calculateRetryAfterHeader(retryAfter: number) {
    const current = Date.now()
    const diff = new Date(retryAfter).getTime() - current

    return diff
  }

  const downloadProxy = new NetworkAgent({
    userAgent,
    retryOptions: {
      retry: (err, { state, opts }, cb) => {
        const { statusCode, code, headers } = err as any

        if ((opts as any).noRetry?.value) {
          cb(err)
          return
        }

        const { method, retryOptions } = opts
        const {
          maxRetries,
          minTimeout,
          maxTimeout,
          timeoutFactor,
          statusCodes,
          errorCodes,
          methods,
        } = retryOptions! as any
        const { counter } = state

        // Any code that is not a Undici's originated and allowed to retry
        if (
          code &&
          code !== 'UND_ERR_REQ_RETRY' &&
          !errorCodes!.includes(code)
        ) {
          if (code !== 'UND_ERR_CONNECT_TIMEOUT') {
            cb(err)
            return
          }
          // Check if there are connection with the same origin
          // If there are, this error is usually due to high traffic, and we should retry
          // @ts-ignore
          const clients = downloadProxy.agent[kClients] as Map<string, Pool>
          if (!opts.origin) {
            cb(err)
            return
          }
          const pool = clients.get(typeof opts.origin === 'string' ? opts.origin : opts.origin.origin)
          const stats = pool?.stats
          if (!stats?.connected && !stats?.pending && !stats?.running && !stats?.queued && !stats?.free) {
            // throw error if there are no connection with the same origin
            cb(err)
            return
          }
        }

        // If a set of method are provided and the current method is not in the list
        if (Array.isArray(methods) && !methods.includes(method)) {
          cb(err)
          return
        }

        // If a set of status code are provided and the current status code is not in the list
        if (
          statusCode != null &&
          Array.isArray(statusCodes) &&
          !statusCodes.includes(statusCode)
        ) {
          cb(err)
          return
        }

        // If we reached the max number of retries
        if (counter > maxRetries) {
          cb(err)
          return
        }

        let retryAfterHeader = headers?.['retry-after']
        if (retryAfterHeader) {
          retryAfterHeader = Number(retryAfterHeader)
          retryAfterHeader = Number.isNaN(retryAfterHeader)
            ? calculateRetryAfterHeader(retryAfterHeader)
            : retryAfterHeader * 1e3 // Retry-After is in seconds
        }

        const retryTimeout =
          retryAfterHeader > 0
            ? Math.min(retryAfterHeader, maxTimeout)
            : Math.min(minTimeout * timeoutFactor ** (counter - 1), maxTimeout)

        setTimeout(() => cb(null), retryTimeout)
      },
    },
    factory: (connect) => new Agent({
      headersTimeout: 45_000,
      bodyTimeout: 60_000,
      maxRedirections: 5,
      connect,
      factory: (origin, opts) => {
        return patchIfPool(new Pool(origin, opts))
      },
    }),
    proxyTls: connectorOptions,
    requestTls: connectorOptions,
  })

  class RangePolicy extends DefaultRangePolicy {
    getConcurrency() {
      return Math.max(maxConnection / 4, 4)
    }
  }
  proxyControl.add(downloadProxy)
  app.registry.register(kDownloadOptions, {
    rangePolicy: new RangePolicy(2 * 1024 * 1024, Math.max(maxConnection / 4, 4)),
    dispatcher: downloadProxy,
    checkpointHandler: {
      lookup: async (url) => { return undefined },
      put: async (url, checkpoint) => { },
      delete: async (url) => { },
    },
    headers: {
    },
  })

  const getAgentStatus = () => {
    // @ts-ignore
    const clients = downloadProxy.agent[kClients] as Map<string, Dispatcher>
    const result = {} as Record<string, PoolStats>
    for (const [k, v] of clients.entries()) {
      if (v instanceof Pool) {
        const connected = v.stats.connected
        const free = v.stats.free
        const pending = v.stats.pending
        const queued = v.stats.queued
        const running = v.stats.running
        const size = v.stats.size
        const status = { connected, free, pending, queued, running, size }
        result[k] = status
      }
    }
    return result
  }

  downloadProxy.agent.on('drain', (url) => {
    setTimeout(() => {
      // @ts-ignore
      const clients = downloadProxy.agent[kClients] as Map<string, Dispatcher>
      const pool = clients.get(url.origin)
      if (pool instanceof Pool) {
        const stats = pool?.stats
        if (!stats?.connected && !stats?.pending && !stats?.running && !stats?.queued && !stats?.free) {
          pool?.close()
          clients.delete(url.origin)
        }
      } else {
        // @ts-ignore
        const running = pool?.[kRunning]

        if (typeof running === 'number' && running === 0) {
          pool?.close()
          clients.delete(url.origin)
        }
      }
    }, 60_000)
  })

  app.registry.register(kNetworkInterface, {
    getDownloadAgentStatus: getAgentStatus,
    async destroyPool(origin) {
      // @ts-ignore
      const clients = downloadProxy.agent[kClients] as Map<string, Dispatcher>
      const pool = clients.get(origin)
      await Promise.race([pool?.close().then(() => true), timeout(500).then(() => false)]).then((closed) => {
        if (!closed) return pool?.destroy()
      })
      clients.delete(origin)
    },
  })
}
