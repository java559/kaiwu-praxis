/**
 * K8s 只读查询核心单测：模式判定矩阵、白名单拒绝、投影正确性、
 * 403 如实返回、demo 降级与强制 live 不降级、日志截断。
 * 全部用 mock apis，不依赖真实集群。
 */
import assert from 'node:assert/strict'
import {
  KIND_WHITELIST,
  demoK8sResources,
  k8sConfigFromEnv,
  k8sModeFromEnv,
  projectK8sItem,
  queryK8sLogs,
  queryK8sResources,
} from '../lib/k8s-core.mjs'

// ---- 模式判定矩阵 ----
assert.equal(k8sModeFromEnv({}), 'demo')                                     // auto + 无 SA 文件 → demo（走真实 node:fs 默认路径）
// 回归：默认 fsAccess 必须接真实 existsSync（曾误接恒 false 的桩导致线上永远 demo）
assert.equal(k8sModeFromEnv({ KAIWU_K8S_MODE: 'auto' }, { existsSync: (p) => p === '/var/run/secrets/kubernetes.io/serviceaccount/token' }), 'live')
assert.equal(k8sModeFromEnv({}, { existsSync: (p) => p.includes('serviceaccount') }), 'live') // auto + SA → live
assert.equal(k8sModeFromEnv({ KAIWU_K8S_MODE: 'live' }), 'live')
assert.equal(k8sModeFromEnv({ KAIWU_K8S_MODE: 'demo' }), 'demo')
assert.equal(k8sModeFromEnv({ KAIWU_K8S_MODE: 'off' }), 'off')
assert.equal(k8sModeFromEnv({ KAIWU_K8S_MODE: 'AUTO' }, { existsSync: (p) => p.includes('serviceaccount') }), 'live') // 大小写不敏感 + mock SA

// 日志行数上限：默认 200、硬上限 2000；forced 仅在显式 live 时为 true
assert.equal(k8sConfigFromEnv({}).logTailLines, 200)
assert.equal(k8sConfigFromEnv({ KAIWU_K8S_LOG_MAX_LINES: '5000' }).logTailLines, 2000)
assert.equal(k8sConfigFromEnv({ KAIWU_K8S_LOG_MAX_LINES: 'abc' }).logTailLines, 200)
assert.equal(k8sConfigFromEnv({ KAIWU_K8S_MODE: 'live' }).forced, true)
assert.equal(k8sConfigFromEnv({ KAIWU_K8S_MODE: 'auto' }, { existsSync: () => true }).forced, false)
assert.equal(k8sConfigFromEnv({}).forced, false)

// ---- 白名单拒绝：不在白名单直接拒绝，且白名单本身不含 secrets/configmaps ----
assert.ok(!KIND_WHITELIST.secrets && !KIND_WHITELIST.configmaps)
for (const bad of ['secrets', 'configmaps', 'Pod', '', 'deployments/status', 'drop table']) {
  const r = await queryK8sResources({ kind: bad, config: { mode: 'live' } })
  assert.equal(r.error, 'kind_not_allowed', `kind=${bad} 应被拒绝`)
  assert.ok(Array.isArray(r.allowedKinds))
}

// ---- demo / off 模式 ----
const demoRes = await queryK8sResources({ kind: 'pods', config: { mode: 'demo' } })
assert.equal(demoRes.mode, 'demo')
assert.ok(demoRes.items.length > 0)
const offRes = await queryK8sResources({ kind: 'pods', config: { mode: 'off' } })
assert.equal(offRes.mode, 'off')
assert.ok(offRes.message.includes('未启用'))
const offLogs = await queryK8sLogs({ pod: 'x', config: { mode: 'off' } })
assert.equal(offLogs.mode, 'off')

// ---- 投影正确性：字段白名单式，不回吐 spec 原始字段 ----
const podItem = projectK8sItem('pods', {
  metadata: { name: 'p1', namespace: 'ns1', creationTimestamp: new Date(Date.now() - 3600_000).toISOString() },
  spec: { nodeName: 'node-1', containers: [{ name: 'c', env: [{ name: 'SECRET_VALUE', value: 'should-not-leak' }] }] },
  status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2 }, { ready: false, restartCount: 3 }] },
})
assert.deepEqual(podItem, {
  name: 'p1', namespace: 'ns1', phase: 'Running', ready: '1/2', restarts: 5, age: '1h', node: 'node-1',
})
assert.equal(Object.values(podItem).some((v) => String(v).includes('should-not-leak')), false)

const depItem = projectK8sItem('deployments', {
  metadata: { name: 'd1', namespace: 'ns1', creationTimestamp: new Date().toISOString() },
  spec: { replicas: 3, template: { spec: { containers: [{ image: 'img:v1' }] } } },
  status: { readyReplicas: 2 },
})
assert.deepEqual(depItem, {
  name: 'd1', namespace: 'ns1', replicas: 3, readyReplicas: 2, images: ['img:v1'], age: '0s',
})

// 兜底投影（services）：仅 name/namespace/age
const svcItem = projectK8sItem('services', {
  metadata: { name: 's1', namespace: 'ns1', creationTimestamp: new Date().toISOString() },
  spec: { clusterIP: '10.0.0.1', ports: [{ port: 80 }] },
})
assert.deepEqual(Object.keys(svcItem).sort(), ['age', 'name', 'namespace'])

// ---- live 查询（mock apis）：全命名空间 / 指定命名空间 / 集群级 namespace 忽略 ----
function mockApis(itemsByMethod) {
  const callLog = []
  const make = (group) => new Proxy({}, {
    get: (_t, method) => async (params) => {
      callLog.push({ group, method, params })
      const item = itemsByMethod[method]
      if (item instanceof Error) throw item
      return { items: item || [] }
    },
  })
  return { apis: { core: make('core'), apps: make('apps'), batch: make('batch') }, callLog }
}

