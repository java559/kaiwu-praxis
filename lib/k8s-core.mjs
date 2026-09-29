/**
 * 开物 K8s 只读查询核心：集群资源 / Pod 日志（纯函数 + in-cluster SA 适配）。
 *
 * 安全硬边界：只封装 get/list 类调用，代码路径中不存在 create/delete/patch/exec；
 * kind 白名单硬编码，secrets/configmaps 无条件排除；输出一律字段白名单式投影，
 * 绝不回吐原始对象（完整对象内嵌 containers[].env，可能含敏感值）。
 * 403 如实返回 forbidden，不伪造数据；仅网络类失败才降级 demo（带 liveError）。
 */

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const DEFAULT_LOG_TAIL_LINES = 200
const MAX_LOG_TAIL_LINES = 2000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const LOG_LINE_MAX_CHARS = 500

/**
 * kind 只读白名单（硬编码）。group 决定使用哪个 API 客户端；
 * scope=cluster 的 kind 忽略 namespace 参数。
 */
export const KIND_WHITELIST = {
  pods: { group: 'core', all: 'listPodForAllNamespaces', ns: 'listNamespacedPod', scope: 'namespaced' },
  services: { group: 'core', all: 'listServiceForAllNamespaces', ns: 'listNamespacedService', scope: 'namespaced' },
  endpoints: { group: 'core', all: 'listEndpointsForAllNamespaces', ns: 'listNamespacedEndpoints', scope: 'namespaced' },
  events: { group: 'core', all: 'listEventForAllNamespaces', ns: 'listNamespacedEvent', scope: 'namespaced' },
  namespaces: { group: 'core', all: 'listNamespace', ns: null, scope: 'cluster' },
  nodes: { group: 'core', all: 'listNode', ns: null, scope: 'cluster' },
  deployments: { group: 'apps', all: 'listDeploymentForAllNamespaces', ns: 'listNamespacedDeployment', scope: 'namespaced' },
  statefulsets: { group: 'apps', all: 'listStatefulSetForAllNamespaces', ns: 'listNamespacedStatefulSet', scope: 'namespaced' },
  daemonsets: { group: 'apps', all: 'listDaemonSetForAllNamespaces', ns: 'listNamespacedDaemonSet', scope: 'namespaced' },
  replicasets: { group: 'apps', all: 'listReplicaSetForAllNamespaces', ns: 'listNamespacedReplicaSet', scope: 'namespaced' },
  jobs: { group: 'batch', all: 'listJobForAllNamespaces', ns: 'listNamespacedJob', scope: 'namespaced' },
  cronjobs: { group: 'batch', all: 'listCronJobForAllNamespaces', ns: 'listNamespacedCronJob', scope: 'namespaced' },
}

/** Pod 内 SA 文件是否可检测（auto 模式据此判 live）。抽出来便于测试注入。 */
function hasInClusterSa(fsAccess = { existsSync: (p) => false }) {
  try {
    return Boolean(fsAccess.existsSync(SA_TOKEN_PATH))
  } catch {
    return false
  }
}

/**
 * 模式判定：KAIWU_K8S_MODE = auto（默认）/ live / demo / off。
 * auto：Pod 内检测到 SA token 文件 → live，否则 demo（本地无集群时可演示）。
 * live：强制直连，失败如实报错，不降级。
 */
export function k8sModeFromEnv(env = process.env, fsAccess = undefined) {
  const raw = String(env.KAIWU_K8S_MODE || 'auto').toLowerCase()
  if (raw === 'off') return 'off'
  if (raw === 'demo') return 'demo'
  if (raw === 'live') return 'live'
  return hasInClusterSa(fsAccess) ? 'live' : 'demo'
}

export function k8sConfigFromEnv(env = process.env, fsAccess = undefined) {
  const raw = String(env.KAIWU_K8S_MODE || 'auto').toLowerCase()
  const maxLines = Math.min(
    MAX_LOG_TAIL_LINES,
    Math.max(1, Math.round(Number(env.KAIWU_K8S_LOG_MAX_LINES) || DEFAULT_LOG_TAIL_LINES)),
  )
  return {
    mode: k8sModeFromEnv(env, fsAccess),
    // forced=true 表示显式 KAIWU_K8S_MODE=live：失败如实报错，不降级演示数据。
    forced: raw === 'live',
    defaultNamespace: String(env.KAIWU_NAMESPACE || 'kaiwu'),
    logTailLines: maxLines,
  }
}

function clampLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.round(n))
}

