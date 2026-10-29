import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageTrackingSession } from '../ar/ImageTrackingSession.js';
import { ARError, detectARSupportIssue, requestOrientationAccess } from '../ar/environment.js';
import { addModelLighting, createARContent } from '../ar/content.js';
import { HotspotLayer } from '../ar/hotspots.js';
import { LockOnFrame } from '../ar/lockOn.js';

/**
 * Lifecycle of one image-tracked AR session.
 *
 * status: 'idle' | 'starting' | 'scanning' | 'tracking' | 'holding' | 'error'
 *   scanning  – target not found yet
 *   tracking  – target in view, content anchored to it
 *   holding   – target left the view after being found; content stays
 *               (gyro-stabilised extended tracking) and re-locks when seen again
 *
 * The camera is only requested when `start()` is called (from a user tap).
 * `stop()` and unmount release the camera, the tracking worker, the WebGL
 * context and all content resources.
 */
export function useWebAR({ containerRef, experience, assets }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [videoBlocked, setVideoBlocked] = useState(false);
  const [muted, setMuted] = useState(true);
  const [activeHotspot, setActiveHotspot] = useState(null);
  const [fullscreen, setFullscreenState] = useState(false);
  const [stats, setStats] = useState(null);

  const runtime = useRef(null);
  const startingRef = useRef(false);

  const teardown = useCallback(async () => {
    const rt = runtime.current;
    runtime.current = null;
    if (!rt) return;
    rt.container.removeEventListener('click', rt.onClick);
    document.removeEventListener('visibilitychange', rt.onVisibility);
    rt.content?.dispose();
    rt.hotspots?.dispose();
    rt.lockOn?.dispose();
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
    if (!container || !experience || !assets || startingRef.current || runtime.current) return;
    startingRef.current = true;
    // Must run synchronously inside the tap handler (iOS permission prompt).
    const orientationAccess = requestOrientationAccess();
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

    const rt = { container, content: null, hotspots: null };
    const playContent = async () => {
      if (!rt.content) return;
      const { blocked } = await rt.content.onFound();
      if (runtime.current === rt) setVideoBlocked(blocked);
    };

    const session = new ImageTrackingSession({
      container,
      mindBuffer: assets.mindBuffer,
      onTrackingChange: ({ type }) => {
        if (runtime.current !== rt) return;
        if (type === 'found') {
          setStatus('tracking');
          if (!session.fullscreen) rt.lockOn?.play();
          playContent();
        } else {
          // Keep the content visible and playing: no return to the scan screen.
          setStatus('holding');
        }
      },
      onModeChange: ({ fullscreen: on }) => {
        if (runtime.current !== rt) return;
        setFullscreenState(on);
        if (on) rt.lockOn?.update(10); // hide brackets while detached
      },
      onFrame: (dt) => {
        rt.content?.update(dt);
        rt.hotspots?.update(dt);
        rt.lockOn?.update(dt);
      },
    });
    rt.session = session;

    rt.onClick = (e) => {
      if (!rt.hotspots?.items.length) return;
      const hit = session.pick(e.clientX, e.clientY, rt.hotspots.hitTargets);
      // Tapping a marker toggles its label; tapping anywhere else closes it.
      const id = rt.hotspots.toggle(hit?.object.userData.hotspotId ?? null);
      setActiveHotspot(experience.hotspots.find((h) => h.id === id) ?? null);
    };
    rt.onVisibility = () => {
      const video = rt.content?.video;
      if (!video) return;
      if (document.hidden) video.pause();
      else if (session.hasFoundTarget) playContent();
    };
    runtime.current = rt;

    try {
      await session.start();
      if (runtime.current !== rt) return;
      session.enableOrientation(await orientationAccess);

      if (experience.content.type === 'model') {
        rt.disposeLighting = addModelLighting(session.scene, session.renderer);
      }
      const content = await createARContent({
        content: experience.content,
        placement: experience.placement,
        targetAspect: session.targetAspect,
        url: assets.contentUrl,
        maxAnisotropy: session.renderer.capabilities.getMaxAnisotropy(),
      });
      if (runtime.current !== rt) {
        content.dispose();
        return;
      }
      rt.content = content;
      session.anchor.add(content.root);

      if (experience.hotspots?.length) {
        rt.hotspots = new HotspotLayer({
          hotspots: experience.hotspots,
          targetAspect: session.targetAspect,
          accentColor: experience.brand?.accentColor,
        });
        session.anchor.add(rt.hotspots.group);
      }

      rt.lockOn = new LockOnFrame({ targetAspect: session.targetAspect, color: experience.brand?.accentColor });
      session.anchor.add(rt.lockOn.group);

      container.addEventListener('click', rt.onClick);
      document.addEventListener('visibilitychange', rt.onVisibility);
      setMuted(content.video ? content.video.muted : true);

      if (session.isTracking) {
        setStatus('tracking');
        rt.lockOn.play();
        playContent();
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
  }, [containerRef, experience, assets, teardown]);

  const toggleMute = useCallback(() => {
    const video = runtime.current?.content?.video;
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
    if (next) rt.content?.onFound().then(({ blocked }) => runtime.current === rt && setVideoBlocked(blocked));
  }, []);

  const resumeVideo = useCallback(async () => {
    const video = runtime.current?.content?.video;
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
      setStats(s ? { trackFps: s.stats.trackFps, tracking: s.isTracking } : null);
    }, 500);
    return () => clearInterval(t);
  }, []);

  // Release everything on unmount.
  useEffect(() => () => void teardown(), [teardown]);

  return {
    status,
    error,
    start,
    stop,
    videoBlocked,
    resumeVideo,
    muted,
    toggleMute,
    hasVideo: experience?.content?.type === 'video',
    activeHotspot,
    fullscreen,
    toggleFullscreen,
    stats,
  };
}
