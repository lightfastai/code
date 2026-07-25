import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { ChatScene3DArtifact, type Scene3DObject, type SceneVec3 } from "./contracts.ts";

const DEFAULT_CAMERA_POSITION: SceneVec3 = [5.5, 4.5, 6.5];
const DEFAULT_CAMERA_TARGET: SceneVec3 = [0, 0.75, 0];
const DEFAULT_CAPABILITIES = ["orbit", "pan", "zoom", "reset-camera"] as const;
const decodeScene3DArtifact = Schema.decodeUnknownOption(ChatScene3DArtifact);

const toVector3 = (value: SceneVec3): THREE.Vector3 =>
  new THREE.Vector3(value[0], value[1], value[2]);

function safeNormal(value: SceneVec3): THREE.Vector3 {
  const normal = toVector3(value);
  return normal.lengthSq() > 0.000001 ? normal.normalize() : new THREE.Vector3(0, 0, 1);
}

function objectAnchor(object: Scene3DObject): THREE.Vector3 {
  switch (object.type) {
    case "point":
      return toVector3(object.position);
    case "vector":
      return toVector3(object.end);
    case "segment":
      return toVector3(object.start).add(toVector3(object.end)).multiplyScalar(0.5);
    case "sphere":
    case "circle":
    case "plane":
      return toVector3(object.center);
  }
}

function createLabel(label: string, color: string, position: THREE.Vector3): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = 512;
  canvas.height = 128;
  if (context) {
    context.font = "600 48px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "rgba(8, 12, 24, 0.78)";
    context.roundRect(8, 12, 496, 104, 22);
    context.fill();
    context.fillStyle = color;
    context.fillText(label, 256, 66, 460);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.position.copy(position).add(new THREE.Vector3(0, 0.24, 0));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function addSceneObject(root: THREE.Group, object: Scene3DObject): void {
  const color = new THREE.Color(object.color ?? "#7dd3fc");
  const opacity = object.opacity ?? 1;

  switch (object.type) {
    case "point": {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(object.radius ?? 0.09, 24, 16),
        new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity }),
      );
      mesh.position.copy(toVector3(object.position));
      root.add(mesh);
      break;
    }
    case "vector": {
      const start = toVector3(object.start);
      const delta = toVector3(object.end).sub(start);
      const length = delta.length();
      if (length > 0.000001) {
        root.add(
          new THREE.ArrowHelper(
            delta.normalize(),
            start,
            length,
            color,
            Math.min(0.3, length * 0.24),
            Math.min(0.16, length * 0.12),
          ),
        );
      }
      break;
    }
    case "segment": {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        toVector3(object.start),
        toVector3(object.end),
      ]);
      root.add(
        new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
        ),
      );
      break;
    }
    case "sphere": {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(object.radius, 40, 24),
        new THREE.MeshStandardMaterial({
          color,
          transparent: opacity < 1 || !object.wireframe,
          opacity: object.wireframe ? opacity : Math.min(opacity, 0.42),
          wireframe: object.wireframe ?? false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.position.copy(toVector3(object.center));
      root.add(mesh);
      break;
    }
    case "circle": {
      const points: THREE.Vector3[] = [];
      for (let index = 0; index <= 96; index += 1) {
        const angle = (index / 96) * Math.PI * 2;
        points.push(
          new THREE.Vector3(Math.cos(angle) * object.radius, Math.sin(angle) * object.radius, 0),
        );
      }
      const circle = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
      );
      circle.position.copy(toVector3(object.center));
      circle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), safeNormal(object.normal));
      root.add(circle);
      break;
    }
    case "plane": {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(object.width, object.height),
        new THREE.MeshStandardMaterial({
          color,
          transparent: true,
          opacity: Math.min(opacity, 0.28),
          side: THREE.DoubleSide,
        }),
      );
      mesh.position.copy(toVector3(object.center));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), safeNormal(object.normal));
      root.add(mesh);
      break;
    }
  }

  if (object.label) {
    root.add(createLabel(object.label, object.color ?? "#e2e8f0", objectAnchor(object)));
  }
}

