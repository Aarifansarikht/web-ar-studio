import * as THREE from 'three';

const HOTSPOT_Z = 0.012;
const DOT_RADIUS = 0.012;

function makeLabelTexture(text, accent) {
  const fontSize = 44;
  const paddingX = 34;
  const height = 92;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `800 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.font = font;
  const textWidth = Math.ceil(ctx.measureText(text.toUpperCase()).width);
  const dpr = 2;
  const width = textWidth + paddingX * 2 + 26;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // Pill
  const r = height / 2 - 6;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = 'rgba(15,17,23,0.18)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(4, 6, width - 8, height - 12, r);
  ctx.fill();
  ctx.stroke();

  // Accent marker
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(paddingX - 2, height / 2, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = font;
  ctx.fillStyle = '#2a2d36';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), paddingX + 18, height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: width / height };
}

/**
 * Pulsing, tappable hotspot markers positioned on the target image.
 * Positions are normalised (0..1) from the target's top-left corner.
 */
export class HotspotLayer {
  /** @param {{hotspots: Array, targetAspect: number, accentColor?: string, alwaysShowLabels?: boolean, depthScale?: number}} opts */
  constructor({ hotspots, targetAspect, accentColor = '#e5173f', alwaysShowLabels = false, depthScale = 1 }) {
    this.alwaysShowLabels = alwaysShowLabels;
    // Hotspot depths follow the model's depth compression (content.depth).
    this.depthScale = depthScale;
    this.group = new THREE.Group();
    this.group.name = 'hotspots';
    this.items = [];
    this.activeId = null;
    this.accent = new THREE.Color(accentColor);
    this.accentHex = accentColor;
    this.targetAspect = targetAspect;
    // Size markers by the target's shorter side so they look the same on wide
    // posters and portrait prints (1 unit = target width).
    this.sizeScale = Math.min(1, targetAspect);
    this.time = 0;

    this.dotGeometry = new THREE.CircleGeometry(DOT_RADIUS, 32);
    this.ringGeometry = new THREE.RingGeometry(DOT_RADIUS * 1.25, DOT_RADIUS * 1.6, 40);
    // Generous invisible tap area, independent of the small visual dot.
    this.hitGeometry = new THREE.CircleGeometry(DOT_RADIUS * 5, 16);

    for (const h of hotspots) this.#add(h);
  }

  #add(h) {
    const root = new THREE.Group();
    root.position.set(h.x - 0.5, (0.5 - h.y) * this.targetAspect, HOTSPOT_Z + (h.z ?? 0) * this.depthScale);
    root.scale.setScalar(this.sizeScale);
    root.userData.hotspotId = h.id;

    const dot = new THREE.Mesh(
      this.dotGeometry,
      new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, depthTest: false }),
    );
    dot.renderOrder = 10;

    const border = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
    );
    border.renderOrder = 10;

    const pulse = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, depthTest: false }),
    );
    pulse.renderOrder = 9;

    // Larger invisible disc so the marker is easy to tap on a phone.
    const hit = new THREE.Mesh(
      this.hitGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hit.userData.hotspotId = h.id;

    const { texture, aspect } = makeLabelTexture(h.label, this.accentHex);
    const labelHeight = 0.05;
    const labelWidth = labelHeight * aspect;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(labelWidth, labelHeight),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 }),
    );
    label.renderOrder = 11;
    const side = h.x > 0.62 ? -1 : 1; // keep labels inside the target
    label.position.set(side * (labelWidth / 2 + DOT_RADIUS * 2.4), 0, 0.001);
    label.visible = false;

    root.add(pulse, border, dot, hit, label);
    this.group.add(root);
    this.items.push({ id: h.id, root, dot, pulse, hit, label, phase: Math.random() * Math.PI * 2, open: 0 });
  }

  get hitTargets() {
    return this.items.map((i) => i.hit);
  }

  /** Toggle a hotspot by id (or close all with null). Returns the active id. */
  toggle(id) {
    this.activeId = this.activeId === id ? null : id;
    return this.activeId;
  }

  update(dt) {
    this.time += dt;
    for (const item of this.items) {
      const t = (this.time * 0.8 + item.phase) % 1;
      item.pulse.scale.setScalar(1 + t * 1.6);
      item.pulse.material.opacity = 0.7 * (1 - t);

      const target = this.alwaysShowLabels || item.id === this.activeId ? 1 : 0;
      item.open += (target - item.open) * Math.min(1, dt * 12);
      item.label.visible = item.open > 0.01;
      item.label.material.opacity = item.open;
      item.label.scale.setScalar(0.85 + 0.15 * item.open);
      item.dot.scale.setScalar(1 + 0.35 * item.open);
    }
  }

  dispose() {
    for (const item of this.items) {
      item.dot.material.dispose();
      item.pulse.material.dispose();
      item.root.children[1].material.dispose();
      item.hit.material.dispose();
      item.label.material.map?.dispose();
      item.label.material.dispose();
      item.label.geometry.dispose();
    }
    this.dotGeometry.dispose();
    this.ringGeometry.dispose();
    this.hitGeometry.dispose();
    this.group.removeFromParent();
  }
}
