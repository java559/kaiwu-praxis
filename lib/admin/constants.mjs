/**
 * 员工设置 / 物化共用常量。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NS = 'kaiwu-praxis'
export const HERE = dirname(fileURLToPath(import.meta.url))
export const SHIPPED_PRESETS = join(HERE, '..', '..', 'presets')
export const CAPABILITY_VERSION = '0.2.0'
export const LOCAL_SOURCE = 'local'
export const PACKAGE_SOURCE = 'package'

export const WORKER_IDS = [
  'kaiwu-watermark',
  'kaiwu-docbutler',
  'kaiwu-content',
  'kaiwu-competitor',
  'kaiwu-research',
  'kaiwu-brand-auditor',
  'kaiwu-data-tracker',
  'kaiwu-aiops',
]

export const ALL_CUSTOM_TOOLS = [
  'batch_rename',
  'format_convert',
  'watermark',
  'file_classify',
  'query_metrics',
  'search_logs',
  'list_changes',
  'propose_remediation',
  'query_k8s_resources',
  'query_k8s_logs',
]
