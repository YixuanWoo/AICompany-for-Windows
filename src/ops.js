// P2-4：常驻运维席位的通用命令构建器。
// 只产出「process」型 adapter 配置；本地执行 / SSH 目标全部来自调用方配置，
// 源码零产品名、零写死的主机名与本机绝对路径（任务书 §6B.2 / §6B.6 / §10.4）。

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildOpsAdapterConfig({
  target = 'local', host = null, user = null, port = 22,
  cwd = null, command,
}) {
  if (!command || typeof command !== 'string') {
    throw new Error('运维席位必须显式提供 command（不写死在源码里）');
  }
  if (target === 'local') {
    return {
      type: 'process',
      config: { command: cwd ? `cd ${shellQuote(cwd)} && ${command}` : command },
    };
  }
  if (target === 'ssh') {
    if (!host) throw new Error('target=ssh 必须提供 host');
    const remote = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
    const who = user ? `${user}@${host}` : host;
    const portArg = port && Number(port) !== 22 ? `-p ${Number(port)} ` : '';
    return {
      type: 'process',
      config: { command: `ssh ${portArg}${who} ${shellQuote(remote)}` },
    };
  }
  throw new Error(`未知运维目标 ${target}；可用：local / ssh`);
}

// 给配置与 CI 用：判断一段命令里有没有把主机名 / 本机绝对路径写死。
export function findHardcodedTarget(text) {
  const patterns = [
    { label: 'IP 地址', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
    { label: 'Windows 盘符路径', re: /[A-Za-z]:[\\/]/ },
    { label: '本机用户目录', re: /\/home\/[a-z0-9_-]+\//i },
  ];
  return patterns.filter((p) => p.re.test(String(text))).map((p) => p.label);
}
