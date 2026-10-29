import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { addModelLighting, createARContent, modelDepth } from '../../ar/content.js';
import { HotspotLayer } from '../../ar/hotspots.js';
import styles from './ExperienceForm.module.css';

/**
 * Desktop preview of the AR scene: the target image lying in its own plane
 * with the configured content and hotspots, using exactly the same content
 * builders as the live AR page. No camera or tracking involved.
 */
export default function PlacementPreview({ targetUrl, targetAspect, content, contentUrl, placement, hotspots, accentColor }) {
  const hostRef = useRef(null);
  const ctx = useRef(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const placementRef = useRef(placement);
  placementRef.current = placement;

  // Renderer, camera, controls — created once.
  useEffect(() => {
    const host = hostRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    camera.position.set(0.55, -0.85, 1.55);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0.05);
    controls.maxDistance = 6;
    controls.minDistance = 0.3;

    const anchor = new THREE.Group();
    scene.add(anchor);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.1);
      ctx.current?.content?.update(dt);
      ctx.current?.hotspots?.update(dt);
      controls.update();
      renderer.render(scene, camera);
    });

    const disposeLighting = addModelLighting(scene, renderer);
    ctx.current = { renderer, scene, camera, anchor, content: null, hotspots: null, target: null };

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      ctx.current?.content?.dispose();
      ctx.current?.hotspots?.dispose();
      ctx.current?.target?.geometry.dispose();
      ctx.current?.target?.material.map?.dispose();
      ctx.current?.target?.material.dispose();
      disposeLighting();
      renderer.dispose();
      renderer.domElement.remove();
      ctx.current = null;
    };
  }, []);

  // Target image plane.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !targetUrl) return undefined;
    let cancelled = false;
    new THREE.TextureLoader().loadAsync(targetUrl).then((tex) => {
      if (cancelled || !ctx.current) return tex.dispose();
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, targetAspect),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }),
      );
      mesh.position.z = -0.001;
      c.anchor.add(mesh);
      c.target = mesh;
    });
    return () => {
      cancelled = true;
      if (c.target) {
        c.target.removeFromParent();
        c.target.geometry.dispose();
        c.target.material.map?.dispose();
        c.target.material.dispose();
        c.target = null;
      }
    };
  }, [targetUrl, targetAspect]);

  // Content (rebuilt only when the asset or its geometry-affecting options change).
  const { type, fit, loop, playAnimations, alignToTarget, depth } = content;
  useEffect(() => {
    const c = ctx.current;
    if (!c || !contentUrl) return undefined;
    let cancelled = false;
    let built = null;
    setStatus('loading');
    setError('');
    createARContent({
      content: { type, fit, loop, startMuted: true, playAnimations, alignToTarget, depth },
      placement: placementRef.current,
      targetAspect,
      url: contentUrl,
    })
      .then((result) => {
        if (cancelled) return result.dispose();
        built = result;
        c.content = result;
        c.anchor.add(result.root);
        result.showImmediately();
        result.video?.play().catch(() => {});
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setError(err.message);
      });
    return () => {
      cancelled = true;
      if (built) {
        built.dispose();
        if (c.content === built) c.content = null;
      }
    };
  }, [contentUrl, type, fit, loop, playAnimations, alignToTarget, depth, targetAspect]);

  // Placement is applied live without rebuilding.
  useEffect(() => {
    ctx.current?.content?.applyPlacement(placement);
  }, [placement, status]);

  // Hotspots — all shown with their labels open in the preview.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return undefined;
    const layer = new HotspotLayer({
      hotspots,
      targetAspect,
      accentColor,
      alwaysShowLabels: true,
      depthScale: modelDepth({ type, depth }),
    });
    c.anchor.add(layer.group);
    c.hotspots = layer;
    return () => {
      layer.dispose();
      if (c.hotspots === layer) c.hotspots = null;
    };
  }, [hotspots, targetAspect, accentColor, type, depth]);

  return (
    <div className={styles.preview}>
      <div ref={hostRef} className={styles.previewCanvas} />
      {!contentUrl && <div className={styles.previewNote}>Upload AR content to preview it here.</div>}
      {status === 'loading' && (
        <div className={styles.previewNote}>
          <span className="spinner" /> Loading preview…
        </div>
      )}
      {status === 'error' && <div className={`${styles.previewNote} ${styles.previewError}`}>{error}</div>}
      <span className={styles.previewHint}>Drag to orbit · scroll to zoom</span>
    </div>
  );
}
