#!/usr/bin/env node
/**
 * 本地端口控制台 —— 零依赖 Node 后端
 * 读 services.json，提供 启动 / 停止 / 重启 / 全量操作 / 日志 / 实时状态
 * 只监听 127.0.0.1，命令只来自本地配置文件，不对公网暴露。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 打包成 .app 后应用目录是只读的，数据（清单/日志）统一放到可写目录
const DATA_DIR = process.env.PORTCONSOLE_DATA || ROOT;
const CONFIG_PATH = path.join(DATA_DIR, 'services.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4318);
const LSOF = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';

fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ services: [] }, null, 2)}\n`, 'utf8');
}

/** id -> { pid, startedAt, exited, error } */
const children = new Map();
let SELF_PGID = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------- 配置 ---------------------------------- */

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(`读不到配置文件：${CONFIG_PATH}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`services.json 不是合法 JSON：${e.message}`);
  }
  if (!cfg || !Array.isArray(cfg.services)) throw new Error('services.json 缺少 services 数组');

  const seen = new Set();
  for (const s of cfg.services) {
    for (const k of ['id', 'name', 'command', 'port']) {
      if (!s[k]) throw new Error(`服务缺少字段 ${k}：${JSON.stringify(s)}`);
    }
    if (Number(s.port) < 1 || Number(s.port) > 65535) throw new Error(`端口非法：${s.id}`);
    if (seen.has(s.id)) throw new Error(`服务 id 重复：${s.id}`);
    seen.add(s.id);
  }
  return cfg;
}

function findService(id) {
  const svc = loadConfig().services.find((s) => s.id === id);
  if (!svc) throw new Error(`没有这个服务：${id}`);
  return svc;
}

function expandPath(p) {
  if (!p) return ROOT;
  if (p.startsWith('~')) return path.join(process.env.HOME || '', p.slice(1));
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

/* -------------------------------- 进程探测 -------------------------------- */

function listListenerPids(port) {
  return new Promise((resolve) => {
    execFile(
      LSOF,
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { timeout: 4000 },
      (err, stdout) => {
        const pids = String(stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0);
        resolve([...new Set(pids)]);
      }
    );
  });
}

function procInfo(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,comm=,etime=', '-p', String(pid)], { timeout: 3000 }, (err, out) => {
      const line = String(out || '').trim();
      if (!line) return resolve(null);
      const parts = line.split(/\s+/);
      if (parts.length < 3) return resolve(null);
      resolve({
        pid: Number(parts[0]),
        comm: parts.slice(1, -1).join(' '),
        etime: parts[parts.length - 1],
      });
    });
  });
}

function pgidOf(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pgid=', '-p', String(pid)], { timeout: 3000 }, (err, out) => {
      const n = Number(String(out || '').trim());
      resolve(Number.isInteger(n) && n > 0 ? n : null);
    });
  });
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await listListenerPids(port);
    if (pids.length === 0) return true;
    await sleep(300);
  }
  return (await listListenerPids(port)).length === 0;
}

/* --------------------------------- 状态 ---------------------------------- */

async function buildState() {
  const cfg = loadConfig();
  const services = [];

  for (const svc of cfg.services) {
    const pids = await listListenerPids(svc.port);
    const rec = children.get(svc.id);
    const recAlive = rec ? isAlive(rec.pid) : false;

    let status = 'stopped';
    if (pids.length > 0) status = 'running';
    else if (recAlive) status = 'starting';

    let proc = null;
    if (pids.length > 0) proc = await procInfo(pids[0]);

    services.push({
      id: svc.id,
      name: svc.name,
      note: svc.note || '',
      port: Number(svc.port),
      command: svc.command,
      cwd: svc.cwd ? expandPath(svc.cwd) : inferProjectDir(svc.command),
      url: svc.url || `http://localhost:${svc.port}`,
      status,
      pid: proc?.pid ?? rec?.pid ?? null,
      process: proc?.comm ?? null,
      uptime: proc?.etime ?? (recAlive ? fmtElapsed(Date.now() - rec.startedAt) : null),
      managed: Boolean(recAlive || (rec && status === 'running')),
      exited: rec?.exited ?? null,
      error: rec?.error ?? null,
    });
  }

  return { services, consolePort: PORT, configPath: CONFIG_PATH, logDir: LOG_DIR };
}

/* ------------------------------- 启停实现 -------------------------------- */

