import * as THREE from "three";

/* ───────── 設定 ─────────
   之後放自己的照片：把圖片丟進 /photos，並把檔名寫進下面的陣列，例如：
   const PHOTOS = ["photos/01.jpg", "photos/02.jpg"];
   留空 = 使用淺灰占位圖。照片數量不夠時會自動循環重複。 */
const PHOTOS = [];

const BG_COLOR = 0xf2f2f0;
const CHUNK_SIZE = 50;          // 每個立方體區塊邊長
const PLANES_PER_CHUNK = 5;     // 每個區塊的圖片數
const RENDER_DISTANCE = 1;      // 1 → 3×3×3 = 27 個區塊
const CHUNK_FADE_MARGIN = 1;
const DEPTH_FADE_START = 60;
const DEPTH_FADE_END = 110;
const INVIS_THRESHOLD = 0.01;
const VELOCITY_LERP = 0.16;     // 慣性：越小越「滑」
const VELOCITY_DECAY = 0.9;
const INITIAL_CAMERA_Z = 50;

/* ───────── 工具 ───────── */
const lerp = (a, b, t) => a + (b - a) * t;
const hashString = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const seededRandom = (seed) => {           // 0~1 的確定性亂數
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/* ───────── 確定性版面 + LRU 快取 ───────── */
const MAX_PLANE_CACHE = 256;
const planeCache = new Map();
function generateChunkPlanes(cx, cy, cz) {
  const seed = hashString(`${cx},${cy},${cz}`);
  const planes = [];
  for (let i = 0; i < PLANES_PER_CHUNK; i++) {
    const s = seed + i * 1000;
    const r = (n) => seededRandom(s + n);
    planes.push({
      x: cx * CHUNK_SIZE + r(0) * CHUNK_SIZE,
      y: cy * CHUNK_SIZE + r(1) * CHUNK_SIZE,
      z: cz * CHUNK_SIZE + r(2) * CHUNK_SIZE,
      size: 12 + r(4) * 8,
      mediaIndex: Math.floor(r(5) * 1_000_000),
    });
  }
  return planes;
}
function getChunkPlanes(cx, cy, cz) {
  const key = `${cx},${cy},${cz}`;
  const hit = planeCache.get(key);
  if (hit) { planeCache.delete(key); planeCache.set(key, hit); return hit; }
  const planes = generateChunkPlanes(cx, cy, cz);
  planeCache.set(key, planes);
  while (planeCache.size > MAX_PLANE_CACHE) planeCache.delete(planeCache.keys().next().value);
  return planes;
}

/* ───────── 媒體：淺灰占位圖 / 真實照片 ───────── */
function makePlaceholder(gray) {
  const c = document.createElement("canvas");
  c.width = c.height = 4;
  const g = c.getContext("2d");
  g.fillStyle = `rgb(${gray},${gray},${gray})`;
  g.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { texture: t, aspect: 1 };
}

async function loadMedia() {
  if (PHOTOS.length) {
    const loader = new THREE.TextureLoader();
    const items = await Promise.all(PHOTOS.map((url) => new Promise((resolve) => {
      loader.load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve({ texture: t, aspect: t.image.width / t.image.height });
      }, undefined, () => resolve(null));   // 載入失敗就略過
    })));
    const ok = items.filter(Boolean);
    if (ok.length) return ok;
  }
  return [214, 220, 208, 226, 218, 211, 223, 205].map(makePlaceholder);
}

/* ───────── 場景 ───────── */
const media = await loadMedia();

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
const isTouch = matchMedia("(pointer: coarse)").matches;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 300);
camera.position.z = INITIAL_CAMERA_Z;

const geometry = new THREE.PlaneGeometry(1, 1);
const chunks = new Map();   // key -> { cx, cy, cz, group, planes: [{mesh, mat, opacity, ...}] }

