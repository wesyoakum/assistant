"""
Label review tool — run with: python3 review_server.py
Opens a browser where you can click bounding boxes to delete false positives.
"""
import http.server
import json
import os
import urllib.parse
from pathlib import Path

PORT = 8899
BASE = Path(__file__).parent / "upload"
IMAGES = BASE / "images"
LABELS = BASE / "labels"

def get_labeled_images():
    """Return list of image filenames that have a corresponding label file."""
    labeled = []
    for lbl in sorted(LABELS.glob("*.txt")):
        img = IMAGES / (lbl.stem + ".jpg")
        if img.exists():
            labeled.append(lbl.stem)
    return labeled

def read_labels(name):
    lbl_path = LABELS / f"{name}.txt"
    if not lbl_path.exists():
        return []
    boxes = []
    for i, line in enumerate(lbl_path.read_text().strip().split("\n")):
        if not line.strip():
            continue
        parts = line.strip().split()
        if len(parts) >= 5:
            boxes.append({
                "idx": i,
                "cls": int(parts[0]),
                "x": float(parts[1]),
                "y": float(parts[2]),
                "w": float(parts[3]),
                "h": float(parts[4]),
                "conf": float(parts[5]) if len(parts) > 5 else None,
            })
    return boxes

def write_labels(name, keep_indices):
    lbl_path = LABELS / f"{name}.txt"
    if not lbl_path.exists():
        return
    lines = lbl_path.read_text().strip().split("\n")
    kept = [lines[i] for i in keep_indices if i < len(lines)]
    if kept:
        lbl_path.write_text("\n".join(kept) + "\n")
    else:
        lbl_path.unlink()  # no labels left — delete file

HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Label Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; color: #fff; font-family: -apple-system, sans-serif; overflow: hidden; }
  #container { position: relative; display: flex; justify-content: center; align-items: center; height: 100vh; }
  #canvas { max-width: 95vw; max-height: 85vh; cursor: crosshair; }
  #hud { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
         background: rgba(0,0,0,0.7); padding: 8px 20px; border-radius: 8px;
         font-size: 14px; z-index: 10; text-align: center; }
  #hud .count { color: #ff6b6b; font-weight: 700; }
  #hud .name { color: #888; font-size: 12px; }
  #help { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
          background: rgba(0,0,0,0.7); padding: 8px 20px; border-radius: 8px;
          font-size: 12px; color: #888; }
  .toast { position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
           background: #ff6b6b; color: #fff; padding: 6px 16px; border-radius: 6px;
           font-size: 13px; font-weight: 600; opacity: 0; transition: opacity 0.3s; z-index: 20; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div id="hud">
  <span id="pos">0 / 0</span> &mdash; <span class="count" id="boxcount">0 boxes</span>
  <br><span class="name" id="filename"></span>
</div>
<div id="container"><canvas id="canvas"></canvas></div>
<div id="help">← → navigate &nbsp;|&nbsp; click box to delete &nbsp;|&nbsp; D = delete all boxes on this image</div>
<div class="toast" id="toast"></div>
<script>
let images = [];
let idx = 0;
let boxes = [];
let imgObj = new Image();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

async function load() {
  const r = await fetch('/api/list');
  images = await r.json();
  if (images.length === 0) { alert('No labeled images found'); return; }
  show(0);
}

async function show(i) {
  idx = Math.max(0, Math.min(i, images.length - 1));
  const name = images[idx];
  const r = await fetch('/api/labels?name=' + encodeURIComponent(name));
  boxes = await r.json();
  document.getElementById('pos').textContent = (idx + 1) + ' / ' + images.length;
  document.getElementById('filename').textContent = name;
  updateBoxCount();
  // Always load fresh and redraw
  const fresh = new Image();
  fresh.onload = () => { imgObj = fresh; draw(); };
  fresh.src = '/images/' + name + '.jpg?' + Date.now();
}

function updateBoxCount() {
  const el = document.getElementById('boxcount');
  el.textContent = boxes.length + ' box' + (boxes.length !== 1 ? 'es' : '');
  el.style.color = boxes.length === 0 ? '#4ecdc4' : '#ff6b6b';
}

function draw() {
  const maxW = window.innerWidth * 0.95;
  const maxH = window.innerHeight * 0.85;
  const scale = Math.min(maxW / imgObj.width, maxH / imgObj.height);
  canvas.width = imgObj.width * scale;
  canvas.height = imgObj.height * scale;
  ctx.drawImage(imgObj, 0, 0, canvas.width, canvas.height);

  for (const b of boxes) {
    const bx = (b.x - b.w / 2) * canvas.width;
    const by = (b.y - b.h / 2) * canvas.height;
    const bw = b.w * canvas.width;
    const bh = b.h * canvas.height;
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    // Clickable fill (semi-transparent)
    ctx.fillStyle = 'rgba(255, 107, 107, 0.15)';
    ctx.fillRect(bx, by, bw, bh);
    // Confidence label
    const label = b.conf !== null ? (b.conf * 100).toFixed(0) + '%' : '';
    if (label) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillRect(bx, by - 18, 40, 18);
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.fillText(label, bx + 3, by - 5);
    }
  }
}

canvas.addEventListener('click', async (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / canvas.width;
  const cy = (e.clientY - rect.top) / canvas.height;

  // Find which box was clicked (smallest box wins if overlapping)
  let hitIdx = -1;
  let hitArea = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const x1 = b.x - b.w/2, x2 = b.x + b.w/2;
    const y1 = b.y - b.h/2, y2 = b.y + b.h/2;
    if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
      const area = b.w * b.h;
      if (area < hitArea) { hitIdx = i; hitArea = area; }
    }
  }
  if (hitIdx === -1) return;

  // Remove this box — send the original line indices to keep
  const keepOrigIdx = boxes.filter((_, i) => i !== hitIdx).map(b => b.idx);
  const remaining = boxes.length - 1;
  await fetch('/api/delete', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name: images[idx], keep: keepOrigIdx })
  });
  toast('Deleted box — ' + remaining + ' remaining');
  await show(idx);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') show(idx + 1);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') show(idx - 1);
  if (e.key === 'd' || e.key === 'D') deleteAll();
});

async function deleteAll() {
  if (boxes.length === 0) return;
  await fetch('/api/delete', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name: images[idx], keep: [] })
  });
  toast('Deleted all boxes');
  show(idx);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}

window.addEventListener('resize', draw);
load();
</script>
</body>
</html>"""

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(HTML.encode())

        elif path == "/api/list":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(get_labeled_images()).encode())

        elif path == "/api/labels":
            qs = urllib.parse.parse_qs(parsed.query)
            name = qs.get("name", [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(read_labels(name)).encode())

        elif path.startswith("/images/"):
            fname = path.split("/images/")[1].split("?")[0]
            fpath = IMAGES / fname
            if fpath.exists():
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.end_headers()
                self.wfile.write(fpath.read_bytes())
            else:
                self.send_response(404)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/api/delete":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            name = body["name"]
            keep = body["keep"]
            write_labels(name, keep)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress logs

if __name__ == "__main__":
    print(f"Label review tool running at http://localhost:{PORT}")
    print(f"Images: {IMAGES}")
    print(f"Labels: {LABELS}")
    print(f"Press Ctrl+C to stop")
    import webbrowser
    webbrowser.open(f"http://localhost:{PORT}")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
