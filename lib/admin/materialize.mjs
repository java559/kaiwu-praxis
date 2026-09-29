/**
 * 能力播种与 preset 物化（资料 / SOP / 技能 / 工具策略 / profile.json）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ALL_CUSTOM_TOOLS,
  CAPABILITY_VERSION,
  LOCAL_SOURCE,
  PACKAGE_SOURCE,
  SHIPPED_PRESETS,
  WORKER_IDS,
} from './constants.mjs'
import {
  capabilitySummary,
  defaultProfileFor,
  extractPersonaText,
  firstNonEmpty,
  growthTimeline,
  mergeProfile,
  renderIdentityPersona,
  replacePersonaText,
} from './profile.mjs'

export function dshHome() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
}

export function userPresetRoot() {
  return join(dshHome(), '.agent-presets')
}

/** 无工作区时用于临时对话的工作区目录：固定在 DSH 根目录下，方便日后翻找记录。 */
export function tempWorkspaceDir() {
  return join(dshHome(), '临时对话')
}

/** 每位数字员工一个固定子目录，供客户端 createWorkspace 采用（本机 native picker 不能建目录）。 */
export async function ensureWorkerWorkspaceDirs(workerIds = WORKER_IDS) {
  const base = tempWorkspaceDir()
  await mkdir(base, { recursive: true })
  for (const id of workerIds) {
    await mkdir(join(base, id), { recursive: true })
  }
  return base
}

export function sanitizeName(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned === '' ? 'untitled' : cleaned
}

export function materializedDocFileName(name) {
  const safeName = sanitizeName(name)
  return /\.md$/i.test(safeName) ? safeName : `${safeName}.md`
}

function parseSkill(raw, id) {
  let name = ''
  let description = ''
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (m) {
    const fm = m[1]
    const n = /^name:\s*(.+)$/m.exec(fm)
    const d = /^description:\s*(.+)$/m.exec(fm)
    if (n) name = n[1].trim()
    if (d) description = d[1].trim()
  }
  return {
    id,
    name: name || id,
    description,
    content: raw,
    enabled: true,
    deleted: false,
    source: PACKAGE_SOURCE,
    baseVersion: CAPABILITY_VERSION,
    packageVersion: CAPABILITY_VERSION,
    localRevision: 0,
    modified: false,
  }
}

/** 读取交付包技能基线；用户修改只从 settings 合并，不能反向污染官方基线。 */
function readSkillsFor(workerId) {
  const roots = [join(SHIPPED_PRESETS, workerId, 'skills')]
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
      if (dirs.length === 0) continue
      const skills = []
      for (const dir of dirs) {
        const file = join(root, dir.name, 'SKILL.md')
        if (existsSync(file)) skills.push(parseSkill(readFileSync(file, 'utf8'), dir.name))
      }
      if (skills.length > 0) return skills
    } catch {
      // 读失败就试下一个根
    }
  }
  return []
}