function ageOf(iso) {
  const ts = Date.parse(String(iso || ''))
  if (!Number.isFinite(ts)) return ''
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function metaOf(item) {
  return item?.metadata || {}
}

/** 投影：一律字段白名单式，绝不回吐原始对象。 */
export function projectK8sItem(kind, item) {
  const meta = metaOf(item)
  switch (kind) {
    case 'pods':
      return {
        name: meta.name || '',
        namespace: meta.namespace || '',
        phase: item.status?.phase || '',
        ready: `${item.status?.containerStatuses?.filter((c) => c.ready).length ?? 0}/${item.status?.containerStatuses?.length ?? 0}`,
        restarts: (item.status?.containerStatuses || []).reduce((sum, c) => sum + (c.restartCount || 0), 0),
        age: ageOf(meta.creationTimestamp),
        node: item.spec?.nodeName || '',
      }
    case 'deployments':
      return {
        name: meta.name || '',
        namespace: meta.namespace || '',
        replicas: item.spec?.replicas ?? 0,
        readyReplicas: item.status?.readyReplicas ?? 0,
        images: (item.spec?.template?.spec?.containers || []).map((c) => c.image),
        age: ageOf(meta.creationTimestamp),
      }
    case 'events':
      return {
        involvedObject: `${item.involvedObject?.kind || ''}/${item.involvedObject?.name || ''}`,
        reason: item.reason || '',
        type: item.type || '',
        message: String(item.message || '').slice(0, LOG_LINE_MAX_CHARS),
        count: item.count ?? 1,
        lastTimestamp: item.lastTimestamp || item.lastObservedTime || '',
        namespace: meta.namespace || '',
      }
    case 'jobs':
      return {
        name: meta.name || '',
        namespace: meta.namespace || '',
        active: item.status?.active ?? 0,
        succeeded: item.status?.succeeded ?? 0,
        failed: item.status?.failed ?? 0,
        age: ageOf(meta.creationTimestamp),
      }
    case 'statefulsets':
    case 'replicasets':
      return {
        name: meta.name || '',
        namespace: meta.namespace || '',
        replicas: item.spec?.replicas ?? 0,
        readyReplicas: item.status?.readyReplicas ?? 0,
        age: ageOf(meta.creationTimestamp),
      }
    case 'cronjobs':
      return {
        name: meta.name || '',
        namespace: meta.namespace || '',
        active: (item.status?.active || []).length,
        age: ageOf(meta.creationTimestamp),
      }
    default:
      // services / endpoints / daemonsets / namespaces / nodes 等通用兜底：
      // 仅名称与计数类元数据，不回吐任何 spec 字段。
      return {
        name: meta.name || '',
        namespace: meta.namespace || '',
        age: ageOf(meta.creationTimestamp),
      }
  }
}

function isForbidden(error) {
  const status = Number(error?.statusCode ?? error?.status)
  return status === 401 || status === 403
}

function errorStatus(error) {
  const status = Number(error?.statusCode ?? error?.status)
  return Number.isInteger(status) && status >= 400 ? status : null
}

// KubeConfig 懒加载：Pod 内 loadFromDefault() 自动走 in-cluster SA，无需任何 kubeconfig。
let cachedApis = null
async function loadApis() {
  if (!cachedApis) {
    const k8s = await import('@kubernetes/client-node')
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    cachedApis = {
      core: kc.makeApiClient(k8s.CoreV1Api),
      apps: kc.makeApiClient(k8s.AppsV1Api),
      batch: kc.makeApiClient(k8s.BatchV1Api),
    }
  }
  return cachedApis
}

export function pickApi(apis, kind) {
  const group = KIND_WHITELIST[kind].group
  return apis[group]
}

function rejectKind(kind) {
  return {
    mode: 'off',
    error: 'kind_not_allowed',
    kind: String(kind || ''),
    allowedKinds: Object.keys(KIND_WHITELIST),
    message: `kind 仅限只读白名单（不含 secrets/configmaps 与任何写操作）：${Object.keys(KIND_WHITELIST).join(', ')}`,
  }
}

/** 演示样例：与 aiops demo 的「发布后延迟升高」故障链呼应。 */
export function demoK8sResources(kind) {
  const now = Date.now()
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString()
  const data = {
    pods: [
      { name: 'order-service-7d9c6b5f4-xk2vq', namespace: 'demo-app', phase: 'Running', ready: '1/2', restarts: 5, age: '3h', node: 'node-01' },
      { name: 'order-service-6c8f2a1d9-prev', namespace: 'demo-app', phase: 'Running', ready: '2/2', restarts: 0, age: '26h', node: 'node-02' },
      { name: 'kaiwu-console-5797dbbd99-qzmlx', namespace: 'kaiwu', phase: 'Running', ready: '1/1', restarts: 0, age: '5d', node: 'node-01' },
    ],
    deployments: [
      { name: 'order-service', namespace: 'demo-app', replicas: 2, readyReplicas: 1, images: ['registry.demo/order-service:v2.14.3'], age: '26h' },
      { name: 'kaiwu-console', namespace: 'kaiwu', replicas: 1, readyReplicas: 1, images: ['docker.changqingyun.cn/ani/kaiwu-employee:demo'], age: '5d' },
    ],
    events: [
      { involvedObject: 'Pod/order-service-7d9c6b5f4-xk2vq', reason: 'BackOff', type: 'Warning', message: 'Back-off restarting failed container order', count: 7, lastTimestamp: iso(4), namespace: 'demo-app' },
      { involvedObject: 'Deployment/order-service', reason: 'ScalingReplicaSet', type: 'Normal', message: 'Scaled up replica set order-service-7d9c6b5f4 to 1', count: 1, lastTimestamp: iso(16), namespace: 'demo-app' },
    ],
    services: [
      { name: 'order-service', namespace: 'demo-app', age: '30d' },
    ],
    endpoints: [
      { name: 'order-service', namespace: 'demo-app', age: '30d' },
    ],
    namespaces: [
      { name: 'kaiwu', namespace: '', age: '5d' },
      { name: 'demo-app', namespace: '', age: '30d' },
    ],
    nodes: [
      { name: 'node-01', namespace: '', age: '90d' },
      { name: 'node-02', namespace: '', age: '90d' },
    ],
    statefulsets: [{ name: 'order-db', namespace: 'demo-app', replicas: 1, readyReplicas: 1, age: '30d' }],
    daemonsets: [{ name: 'node-agent', namespace: 'kube-system', age: '60d' }],
    replicasets: [
      { name: 'order-service-7d9c6b5f4', namespace: 'demo-app', replicas: 1, readyReplicas: 0, age: '3h' },
      { name: 'order-service-6c8f2a1d9', namespace: 'demo-app', replicas: 1, readyReplicas: 1, age: '26h' },
    ],
    jobs: [{ name: 'order-report-20260929', namespace: 'demo-app', active: 1, succeeded: 0, failed: 0, age: '2h' }],
    cronjobs: [{ name: 'order-report', namespace: 'demo-app', active: 1, age: '30d' }],
  }
  const items = data[kind] || []
  return {
    mode: 'demo',
    kind,
    returned: items.length,
    items,
    queriedAt: new Date(now).toISOString(),
    notes: [
      '演示数据：未检测到 Pod 内 ServiceAccount（或强制 demo 模式）时返回，与运维诊断 demo 故障链呼应。',
    ],
  }
}

export async function queryK8sResources({
  kind,
  namespace = '',
  labelSelector = '',
  limit,
  config = k8sConfigFromEnv(),
  apis = null,
} = {}) {
  const kindName = String(kind || '').trim()
  if (!KIND_WHITELIST[kindName]) return rejectKind(kindName)

  if (config.mode === 'off') {
    return {
      mode: 'off',
      kind: kindName,
      message: 'K8s 只读查询未启用（KAIWU_K8S_MODE=off）。如需启用请联系管理员配置模式与 RBAC。',
    }
  }
  if (config.mode === 'demo') {
    return { ...demoK8sResources(kindName), kind: kindName }
  }

  const spec = KIND_WHITELIST[kindName]
  const clusterScoped = spec.scope === 'cluster'
  const namespaceIgnored = clusterScoped && Boolean(String(namespace || '').trim())
  const queryLimit = clampLimit(limit)

  let clients = apis
  if (!clients) {
    try {
      clients = await loadApis()
    } catch (error) {
      if (config.mode === 'live') {
        return { mode: 'live', kind: kindName, error: 'client_init_failed', liveError: String(error?.message || error) }
      }
      const fallback = demoK8sResources(kindName)
      return {
        ...fallback,
        mode: 'demo_fallback',
        kind: kindName,
        liveError: String(error?.message || error),
      }
    }
  }

  try {
    const client = pickApi(clients, kindName)
    const method = !clusterScoped && namespace ? spec.ns : spec.all
    const params = { limit: queryLimit }
    if (!clusterScoped && namespace) params.namespace = String(namespace).trim()
    if (labelSelector) params.labelSelector = String(labelSelector)
    const body = await client[method](params)
    const items = (Array.isArray(body?.items) ? body.items : []).map((item) => projectK8sItem(kindName, item))
    const result = {
      mode: 'live',
      kind: kindName,
      returned: items.length,
      items,
      queriedAt: new Date().toISOString(),
      notes: ['已直连 K8s API Server 只读查询。结果为字段投影，非原始对象。'],
    }
    if (namespaceIgnored) result.namespaceIgnored = true
    return result
  } catch (error) {
    if (isForbidden(error)) {
      return {
        mode: 'live',
        kind: kindName,
        error: 'forbidden',
        liveStatus: errorStatus(error),
        liveError: String(error?.message || error).slice(0, 300),
        hint: 'RBAC 未授权该资源。kaiwu-k8s-reader 仅授予只读白名单资源；请核对 ClusterRole 规则。',
      }
    }
    if (config.mode === 'live' && config.forced) {
      return {
        mode: 'live',
        kind: kindName,
        error: 'query_failed',
        liveStatus: errorStatus(error),
        liveError: String(error?.message || error).slice(0, 300),
        hint: '强制 live 模式失败如实报错，不降级演示数据。',
      }
    }
    const fallback = demoK8sResources(kindName)
    return {
      ...fallback,
      mode: 'demo_fallback',
      kind: kindName,
      liveStatus: errorStatus(error),
      liveError: String(error?.message || error).slice(0, 300),
    }
  }
}

function clampTailLines(tailLines, config) {
  const n = Number(tailLines)
  if (!Number.isFinite(n) || n <= 0) return config.logTailLines
  return Math.min(MAX_LOG_TAIL_LINES, Math.max(1, Math.round(n)))
}

export function demoK8sLogs(pod, namespace, tailLines) {
  return {
    mode: 'demo',
    pod: String(pod || ''),
    namespace: String(namespace || ''),
    tailLines,
    matchCount: 3,
    entries: [
      { ts: new Date(Date.now() - 12 * 60_000).toISOString(), text: 'ERROR Timeout acquiring DB connection pool for order-service' },
      { ts: new Date(Date.now() - 10 * 60_000).toISOString(), text: 'ERROR Handler failed: connection pool exhausted (max=100)' },
      { ts: new Date(Date.now() - 8 * 60_000).toISOString(), text: 'WARN Retrying downstream call inventory-service after 504' },
    ].slice(-tailLines),
    notes: ['演示数据：未检测到 Pod 内 ServiceAccount（或强制 demo 模式）时返回。'],
  }
}

export async function queryK8sLogs({
  pod,
  namespace,
  container = '',
  tailLines,
  config = k8sConfigFromEnv(),
  apis = null,
} = {}) {
  const podName = String(pod || '').trim()
  const ns = String(namespace || config.defaultNamespace || 'kaiwu').trim()
  const lines = clampTailLines(tailLines, config)

  if (config.mode === 'off') {
    return {
      mode: 'off',
      pod: podName,
      message: 'K8s 只读查询未启用（KAIWU_K8S_MODE=off）。如需启用请联系管理员配置模式与 RBAC。',
    }
  }
  if (config.mode === 'demo') {
    return demoK8sLogs(podName, ns, lines)
  }

  let clients = apis
  if (!clients) {
    try {
      clients = await loadApis()
    } catch (error) {
      return { mode: 'live', pod: podName, error: 'client_init_failed', liveError: String(error?.message || error) }
    }
  }

  try {
    const params = { name: podName, namespace: ns, tailLines: lines }
    if (container) params.container = String(container)
    const text = await clients.core.readNamespacedPodLog(params)
    const entries = String(text || '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ({ text: line.slice(0, LOG_LINE_MAX_CHARS) }))
      .slice(-lines)
    return {
      mode: 'live',
      pod: podName,
      namespace: ns,
      tailLines: lines,
      matchCount: entries.length,
      entries,
      notes: ['已读取 Pod 日志（只读）。每行截断 500 字符。'],
    }
  } catch (error) {
    if (isForbidden(error)) {
      return {
        mode: 'live',
        pod: podName,
        namespace: ns,
        error: 'forbidden',
        liveStatus: errorStatus(error),
        liveError: String(error?.message || error).slice(0, 300),
        hint: 'RBAC 未授权 pods/log 读取。kaiwu-k8s-reader 仅授予 get pods/log；请核对 ClusterRole 规则。',
      }
    }
    if (config.mode === 'live' && config.forced) {
      return {
        mode: 'live',
        pod: podName,
        namespace: ns,
        error: 'query_failed',
        liveStatus: errorStatus(error),
        liveError: String(error?.message || error).slice(0, 300),
        hint: '强制 live 模式失败如实报错，不降级演示数据。',
      }
    }
    const fallback = demoK8sLogs(podName, ns, lines)
    return {
      ...fallback,
      mode: 'demo_fallback',
      liveStatus: errorStatus(error),
      liveError: String(error?.message || error).slice(0, 300),
    }
  }
}
