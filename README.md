# VLSI Club simulation server

Runs Verilog (Icarus Verilog) and VHDL (GHDL) for signed-in club members and returns the
console output plus a VCD waveform.

## Deploy on Render (no Docker install needed)
1. Put this `sim-server` folder in a GitHub repository (it can be its own repo).
2. Render: New > Web Service > connect that repository > Runtime: Docker.
3. Environment variables:
   - SUPABASE_URL = your project URL
   - SUPABASE_ANON_KEY = your anon key (the same one as in js/auth.js)
   - ALLOWED_ORIGINS = the addresses your website is served from, comma separated,
     e.g. http://127.0.0.1:5500,https://your-club-site.example
4. When it is live, open https://YOUR-SERVICE.onrender.com/health. It should say: ok
5. In club-site-v2/js/workspace.js, set SIM_URL to that address.

Free tiers usually put the service to sleep when idle, so the first run after a quiet
period can take a minute.

## Safety limits (see the constants at the top of server.js)
- Only signed-in members can run code, 10 runs per minute each, 2 runs at once.
- Each step stops after 10 s, with memory, CPU and file-size limits.
- The tools run with an empty environment, so no keys are visible to member code.
- Verilog `$system` is rejected. Treat this as a student-club service, not a place for secrets.