const WORKER_TOOLS = {
  'kaiwu-watermark': [
    { name: 'filesystem', description: '读取输入文件与保存处理结果', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载水印处理 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
    { name: 'watermark', description: '批量为 PDF 与图片添加水印', source: '开物本地工具', componentId: '' },
  ],
  'kaiwu-docbutler': [
    { name: 'filesystem', description: '读取输入文件与保存处理结果', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载资料管家 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
    { name: 'file_classify', description: '按规则分类并归档本地文件', source: '开物本地工具', componentId: '' },
    { name: 'batch_rename', description: '批量重命名文件', source: '开物本地工具', componentId: '' },
    { name: 'format_convert', description: '转换常用文件格式', source: '开物本地工具', componentId: '' },
  ],
  'kaiwu-content': [
    { name: 'web', description: '检索公开背景资料并保留来源', source: 'DSH 联网检索', componentId: 'tool-web' },
    { name: 'filesystem', description: '读取企业资料与保存内容产出', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载内容创作 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
  ],
  'kaiwu-competitor': [
    { name: 'web', description: '检索公开竞品信息并保留来源', source: 'DSH 联网检索', componentId: 'tool-web' },
    { name: 'filesystem', description: '读取企业事实与保存分析结果', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载竞品分析 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
  ],
  'kaiwu-research': [
    { name: 'web', description: '多源检索公开行业与客户情报', source: 'DSH 联网检索', componentId: 'tool-web' },
    { name: 'filesystem', description: '读取内部资料与保存情报简报', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载情报采集 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
  ],
  'kaiwu-brand-auditor': [
    { name: 'web', description: '扫描公开品牌与口碑信息', source: 'DSH 联网检索', componentId: 'tool-web' },
    { name: 'filesystem', description: '读取品牌资料与保存诊断报告', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载品牌诊断 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
  ],
  'kaiwu-data-tracker': [
    { name: 'filesystem', description: '读取业务数据并保存台账和汇报材料', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载数据追踪 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
  ],
  'kaiwu-aiops': [
    { name: 'filesystem', description: '读取诊断备注与保存报告草稿', source: 'DSH 文件能力', componentId: 'tool-fs' },
    { name: 'skill', description: '加载 AIOps 故障诊断 SOP', source: 'DSH 技能能力', componentId: 'tool-skill' },
    { name: 'query_metrics', description: '查询服务运行指标（Prometheus 或演示数据）', source: '开物 AIOps 工具', componentId: '' },
    { name: 'search_logs', description: '检索服务错误日志（Loki 或演示数据）', source: '开物 AIOps 工具', componentId: '' },
    { name: 'list_changes', description: '列出近期发布与变更（GitLab 或演示数据）', source: '开物 AIOps 工具', componentId: '' },
    { name: 'propose_remediation', description: '生成处置建议（不自动执行）', source: '开物 AIOps 工具', componentId: '' },
    { name: 'query_k8s_resources', description: '只读查询集群资源（Pod/Deployment/Event 等，白名单硬编码）', source: '开物 K8s 工具', componentId: '' },
    { name: 'query_k8s_logs', description: '只读读取 Pod 日志（tail，每行截断 500 字符）', source: '开物 K8s 工具', componentId: '' },
  ],
}

function seededTool(tool) {
  const runtimeNames = tool.name === 'filesystem'
    ? ['read', 'write', 'edit', 'read_image']
    : tool.name === 'web'
      ? ['web_search', 'web_fetch']
      : [tool.name]
  return {
    id: tool.name,
    ...tool,
    runtimeNames,
    enabled: true,
    baseVersion: CAPABILITY_VERSION,
    packageVersion: CAPABILITY_VERSION,
    localRevision: 0,
    modified: false,
  }
}

export function seededWorkers() {
  const workers = {}
  const today = new Date().toISOString().slice(0, 10)
  for (const id of WORKER_IDS) {
    workers[id] = {
      profile: defaultProfileFor(id, today),
      knowledge: [],
      memories: [],
      sops: [],
      tasks: [],
      skills: readSkillsFor(id),
      tools: (WORKER_TOOLS[id] || []).map(seededTool),
    }
  }
  return workers
}

async function syncDocDir(dir, docs) {
  await mkdir(dir, { recursive: true })
  const wanted = new Set()
  for (const doc of docs || []) {
    const file = materializedDocFileName(doc.name)
    wanted.add(file)
    await writeFile(join(dir, file), String(doc.content ?? ''), 'utf8')
  }
  // 清理该目录下不再存在的 md 文件
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md') && !wanted.has(entry.name)) {
      await rm(join(dir, entry.name), { force: true })
    }
  }
}

export function mergeSkills(shipped, current) {
  const used = new Set()
  const merged = shipped.map((base) => {
    const index = (current || []).findIndex((item, i) => !used.has(i) && ((item.id && item.id === base.id) || (!item.id && item.name === base.name)))
    if (index < 0) return base
    used.add(index)
    const cur = current[index]
    const modified = cur.modified === true && (
      (cur.name || base.name) !== base.name ||
      (cur.description ?? base.description) !== base.description ||
      (cur.content || base.content) !== base.content
    )
    return {
      ...base,
      name: modified ? (cur.name || base.name) : base.name,
      description: modified ? (cur.description ?? base.description) : base.description,
      content: modified ? (cur.content || base.content) : base.content,
      enabled: cur.enabled !== false,
      deleted: cur.deleted === true,
      baseVersion: modified ? (cur.baseVersion || CAPABILITY_VERSION) : CAPABILITY_VERSION,
      packageVersion: CAPABILITY_VERSION,
      localRevision: Number(cur.localRevision) || 0,
      modified,
    }
  })
  for (let i = 0; i < (current || []).length; i += 1) {
    if (used.has(i)) continue
    const cur = current[i]
    // 旧 schema 曾把缺失技能解析成一个全空默认对象；这不是用户资产。
    if (!cur.id && !cur.name && !cur.description && !cur.content) continue
    const normalizedContent = String(cur.content || '').replace(/\r\n/g, '\n').trim()
    const duplicatesPackage = shipped.some((base) => String(base.content || '').replace(/\r\n/g, '\n').trim() === normalizedContent)
    if (/^local-untitled-\d+$/.test(cur.id || '') && cur.name === '未命名技能' && duplicatesPackage) continue
    merged.push({
      id: cur.id || `local-${sanitizeName(cur.name)}-${i + 1}`,
      name: cur.name || '未命名技能',
      description: cur.description || '',
      content: cur.content || '',
      enabled: cur.enabled !== false,
      deleted: cur.deleted === true,
      source: LOCAL_SOURCE,
      baseVersion: cur.baseVersion || '',
      packageVersion: cur.packageVersion || '',
      localRevision: Number(cur.localRevision) || 1,
      modified: true,
    })
  }
  return merged
}

export function mergeTools(shipped, current) {
  return shipped.map((base) => {
    const cur = (current || []).find((item) => (item.id || item.name) === base.id)
    if (!cur) return base
    return {
      ...base,
      enabled: cur.enabled !== false,
      localRevision: Number(cur.localRevision) || 0,
      modified: cur.enabled === false,
    }
  })
}

function skillMarkdown(skill) {
  const raw = String(skill.content || '')
  const header = `---\nname: ${skill.name || skill.id}\ndescription: ${skill.description || ''}\n---`
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(raw)) return raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, header)
  return `${header}\n\n${raw}`
}

async function syncSkills(dir, skills) {
  await mkdir(dir, { recursive: true })
  const wanted = new Set()
  for (const skill of skills || []) {
    const id = sanitizeName(skill.id || skill.name)
    const target = join(dir, id)
    if (skill.enabled === false || skill.deleted === true) {
      await rm(target, { recursive: true, force: true })
      continue
    }
    wanted.add(id)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), skillMarkdown(skill), 'utf8')
    await writeFile(join(target, '.kaiwu-managed'), `${skill.id || id}\n`, 'utf8')
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || wanted.has(entry.name)) continue
    const target = join(dir, entry.name)
    if (existsSync(join(target, '.kaiwu-managed'))) await rm(target, { recursive: true, force: true })
  }
}