async function startService(svc, { quiet = false } = {}) {
  const occupied = await listListenerPids(svc.port);
  if (occupied.length > 0) {
    throw new Error(`端口 ${svc.port} 已被占用（PID ${occupied.join(', ')}），先停止占用进程再启动`);
  }

  const cwd = expandPath(svc.cwd || inferProjectDir(svc.command));
  if (!fs.existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`);

  const logPath = path.join(LOG_DIR, `${svc.id}.log`);
  const fd = fs.openSync(logPath, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toLocaleString('zh-CN')} 启动：${svc.command} =====\n`);

  const child = spawn('/bin/zsh', ['-lc', svc.command], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...(svc.env || {}) },
  });

  const rec = { pid: child.pid, startedAt: Date.now(), exited: null, error: null };
  children.set(svc.id, rec);
  child.unref();

  child.on('exit', (code) => {
    rec.exited = code;
    try {
      fs.closeSync(fd);
    } catch {
      /* fd 已关闭 */
    }
  });
  child.on('error', (err) => {
    rec.error = err.message;
    try {
      fs.closeSync(fd);
    } catch {
      /* fd 已关闭 */
    }
  });

  const timeout = Number(svc.startTimeout || 25000);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(400);
    const pids = await listListenerPids(svc.port);
    if (pids.length > 0) {
      return { id: svc.id, started: true, pid: pids[0], waited: timeout - (deadline - Date.now()) };
    }
    if (!isAlive(child.pid)) {
      children.delete(svc.id);
      if (rec.error) throw new Error(`启动失败：${rec.error}`);
      throw new Error(
        `进程已退出（退出码 ${rec.exited === null ? '未知' : rec.exited}）且端口 ${svc.port} 未监听，请查看日志`
      );
    }
  }

  // 超时：进程还活着但端口没起来，保留进程让用户看日志
  if (isAlive(child.pid)) {
    return { id: svc.id, started: false, timeout: true, pid: child.pid, timeoutMs: timeout };
  }
  children.delete(svc.id);
  throw new Error(`启动超时（${timeout}ms）且进程已退出，请查看日志`);
}

async function stopService(svc) {
  const rec = children.get(svc.id);
  const listeners = await listListenerPids(svc.port);
  const targets = new Set(listeners);
  if (rec && isAlive(rec.pid)) targets.add(rec.pid);

  if (targets.size === 0) {
    children.delete(svc.id);
    return { id: svc.id, stopped: true, already: true };
  }

  // 只有本控制台亲自拉起的进程（detached 后 pgid === 子进程 pid）才按进程组杀；
  // 扫描发现的系统进程/其它进程一律只杀监听进程本身，绝不碰更大的进程组（尤其 pgid 1 = launchd）。
  const groupOf = async (pid) => {
    const pgid = await pgidOf(pid);
    return pgid && pgid > 1 && pgid !== SELF_PGID && pgid === pid ? pgid : null;
  };

  // 第一轮：SIGTERM
  let groupPid = rec && isAlive(rec.pid) ? await groupOf(rec.pid) : null;
  if (groupPid) {
    try {
      process.kill(-groupPid, 'SIGTERM');
    } catch {
      /* 组已消失，回退单进程 */
    }
  }
  for (const pid of targets) {
    if (groupPid && pid === groupPid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 进程已退出 */
    }
  }

  if (await waitPortFree(svc.port, 6000)) {
    children.delete(svc.id);
    return { id: svc.id, stopped: true };
  }

  // 第二轮：SIGKILL
  const leftover = await listListenerPids(svc.port);
  const killTargets = new Set(leftover);
  if (rec && isAlive(rec.pid)) killTargets.add(rec.pid);

  groupPid = rec && isAlive(rec.pid) ? await groupOf(rec.pid) : null;
  if (groupPid) {
    try {
      process.kill(-groupPid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  for (const pid of killTargets) {
    if (groupPid && pid === groupPid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }

  if (!(await waitPortFree(svc.port, 3000))) {
    const left = await listListenerPids(svc.port);
    throw new Error(`端口 ${svc.port} 仍在监听（PID ${left.join(', ')}），可能属于其他用户，需要更高权限`);
  }

  children.delete(svc.id);
  return { id: svc.id, stopped: true };
}

async function restartService(svc) {
  await stopService(svc);
  return startService(svc);
}

/* ------------------------------- 端口发现 -------------------------------- */

let scanCache = { at: 0, data: null };

function readListening() {
  return new Promise((resolve) => {
    execFile(
      LSOF,
      ['-nP', '-iTCP', '-sTCP:LISTEN'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 8000 },
      (err, out) => resolve(String(out || ''))
    );
  });
}

function readProcessTable() {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,etime=,command='],
      { maxBuffer: 8 * 1024 * 1024, timeout: 6000 },
      (err, out) => {
        const map = new Map();
        for (const line of String(out || '').split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const sp = t.split(/\s+/);
          if (sp.length < 3) continue;
          const pid = Number(sp[0]);
          if (!Number.isInteger(pid)) continue;
          map.set(pid, { etime: sp[1], command: sp.slice(2).join(' ') });
        }
        resolve(map);
      }
    );
  });
}

function cwdOf(pid) {
  return new Promise((resolve) => {
    execFile(LSOF, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (err, out) => {
      const line = String(out || '').split('\n').find((l) => l.startsWith('n'));
      resolve(line ? line.slice(1) : null);
    });
  });
}

const PROJECT_MARKERS = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Pipfile',
  'Makefile', 'CMakeLists.txt', 'platformio.ini', 'pom.xml', 'build.gradle', 'settings.gradle',
  'pubspec.yaml', 'Package.swift', 'compose.yaml', 'docker-compose.yml', 'mix.exs', 'Gemfile',
];