function createChunk(cx, cy, cz) {
  const group = new THREE.Group();
  const planes = getChunkPlanes(cx, cy, cz).map((p) => {
    const item = media[p.mediaIndex % media.length];
    const mat = new THREE.MeshBasicMaterial({
      map: item.texture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    const k = Math.sqrt(item.aspect);              // 保持面積，依照片長寬比調整
    mesh.scale.set(p.size * k, p.size / k, 1);
    mesh.position.set(p.x, p.y, p.z);
    mesh.visible = false;
    group.add(mesh);
    const plane = { mesh, mat, opacity: 0, z: p.z };
    mesh.userData.plane = plane;
    return plane;
  });
  scene.add(group);
  return { cx, cy, cz, group, planes };
}
function disposeChunk(c) {
  scene.remove(c.group);
  c.planes.forEach((p) => p.mat.dispose());        // 幾何體與貼圖是共用的，不釋放
}

const CHUNK_OFFSETS = [];
for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++)
  for (let dy = -RENDER_DISTANCE; dy <= RENDER_DISTANCE; dy++)
    for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) CHUNK_OFFSETS.push([dx, dy, dz]);

function syncChunks(ccx, ccy, ccz) {
  const want = new Set();
  for (const [dx, dy, dz] of CHUNK_OFFSETS) {
    const cx = ccx + dx, cy = ccy + dy, cz = ccz + dz;
    const key = `${cx},${cy},${cz}`;
    want.add(key);
    if (!chunks.has(key)) chunks.set(key, createChunk(cx, cy, cz));
  }
  for (const [key, c] of chunks) {
    // 離開範圍的區塊：先讓它淡出，淡完才移除，避免畫面突然消失
    c.leaving = !want.has(key);
  }
}

/* ───────── 輸入 + 慣性 ───────── */
const s = {
  basePos: new THREE.Vector3(0, 0, INITIAL_CAMERA_Z),
  velocity: new THREE.Vector3(),
  targetVel: new THREE.Vector3(),
  scrollAccum: 0,
  chunk: null, pendingChunk: null, lastChunkUpdate: 0,
};
const pointers = new Map();
let pinchDist = 0;
const keys = new Set();

/* ───────── 點擊聚焦 ───────── */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let focus = null;   // { plane }：目前聚焦的照片
let down = null;    // 用來區分「點擊」和「拖曳」
const FOCUS_FILL = 1.4;    // 越大 → 聚焦後照片越小（約佔畫面 70%）
const FOCUS_SPEED = 0.08;  // 飛行速度，越小越柔
const FOCUS_DIM = 0.12;    // 其他照片的透明度倍率（0 = 完全消失）

function handleClick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = [];
  for (const c of chunks.values())
    for (const p of c.planes) if (p.mesh.visible && p.opacity > 0.5) meshes.push(p.mesh);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  focus = hit ? { plane: hit.object.userData.plane } : null;   // 點空白處 = 退出
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add("dragging");
  if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); }
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (focus && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) focus = null;
  if (pointers.size === 1) {
    s.targetVel.x -= (e.clientX - p.x) * 0.025;
    s.targetVel.y += (e.clientY - p.y) * 0.025;
  }
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    s.targetVel.z -= (d - pinchDist) * 0.04;       // 兩指張開 = 往前推進
    pinchDist = d;
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6
      && performance.now() - down.t < 300) handleClick(e);
  down = null;
  endPointer(e);
});
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  focus = null;
  s.scrollAccum += e.deltaY * 0.006;               // 往下滾 = 往前推進
  s.targetVel.z += s.scrollAccum;
  s.scrollAccum *= 0.8;
}, { passive: false });
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "escape" || "wasdqe".includes(k)) focus = null;
  keys.add(k);
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ───────── 主迴圈 ───────── */
syncChunks(...(s.chunk = [0, 0, 0]));
const drift = { x: 0, y: 0 };