{
  const { apis, callLog } = mockApis({ listPodForAllNamespaces: [{ metadata: { name: 'p1', creationTimestamp: new Date().toISOString() } }] })
  const r = await queryK8sResources({ kind: 'pods', config: { mode: 'live' }, apis })
  assert.equal(r.mode, 'live')
  assert.equal(r.returned, 1)
  assert.equal(r.items[0].name, 'p1')
  assert.equal(callLog[0].method, 'listPodForAllNamespaces')
}
{
  const { apis, callLog } = mockApis({ listNamespacedPod: [] })
  const r = await queryK8sResources({ kind: 'pods', namespace: 'kaiwu', labelSelector: 'app=x', limit: 10, config: { mode: 'live' }, apis })
  assert.equal(r.mode, 'live')
  assert.equal(callLog[0].method, 'listNamespacedPod')
  assert.equal(callLog[0].params.namespace, 'kaiwu')
  assert.equal(callLog[0].params.labelSelector, 'app=x')
  assert.equal(callLog[0].params.limit, 10)
}
{
  const { apis, callLog } = mockApis({ listNode: [] })
  const r = await queryK8sResources({ kind: 'nodes', namespace: 'kaiwu', config: { mode: 'live' }, apis })
  assert.equal(r.mode, 'live')
  assert.equal(r.namespaceIgnored, true)   // 集群级 kind：namespace 显式忽略并标注
  assert.equal(callLog[0].method, 'listNode')
}
{
  const { apis, callLog } = mockApis({ listNamespacedCronJob: [] })
  const r = await queryK8sResources({ kind: 'cronjobs', namespace: 'demo', config: { mode: 'live' }, apis })
  assert.equal(r.mode, 'live')
  assert.equal(callLog[0].group, 'batch')
}

// ---- 403 如实返回 forbidden，不伪造数据 ----
{
  const forbidden = Object.assign(new Error('HTTP 403'), { statusCode: 403 })
  const { apis } = mockApis({ listPodForAllNamespaces: forbidden })
  const r = await queryK8sResources({ kind: 'pods', config: { mode: 'live' }, apis })
  assert.equal(r.mode, 'live')
  assert.equal(r.error, 'forbidden')
  assert.equal(r.items, undefined)
  assert.ok(r.hint.includes('RBAC'))
}

// ---- 网络类失败：auto→live 降级 demo_fallback 带 liveError；强制 live 不降级 ----
{
  const netErr = Object.assign(new Error('fetch failed'), { statusCode: 503 })
  const { apis } = mockApis({ listPodForAllNamespaces: netErr })
  const autoDown = await queryK8sResources({ kind: 'pods', config: { mode: 'live', forced: false }, apis })
  assert.equal(autoDown.mode, 'demo_fallback')
  assert.ok(autoDown.liveError.includes('fetch failed'))
  assert.ok(autoDown.items.length > 0)
  const { apis: apis2 } = mockApis({ listPodForAllNamespaces: netErr })
  const forced = await queryK8sResources({ kind: 'pods', config: { mode: 'live', forced: true }, apis: apis2 })
  assert.equal(forced.mode, 'live')
  assert.equal(forced.error, 'query_failed')
  assert.equal(forced.items, undefined)
  const { apis: apis3 } = mockApis({ listPodForAllNamespaces: netErr })
  const demo = await queryK8sResources({ kind: 'pods', config: { mode: 'demo' }, apis: apis3 })
  assert.equal(demo.mode, 'demo')
}

// ---- 日志：截断、tailLines 钳制、403 与降级 ----
{
  const longLine = 'x'.repeat(900)
  const logApi = { core: { readNamespacedPodLog: async (p) => `${longLine}\nshort\n`.repeat(1) } }
  const r = await queryK8sLogs({ pod: 'p1', namespace: 'ns1', tailLines: 10, config: { mode: 'live' }, apis: logApi })
  assert.equal(r.mode, 'live')
  assert.equal(r.entries.length, 2)
  assert.ok(r.entries[0].text.length <= 500)
  assert.equal(r.entries[0].text.length, 500)
}
{
  const forbidden = Object.assign(new Error('HTTP 403'), { statusCode: 403 })
  const logApi = { core: { readNamespacedPodLog: async () => { throw forbidden } } }
  const r = await queryK8sLogs({ pod: 'p1', config: { mode: 'live' }, apis: logApi })
  assert.equal(r.error, 'forbidden')
  assert.equal(r.entries, undefined)
}
{
  const netErr = Object.assign(new Error('connect ECONNREFUSED'), { statusCode: 500 })
  const logApi = { core: { readNamespacedPodLog: async () => { throw netErr } } }
  const r = await queryK8sLogs({ pod: 'p1', namespace: 'ns1', tailLines: 2, config: { mode: 'live', forced: false }, apis: logApi })
  assert.equal(r.mode, 'demo_fallback')
  assert.ok(r.liveError.includes('ECONNREFUSED'))
  const forced = await queryK8sLogs({ pod: 'p1', namespace: 'ns1', config: { mode: 'live', forced: true }, apis: logApi })
  assert.equal(forced.error, 'query_failed')
  assert.equal(forced.entries, undefined)
}
const demoLogs = await queryK8sLogs({ pod: 'p1', config: { mode: 'demo' } })
assert.equal(demoLogs.mode, 'demo')

// ---- demo 样例覆盖全部白名单 kind ----
for (const kind of Object.keys(KIND_WHITELIST)) {
  const d = demoK8sResources(kind)
  assert.ok(Array.isArray(d.items), `demo 样例缺少 kind=${kind}`)
}

console.log('test-k8s: ok')
