FROM node:22-bookworm-slim

ARG KAIWU_PROFILE_VERSION=0.5.2-k8s.8
# 构建机上 npm 官方源延迟高（实测元数据请求 3.4s，npmmirror 1.3s），构建内统一换源；
# 仅作用于构建期（运行期无 npm 安装）。如需回官方源：
#   --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV DEBIAN_FRONTEND=noninteractive \
    KAIWU_PROFILE_VERSION=${KAIWU_PROFILE_VERSION} \
    npm_config_registry=${NPM_REGISTRY}

# python3/make/g++ 是 node-gyp 的编译三件套：node-pty@1.1.0 的 npm 包
# prebuilds 只含 darwin/win32、没有 linux-x64，Linux 容器内 install 脚本
# `node scripts/prebuild.js || node-gyp rebuild` 必走源码编译（koffi 同理）。
# socat 用于运行期把外部流量转发给只绑回环的 dsh（见 entrypoint.sh）。
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git openssh-client procps tar \
       python3 make g++ socat \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@12.3.4 @deepseek-ai/dsh@0.1.2-rc.1

WORKDIR /opt/kaiwu-praxis
COPY . .

# dsh-web-app 的 URL 输出依赖 loader settle；在复杂 Kaiwu profile 中可能
# 长时间不触发。这里让 client-connection 在生成 token 时同步写入
# DSH_LAUNCH_TOKEN_FILE，供 entrypoint 稳定写入 Kubernetes Secret。
RUN node deploy/k8s/patch-dsh-client-connection.mjs \
    /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js

RUN npm install --omit=dev

# 构建机访问 GitHub 需要代理时，把代理地址传给 pnpm：
#   docker build --build-arg HTTPS_PROXY=http://<proxy>:<port> ...
ARG HTTPS_PROXY
ENV HTTPS_PROXY=${HTTPS_PROXY} HTTP_PROXY=${HTTPS_PROXY}

# 生成一个只作为镜像模板的 DSH_HOME。
# 版本组合为 0.1.2-rc.1 栈实测组合，勿单独升降（见本地部署流程.md 的版本矩阵）：
#   dsh 0.1.2-rc.1 / web-app 0.1.2-rc.1 / agent-teams 0.1.16-rc.1
#   better-sidebar 0.18.1（0.17.x 报 settingsNamespace 错误；0.19.x 要求 dsh 0.1.5-rc.1）
#   hindsight 0.4.3
# 主插件用 git+ 安装：包被真实复制进 profile 内部，依赖解析完整，
# 可避免 link: 方式下 @deepseek-ai/schemastery（optional peer，npm 不自动安装）
# 的 ERR_MODULE_NOT_FOUND 问题。
# 预写 profile 的 pnpm-workspace.yaml（含 allowBuilds 放行构建脚本）。
# dsh 首次初始化 profile 时对每个文件先 existsSync 再写，已存在的 yaml 不会被覆盖，
# 因此在 add 之前预写即可根治 ERR_PNPM_IGNORED_BUILDS：
#   sharp —— git+ 安装 kaiwu-praxis 时其依赖树触发（报错即 sharp@0.34.5）
#   koffi / node-pty —— hindsight / agent-teams 依赖树触发
# 三个 key 与本机实测 employee profile 的 yaml 完全一致。
RUN mkdir -p /opt/kaiwu-home-template/profiles/employee \
    && printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  node-pty: true\n  sharp: true\n' \
        > /opt/kaiwu-home-template/profiles/employee/pnpm-workspace.yaml
# 在本 RUN 的 shell 内 export DSH_HOME：对后续所有 dsh plugin 生效，
# 但只存在于该构建层进程，不会写入镜像 ENV（避免运行期 Deployment 漏设时兜底失效）。
# 仓库迁移：原地址为前任的 hemuroukLY/kaiwu-praxis，现构建一律拉当前 origin
# （java559/kaiwu-praxis）；改仓库时需同步更新 README 安装命令与交接文档。
RUN export DSH_HOME=/opt/kaiwu-home-template \
    && dsh plugin --profile employee add git+https://github.com/java559/kaiwu-praxis.git \
    && dsh plugin --profile employee add @nanmicoder/dsh-agent-teams@0.1.16-rc.1 \
    && dsh plugin --profile employee add @vectorize-io/hindsight-coding-agents@0.4.3 \
    && dsh plugin --profile employee add dsh-better-sidebar@0.18.1 \
    && dsh plugin --profile employee add @deepseek-ai/dsh-web-app@0.1.2-rc.1 \
    && unset DSH_HOME HTTP_PROXY HTTPS_PROXY

# K8s 生产实例不需要用户 patch 层 live reload。employee profile 重建后
# live watcher 依赖 Cordis HMR 服务；startup 模式只在实际启动时合成 patch，
# 避免复杂 profile 中 HMR 服务缺失导致进程退出。
RUN sed -i 's/"patchReload": "live"/"patchReload": "startup"/' \
    /opt/kaiwu-home-template/profiles/employee/package.json

# employee profile 运行时加载的是 profile 内的 dsh-client-connection，
# 不是全局 DSH 包里的那份；两份都要补，确保 token 文件逻辑实际生效。
RUN node deploy/k8s/patch-dsh-client-connection.mjs \
    /opt/kaiwu-home-template/profiles/employee/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js

# 共享能力目录由 PVC 提供，不能从镜像模板复制覆盖。
RUN rm -rf /opt/kaiwu-home-template/.agent-presets

COPY deploy/k8s/entrypoint.sh /usr/local/bin/kaiwu-entrypoint
RUN chmod +x /usr/local/bin/kaiwu-entrypoint \
    && chown -R node:node /opt/kaiwu-praxis /opt/kaiwu-home-template

USER node
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/kaiwu-entrypoint"]
