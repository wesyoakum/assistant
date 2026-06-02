import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type TrackingApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const tracking: TrackingApp = new Hono();

// Auth for all except /view pages (shareable links).
tracking.use("*", async (c, next) => {
  if (c.req.path.endsWith("/view")) return next();
  return authMiddleware(c, next);
});

// POST /tracking — save a tracking session (camera pose + detections).
// Stored as a JSON file in R2 under users/<uid>/tracking/<id>.json.
tracking.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const key = `users/${userId}/tracking/${id}.json`;

  const payload = {
    id,
    userId,
    savedAt: new Date().toISOString(),
    ...body,
  };

  await c.env.FILES.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  return c.json({ id, key });
});

// GET /tracking — list saved tracking sessions.
tracking.get("/", async (c) => {
  const userId = c.get("userId");
  const prefix = `users/${userId}/tracking/`;
  const list = await c.env.FILES.list({ prefix, limit: 50 });

  const sessions = list.objects.map((obj) => ({
    key: obj.key,
    id: obj.key.replace(prefix, "").replace(".json", ""),
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));

  return c.json({ sessions });
});

// ── Static paths MUST come before /:id to avoid being swallowed ──

// GET /tracking/list/view — public HTML page listing all tracking sessions.
tracking.get("/list/view", async (c) => {
  const allList = await c.env.FILES.list({ prefix: "users/", limit: 500 });
  const items = allList.objects
    .filter((o) => o.key.includes("/tracking/") && o.key.endsWith(".json"))
    .map((o) => ({
      id: o.key.split("/tracking/")[1]?.replace(".json", "") || "",
      size: o.size,
      uploaded: o.uploaded.toISOString(),
    }))
    .filter((i) => i.id)
    .sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  const rows = items.map((i) =>
    `<tr><td><a href="/tracking/${i.id}/view">${i.id}</a></td><td>${i.uploaded}</td><td>${(i.size / 1024).toFixed(1)} KB</td></tr>`
  ).join("\n");

  return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tracking Sessions</title>
<style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;background:#111;color:#eee}
table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #333}
a{color:#0cf;text-decoration:none}a:hover{text-decoration:underline}</style></head>
<body><h1>Tracking Sessions</h1>
<table><thead><tr><th>ID</th><th>Date</th><th>Size</th></tr></thead>
<tbody>${rows || "<tr><td colspan=3>No sessions saved yet</td></tr>"}</tbody></table>
</body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
});

// GET /tracking/:id — retrieve a specific tracking session.
tracking.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const key = `users/${userId}/tracking/${id}.json`;
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const data = await obj.json();
  return c.json(data);
});

// GET /tracking/:id/view — HTML viewer with table, CSV, and plot.
// No auth required so links are shareable.
tracking.get("/:id/view", async (c) => {
  // Search all user prefixes for this ID (shareable links don't include userId).
  const id = c.req.param("id");
  const list = await c.env.FILES.list({ prefix: "users/", limit: 200 });
  let data: any = null;
  for (const obj of list.objects) {
    if (obj.key.endsWith(`/tracking/${id}.json`)) {
      const r = await c.env.FILES.get(obj.key);
      if (r) { data = await r.json(); break; }
    }
  }
  if (!data) return c.text("Not found", 404);

  return new Response(viewerHTML(id, data), {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
});

// ── Model storage ──────────────────────────────────────────────────

// POST /tracking/models — upload a .mlmodel file.
// Body is the raw model bytes. Name from query param.
tracking.post("/models", async (c) => {
  const userId = c.get("userId");
  const name = c.req.query("name");
  if (!name) return c.json({ error: "name query param required" }, 400);
  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) return c.json({ error: "Empty body" }, 400);
  const key = `models/${name}.mlmodel`;
  await c.env.FILES.put(key, data, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { uploadedBy: userId, uploadedAt: new Date().toISOString() },
  });
  return c.json({ key, size: data.byteLength });
});

