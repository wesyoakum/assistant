"""
Build every season preset of the page set into out/:
    out/                 2016-2025 (default)
    out/2021-2025/
    out/2023-2025/
    out/current-coach/   each program over its current head coach's tenure
    python build_all.py
"""
import subprocess, shutil, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
shutil.rmtree('out', ignore_errors=True)
for w, outdir in [('all', 'out'), ('2021-2025', 'out/2021-2025'), ('2023-2025', 'out/2023-2025'), ('current-coach', 'out/current-coach')]:
    r = subprocess.run([sys.executable, 'build_cfbanalysis.py', '--window', w, '--out', outdir])
    if r.returncode:
        sys.exit(r.returncode)
print('all presets built')
