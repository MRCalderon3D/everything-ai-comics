// The waiting scene while a page is drawn (two to five minutes with the real
// tools): a blank sheet on the desk whose panel borders are inked as the
// expected time passes, with the pen moving along the line. The layout is
// the page's own plan when it is known (panels per tier).

function layoutRects(tiers) {
  const rows = Array.isArray(tiers) && tiers.length ? tiers : [1, 2, 2];
  const m = 0.06;
  const gut = 0.025;
  const rects = [];
  const rowH = (1 - 2 * m - gut * (rows.length - 1)) / rows.length;
  rows.forEach((count, r) => {
    const n = Math.max(1, Number(count) || 1);
    const w = (1 - 2 * m - gut * (n - 1)) / n;
    for (let c = 0; c < n; c += 1) {
      rects.push({ x: m + c * (w + gut), y: m + r * (rowH + gut), w, h: rowH });
    }
  });
  return rects;
}

function seeded(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/**
 * inkingScene({ tiers, progress }) -> scene builder.
 * progress() returns 0..1, the share of the expected time that has passed.
 */
export function inkingScene({ tiers, progress } = {}) {
  return (THREE, env) => {
    let pal = env.palette;
    const W = 512;
    const H = 768;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const rects = layoutRects(tiers);
    // One path: the border of each panel in turn, then rough sketch strokes.
    const segments = [];
    for (const r of rects) {
      const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y]];
      for (let i = 0; i < 4; i += 1) segments.push({ a: pts[i], b: pts[i + 1], kind: 'border' });
      const rand = seeded(Math.round(r.x * 1000 + r.y * 7919 + 13));
      for (let k = 0; k < 5; k += 1) {
        const y = r.y + r.h * (0.3 + rand() * 0.6);
        const x0 = r.x + r.w * (0.1 + rand() * 0.3);
        const x1 = x0 + r.w * (0.2 + rand() * 0.35);
        segments.push({ a: [x0, y], b: [x1, y - r.h * (rand() * 0.2 - 0.1)], kind: 'sketch' });
      }
    }
    const lengths = segments.map((s) => Math.hypot((s.b[0] - s.a[0]) * W, (s.b[1] - s.a[1]) * H));
    const total = lengths.reduce((a, b) => a + b, 0);

    let lastDrawn = -1;
    let pen = [0.5, 0.5];
    function paint(p) {
      g.fillStyle = pal.sheet;
      g.fillRect(0, 0, W, H);
      g.fillStyle = pal.dark ? 'rgba(255,255,255,0.05)' : 'rgba(27,26,34,0.06)';
      for (let y = 6; y < H; y += 10) for (let x = 6; x < W; x += 10) { g.beginPath(); g.arc(x, y, 1.2, 0, 7); g.fill(); }
      // Pencil guides of every panel, light blue like non-photo blue.
      g.strokeStyle = 'rgba(70,140,220,0.35)';
      g.lineWidth = 1.5;
      for (const r of rects) g.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
      let left = total * Math.min(0.97, p);
      g.lineCap = 'round';
      for (let i = 0; i < segments.length && left > 0; i += 1) {
        const s = segments[i];
        const part = Math.min(1, left / lengths[i]);
        left -= lengths[i];
        const x = s.a[0] + (s.b[0] - s.a[0]) * part;
        const y = s.a[1] + (s.b[1] - s.a[1]) * part;
        g.strokeStyle = s.kind === 'border' ? pal.ink : pal.ink3;
        g.lineWidth = s.kind === 'border' ? 5 : 2;
        g.beginPath();
        g.moveTo(s.a[0] * W, s.a[1] * H);
        g.lineTo(x * W, y * H);
        g.stroke();
        pen = [x, y];
      }
      texture.needsUpdate = true;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 2 / 3, 0.1, 50);
    camera.position.set(0, -1.2, 6.6);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 5);
    scene.add(key);

    const desk = new THREE.Group();
    scene.add(desk);
    desk.rotation.x = -0.32;
    const sheetGeo = new THREE.BoxGeometry(2, 3, 0.02);
    const paper = new THREE.MeshLambertMaterial({ color: new THREE.Color(pal.sheet) });
    const face = new THREE.MeshBasicMaterial({ map: texture });
    const sheet = new THREE.Mesh(sheetGeo, [paper, paper, paper, paper, face, paper]);
    desk.add(sheet);

    // The pen: a slim barrel and a nib, in process magenta.
    const penGroup = new THREE.Group();
    const barrelGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.9, 16);
    const nibGeo = new THREE.ConeGeometry(0.035, 0.12, 16);
    const penMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(pal.live) });
    const nibMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(pal.ink) });
    const barrel = new THREE.Mesh(barrelGeo, penMat);
    barrel.position.y = 0.51;
    const nib = new THREE.Mesh(nibGeo, nibMat);
    nib.rotation.x = Math.PI;
    nib.position.y = 0.06;
    penGroup.add(barrel, nib);
    penGroup.rotation.set(0.9, 0, -0.5);
    desk.add(penGroup);

    let lastPaint = 0;
    return {
      render(time) {
        const p = Math.max(0, Math.min(1, progress ? progress() : 0));
        if (time - lastPaint > 0.08 || lastDrawn < 0) {
          const q = Math.round(p * 2000);
          if (q !== lastDrawn) { paint(p); lastDrawn = q; }
          lastPaint = time;
        }
        const sway = env.reduced ? 0 : Math.sin(time * 0.5) * 0.04;
        desk.rotation.z = sway * 0.5;
        desk.position.y = env.reduced ? 0 : Math.sin(time * 0.7) * 0.03;
        const bob = env.reduced ? 0 : Math.abs(Math.sin(time * 9)) * 0.03;
        penGroup.position.set(pen[0] * 2 - 1, 1.5 - pen[1] * 3, 0.02 + bob);
        env.renderer.render(scene, camera);
        return true;
      },
      resize(w, h) {
        camera.aspect = w / h;
        camera.position.z = camera.aspect < 0.8 ? 7.6 : 6.4;
        camera.updateProjectionMatrix();
      },
      theme(next) {
        pal = next;
        paper.color.set(pal.sheet);
        penMat.color.set(pal.live);
        nibMat.color.set(pal.ink);
        lastDrawn = -1;
      },
      dispose() {
        texture.dispose();
        sheetGeo.dispose();
        paper.dispose();
        face.dispose();
        barrelGeo.dispose();
        nibGeo.dispose();
        penMat.dispose();
        nibMat.dispose();
      },
    };
  };
}