// GET /tracking/models — list available models.
tracking.get("/models", async (c) => {
  const list = await c.env.FILES.list({ prefix: "models/", limit: 50 });
  const models = list.objects.map((obj) => ({
    name: obj.key.replace("models/", "").replace(".mlmodel", ""),
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));
  return c.json({ models });
});

// GET /tracking/models/:name — download a model file.
tracking.get("/models/:name", async (c) => {
  const name = c.req.param("name");
  const key = `models/${name}.mlmodel`;
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.json({ error: "Model not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}.mlmodel"` },
  });
});

function viewerHTML(id: string, data: any): string {
  const d = data.detections || [];
  const cam = data.cameraPose || {};
  const img = data.imageSize || {};
  const H = data.homography || {};

  const csvHeader = "frame,time,type,pixel_x,pixel_y,yz_y,yz_z,ray_dx,ray_dy,ray_dz";
  const csvRows = d.map((r: any) =>
    `${r.frame},${r.time},${r.type},${r.pixel?.x},${r.pixel?.y},${r.yzPlane?.y},${r.yzPlane?.z},${r.ray?.dx},${r.ray?.dy},${r.ray?.dz}`
  ).join("\\n");

  const tableRows = d.map((r: any) => `<tr class="${r.type}">
    <td>${r.frame}</td><td>${r.time}</td><td>${r.type}</td>
    <td>${r.pixel?.x}</td><td>${r.pixel?.y}</td>
    <td>${r.yzPlane?.y?.toFixed?.(3) ?? r.yzPlane?.y}</td>
    <td>${r.yzPlane?.z?.toFixed?.(3) ?? r.yzPlane?.z}</td>
    <td>${r.ray?.dx}</td><td>${r.ray?.dy}</td><td>${r.ray?.dz}</td>
  </tr>`).join("\n");

  // Pixel data for the plot (detected only).
  const detected = d.filter((r: any) => r.type === "detect");
  const pxData = JSON.stringify(detected.map((r: any) => [r.pixel?.x ?? 0, r.pixel?.y ?? 0]));

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tracking ${id}</title>
<style>
body{font-family:system-ui;max-width:1100px;margin:40px auto;padding:0 20px;background:#111;color:#eee}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:24px}
.meta{font-size:0.85rem;color:#aaa;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:0.8rem;margin-top:8px}
th,td{padding:4px 8px;text-align:right;border-bottom:1px solid #333}
th{text-align:right;color:#888;font-weight:600}
tr.detect td:nth-child(3){color:#3c6}
tr.interp td:nth-child(3){color:#f90}
canvas{background:#1a1a1a;border-radius:8px;margin-top:12px;width:100%;max-width:700px;height:400px}
a{color:#0cf}
.btn{display:inline-block;padding:8px 16px;background:#0cf;color:#111;border-radius:6px;text-decoration:none;font-weight:600;margin-right:8px;margin-top:8px}
.btn:hover{background:#0ae}
</style></head>
<body>
<h1>Tracking: ${id}</h1>
<div class="meta">
  <strong>Camera:</strong> pos (${cam.position?.x}, ${cam.position?.y}, ${cam.position?.z}) m
  · rot (${cam.rotation?.rx}°, ${cam.rotation?.ry}°, ${cam.rotation?.rz}°)<br>
  <strong>Image:</strong> ${img.width}×${img.height} · ${data.frameRate} fps · ${data.trackerMode}<br>
  ${H.rmsPx != null ? `<strong>Homography RMS:</strong> ${H.rmsPx.toFixed?.(1) ?? H.rmsPx}px` : ""}
</div>

<a class="btn" href="/tracking/${id}" target="_blank">JSON</a>
<a class="btn" id="csvBtn" href="#">Download CSV</a>
<a class="btn" href="/tracking/list/view">All Sessions</a>

<h2>3D Field View</h2>
<div style="position:relative">
<div id="scene3d-container" style="width:100%;max-width:800px;height:500px;position:relative;border-radius:8px;overflow:hidden;background:#0a0a0a">
  <canvas id="scene3d"></canvas>
</div>
<button id="toggleYZ" style="position:absolute;top:8px;right:8px;padding:4px 10px;border-radius:4px;border:1px solid #ffcc00;background:rgba(255,204,0,0.2);color:#ffcc00;font-size:12px;cursor:pointer">YZ Plane</button>
</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const camData = ${JSON.stringify(cam.position || { x: 0, y: -7, z: 2 })};
const detData = ${JSON.stringify(detected.map((r: any) => ({ type: r.type, yz: r.yzPlane, ray: r.ray })))};
const bp = ${data.basepathFt || 60}; // basepath in feet
const FT = 0.3048;
const D = Math.SQRT1_2;

// Coord mapping: user (X→1B, Y→2B, Z→up) → Three.js (X→right, Y→up, Z→toward viewer)
function u2t(ux, uy, uz) { return new THREE.Vector3(ux, uz, -uy); }
// Internal field (x→1B foul, z→3B foul) → user coords (meters)
function f2u(fx, fz) { return [(fx - fz) * D * FT, (fx + fz) * D * FT]; }

const container = document.getElementById('scene3d-container');
const W = container.clientWidth, H = container.clientHeight;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
const cp = u2t(camData.x, camData.y, camData.z);
camera.position.set(cp.x + 5, cp.y + 5, cp.z + 5);
camera.lookAt(0, 0, 0);
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('scene3d'), antialias: true });
renderer.setSize(W, H);
renderer.setPixelRatio(window.devicePixelRatio);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// Lighting
scene.add(new THREE.AmbientLight(0x666666));
const dl = new THREE.DirectionalLight(0xffffff, 0.8);
dl.position.set(5, 10, 5);
scene.add(dl);

// Ground grid
const grid = new THREE.GridHelper(40, 40, 0x333333, 0x222222);
scene.add(grid);

// Axes
const axLen = 3;
scene.add(new THREE.ArrowHelper(new THREE.Vector3(1,0,0), new THREE.Vector3(0,0,0), axLen, 0xff0000));
scene.add(new THREE.ArrowHelper(new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,0), axLen, 0x00ff00));
scene.add(new THREE.ArrowHelper(new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,0), axLen, 0x0000ff));

// Field geometry
const bases = {
  apex: f2u(0, 0),
  '1b': f2u(bp, 0),
  '2b': f2u(bp, bp),
  '3b': f2u(0, bp),
};
const foulEnd = bp + 2.5 * bp; // foul line extends past bases

// Foul lines (pink, from apex past bases)
const foulMat = new THREE.LineBasicMaterial({ color: 0xff78b4 });
const foul1b = f2u(foulEnd, 0);
const foul3b = f2u(0, foulEnd);
scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([u2t(0,0,0), u2t(foul1b[0],foul1b[1],0)]), foulMat));
scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([u2t(0,0,0), u2t(foul3b[0],foul3b[1],0)]), foulMat));

// Basepaths (pink)
const bpMat = new THREE.LineBasicMaterial({ color: 0xff78b4 });
const bpKeys = ['apex', '1b', '2b', '3b', 'apex'];
const bpPts = bpKeys.map(k => { const p = bases[k]; return u2t(p[0], p[1], 0); });
scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bpPts), bpMat));

// Bases (yellow boxes)
const baseMat = new THREE.MeshBasicMaterial({ color: 0xffdc00 });
['1b', '2b', '3b'].forEach(k => {
  const p = bases[k];
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.05, 0.38), baseMat);
  const tp = u2t(p[0], p[1], 0);
  m.position.set(tp.x, tp.y + 0.025, tp.z);
  m.rotation.y = Math.PI / 4;
  scene.add(m);
});

// Home plate (white pentagon with actual shape)
{
  const plateFront = 17/12; // ft
  const halfW = 8.5/12;
  const sideD = 8.5/12;
  const fwd = {x: D, z: D}, rgt = {x: D, z: -D};
  const fc = {x: plateFront*fwd.x, z: plateFront*fwd.z};
  const plateCorners = [
    [0, 0], // apex
    [fc.x - sideD*fwd.x + halfW*rgt.x, fc.z - sideD*fwd.z + halfW*rgt.z], // right bevel
    [fc.x + halfW*rgt.x, fc.z + halfW*rgt.z], // front right
    [fc.x - halfW*rgt.x, fc.z - halfW*rgt.z], // front left
    [fc.x - sideD*fwd.x - halfW*rgt.x, fc.z - sideD*fwd.z - halfW*rgt.z], // left bevel
  ];
  const plateShape = new THREE.Shape();
  plateCorners.forEach((c, i) => {
    const u = f2u(c[0], c[1]);
    if (i === 0) plateShape.moveTo(u[0], -u[1]); // negate Y for shape (XZ plane)
    else plateShape.lineTo(u[0], -u[1]);
  });
  plateShape.closePath();
  const plateGeo = new THREE.ShapeGeometry(plateShape);
  const plateMesh = new THREE.Mesh(plateGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  plateMesh.rotation.x = -Math.PI / 2;
  plateMesh.position.y = 0.01;
  scene.add(plateMesh);
  // Plate outline
  const plateLinePts = [...plateCorners, plateCorners[0]].map(c => {
    const u = f2u(c[0], c[1]);
    return u2t(u[0], u[1], 0.02);
  });
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(plateLinePts), new THREE.LineBasicMaterial({ color: 0xff78b4 })));
}

// Batter's boxes (cyan outlines)
{
  const boxW = 4, boxL = 6;
  const plateW = 17/12, insideGap = 0.5;
  const fwd = {x: D, z: D}, rgt = {x: D, z: -D};
  const pcx = (17/12/2)*D, pcz = (17/12/2)*D;
  const frontDist = 3, backDist = -3;
  const insideOff = plateW/2 + insideGap;
  const outsideOff = insideOff + boxW;
  [1, -1].forEach(sign => { // left=1, right=-1
    const corners = [
      [pcx + frontDist*fwd.x + sign*insideOff*rgt.x, pcz + frontDist*fwd.z + sign*insideOff*rgt.z],
      [pcx + frontDist*fwd.x + sign*outsideOff*rgt.x, pcz + frontDist*fwd.z + sign*outsideOff*rgt.z],
      [pcx + backDist*fwd.x + sign*outsideOff*rgt.x, pcz + backDist*fwd.z + sign*outsideOff*rgt.z],
      [pcx + backDist*fwd.x + sign*insideOff*rgt.x, pcz + backDist*fwd.z + sign*insideOff*rgt.z],
    ];
    const pts = [...corners, corners[0]].map(c => {
      const u = f2u(c[0], c[1]);
      return u2t(u[0], u[1], 0.02);
    });
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x00c8ff })));
  });
}

// Camera marker (red cone)
const camMat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
const camMesh = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 8), camMat);
camMesh.position.copy(u2t(camData.x, camData.y, camData.z));
scene.add(camMesh);

// YZ plane (semi-transparent yellow, at X=0) — toggleable
const yzGroup = new THREE.Group();
const yzGeo = new THREE.PlaneGeometry(20, 6);
const yzMat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
const yzPlaneMesh = new THREE.Mesh(yzGeo, yzMat);
yzPlaneMesh.rotation.y = Math.PI / 2;
yzPlaneMesh.position.set(0, 3, 0);
yzGroup.add(yzPlaneMesh);
const yzBorder = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, -10), new THREE.Vector3(0, 0, 10),
  new THREE.Vector3(0, 6, 10), new THREE.Vector3(0, 6, -10),
]), new THREE.LineBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.4 }));
yzGroup.add(yzBorder);
scene.add(yzGroup);

// Rays and intersection points
const rayMat = new THREE.LineBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.3 });
const camPos3 = u2t(camData.x, camData.y, camData.z);
const detectSphMat = new THREE.MeshBasicMaterial({ color: 0x34c759 });
const interpSphMat = new THREE.MeshBasicMaterial({ color: 0xff9500 });
const sphGeo = new THREE.SphereGeometry(0.06, 8, 8);

detData.forEach(d => {
  if (!d.yz) return;
  const intPt = u2t(0, d.yz.y, d.yz.z);
  // Ray line from camera to intersection
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([camPos3, intPt]),
    rayMat
  ));
  // Intersection sphere
  const sph = new THREE.Mesh(sphGeo, d.type === 'detect' ? detectSphMat : interpSphMat);
  sph.position.copy(intPt);
  scene.add(sph);
});

// YZ plane toggle
document.getElementById('toggleYZ').addEventListener('click', function() {
  yzGroup.visible = !yzGroup.visible;
  this.style.opacity = yzGroup.visible ? '1' : '0.4';
});

function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
animate();

window.addEventListener('resize', () => {
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});
</script>

<h2>Pixel Position Plot (detected)</h2>
<canvas id="plot" width="700" height="400"></canvas>

<h2>Detections (${d.length} frames, ${detected.length} detected)</h2>
<div style="max-height:400px;overflow:auto">
<table>
<thead><tr><th>frame</th><th>time</th><th>type</th><th>px_x</th><th>px_y</th><th>yz_y</th><th>yz_z</th><th>ray_dx</th><th>ray_dy</th><th>ray_dz</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</div>

<script>
// CSV download.
document.getElementById("csvBtn").addEventListener("click", function(e) {
  e.preventDefault();
  var csv = "${csvHeader}\\n${csvRows}";
  var blob = new Blob([csv.replace(/\\\\n/g, "\\n")], {type: "text/csv"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tracking_${id}.csv";
  a.click();
});

// Plot.
var pts = ${pxData};
var canvas = document.getElementById("plot");
var ctx = canvas.getContext("2d");
var W = canvas.width, H = canvas.height;
if (pts.length > 0) {
  var xs = pts.map(function(p){return p[0]}), ys = pts.map(function(p){return p[1]});
  var minX = Math.min.apply(null,xs), maxX = Math.max.apply(null,xs);
  var minY = Math.min.apply(null,ys), maxY = Math.max.apply(null,ys);
  var pad = 30;
  var rngX = maxX-minX||1, rngY = maxY-minY||1;
  function tx(x){return pad+(x-minX)/rngX*(W-2*pad)}
  function ty(y){return pad+(y-minY)/rngY*(H-2*pad)}

  // Axes.
  ctx.strokeStyle="#444";ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(pad,pad);ctx.lineTo(pad,H-pad);ctx.lineTo(W-pad,H-pad);ctx.stroke();
  ctx.fillStyle="#888";ctx.font="10px system-ui";
  ctx.fillText(minX.toFixed(0),pad,H-pad+12);
  ctx.fillText(maxX.toFixed(0),W-pad-20,H-pad+12);
  ctx.fillText(minY.toFixed(0),2,pad+4);
  ctx.fillText(maxY.toFixed(0),2,H-pad);

  // Points.
  ctx.fillStyle="rgba(0,204,255,0.7)";
  for(var i=0;i<pts.length;i++){
    ctx.beginPath();ctx.arc(tx(pts[i][0]),ty(pts[i][1]),3,0,6.28);ctx.fill();
  }

  // Quadratic fit: y = a*x^2 + b*x + c  (least squares).
  if(pts.length>=3){
    var n=pts.length,sx=0,sx2=0,sx3=0,sx4=0,sy=0,sxy=0,sx2y=0;
    for(var i=0;i<n;i++){
      var x=xs[i],y=ys[i];
      sx+=x;sx2+=x*x;sx3+=x*x*x;sx4+=x*x*x*x;sy+=y;sxy+=x*y;sx2y+=x*x*y;
    }
    var M=[[sx4,sx3,sx2],[sx3,sx2,sx],[sx2,sx,n]];
    var B=[sx2y,sxy,sy];
    // Solve 3x3.
    function solve(M,B){
      var a=M,b=B.slice();
      for(var i=0;i<3;i++){
        var mx=i;for(var j=i+1;j<3;j++)if(Math.abs(a[j][i])>Math.abs(a[mx][i]))mx=j;
        var t=a[i];a[i]=a[mx];a[mx]=t;t=b[i];b[i]=b[mx];b[mx]=t;
        if(Math.abs(a[i][i])<1e-12)return null;
        for(var j=i+1;j<3;j++){var f=a[j][i]/a[i][i];for(var k=i;k<3;k++)a[j][k]-=f*a[i][k];b[j]-=f*b[i];}
      }
      var x=[0,0,0];
      for(var i=2;i>=0;i--){var s=b[i];for(var j=i+1;j<3;j++)s-=a[i][j]*x[j];x[i]=s/a[i][i];}
      return x;
    }
    var abc=solve(M,B);
    if(abc){
      ctx.strokeStyle="rgba(255,100,100,0.8)";ctx.lineWidth=2;ctx.beginPath();
      for(var px=minX;px<=maxX;px+=(maxX-minX)/200){
        var py=abc[0]*px*px+abc[1]*px+abc[2];
        var sx=tx(px),sy=ty(py);
        if(px===minX)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
      }
      ctx.stroke();
      ctx.fillStyle="rgba(255,100,100,0.9)";ctx.font="11px system-ui";
      ctx.fillText("y = "+abc[0].toExponential(3)+"x² + "+abc[1].toFixed(3)+"x + "+abc[2].toFixed(1), pad+10, pad+16);
    }
  }
} else {
  ctx.fillStyle="#666";ctx.font="14px system-ui";ctx.fillText("No detected points to plot",W/2-80,H/2);
}
</script>
</body></html>`;
}

export { tracking };
