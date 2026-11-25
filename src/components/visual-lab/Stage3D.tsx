import { useEffect, useRef } from 'react';
import type { Scene } from '../../core/visualisation/scene';
import { StoryBanner } from './StoryBanner';
import { LabRenderer } from './three/LabRenderer';
import './Stage3D.css';

export interface Stage3DProps {
  readonly scene: Scene;
  /** Animation length for this transition; 0 jumps straight to the final state. */
  readonly durationMs: number;
  /** Changes whenever the user asks to reset the camera. */
  readonly resetSignal: number;
  /** Called if WebGL cannot be initialised, so the lab can fall back to 2D. */
  readonly onUnavailable: (reason: string) => void;
}

/** React wrapper around the Three.js laboratory (loaded lazily with this module). */
export default function Stage3D({ scene, durationMs, resetSignal, onUnavailable }: Stage3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<LabRenderer | null>(null);
  const failed = useRef(onUnavailable);
  failed.current = onUnavailable;

  useEffect(() => {
    if (!host.current) return;
    try {
      renderer.current = new LabRenderer(host.current);
    } catch (err) {
      failed.current(err instanceof Error ? err.message : 'WebGL is not available.');
      return;
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    renderer.current?.show(scene, durationMs);
  }, [scene, durationMs]);

  useEffect(() => {
    if (resetSignal > 0) renderer.current?.resetView(true);
  }, [resetSignal]);

  return (
    <div className="lab3d-wrap">
      {/* The story sits above the 3D scene (never on top of it). */}
      <div className="lab3d-caption">
        <StoryBanner story={scene.story} variant="stage" />
      </div>
      <div className="lab3d" ref={host} role="img" aria-label={`3D picture of step ${scene.stepNumber}: ${scene.story.headline}`} />
    </div>
  );
}
