const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());                       // lets your website call this server
app.use(express.json({ limit: '2mb' }));

// Only needs the PUBLIC (anon) key to verify a user's sign-in token.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const RUN_TIMEOUT_MS = 10000;
const MAX_OUTPUT = 200 * 1024;

// ---------- auth ----------
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not signed in (no token sent).' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) {
    console.error('Auth failed:', error && error.message);
    return res.status(401).json({ error: 'Sign-in check failed: ' + (error ? error.message : 'unknown') });
  }
  req.user = data.user;
  next();
}

// ---------- helpers ----------
function run(cmd, args, cwd) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        timedOut: !!(err && err.killed),
        notFound: !!(err && err.code === 'ENOENT'),
        out: (stdout || '') + (stderr || '')
      });
    });
  });
}

function safeName(p, lang) {
  let name = path.basename(String(p || 'file')).replace(/[^\w.\-]/g, '_');
  const ext = lang === 'vhdl' ? '.vhd' : '.v';
  if (!/\.(v|sv|vhd|vhdl)$/i.test(name)) name += ext;   // "subtractor" -> "subtractor.v"
  return name;
}

async function simulateVerilog(dir, names) {
  const compile = await run('iverilog', ['-g2012', '-o', 'sim.out', ...names], dir);
  if (compile.notFound) return { error: 'iverilog is not installed on the server.' };
  if (!compile.ok) return { error: compile.out || 'Compile failed.' };

  const sim = await run('vvp', ['sim.out'], dir);
  if (sim.timedOut) return { error: 'Simulation timed out (10 s). Does your testbench call $finish?' };
  let log = (compile.out + sim.out).trim();
  if (!log) log = 'Compiled and ran OK, but nothing was printed.\nAdd a testbench that uses $display and $finish to see output.';

  let vcd = null;
  try {
    const files = await fs.readdir(dir);
    const v = files.find(f => f.endsWith('.vcd'));
    if (v) {
      const text = await fs.readFile(path.join(dir, v), 'utf8');
      if (text.length < 2 * 1024 * 1024) vcd = text;
    }
  } catch (_) {}
  return { log, vcd };
}

async function simulateVhdl(dir, files) {
  const analyze = await run('ghdl', ['-a', '--std=08', ...files.map(f => f.name)], dir);
  if (analyze.notFound) return { error: 'ghdl is not installed on the server.' };
  if (!analyze.ok) return { error: analyze.out || 'VHDL analysis failed.' };

  // Pick the testbench entity: prefer one named *tb* / *test*, else the last entity found.
  const entities = [];
  for (const f of files) {
    for (const m of f.content.matchAll(/^\s*entity\s+(\w+)\s+is/gim)) entities.push(m[1]);
  }
  if (!entities.length) return { error: 'No VHDL entity found.' };
  const top = entities.find(e => /tb|test/i.test(e)) || entities[entities.length - 1];

  const elab = await run('ghdl', ['-e', '--std=08', top], dir);
  if (!elab.ok) return { error: elab.out || 'VHDL elaboration failed.' };
  const sim = await run('ghdl', ['-r', '--std=08', top, '--vcd=wave.vcd', '--stop-time=1ms'], dir);
  if (sim.timedOut) return { error: 'Simulation timed out (10 s).' };

  let log = sim.out.trim() || `Simulated "${top}" OK, but nothing was reported.\nUse "report" statements in your testbench to print output.`;
  let vcd = null;
  try {
    const text = await fs.readFile(path.join(dir, 'wave.vcd'), 'utf8');
    if (text.length < 2 * 1024 * 1024) vcd = text;
  } catch (_) {}
  return { log, vcd };
}

// ---------- routes ----------
app.get('/', (req, res) => res.send('SIM Server is running'));

app.post('/simulate', requireAuth, async (req, res) => {
  const lang = String((req.body && req.body.language) || 'verilog').toLowerCase();
  const input = (req.body && req.body.files) || [];
  if (!Array.isArray(input) || !input.length) return res.json({ error: 'No files to simulate.' });
  if (input.length > 20) return res.json({ error: 'Too many files (max 20).' });

  const files = input.map(f => ({ name: safeName(f.path, lang), content: String(f.content || '') }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-'));
  try {
    for (const f of files) await fs.writeFile(path.join(dir, f.name), f.content);
    const result = lang === 'vhdl'
      ? await simulateVhdl(dir, files)
      : await simulateVerilog(dir, files.map(f => f.name));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.json({ error: 'Server error: ' + e.message });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SIM server listening on ' + PORT));
