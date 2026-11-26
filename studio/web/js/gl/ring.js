// The style picker in 3D: the sample page of every preset on a ring, the
// chosen one turned to the front. Clicking a page chooses it. The cards
// below the stage and the arrows beside it do the same from the keyboard.

import { smallTexture } from '/js/gl/stage.js';

function emptyPage(text, pal) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const g = c.getContext('2d');
  g.fillStyle = pal.sheet2;
  g.fillRect(0, 0, 256, 384);
  g.fillStyle = pal.dark ? 'rgba(255,255,255,0.09)' : 'rgba(27,26,34,0.14)';
  for (let y = 5; y < 384; y += 9) for (let x = 5; x < 256; x += 9) { g.beginPath(); g.arc(x, y, 1.3, 0, 7); g.fill(); }
  g.strokeStyle = pal.ink3;
  g.setLineDash([8, 6]);
  g.lineWidth = 3;
  g.strokeRect(10, 10, 236, 364);
  g.setLineDash([]);
  g.fillStyle = pal.ink3;
  g.font = '600 19px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > 200 && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => g.fillText(l, 128, 180 - (lines.length * 12) + i * 26));
  return c;
}

/**
 * ringScene(items, { selected, onPick, emptyText }) -> scene builder.
 * items: [{ key, url }]. The api has select(key).
 */
export function ringScene(items, { selected, onPick, emptyText = '' } = {}) {
  return (THREE, env) => {
    const n = Math.max(items.length, 1);
    const radius = Math.max(4, (n * 2.5) / (2 * Math.PI));
    const scene = new THREE.Scene();
    let pal = env.palette;
    scene.fog = new THREE.Fog(new THREE.Color(pal.board), radius + 3, radius * 2 + 6);
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
    camera.position.set(0, 0.5, radius + 9.5);
    camera.lookAt(0, -0.1, radius);

    const ring = new THREE.Group();
    scene.add(ring);
    const geometry = new THREE.PlaneGeometry(2, 3);
    const shadowGeo = new THREE.PlaneGeometry(2.2, 0.5);
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 32;
    const sg = shadowCanvas.getContext('2d');
    const grad = sg.createRadialGradient(64, 16, 2, 64, 16, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 128, 32);
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, fog: true });
    const emptyTex = new THREE.CanvasTexture(emptyPage(emptyText, pal));
    emptyTex.colorSpace = THREE.SRGBColorSpace;

    const step = (Math.PI * 2) / n;
    const pages = items.map((item, i) => {
      const material = new THREE.MeshBasicMaterial({ map: emptyTex, fog: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      const angle = i * step;
      mesh.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      mesh.rotation.y = angle;
      mesh.userData = { item, material, index: i };
      ring.add(mesh);
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(Math.sin(angle) * radius, -1.62, Math.cos(angle) * radius);
      ring.add(shadow);
      return mesh;
    });

    let index = Math.max(0, items.findIndex((i) => i.key === selected));
    let target = -index * step;
    ring.rotation.y = target;
    const pointer = { x: 0, y: 0, inside: false };
    const raycaster = new THREE.Raycaster();

    // Textures load nearest the front first, so the first view is complete soonest.
    const order = items.map((_, i) => i).sort((a, b) => {
      const d = (i) => Math.min(Math.abs(i - index), n - Math.abs(i - index));
      return d(a) - d(b);
    });
    let cancelled = false;
    (async () => {
      for (const i of order) {
        if (cancelled) return;
        const item = items[i];
        if (!item.url) continue;
        const res = await smallTexture(THREE, item.url, 300);
        if (!res || cancelled) continue;
        pages[i].userData.material.map = res.texture;
        pages[i].userData.material.needsUpdate = true;
        env.invalidate();
      }
    })();

    return {
      render(time, dt) {
        const k = env.reduced ? 1 : Math.min(1, dt * 5);
        const diff = target - ring.rotation.y;
        ring.rotation.y += diff * k;
        const tilt = pointer.inside ? -pointer.y * 0.05 : 0;
        ring.rotation.x += (tilt - ring.rotation.x) * Math.min(1, dt * 6);
        const front = ((-ring.rotation.y / step) % n + n) % n;
        pages.forEach((p, i) => {
          const dist = Math.min(Math.abs(i - front), n - Math.abs(i - front));
          const s = 1 + Math.max(0, 1 - dist) * 0.12;
          p.scale.set(s, s, 1);
        });
        env.renderer.render(scene, camera);
        return Math.abs(diff) > 0.0008 || Math.abs(tilt - ring.rotation.x) > 0.0008;
      },
      resize(w, h) {
        camera.aspect = w / h;
        camera.position.z = radius + (camera.aspect < 1.4 ? 12 : 9.5);
        camera.updateProjectionMatrix();
      },
      pointer(x, y, inside) {
        pointer.x = x; pointer.y = y; pointer.inside = inside;
        if (!inside) return;
        raycaster.setFromCamera({ x, y }, camera);
        const hit = raycaster.intersectObjects(pages, false)[0];
        env.canvas.style.cursor = hit ? 'pointer' : '';
      },
      click(x, y) {
        raycaster.setFromCamera({ x, y }, camera);
        const hit = raycaster.intersectObjects(pages, false)[0];
        if (hit && onPick) onPick(hit.object.userData.item.key);
      },
      select(key) {
        const next = items.findIndex((i) => i.key === key);
        if (next < 0) return;
        // Turn the short way round.
        let delta = (next - index) % n;
        if (delta > n / 2) delta -= n;
        if (delta < -n / 2) delta += n;
        index = next;
        target -= delta * step;
        env.invalidate();
      },
      theme(next) {
        pal = next;
        scene.fog.color.set(pal.board);
      },
      dispose() {
        cancelled = true;
        geometry.dispose();
        shadowGeo.dispose();
        shadowTex.dispose();
        shadowMat.dispose();
        emptyTex.dispose();
        for (const p of pages) {
          if (p.userData.material.map && p.userData.material.map !== emptyTex) p.userData.material.map.dispose();
          p.userData.material.dispose();
        }
      },
    };
  };
}
