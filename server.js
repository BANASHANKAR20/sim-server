'use strict';
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5500,http://localhost:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

const STEP_TIMEOUT_MS = 10000;   // each compile/run step
const MAX_LOG = 100000;          // characters of console output returned
const MAX_VCD = 3000000;         // bytes of waveform data returned
const MAX_BUSY = 2;              // simulations running at once
const VHDL_STOP = '1us';         // VHDL clocks never stop, so we stop the run
const NAME = /^[A-Za-z0-9_.-]{1,60}$/;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) console.warn('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) { res.set('Access-Control-Allow-Origin', o); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Only signed-in club members may run code: ask Supabase who owns this token.
async function userId(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + m[1], apikey: SUPABASE_ANON_KEY }
    });
    if (!r.ok) return null;
    return (await r.json()).id || null;
  } catch { return null; }
}

const hits = new Map();
function limited(id) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const a = (hits.get(id) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(id, a);
  return a.length > 10;            // 10 runs per minute per member
}

// Run one tool with limits and an empty environment (no secrets visible to it).
function run(cmd, args, cwd) {
  return new Promise(resolve => {
    const p = spawn('prlimit', ['--as=2147483648', '--cpu=10', '--fsize=20000000', '--nproc=64', '--', cmd, ...args],
      { cwd, env: { PATH: '/usr/bin:/bin' }, detached: true });
    let out = '', timedOut = false;
    const add = d => { if (out.length < MAX_LOG) out += d; };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, STEP_TIMEOUT_MS);
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: out + String(e), timedOut }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, timedOut }); });
  });
}

async function simulate(language, files, dir) {
  let log = '';
  const step = async (cmd, args) => {
    log += '$ ' + [cmd, ...args].join(' ') + '\n';
    const r = await run(cmd, args, dir);
    log += r.out + '\n';
    if (r.timedOut) log += `[Stopped after ${STEP_TIMEOUT_MS / 1000} s. Does your testbench call $finish?]\n`;
    return r.code === 0 && !r.timedOut;
  };
  let ok = false;
  if (language === 'verilog') {
    const src = files.filter(f => /\.(v|sv)$/i.test(f.path)).map(f => f.path);
    if (!src.length) return { ok, log: 'No .v or .sv files in this project.' };
    ok = await step('iverilog', ['-g2012', '-o', 'sim.vvp', ...src]) && await step('vvp', ['-n', 'sim.vvp']);
  } else {
    const src = files.filter(f => /\.(vhd|vhdl)$/i.test(f.path));
    if (!src.length) return { ok, log: 'No .vhd or .vhdl files in this project.' };
    const names = [...src.map(f => f.content).join('\n').matchAll(/^\s*entity\s+(\w+)\s+is/gim)].map(m => m[1]);
    const top = names.find(n => /(^tb_|_tb$|^tb$|test)/i.test(n)) || names[names.length - 1];
    if (!top) return { ok, log: 'No entity found in the VHDL files.' };
    await fs.mkdir(path.join(dir, 'work'));
    const base = ['--std=08', '--workdir=work'];
    ok = await step('ghdl', ['-i', ...base, ...src.map(f => f.path)])
      && await step('ghdl', ['-m', ...base, top])
      && await step('ghdl', ['-r', ...base, top, '--vcd=wave.vcd', '--stop-time=' + VHDL_STOP]);
  }
  return { ok, log };
}

let busy = 0;
app.post('/simulate', async (req, res) => {
  const id = await userId(req);
  if (!id) return res.status(401).json({ error: 'Please sign in again.' });
  if (limited(id)) return res.status(429).json({ error: 'Too many runs. Wait a minute and try again.' });

  const { language, files } = req.body || {};
  if (!['verilog', 'vhdl'].includes(language) || !Array.isArray(files) || files.length < 1 || files.length > 20)
    return res.status(400).json({ error: 'Invalid request.' });
  let total = 0;
  for (const f of files) {
    if (!f || !NAME.test(f.path || '') || typeof f.content !== 'string' || f.content.length > 200000)
      return res.status(400).json({ error: 'Invalid file: ' + (f && f.path) });
    total += f.content.length;
  }
  if (total > 400000) return res.status(400).json({ error: 'Project is too large.' });
  if (files.some(f => /\$system/i.test(f.content))) return res.status(400).json({ error: '$system is not allowed.' });
  if (busy >= MAX_BUSY) return res.status(503).json({ error: 'Server is busy. Try again in a few seconds.' });

  busy++;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-'));
  try {
    for (const f of files) await fs.writeFile(path.join(dir, f.path), f.content);
    const r = await simulate(language, files, dir);
    let vcd = null;
    const v = (await fs.readdir(dir)).find(n => n.endsWith('.vcd'));
    if (v) {
      const buf = await fs.readFile(path.join(dir, v));
      if (buf.length <= MAX_VCD) vcd = buf.toString('utf8');
      else r.log += '\n[Waveform file is too large to display. Shorten the simulation.]';
    }
    res.json({ ok: r.ok, log: r.log.slice(0, MAX_LOG), vcd });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Simulation failed to start.' });
  } finally {
    busy--;
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/', (_req, res) => {
  res.send('SIM Server is running');
});

app.get('/health', (_req, res) => {
  res.send('ok');
});

app.listen(PORT, () => {
  console.log('Simulation server on port ' + PORT);
});
