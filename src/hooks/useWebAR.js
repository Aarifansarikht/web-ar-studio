import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ImageTrackingSession } from '../ar/ImageTrackingSession.js';
import { ARError, detectARSupportIssue } from '../ar/environment.js';
import { addModelLighting, createARContent, modelDepth } from '../ar/content.js';
import { HotspotLayer } from '../ar/hotspots.js';
import { LockOnFrame } from '../ar/lockOn.js';
import { requestMotionAccess } from '../ar/GyroTracker.js';

/**
 * Lifecycle of one image-tracked AR session over one or more artworks.
 *
 * `experiences[i]` is recognised by target i of `assets.mindBuffer` (a single
 * experience, or a gallery whose compiled targets were merged in that order).
 * Whichever artwork is in view shows its own content; the others stay hidden.
 *
 * status: 'idle' | 'starting' | 'scanning' | 'tracking' | 'searching' | 'error'
 *   scanning  – no artwork found yet
 *   tracking  – an artwork is in view, its content anchored to it
 *   searching – the artwork left the view after being found; content is hidden
 *               (it only ever appears on the image) until an artwork is seen again
 *
 * The camera is only requested when `start()` is called (from a user tap).
 * `stop()` and unmount release the camera, the tracking worker, the WebGL
 * context and all content resources.
 */
