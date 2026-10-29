import * as THREE from 'three';

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Accent corner brackets that snap onto the target's edges when it is
 * recognised, then fade out: a "locked on" cue drawn in target space.
 */
export class LockOnFrame {
  constructor({ targetAspect, color = '#e5173f' }) {
    this.group = new THREE.Group();
    this.group.name = 'lock-on';
    this.group.renderOrder = 12;
    this.material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false });
    this.glow = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const w = 0.5;
    const h = targetAspect / 2;
    const size = Math.min(1, targetAspect);
    const len = 0.16 * size;
    const thick = 0.009 * size;
    this.geometries = [new THREE.PlaneGeometry(len, thick), new THREE.PlaneGeometry(thick, len)];
    this.glowGeometries = [new THREE.PlaneGeometry(len, thick * 4), new THREE.PlaneGeometry(thick * 4, len)];

    for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const corner = new THREE.Group();
      corner.position.set(sx * w, sy * h, 0.02);
      const horiz = new THREE.Mesh(this.geometries[0], this.material);
      horiz.position.set((-sx * len) / 2 + (sx * thick) / 2, 0, 0);
      const vert = new THREE.Mesh(this.geometries[1], this.material);
      vert.position.set(0, (-sy * len) / 2 + (sy * thick) / 2, 0);
      const hGlow = new THREE.Mesh(this.glowGeometries[0], this.glow);
      hGlow.position.copy(horiz.position);
      const vGlow = new THREE.Mesh(this.glowGeometries[1], this.glow);
      vGlow.position.copy(vert.position);
      for (const m of [horiz, vert, hGlow, vGlow]) m.renderOrder = 12;
      corner.add(hGlow, vGlow, horiz, vert);
      corner.userData.dir = new THREE.Vector2(sx, sy);
      this.group.add(corner);
    }
    this.corners = this.group.children;
    this.t = Infinity;
    this.group.visible = false;
  }

  /** Play the snap-on animation. */
  play() {
    this.t = 0;
    this.group.visible = true;
  }

  update(dt) {
    if (!this.group.visible) return;
    this.t += dt;
    const snap = easeOut(Math.min(1, this.t / 0.45));
    const fade = this.t < 0.9 ? 1 : Math.max(0, 1 - (this.t - 0.9) / 0.5);
    // Brackets start 18% outside the target and slide onto its corners.
    const spread = 0.18 * (1 - snap);
    for (const c of this.corners) {
      const base = c.userData.base ?? (c.userData.base = c.position.clone());
      c.position.set(base.x * (1 + spread), base.y * (1 + spread), base.z);
    }
    this.material.opacity = Math.min(1, this.t / 0.15) * fade;
    this.glow.opacity = 0.35 * this.material.opacity;
    if (fade <= 0) this.group.visible = false;
  }

  dispose() {
    this.material.dispose();
    this.glow.dispose();
    for (const g of [...this.geometries, ...this.glowGeometries]) g.dispose();
    this.group.removeFromParent();
  }
}
