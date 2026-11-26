// The project gallery in 3D: the comics as books fanned on a table, covers
// up. The book whose card is under the pointer comes forward; clicking a
// book opens the project. The cards below the stage stay the real controls.

import { smallTexture } from '/js/gl/stage.js';

/** A cover for a comic with no image yet: its title on a halftone page. */
export function titleCanvas(title, pal, width = 256) {
  const height = Math.round(width * 1.5);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  g.fillStyle = pal.sheet;
  g.fillRect(0, 0, width, height);
  g.fillStyle = pal.dark ? 'rgba(255,255,255,0.08)' : 'rgba(27,26,34,0.12)';
  for (let y = 6; y < height; y += 9) {
    for (let x = (y % 18 === 6 ? 6 : 10); x < width; x += 9) {
      const r = 1.2 + 1.6 * (y / height);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = pal.marker;
  g.fillRect(14, 14, width - 28, height * 0.34);
  g.strokeStyle = pal.ink;
  g.lineWidth = 4;
  g.strokeRect(14, 14, width - 28, height * 0.34);
  g.strokeRect(14, height * 0.34 + 26, (width - 40) / 2, height * 0.6 - 40);
  g.strokeRect(width / 2 + 6, height * 0.34 + 26, (width - 40) / 2, height * 0.6 - 40);
  g.fillStyle = '#1b1a22';
  g.font = `700 ${Math.round(width / 9)}px Bahnschrift, "Arial Narrow", sans-serif`;
  g.textBaseline = 'top';
  const words = String(title || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > width - 52 && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  lines.slice(0, 3).forEach((l, i) => g.fillText(l, 26, 26 + i * (width / 8)));
  return c;
}

/**
 * shelfScene(items, { onOpen }) -> scene builder for glStage.
 * items: [{ id, title, url }] (url may be null).
 * The returned api has setHot(index) for the card under the pointer.
 */
export function shelfScene(items, { onOpen } = {}) {
  return (THREE, env) => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0.6, 12);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-3, 4, 6);
    scene.add(sun);

    const shown = items.slice(0, 7);
    const group = new THREE.Group();
    scene.add(group);
    const geometry = new THREE.BoxGeometry(2, 3, 0.1);
    let pal = env.palette;
    const edge = new THREE.MeshLambertMaterial({ color: new THREE.Color(pal.sheet) });
    const back = new THREE.MeshLambertMaterial({ color: new THREE.Color(pal.ink) });
    const books = shown.map((item, i) => {
      const fallback = new THREE.CanvasTexture(titleCanvas(item.title, pal));
      fallback.colorSpace = THREE.SRGBColorSpace;
      const front = new THREE.MeshBasicMaterial({ map: fallback });
      const mesh = new THREE.Mesh(geometry, [edge, edge, edge, edge, front, back]);
      const offset = i - (shown.length - 1) / 2;
      const base = {
        x: offset * 1.45, y: -Math.abs(offset) * 0.08, z: -Math.abs(offset) * 0.55,
        ry: -offset * 0.16, rz: offset * 0.035,
      };
      mesh.position.set(base.x, base.y - 3, base.z);
      mesh.rotation.set(0, base.ry, base.rz);
      mesh.userData = { item, base, lift: 0, front, phase: i * 1.7 };
      group.add(mesh);
      if (item.url) {
        smallTexture(THREE, item.url, 320).then((res) => {
          if (!res) return;
          fallback.dispose();
          front.map = res.texture;
          front.needsUpdate = true;
          env.invalidate();
        });
      }
      return mesh;
    });

    const pointer = { x: 0, y: 0, inside: false };
    let hot = -1;
    let idleUntil = 0;
    let rise = 0;
    const raycaster = new THREE.Raycaster();

    const api = {
      render(time, dt) {
        const k = Math.min(1, dt * 7);
        rise = Math.min(1, rise + dt * 1.6);
        const ease = 1 - (1 - rise) ** 3;
        let moving = rise < 1;
        group.rotation.y += ((pointer.inside ? pointer.x * 0.22 : 0) - group.rotation.y) * k;
        group.rotation.x += ((pointer.inside ? -pointer.y * 0.08 : 0) - group.rotation.x) * k;
        if (Math.abs(group.rotation.y - (pointer.inside ? pointer.x * 0.22 : 0)) > 0.001) moving = true;
        const sway = !env.reduced && time < idleUntil;
        books.forEach((b, i) => {
          const d = b.userData;
          const target = i === hot ? 1 : 0;
          d.lift += (target - d.lift) * k;
          if (Math.abs(target - d.lift) > 0.002) moving = true;
          const bob = sway ? Math.sin(time * 0.8 + d.phase) * 0.04 : 0;
          b.position.x = d.base.x;
          b.position.y = d.base.y + d.lift * 0.35 + bob + (ease - 1) * 3;
          b.position.z = d.base.z + d.lift * 1.1;
          b.rotation.y = d.base.ry * (1 - d.lift);
          b.rotation.z = d.base.rz * (1 - d.lift);
        });
        if (sway) moving = true;
        env.renderer.render(scene, camera);
        return moving;
      },
      resize(w, h) {
        camera.aspect = w / h;
        // Keep every book in view on a narrow stage.
        const span = Math.max(4, shown.length * 1.45 + 1.2);
        const fitZ = (span / 2) / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect;
        camera.position.z = Math.max(shown.length > 2 ? 10.5 : 8, fitZ * 0.95);
        camera.updateProjectionMatrix();
      },
      pointer(x, y, inside) {
        pointer.x = x; pointer.y = y; pointer.inside = inside;
        idleUntil = performance.now() / 1000 + 6;
        if (!inside) return;
        raycaster.setFromCamera({ x, y }, camera);
        const hit = raycaster.intersectObjects(books, false)[0];
        hot = hit ? books.indexOf(hit.object) : -1;
        env.canvas.style.cursor = hit ? 'pointer' : '';
      },
      click(x, y) {
        raycaster.setFromCamera({ x, y }, camera);
        const hit = raycaster.intersectObjects(books, false)[0];
        if (hit && onOpen) onOpen(hit.object.userData.item);
      },
      setHot(id) {
        hot = books.findIndex((b) => b.userData.item.id === id);
        env.invalidate();
      },
      theme(next) {
        pal = next;
        edge.color.set(pal.sheet);
        back.color.set(pal.ink);
      },
      dispose() {
        geometry.dispose();
        edge.dispose();
        back.dispose();
        for (const b of books) {
          if (b.userData.front.map) b.userData.front.map.dispose();
          b.userData.front.dispose();
        }
      },
    };
    idleUntil = performance.now() / 1000 + 6;
    return api;
  };
}