function withoutDisabledComponents(raw, tools) {
  const disabled = new Set((tools || []).filter((tool) => tool.enabled === false && tool.componentId).map((tool) => tool.componentId))
  return raw.split(/\r?\n(?=- id: )/).filter((block) => {
    const match = /^- id:\s*([^\r\n]+)/m.exec(block)
    return !match || !disabled.has(match[1].trim())
  }).join('\n')
}

async function syncToolPolicy(root, workerId, tools, profile = {}, displayName = '') {
  const enabled = new Set((tools || []).filter((tool) => tool.enabled !== false).map((tool) => tool.name))
  const disabledTools = (tools || []).filter((tool) => tool.enabled === false).flatMap((tool) => tool.runtimeNames || [tool.name])
  const denyGlobal = ALL_CUSTOM_TOOLS.filter((name) => !enabled.has(name))
  await writeFile(join(root, workerId, 'capabilities.json'), `${JSON.stringify({ workerId, disabledTools, denyGlobal }, null, 2)}\n`, 'utf8')
  const shippedConfig = readFileSync(join(SHIPPED_PRESETS, workerId, 'agent.cordis.yml'), 'utf8')
  const basePersona = extractPersonaText(shippedConfig)
  const identityPersona = renderIdentityPersona(displayName || workerId, profile, basePersona)
  const withPersona = replacePersonaText(shippedConfig, identityPersona)
  await writeFile(join(root, workerId, 'agent.cordis.yml'), withoutDisabledComponents(withPersona, tools), 'utf8')
}

function workerDisplayName(workerId) {
  try {
    const raw = readFileSync(join(SHIPPED_PRESETS, workerId, 'preset.yml'), 'utf8')
    const match = /^name:\s*(.+)$/m.exec(raw)
    return match ? match[1].trim() : workerId
  } catch {
    return workerId
  }
}

export async function materialize(workers) {
  const root = userPresetRoot()
  for (const id of WORKER_IDS) {
    const worker = workers[id] || { knowledge: [], sops: [], skills: [], tools: [], profile: {} }
    await mkdir(join(root, id), { recursive: true })
    const profile = mergeProfile(defaultProfileFor(id), worker.profile || {})
    const caps = capabilitySummary(worker)
    const growth = growthTimeline(worker)
    const displayName = firstNonEmpty(profile.displayName, workerDisplayName(id), id)
    await writeFile(
      join(root, id, 'profile.json'),
      `${JSON.stringify({
        workerId: id,
        displayName,
        ...profile,
        capabilities: {
          skills: caps.skillNames,
          knowledge: caps.knowledgeNames,
          tools: caps.toolNames,
          sops: caps.sopNames,
          tasks: caps.taskNames,
          skillCount: caps.skillCount,
          knowledgeCount: caps.knowledgeCount,
          toolCount: caps.toolCount,
          sopCount: caps.sopCount,
          taskCount: caps.taskCount,
        },
        growth,
      }, null, 2)}\n`,
      'utf8',
    )
    await syncDocDir(join(root, id, 'knowledge'), worker.knowledge)
    await syncDocDir(join(root, id, 'sop'), worker.sops)
    await syncSkills(join(root, id, 'skills'), worker.skills)
    await syncToolPolicy(root, id, worker.tools, profile, displayName)
  }
}