function disposeObject(object: THREE.Object3D): void {
  const disposable = object as THREE.Object3D & {
    geometry?: THREE.BufferGeometry;
    material?: THREE.Material | THREE.Material[];
  };
  disposable.geometry?.dispose();
  const materials = Array.isArray(disposable.material)
    ? disposable.material
    : disposable.material
      ? [disposable.material]
      : [];
  for (const material of materials) {
    const map = (material as THREE.SpriteMaterial).map;
    map?.dispose();
    material.dispose();
  }
}

export function Scene3DArtifact({ artifact }: { readonly artifact: ChatScene3DArtifact }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetCameraRef = useRef<() => void>(() => undefined);
  const [renderError, setRenderError] = useState<string | null>(null);
  const capabilities = artifact.capabilities ?? DEFAULT_CAPABILITIES;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      setRenderError("Interactive 3D is unavailable on this device.");
      return;
    }

    setRenderError(null);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(artifact.payload.background ?? "#090d18");
    const cameraConfig = artifact.payload.camera;
    const camera = new THREE.PerspectiveCamera(cameraConfig?.fieldOfView ?? 42, 1, 0.01, 2_000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = capabilities.includes("pan");
    controls.enableZoom = capabilities.includes("zoom");
    controls.enableRotate = capabilities.includes("orbit");
    controls.screenSpacePanning = true;

    const root = new THREE.Group();
    scene.add(root);
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x111827, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(5, 8, 4);
    scene.add(keyLight);
    scene.add(new THREE.AxesHelper(1.15));

    const gridConfig = artifact.payload.grid;
    if (gridConfig?.visible !== false) {
      const grid = new THREE.GridHelper(
        gridConfig?.size ?? 10,
        gridConfig?.divisions ?? 20,
        0x475569,
        0x1e293b,
      );
      root.add(grid);
    }
    for (const object of artifact.payload.objects) addSceneObject(root, object);

    let frame = 0;
    const render = () => {
      frame = 0;
      controls.update();
      renderer.render(scene, camera);
    };
    const scheduleRender = () => {
      if (frame === 0) frame = window.requestAnimationFrame(render);
    };
    const resetCamera = () => {
      camera.position.copy(toVector3(cameraConfig?.position ?? DEFAULT_CAMERA_POSITION));
      controls.target.copy(toVector3(cameraConfig?.target ?? DEFAULT_CAMERA_TARGET));
      camera.updateProjectionMatrix();
      controls.update();
      scheduleRender();
    };
    resetCameraRef.current = resetCamera;
    resetCamera();
    controls.addEventListener("change", scheduleRender);

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      scheduleRender();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    return () => {
      resetCameraRef.current = () => undefined;
      resizeObserver.disconnect();
      controls.removeEventListener("change", scheduleRender);
      controls.dispose();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      scene.traverse(disposeObject);
      renderer.dispose();
    };
  }, [artifact, capabilities]);

  return (
    <section className="my-3 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{artifact.title}</p>
          <p className="text-[11px] text-muted-foreground">Interactive 3D scene</p>
        </div>
        {capabilities.includes("reset-camera") ? (
          <button
            type="button"
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Reset 3D camera"
            onClick={() => resetCameraRef.current()}
          >
            <RotateCcwIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="relative aspect-[16/9] min-h-64 w-full bg-[#090d18]">
        <canvas
          ref={canvasRef}
          className={`block size-full touch-none${renderError ? " invisible" : ""}`}
          aria-label={artifact.title}
        />
        {renderError ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {renderError}
          </div>
        ) : null}
        {!renderError ? (
          <div className="pointer-events-none absolute right-2 bottom-2 rounded bg-black/45 px-2 py-1 text-[10px] text-white/70">
            Drag to orbit · scroll to zoom
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function Scene3DArtifactEnvelopeRenderer({
  artifact,
}: {
  readonly artifact: ArtifactEnvelope;
}) {
  const scene = decodeScene3DArtifact(artifact);
  if (Option.isNone(scene)) {
    return (
      <div className="my-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        Invalid 3D artifact · {artifact.kind} v{artifact.schemaVersion}
      </div>
    );
  }
  return <Scene3DArtifact artifact={scene.value} />;
}