export function useWebAR({ containerRef, experiences, assets }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [videoBlocked, setVideoBlocked] = useState(false);
  const [muted, setMuted] = useState(true);
  const [activeHotspot, setActiveHotspot] = useState(null);
  const [fullscreen, setFullscreenState] = useState(false);
  const [stats, setStats] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const runtime = useRef(null);
  const startingRef = useRef(false);

  const teardown = useCallback(async () => {
    const rt = runtime.current;
    runtime.current = null;
    if (!rt) return;
    rt.container.removeEventListener('click', rt.onClick);
    document.removeEventListener('visibilitychange', rt.onVisibility);
    for (const item of rt.items) {
      item.content?.dispose();
      item.hotspots?.dispose();
      item.lockOn?.dispose();
    }
    rt.disposeLighting?.();
    await rt.session.stop();
  }, []);

  const stop = useCallback(async () => {
    await teardown();
    startingRef.current = false;
    setStatus('idle');
    setVideoBlocked(false);
    setActiveHotspot(null);
    setFullscreenState(false);
  }, [teardown]);

  const start = useCallback(async () => {
    const container = containerRef.current;
    if (!container || !experiences?.length || !assets || startingRef.current || runtime.current) return;
    startingRef.current = true;
    // Experimental gyroscope fusion (?debug&gyro=1) needs motion access, which
    // iOS only grants from inside the tap. Not requested otherwise.
    const q = new URLSearchParams(window.location.search);
    if (q.has('debug') && q.get('gyro') === '1') requestMotionAccess();
    setError(null);
    setFullscreenState(false);
    setVideoBlocked(false);
    setActiveHotspot(null);

    const issue = detectARSupportIssue();
    if (issue) {
      startingRef.current = false;
      setError(issue);
      setStatus('error');
      return;
    }

    setStatus('starting');

    const rt = { container, items: [], active: 0 };
    const activeItem = () => rt.items[rt.active];

    /** Make artwork i the active one: its content plays, every other one pauses. */
    const activate = async (i) => {
      if (rt.active !== i) {
        rt.items[rt.active]?.content?.onLost();
        rt.items[rt.active]?.hotspots?.toggle(null);
        rt.active = i;
        if (runtime.current === rt) {
          setActiveIndex(i);
          setActiveHotspot(null);
          setMuted(rt.items[i]?.content?.video ? rt.items[i].content.video.muted : true);
        }
      }
      const item = rt.items[i];
      if (!item?.content) return;
      const { blocked } = await item.content.onFound();
      if (runtime.current === rt) setVideoBlocked(blocked);
    };

    const session = new ImageTrackingSession({
      container,
      mindBuffer: assets.mindBuffer,
      onTrackingChange: ({ type, targetIndex }) => {
        if (runtime.current !== rt) return;
        if (type === 'found') {
          setStatus('tracking');
          const item = rt.items[targetIndex];
          // Lock-on cue on the first lock of each artwork only: re-locks after
          // a brief look away should feel continuous, not like a new scan.
          if (item && !session.fullscreen && !item.lockedOnce) item.lockOn?.play();
          if (item) item.lockedOnce = true;
          activate(targetIndex);
        } else {
          // Artwork left the view: content hidden until an artwork is seen again
          // (no scan screen; a small hint is shown instead).
          setStatus('searching');
        }
      },
      onModeChange: ({ fullscreen: on }) => {
        if (runtime.current !== rt) return;
        setFullscreenState(on);
        if (on) activeItem()?.lockOn?.update(10); // hide brackets while detached
      },
      onFrame: (dt) => {
        // Show only the artwork whose pose is on screen (the view is slightly
        // delayed, so this can lag the tracker's own state by a few frames).
        const shown = session.fullscreen ? rt.active : session.displayTarget;
        rt.items.forEach((item, i) => {
          item.group.visible = i === shown;
        });
        const item = activeItem();
        item?.content?.update(dt);
        item?.hotspots?.update(dt);
        item?.lockOn?.update(dt);
      },
    });
    rt.session = session;

    rt.onClick = (e) => {
      const item = activeItem();
      if (!item?.hotspots?.items.length) return;
      const hit = session.pick(e.clientX, e.clientY, item.hotspots.hitTargets);
      // Tapping a marker toggles its label; tapping anywhere else closes it.
      const id = item.hotspots.toggle(hit?.object.userData.hotspotId ?? null);
      setActiveHotspot(item.experience.hotspots.find((h) => h.id === id) ?? null);
    };
    rt.onVisibility = () => {
      const video = activeItem()?.content?.video;
      if (!video) return;
      if (document.hidden) video.pause();
      else if (session.hasFoundTarget) activate(rt.active);
    };
    runtime.current = rt;

    try {
      await session.start();
      if (runtime.current !== rt) return;

      if (experiences.some((e) => e.content.type === 'model')) {
        rt.disposeLighting = addModelLighting(session.scene, session.renderer);
      }
      const maxAnisotropy = session.renderer.capabilities.getMaxAnisotropy();
      const contents = await Promise.all(
        experiences.map((experience, i) =>
          createARContent({
            content: experience.content,
            placement: experience.placement,
            targetAspect: session.targets[i]?.aspect ?? 1,
            url: assets.contentUrls[i],
            maxAnisotropy,
          }),
        ),
      );
      if (runtime.current !== rt) {
        contents.forEach((c) => c.dispose());
        return;
      }

      experiences.forEach((experience, i) => {
        const aspect = session.targets[i]?.aspect ?? 1;
        const group = new THREE.Group();
        group.visible = false;
        const item = { experience, group, content: contents[i], hotspots: null, lockOn: null, lockedOnce: false };
        group.add(item.content.root);
        if (experience.hotspots?.length) {
          item.hotspots = new HotspotLayer({
            hotspots: experience.hotspots,
            targetAspect: aspect,
            accentColor: experience.brand?.accentColor,
            depthScale: modelDepth(experience.content),
          });
          group.add(item.hotspots.group);
        }
        item.lockOn = new LockOnFrame({ targetAspect: aspect, color: experience.brand?.accentColor });
        group.add(item.lockOn.group);
        session.anchor.add(group);
        rt.items.push(item);
      });

      container.addEventListener('click', rt.onClick);
      document.addEventListener('visibilitychange', rt.onVisibility);
      setMuted(activeItem()?.content?.video ? activeItem().content.video.muted : true);

      if (session.isTracking) {
        setStatus('tracking');
        const i = Math.max(0, session.activeTarget);
        rt.items[i].lockOn.play();
        rt.items[i].lockedOnce = true;
        activate(i);
      } else {
        setStatus('scanning');
      }
    } catch (err) {
      if (runtime.current === rt) await teardown();
      console.error('[webar]', err);
      setError(err instanceof ARError ? err : new ARError('engine', err?.message || 'AR failed to start.', err));
      setStatus('error');
    } finally {
      startingRef.current = false;
    }
  }, [containerRef, experiences, assets, teardown]);

  const activeVideo = () => {
    const rt = runtime.current;
    return rt?.items[rt.active]?.content?.video ?? null;
  };

  const toggleMute = useCallback(() => {
    const video = activeVideo();
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    if (video.paused && runtime.current.session.hasFoundTarget) video.play().catch(() => {});
  }, []);

  /** Toggle the screen-filling view of the content (works with or without tracking). */
  const toggleFullscreen = useCallback(() => {
    const rt = runtime.current;
    if (!rt?.session) return;
    const next = !rt.session.fullscreen;
    rt.session.setFullscreen(next); // state is updated via onModeChange
    if (next) {
      rt.items[rt.active]?.content?.onFound().then(({ blocked }) => runtime.current === rt && setVideoBlocked(blocked));
    }
  }, []);

  const resumeVideo = useCallback(async () => {
    const video = activeVideo();
    if (!video) return;
    try {
      await video.play();
      setVideoBlocked(false);
    } catch {
      // Still blocked: try muted playback, which every mobile browser allows.
      video.muted = true;
      setMuted(true);
      await video.play().catch(() => {});
      setVideoBlocked(video.paused);
    }
  }, []);

  // Diagnostics overlay (?debug in the URL): tracker frame rate.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('debug')) return undefined;
    const t = setInterval(() => {
      const s = runtime.current?.session;
      setStats(s ? { ...s.stats, tracking: s.isTracking } : null);
    }, 500);
    return () => clearInterval(t);
  }, []);

  // Release everything on unmount.
  useEffect(() => () => void teardown(), [teardown]);

  const activeExperience = experiences?.[activeIndex] ?? experiences?.[0] ?? null;
  return {
    status,
    error,
    start,
    stop,
    videoBlocked,
    resumeVideo,
    muted,
    toggleMute,
    hasVideo: activeExperience?.content?.type === 'video',
    activeHotspot,
    fullscreen,
    toggleFullscreen,
    stats,
    /** The artwork currently (or last) in view. */
    activeExperience,
    activeIndex,
  };
}