renderer.setAnimationLoop((now) => {
  // 鍵盤：WASD 平移、Q/E 上下（這裡的 Z 軸以 W 前進、S 後退）
  const K = 0.05;
  if (keys.has("a")) s.targetVel.x -= K;
  if (keys.has("d")) s.targetVel.x += K;
  if (keys.has("w")) s.targetVel.z -= K;
  if (keys.has("s")) s.targetVel.z += K;
  if (keys.has("q")) s.targetVel.y -= K;
  if (keys.has("e")) s.targetVel.y += K;

  if (focus) {
    // 聚焦：相機平滑飛到照片正前方，讓它佔畫面約 70%
    const m = focus.plane.mesh;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const d = Math.max(m.scale.y / (FOCUS_FILL * tan), m.scale.x / (FOCUS_FILL * tan * camera.aspect));
    s.basePos.x = lerp(s.basePos.x, m.position.x, FOCUS_SPEED);
    s.basePos.y = lerp(s.basePos.y, m.position.y, FOCUS_SPEED);
    s.basePos.z = lerp(s.basePos.z, m.position.z + d, FOCUS_SPEED);
    s.velocity.set(0, 0, 0);
    s.targetVel.set(0, 0, 0);
    camera.position.copy(s.basePos);
  } else {
    // 慣性：實際速度追著目標速度，目標速度逐幀衰減
    s.velocity.lerp(s.targetVel, VELOCITY_LERP);
    s.basePos.add(s.velocity);
    s.targetVel.multiplyScalar(VELOCITY_DECAY);

    // 微小漂移，讓靜止時畫面也有呼吸感
    drift.x = Math.sin(now * 0.0003) * 0.8;
    drift.y = Math.cos(now * 0.00025) * 0.6;
    camera.position.set(s.basePos.x + drift.x, s.basePos.y + drift.y, s.basePos.z);
  }

  // 跨區塊時重建清單（快速縮放時節流）
  const cx = Math.floor(s.basePos.x / CHUNK_SIZE);
  const cy = Math.floor(s.basePos.y / CHUNK_SIZE);
  const cz = Math.floor(s.basePos.z / CHUNK_SIZE);
  if (cx !== s.chunk[0] || cy !== s.chunk[1] || cz !== s.chunk[2]) s.pendingChunk = [cx, cy, cz];
  if (s.pendingChunk) {
    const vz = Math.abs(s.velocity.z);
    const throttle = vz > 0.05 ? Math.min(180, 40 + vz * 60) : 0;
    if (now - s.lastChunkUpdate >= throttle) {
      s.chunk = s.pendingChunk; s.pendingChunk = null; s.lastChunkUpdate = now;
      syncChunks(...s.chunk);
    }
  }

  // 淡入淡出：格子距離 + 深度距離
  for (const [key, c] of chunks) {
    const dist = Math.max(Math.abs(c.cx - cx), Math.abs(c.cy - cy), Math.abs(c.cz - cz));
    const gridFade = c.leaving ? 0
      : dist <= RENDER_DISTANCE ? 1
      : Math.max(0, 1 - (dist - RENDER_DISTANCE) / CHUNK_FADE_MARGIN);
    let anyVisible = false;
    for (const p of c.planes) {
      const absDepth = Math.abs(p.z - s.basePos.z);
      const depthFade = absDepth <= DEPTH_FADE_START ? 1
        : Math.max(0, 1 - (absDepth - DEPTH_FADE_START) / (DEPTH_FADE_END - DEPTH_FADE_START));
      const dim = focus && focus.plane !== p ? FOCUS_DIM : 1;
      const target = Math.min(gridFade, depthFade * depthFade) * dim;
      p.opacity = target < INVIS_THRESHOLD && p.opacity < INVIS_THRESHOLD ? 0 : lerp(p.opacity, target, 0.18);
      const opaque = p.opacity > 0.99;
      p.mat.opacity = opaque ? 1 : p.opacity;
      p.mat.depthWrite = opaque;
      p.mesh.visible = p.opacity > INVIS_THRESHOLD;
      anyVisible ||= p.mesh.visible;
    }
    if (c.leaving && !anyVisible) { disposeChunk(c); chunks.delete(key); }
  }

  renderer.render(scene, camera);
});
