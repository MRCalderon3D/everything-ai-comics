// The page viewer in 3D: the drawn page as a sheet of paper that leans a
// little toward the pointer and lies flat when left alone, so it reads like
// a page on the desk. Choosing another version turns the sheet over to it.
// Clicking opens the large viewer, where the image is shown flat.

import { smallTexture } from '/js/gl/stage.js';

/** sheetScene({ url, width, height, onOpen }) -> builder; api.show(url) flips to another image. */
export function sheetScene({ url, width = 2, height = 3, onOpen } = {}) {
  return (THREE, env) => {
    const aspect = width / height || 2 / 3;
    const sw = aspect >= 2 / 3 ? 2 : 3 * aspect;
    const sh = sw / aspect;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(24, 2 / 3, 0.1, 50);
    scene.add(new THREE.AmbientLight(0xffffff, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(-2, 3, 6);
    scene.add(key);
    let pal = env.palette;

    const holder = new THREE.Group();
    scene.add(holder);
    const geo = new THREE.BoxGeometry(sw, sh, 0.015);
    const edge = new THREE.MeshLambertMaterial({ color: new THREE.Color(pal.sheet) });
    const face = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const backFace = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const sheet = new THREE.Mesh(geo, [edge, edge, edge, edge, face, backFace]);
    holder.add(sheet);

    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 64;
    shadowCanvas.height = 96;
    const sg = shadowCanvas.getContext('2d');
    const grad = sg.createRadialGradient(32, 48, 4, 32, 48, 46);
    grad.addColorStop(0, 'rgba(0,0,0,0.38)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 64, 96);
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(sw * 1.25, sh * 1.2),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.position.set(0.12, -0.16, -0.25);
    scene.add(shadow);

    const textures = new Map();
    let flip = 0; // 0 = at rest; animates to PI while turning over
    let pending = null;
    let intro = env.reduced ? 1 : 0;
    const pointer = { x: 0, y: 0, inside: false };

    function load(u) {
      if (!u) return Promise.resolve(null);
      if (textures.has(u)) return Promise.resolve(textures.get(u));
      return smallTexture(THREE, u, 1400).then((res) => {
        if (res) textures.set(u, res.texture);
        return res ? res.texture : null;
      });
    }
    load(url).then((tex) => {
      if (tex) { face.map = tex; face.needsUpdate = true; }
      env.invalidate();
    });

    return {
      render(time, dt) {
        const k = Math.min(1, dt * 6);
        let moving = false;
        if (intro < 1) { intro = Math.min(1, intro + dt * 1.8); moving = true; }
        const e = 1 - (1 - intro) ** 3;
        const tx = pointer.inside ? -pointer.y * 0.07 : 0;
        const ty = pointer.inside ? pointer.x * 0.09 : 0;
        holder.rotation.x += (tx - holder.rotation.x) * k;
        holder.rotation.y += (ty - holder.rotation.y) * k;
        if (Math.abs(tx - holder.rotation.x) > 0.0005 || Math.abs(ty - holder.rotation.y) > 0.0005) moving = true;
        if (pending) {
          flip = env.reduced ? Math.PI : Math.min(Math.PI, flip + dt * 6);
          if (flip >= Math.PI / 2 && pending.tex && face.map !== pending.tex) {
            backFace.map = face.map;
            face.map = pending.tex;
            face.needsUpdate = true;
            backFace.needsUpdate = true;
          }
          if (flip >= Math.PI) { flip = 0; pending = null; }
          moving = true;
        }
        sheet.rotation.y = flip > Math.PI / 2 ? flip - Math.PI : flip;
        sheet.position.y = (1 - e) * -0.6;
        sheet.rotation.x = (1 - e) * -0.5;
        env.renderer.render(scene, camera);
        return moving;
      },
      resize(w, h) {
        camera.aspect = w / h;
        const fov = (camera.fov * Math.PI) / 180;
        const fitH = (sh * 1.08) / 2 / Math.tan(fov / 2);
        const fitW = (sw * 1.08) / 2 / Math.tan(fov / 2) / camera.aspect;
        camera.position.set(0, 0, Math.max(fitH, fitW));
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
      },
      pointer(x, y, inside) { pointer.x = x; pointer.y = y; pointer.inside = inside; },
      click() { if (onOpen) onOpen(); },
      show(next) {
        load(next).then((tex) => {
          if (!tex || tex === face.map) return;
          pending = { tex };
          flip = 0;
          env.invalidate();
        });
      },
      theme(next) { pal = next; edge.color.set(pal.sheet); },
      dispose() {
        geo.dispose();
        edge.dispose();
        face.dispose();
        backFace.dispose();
        shadowTex.dispose();
        shadow.geometry.dispose();
        shadow.material.dispose();
        for (const t of textures.values()) t.dispose();
      },
    };
  };
}