function hasProjectMarker(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.includes('.git')) return true;
    if (entries.some((n) => PROJECT_MARKERS.includes(n))) return true;
    return entries.some((n) => /\.(xcodeproj|xcworkspace)$/.test(n));
  } catch {
    return false;
  }
}

/** 从进程命令行里反推项目根目录：取第一个存在的 /Users/... 路径，向上找项目标记文件 */
function inferProjectDir(command) {
  const tokens = String(command || '').split(/\s+/);
  for (const raw of tokens) {
    const clean = raw.replace(/^['"]/, '').replace(/['",;)]+$/, '');
    if (!clean.startsWith('/Users/') || !fs.existsSync(clean)) continue;

    let dir;
    try {
      dir = fs.statSync(clean).isDirectory() ? clean : path.dirname(clean);
    } catch {
      continue;
    }

    let cur = dir;
    for (let i = 0; i < 7; i += 1) {
      if (hasProjectMarker(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur || !parent.startsWith('/Users/')) break;
      cur = parent;
    }
    return dir;
  }
  return null;
}

async function scanPorts(force) {
  if (!force && scanCache.data && Date.now() - scanCache.at < 4000) return scanCache.data;

  const [lsofOut, procTable] = await Promise.all([readListening(), readProcessTable()]);

  const rows = new Map();
  for (const line of lsofOut.split('\n')) {
    if (!line.trim() || line.startsWith('COMMAND')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid)) continue;
    const name = parts.slice(8).join(' ');
    const m = name.match(/:(\d+)\s*(?:\(LISTEN\))?$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (port === PORT) continue;
    if (rows.has(port)) continue;

    const ps = procTable.get(pid);
    const fullCommand = ps?.command || parts[0];
    const procName = path.basename(String(fullCommand).split(' ')[0] || parts[0]);

    rows.set(port, {
      port,
      pid,
      user: parts[2],
      process: procName,
      command: fullCommand,
      uptime: ps?.etime || null,
      managedId: null,
    });
  }

  const list = [...rows.values()].sort((a, b) => a.port - b.port).slice(0, 80);
  await Promise.all(
    list.map(async (r) => {
      const cwd = await cwdOf(r.pid);
      const usable = cwd && cwd !== '/' && fs.existsSync(cwd);
      r.cwd = usable ? cwd : inferProjectDir(r.command);
    })
  );

  // 所有正在监听的端口默认就是清单成员：这里把它们同步进 services.json
  const cfgAfter = syncAutoServices(list);
  const idByPort = new Map(cfgAfter.services.map((s) => [Number(s.port), s.id]));
  for (const r of list) r.managedId = idByPort.get(r.port) || null;

  scanCache = { at: Date.now(), data: list };
  return list;
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

const AUTO_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_MAX = 80;

/** 命令指纹：忽略自己监听的端口号，用来识别「同一个程序换了个端口」 */
function cmdSignature(command, port) {
  const p = Number(port);
  return String(command || '').replace(new RegExp(`\\b${p}\\b`, 'g'), '#port#');
}

/**
 * 把当前所有监听端口并进 services.json：新端口自动建条目，已存在的自动条目同步命令/目录。
 * 只动 auto:true 的条目，手工写的配置不会被覆盖。
 */
function syncAutoServices(rows) {
  const cfg = loadConfig();
  const byPort = new Map(cfg.services.map((s) => [Number(s.port), s]));
  const now = Date.now();
  const currentPorts = new Set(rows.map((r) => r.port));
  const seen = new Set();
  let changed = false;

  for (const row of rows) {
    seen.add(row.port);
    let exist = byPort.get(row.port);

    if (exist && !exist.auto) continue;

    if (!exist) {
      // 同一条命令换了个端口（典型是 macOS 守护进程重新绑定，如 rapportd）：
      // 优先复用那条已经不在监听的 auto 条目，而不是再堆一张死卡
      const candidate = cfg.services
        .filter(
          (s) =>
            s.auto &&
            !currentPorts.has(Number(s.port)) &&
            !children.has(s.id) &&
            cmdSignature(s.command, s.port) === cmdSignature(row.command, row.port)
        )
        .sort((a, b) => Number(a.lastSeen || 0) - Number(b.lastSeen || 0))[0];

      if (candidate) {
        const oldPort = Number(candidate.port);
        let id = `auto-${row.port}`;
        let n = 2;
        while (cfg.services.some((s) => s.id === id && s !== candidate)) id = `auto-${row.port}-${n++}`;
        candidate.id = id;
        candidate.port = row.port;
        candidate.name = row.process || candidate.name;
        candidate.cwd = row.cwd || null;
        candidate.url = `http://localhost:${row.port}`;
        candidate.lastSeen = now;
        if (oldPort !== row.port) byPort.delete(oldPort);
        byPort.set(row.port, candidate);
        exist = candidate;
        changed = true;
      }
    }

    if (exist) {
      const nextCwd = row.cwd || null;
      const nextName = row.process || exist.name;
      if (exist.command !== row.command || (exist.cwd || null) !== nextCwd || exist.name !== nextName) {
        exist.command = row.command;
        exist.cwd = nextCwd;
        exist.name = nextName;
        changed = true;
      }
      // lastSeen 每小时刷一次就够了，避免每轮扫描都写文件
      if (!exist.lastSeen || now - Number(exist.lastSeen) > 3600 * 1000) {
        exist.lastSeen = now;
        changed = true;
      }
      continue;
    }

    let id = `auto-${row.port}`;
    let n = 2;
    while (cfg.services.some((s) => s.id === id)) id = `auto-${row.port}-${n++}`;

    const entry = {
      id,
      name: row.process || `端口 ${row.port}`,
      port: row.port,
      cwd: row.cwd || null,
      command: row.command,
      url: `http://localhost:${row.port}`,
      auto: true,
      addedAt: now,
      lastSeen: now,
    };
    cfg.services.push(entry);
    byPort.set(row.port, entry);
    changed = true;
  }

  // 清理：同一条命令已经换了端口占着卡位的旧条目，或 7 天没再监听的临时端口
  const seenCommands = new Set(
    cfg.services
      .filter((s) => s.auto && seen.has(Number(s.port)))
      .map((s) => cmdSignature(s.command, s.port))
  );
  const kept = cfg.services.filter((s) => {
    if (!s.auto || seen.has(Number(s.port))) return true;
    if (seenCommands.has(cmdSignature(s.command, s.port))) return false; // 同程序仍在跑，只是换了端口
    return now - Number(s.lastSeen || 0) <= AUTO_KEEP_MS;
  });
  if (kept.length !== cfg.services.length) {
    cfg.services = kept;
    changed = true;
  }

  // 再兜一层总数上限：超出时先丢最久没出现过的
  const autos = cfg.services.filter((s) => s.auto);
  if (autos.length > AUTO_MAX) {
    const spare = autos
      .filter((s) => !seen.has(Number(s.port)))
      .sort((a, b) => Number(a.lastSeen || 0) - Number(b.lastSeen || 0));
    const drop = new Set(spare.slice(0, autos.length - AUTO_MAX).map((s) => s.id));
    if (drop.size) {
      cfg.services = cfg.services.filter((s) => !drop.has(s.id));
      changed = true;
    }
  }

  if (changed) atomicWrite(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg;
}

async function killPort(port) {
  const target = Number(port);
  if (target === PORT) throw new Error(`端口 ${PORT} 是当前控制台自身，不能结束自己`);
  const pids = await listListenerPids(target);
  if (!pids.length) return { port: target, killed: false, already: true };

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
  if (await waitPortFree(target, 5000)) return { port: target, killed: true };

  for (const pid of await listListenerPids(target)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  if (!(await waitPortFree(target, 2500))) {
    const left = await listListenerPids(target);
    throw new Error(`端口 ${target} 仍在监听（PID ${left.join(', ')}），可能属于系统进程，需要更高权限`);
  }
  return { port: target, killed: true, forced: true };
}

async function revealTarget(kind, payload) {
  let dir = null;

  if (kind === 'service') {
    const svc = findService(String(payload.id || ''));
    dir = svc.cwd ? expandPath(svc.cwd) : inferProjectDir(svc.command);
    if (!dir) throw new Error('这个进程没有可用的项目目录，无法在访达中打开');
  } else {
    const port = Number(payload.port);
    const row = (await scanPorts(false)).find((r) => r.port === port);
    if (!row) throw new Error(`端口 ${port} 目前没有进程在监听`);
    dir = row.cwd || inferProjectDir(row.command);
  }

  if (!dir) throw new Error('拿不到该进程的工作目录，可能是系统进程或权限不足');

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`目录不存在：${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是文件夹：${dir}`);

  spawn('/usr/bin/open', [dir], { detached: true, stdio: 'ignore' }).unref();
  return { dir };
}

/* --------------------------------- 日志 ---------------------------------- */
function readLogTail(id, lines = 200) {
  const svc = findService(id);
  const file = path.join(LOG_DIR, `${svc.id}.log`);
  if (!fs.existsSync(file)) return { id, text: '', exists: false };
  const content = fs.readFileSync(file, 'utf8');
  const arr = content.split('\n');
  return { id, exists: true, text: arr.slice(-lines).join('\n') };
}

/* --------------------------------- HTTP ---------------------------------- */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function handleAction(id, action) {
  const svc = findService(id);
  if (Number(svc.port) === PORT) {
    throw new Error(`端口 ${PORT} 是当前控制台自身，不能从自己里面停止自己`);
  }
  if (action === 'start') return startService(svc);
  if (action === 'stop') return stopService(svc);
  if (action === 'restart') return restartService(svc);
  throw new Error(`未知操作：${action}`);
}

async function handleAll(action) {
  const cfg = loadConfig();
  if (action !== 'start' && action !== 'stop') throw new Error(`未知操作：${action}`);

  const results = [];
  // 启动按配置顺序（配置顺序即启动顺序）；停止按倒序，先停后依赖的
  // 永远跳过控制台自己的端口，否则批量停止会把正在提供界面的进程一起结束
  const list = (action === 'start' ? cfg.services : [...cfg.services].reverse())
    .filter((svc) => Number(svc.port) !== PORT);

  for (const svc of list) {
    const pids = await listListenerPids(svc.port);
    const rec = children.get(svc.id);
    const recAlive = Boolean(rec && isAlive(rec.pid));

    // 已经在跑的跳过，不在跑的不用停；批量操作只处理真正需要动作的
    if (action === 'start' && pids.length > 0) {
      results.push({ id: svc.id, ok: true, skipped: true });
      continue;
    }
    if (action === 'stop' && pids.length === 0 && !recAlive) {
      results.push({ id: svc.id, ok: true, skipped: true });
      continue;
    }

    try {
      const r = action === 'start' ? await startService(svc) : await stopService(svc);
      results.push({ id: svc.id, ok: true, detail: r });
    } catch (e) {
      results.push({ id: svc.id, ok: false, error: e.message });
    }
  }
  return { action, results };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const file = path.join(PUBLIC_DIR, 'index.html');
      const html = fs.readFileSync(file, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      await scanPorts(false); // 顺手把新出现的监听端口并进清单，保证 state 和 scan 一致
      sendJson(res, 200, { ok: true, data: await buildState() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/logs') {
      const id = url.searchParams.get('id') || '';
      const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines') || 200)));
      sendJson(res, 200, { ok: true, data: readLogTail(id, lines) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readBody(req);
      const result = await handleAction(String(body.id || ''), String(body.action || ''));
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/all') {
      const body = await readBody(req);
      const result = await handleAll(String(body.action || ''));
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/scan') {
      sendJson(res, 200, { ok: true, data: { ports: await scanPorts(false) } });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/reveal') {
      const body = await readBody(req);
      const result = await revealTarget(String(body.kind || 'port'), body);
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/scan/kill') {
      const body = await readBody(req);
      const result = await killPort(Number(body.port));
      scanCache = { at: 0, data: null };
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    sendJson(res, 404, { ok: false, error: `未找到：${pathname}` });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, async () => {
  SELF_PGID = (await pgidOf(process.pid)) || 0;
  console.log(`\n  本地端口控制台 → http://${HOST}:${PORT}`);
  console.log(`  配置文件     → ${CONFIG_PATH}`);
  console.log(`  日志目录     → ${LOG_DIR}`);
  console.log(`  按 Ctrl+C 关闭控制台（已启动的服务不会被杀）\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 被占用，换一个：PORT=4319 node server.mjs\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n控制台已关闭，服务仍在后台运行。');
    process.exit(0);
  });
}
