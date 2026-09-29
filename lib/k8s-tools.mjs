/**
 * 开物 K8s 工具：运维诊断员只读查询集群资源与 Pod 日志（不包含任何写操作）。
 */
import {
  KIND_WHITELIST,
  k8sConfigFromEnv,
  queryK8sLogs,
  queryK8sResources,
} from './k8s-core.mjs'

export const name = 'kaiwu-praxis-k8s-tools'
export const inject = ['tools']

function textBlock(title, value) {
  return [{ type: 'text', text: `${title}\n${JSON.stringify(value, null, 2)}` }]
}

export function apply(ctx, config = {}) {
  const getConfig = () => k8sConfigFromEnv(process.env)

  ctx.tools.register({
    name: 'query_k8s_resources',
    description:
      `只读查询 K8s 集群资源（kind 仅限白名单：${Object.keys(KIND_WHITELIST).join(', ')}；` +
      '不含 secrets/configmaps，无任何写操作)。返回字段投影而非原始对象。' +
      '未检测到集群凭证时返回可演示的样例数据。用于故障诊断时核查 Pod 状态 / 重启 / 事件。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '资源类型，仅限只读白名单，如 pods / deployments / events' },
        namespace: { type: 'string', description: '命名空间；不填查全部命名空间（nodes/namespaces 为集群级，忽略此参数）' },
        labelSelector: { type: 'string', description: 'K8s label 选择器，如 app=order-service' },
        limit: { type: 'integer', description: '返回条数上限，默认 50，最大 200' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlock('【K8s 资源查询】', value),
    },
    async execute(args) {
      return queryK8sResources({
        kind: args.kind,
        namespace: args.namespace,
        labelSelector: args.labelSelector,
        limit: args.limit,
        config: getConfig(),
      })
    },
  })

  ctx.tools.register({
    name: 'query_k8s_logs',
    description:
      '只读读取指定 Pod 的日志（tail）。每行截断 500 字符，行数默认 200、硬上限 2000。' +
      '不含任何写操作。用于解释 Pod 重启 / 异常的具体报错。',
    parameters: {
      type: 'object',
      properties: {
        pod: { type: 'string', description: 'Pod 名称' },
        namespace: { type: 'string', description: '命名空间，默认取 KAIWU_NAMESPACE（kaiwu）' },
        container: { type: 'string', description: '容器名；多容器 Pod 时必填' },
        tailLines: { type: 'integer', description: '读取末尾行数，默认 200，硬上限 2000' },
      },
      required: ['pod'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlock('【K8s Pod 日志】', value),
    },
    async execute(args) {
      return queryK8sLogs({
        pod: args.pod,
        namespace: args.namespace,
        container: args.container,
        tailLines: args.tailLines,
        config: getConfig(),
      })
    },
  })
}
