import * as THREE from 'three';
import { WTSSimulationEngine } from '../simulation/wtsEngine';
import { createVest3DModel, Vest3DInstance } from './vestModel';
import { createReceiver3DModel, Receiver3DInstance } from './receiverModel';
import { ObstacleMaterial, SimulationSnapshot } from '../types/wts';
import { RESCUE_DISTANCE_METERS } from '../simulation/scenarioData';

export type InspectorPreset = 'ambos' | 'chaleco_frente' | 'chaleco_espalda' | 'receptor';

export interface SceneInteractionCallbacks {
  onSelectHotspot: (partId: string) => void;
  onReceiverButton: (action: 'prev' | 'next' | 'ok' | 'aux') => void;
  onVestTap: () => void;
}

export class WTSThreeSceneManager {
  private container: HTMLElement;
  private engine: WTSSimulationEngine;
  private callbacks: SceneInteractionCallbacks;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  // Disaster world group (scaled 1:1 in 3D browser, 0.032x in tabletop AR!)
  private worldGroup: THREE.Group;
  private dustParticles: THREE.Points;
  private rescuerAvatar: THREE.Group;
  private handheldReceiver: Receiver3DInstance;
  private beaconVests: Map<string, Vest3DInstance> = new Map();
  private proximityRings: Map<string, THREE.Mesh> = new Map();
  private rfRayLines: Map<string, THREE.Line> = new Map();

  // Studio Inspector group
  private inspectorGroup: THREE.Group;
  private inspectorVest: Vest3DInstance;
  private inspectorReceiver: Receiver3DInstance;

  // Orbit / pointer camera state for Chaleco, Tabletop & Inspector modes
  private isPointerDown = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastPointerPos = { x: 0, y: 0 };
  private orbitYaw = 0.25;
  private orbitPitch = 0.22;
  private orbitDist = 1.45;
  private orbitTarget = new THREE.Vector3(0, 0.06, 0);

  // Keyboard continuous input state
  private keysDown: Set<string> = new Set();
  // Mobile virtual joystick input
  private touchMove = { forward: 0, strafe: 0, turn: 0 };

  // WebXR Mixed Reality state
  private xrSession: XRSession | null = null;
  private xrHitTestSource: XRHitTestSource | null = null;
  private xrReticle: THREE.Mesh;
  private xrAnchorPlaced = false;

  private raycaster = new THREE.Raycaster();
  private lastFrameTime = performance.now();
  private disposed = false;

  constructor(
    container: HTMLElement,
    engine: WTSSimulationEngine,
    callbacks: SceneInteractionCallbacks
  ) {
    this.container = container;
    this.engine = engine;
    this.callbacks = callbacks;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1722);
    this.scene.fog = new THREE.FogExp2(0x16202e, 0.015);

    const width = Math.max(320, container.clientWidth);
    const height = Math.max(240, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.05, 160);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);

    // Lighting
    const hemiLight = new THREE.HemisphereLight(0xcbd5e1, 0x334155, 1.15);
    this.scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfffbeb, 1.35);
    dirLight.position.set(16, 28, 18);
    this.scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.55);
    rimLight.position.set(-14, 12, -16);
    this.scene.add(rimLight);

    // Build Disaster Zone 3D World
    this.worldGroup = new THREE.Group();
    this.dustParticles = this.buildDisasterEnvironment(this.worldGroup);
    this.rescuerAvatar = this.buildRescuerAvatar();
    this.worldGroup.add(this.rescuerAvatar);
    this.scene.add(this.worldGroup);

    // Handheld 3D receiver attached to camera for immersive Rescuer mode
    this.handheldReceiver = createReceiver3DModel();
    this.handheldReceiver.root.scale.setScalar(0.68);
    this.handheldReceiver.root.position.set(0.24, -0.2, -0.46);
    this.handheldReceiver.root.rotation.set(-0.14, -0.28, 0.04);
    this.camera.add(this.handheldReceiver.root);
    this.scene.add(this.camera);

    // Build Studio Device Inspector Group
    this.inspectorGroup = new THREE.Group();
    this.inspectorGroup.visible = false;
    this.inspectorVest = createVest3DModel(true);
    this.inspectorVest.root.position.set(-0.34, 0.02, 0);
    this.inspectorReceiver = createReceiver3DModel();
    this.inspectorReceiver.root.scale.setScalar(1.22);
    this.inspectorReceiver.root.position.set(0.36, 0.02, 0.04);
    this.inspectorReceiver.root.rotation.y = -0.18;

    const pedestalGeo = new THREE.CylinderGeometry(0.78, 0.84, 0.04, 48);
    const pedestalMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.5,
      metalness: 0.3,
    });
    const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.set(0, -0.46, 0);
    this.inspectorGroup.add(
      this.inspectorVest.root,
      this.inspectorReceiver.root,
      pedestal
    );
    this.scene.add(this.inspectorGroup);

    // WebXR placement reticle
    const retGeo = new THREE.RingGeometry(0.11, 0.14, 36);
    retGeo.rotateX(-Math.PI / 2);
    this.xrReticle = new THREE.Mesh(
      retGeo,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    this.xrReticle.matrixAutoUpdate = false;
    this.xrReticle.visible = false;
    this.scene.add(this.xrReticle);

    this.checkWebXrSupport();
    this.bindEvents();

    this.renderer.setAnimationLoop(this.renderFrame);
  }

  private checkWebXrSupport(): void {
    const navXr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!navXr) {
      this.engine.setXrStatus({ supported: false });
      return;
    }
    navXr
      .isSessionSupported('immersive-ar')
      .then((supported) => {
        this.engine.setXrStatus({ supported });
      })
      .catch(() => {
        this.engine.setXrStatus({ supported: false });
      });
  }

  public async startMixedReality(domOverlayRoot: HTMLElement): Promise<boolean> {
    const navXr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!navXr) return false;

    try {
      const sessionInit: XRSessionInit & {
        domOverlay?: { root: HTMLElement };
      } = {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'dom-overlay'],
        domOverlay: { root: domOverlayRoot },
      };

      const session = await navXr.requestSession('immersive-ar', sessionInit);
      this.xrSession = session;
      this.xrAnchorPlaced = false;

      this.renderer.xr.setReferenceSpaceType('local');
      await this.renderer.xr.setSession(session);

      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (session.requestHitTestSource) {
        const src = await session.requestHitTestSource({ space: viewerSpace });
        this.xrHitTestSource = src ?? null;
      }

      this.scene.background = null;
      this.scene.fog = null;
      this.worldGroup.visible = false; // wait until user taps surface reticle
      this.handheldReceiver.root.visible = false;

      session.addEventListener('select', () => {
        if (!this.xrAnchorPlaced && this.xrReticle.visible) {
          this.worldGroup.position.setFromMatrixPosition(this.xrReticle.matrix);
          this.worldGroup.scale.setScalar(0.032); // ~2m tabletop disaster zone
          this.worldGroup.visible = true;
          this.xrAnchorPlaced = true;
          this.xrReticle.visible = false;
          this.engine.setMode('rescatista');
          this.engine.setXrStatus({ active: true, surfacePlaced: true });
        }
      });

      session.addEventListener('end', () => {
        this.xrSession = null;
        this.xrHitTestSource = null;
        this.xrAnchorPlaced = false;
        this.xrReticle.visible = false;
        this.worldGroup.position.set(0, 0, 0);
        this.worldGroup.scale.setScalar(1);
        this.worldGroup.visible = true;
        this.scene.background = new THREE.Color(0x0f1722);
        this.scene.fog = new THREE.FogExp2(0x16202e, 0.015);
        this.engine.setXrStatus({ active: false, surfacePlaced: false });
      });

      this.engine.setXrStatus({ active: true, surfacePlaced: false });
      return true;
    } catch {
      return false;
    }
  }

  public async stopMixedReality(): Promise<void> {
    if (this.xrSession) {
      await this.xrSession.end();
    }
  }

  public setInspectorPreset(preset: InspectorPreset): void {
    if (preset === 'ambos') {
      this.inspectorVest.root.visible = true;
      this.inspectorReceiver.root.visible = true;
      this.inspectorVest.root.position.set(-0.34, 0.02, 0);
      this.inspectorReceiver.root.position.set(0.36, 0.02, 0.04);
      this.orbitTarget.set(0, 0.04, 0);
      this.orbitYaw = 0.12;
      this.orbitPitch = 0.16;
      this.orbitDist = 1.42;
    } else if (preset === 'chaleco_frente') {
      this.inspectorVest.root.visible = true;
      this.inspectorReceiver.root.visible = false;
      this.inspectorVest.root.position.set(0, 0.02, 0);
      this.orbitTarget.set(0, 0.06, 0);
      this.orbitYaw = 0.08;
      this.orbitPitch = 0.14;
      this.orbitDist = 0.96;
    } else if (preset === 'chaleco_espalda') {
      this.inspectorVest.root.visible = true;
      this.inspectorReceiver.root.visible = false;
      this.inspectorVest.root.position.set(0, 0.02, 0);
      this.orbitTarget.set(0, 0.06, 0);
      this.orbitYaw = Math.PI - 0.1;
      this.orbitPitch = 0.15;
      this.orbitDist = 0.96;
    } else if (preset === 'receptor') {
      this.inspectorVest.root.visible = false;
      this.inspectorReceiver.root.visible = true;
      this.inspectorReceiver.root.position.set(0, 0.02, 0);
      this.orbitTarget.set(0, 0.04, 0);
      this.orbitYaw = -0.05;
      this.orbitPitch = 0.1;
      this.orbitDist = 0.88;
    }
  }

  public highlightInspectorPart(partId: string | null): void {
    this.inspectorVest.highlightPart(partId);
    this.inspectorReceiver.highlightPart(partId);
  }

  public pulseReceiverButton3D(btnKey: 'prev' | 'next' | 'ok' | 'aux'): void {
    this.handheldReceiver.pulseButton(btnKey);
    this.inspectorReceiver.pulseButton(btnKey);
  }

  public setTouchMove(forward: number, strafe: number, turn: number): void {
    this.touchMove = { forward, strafe, turn };
  }

  private buildDisasterEnvironment(group: THREE.Group): THREE.Points {
    // Ground asphalt & plaza grid
    const groundGeo = new THREE.PlaneGeometry(72, 72, 24, 24);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1e2530,
      roughness: 0.92,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    group.add(ground);

    const grid = new THREE.GridHelper(68, 34, 0x334155, 0x263040);
    grid.position.y = 0.01;
    group.add(grid);

    // Rescue Command Base Zone at (0, 21)
    const basePad = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.1, 36),
      new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
      })
    );
    basePad.rotation.x = -Math.PI / 2;
    basePad.position.set(0, 0.03, 21);
    group.add(basePad);

    // Command tent canopy
    const tentCanopy = new THREE.Mesh(
      new THREE.ConeGeometry(2.4, 1.5, 4),
      new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.7 })
    );
    tentCanopy.position.set(-4.8, 2.2, 22.5);
    tentCanopy.rotation.y = Math.PI / 4;
    group.add(tentCanopy);

    // Material styles for RF obstacles
    const matByType: Record<ObstacleMaterial, THREE.MeshStandardMaterial> = {
      wood: new THREE.MeshStandardMaterial({
        color: 0x92623a,
        roughness: 0.85,
      }),
      brick: new THREE.MeshStandardMaterial({
        color: 0x8f4638,
        roughness: 0.88,
      }),
      concrete: new THREE.MeshStandardMaterial({
        color: 0x64707d,
        roughness: 0.82,
      }),
      steel: new THREE.MeshStandardMaterial({
        color: 0x3b495e,
        roughness: 0.38,
        metalness: 0.72,
      }),
    };

    for (const obs of this.engine.getObstacles()) {
      const obsGroup = new THREE.Group();
      obsGroup.position.set(obs.x, 0, obs.z);
      obsGroup.rotation.y = obs.rotationY ?? 0;

      const mainBlock = new THREE.Mesh(
        new THREE.BoxGeometry(obs.hx * 2, obs.height, obs.hz * 2),
        matByType[obs.material]
      );
      mainBlock.position.y = obs.height / 2;
      obsGroup.add(mainBlock);

      // Architectural detail: tilted upper slab or steel girders
      if (obs.material === 'concrete' && obs.height > 3.5) {
        const tiltedCap = new THREE.Mesh(
          new THREE.BoxGeometry(obs.hx * 1.9, 0.45, obs.hz * 2.1),
          matByType.concrete
        );
        tiltedCap.position.set(0, obs.height + 0.15, 0);
        tiltedCap.rotation.z = 0.09;
        obsGroup.add(tiltedCap);
      } else if (obs.material === 'steel') {
        for (let i = -2; i <= 2; i++) {
          const beam = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, obs.height + 0.7, 0.18),
            matByType.steel
          );
          beam.position.set(i * (obs.hx * 0.36), obs.height / 2 + 0.2, 0);
          beam.rotation.z = i * 0.12;
          obsGroup.add(beam);
        }
      }
      group.add(obsGroup);
    }

    // Perimeter damaged city building silhouettes for depth & immersion
    const bldgMat = new THREE.MeshStandardMaterial({
      color: 0x293444,
      roughness: 0.88,
    });
    const perimeterBuildings: [number, number, number, number, number, number][] = [
      [-26, -24, 8, 12, 8, 0.04],
      [25, -24, 9, 10, 8, -0.05],
      [-27, 2, 6, 9, 10, 0.03],
      [27, 6, 7, 11, 9, -0.04],
      [0, -29, 14, 13, 5, 0.02],
    ];
    for (const [bx, bz, w, h, d, tilt] of perimeterBuildings) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bldgMat);
      b.position.set(bx, h / 2, bz);
      b.rotation.z = tilt;
      group.add(b);
    }

    // Survivor shelter pods & WTS harness instances
    const snap = this.engine.getSnapshot();
    for (const b of snap.beacons) {
      const shelterGroup = new THREE.Group();
      shelterGroup.position.set(b.x, 0, b.z);

      // Protective concrete/timber shelter lean-to over survivor (non-graphic!)
      const leanToSlab = new THREE.Mesh(
        new THREE.BoxGeometry(2.3, 0.22, 2.2),
        matByType.concrete
      );
      leanToSlab.position.set(0, 1.35, -0.2);
      leanToSlab.rotation.z = 0.24;
      shelterGroup.add(leanToSlab);

      const supportPillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 1.45, 0.28),
        matByType.wood
      );
      supportPillar.position.set(-0.9, 0.72, -0.2);
      shelterGroup.add(supportPillar);

      group.add(shelterGroup);

      // Vest model at beacon position
      const vest3D = createVest3DModel(true);
      vest3D.root.position.set(b.x, 0.56, b.z);
      group.add(vest3D.root);
      this.beaconVests.set(b.id, vest3D);

      // Subtle rescue proximity ring (ONLY visible when rescuer is within ~5.5m!)
      const proxRing = new THREE.Mesh(
        new THREE.RingGeometry(1.15, 1.42, 36),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0,
        })
      );
      proxRing.rotation.x = -Math.PI / 2;
      proxRing.position.set(b.x, 0.04, b.z);
      group.add(proxRing);
      this.proximityRings.set(b.id, proxRing);

      // Optional educational RF 433 MHz ray line
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(b.x, 0.8, b.z),
        new THREE.Vector3(0, 1.2, 21),
      ]);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.75,
      });
      const rfLine = new THREE.Line(lineGeo, lineMat);
      rfLine.visible = false;
      group.add(rfLine);
      this.rfRayLines.set(b.id, rfLine);
    }

    // Atmospheric dust motes
    const count = 260;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = Math.random() * 8 + 0.4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0x94a3b8,
      size: 0.12,
      transparent: true,
      opacity: 0.45,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    group.add(dust);
    return dust;
  }

  private buildRescuerAvatar(): THREE.Group {
    const grp = new THREE.Group();
    const jacketMat = new THREE.MeshStandardMaterial({
      color: 0xf97316,
      roughness: 0.65,
    });
    const helmetMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.35,
    });

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.28, 1.15, 16),
      jacketMat
    );
    body.position.y = 0.85;
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 16, 14),
      helmetMat
    );
    helmet.position.y = 1.62;

    // Direction cone on ground for tabletop view clarity
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.3, 16),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.4,
      })
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(0, 0.12, -1.0);

    grp.add(body, helmet, cone);
    return grp;
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const code = e.code;
      this.keysDown.add(code);

      const snap = this.engine.getSnapshot();
      if (
        (code === 'Space' || code === 'KeyT') &&
        snap.mode === 'chaleco'
      ) {
        e.preventDefault();
        this.callbacks.onVestTap();
      } else if (code === 'KeyE' || code === 'Enter') {
        if (snap.mode === 'rescatista') {
          this.callbacks.onReceiverButton('ok');
        }
      } else if (code === 'BracketLeft' || code === 'KeyZ') {
        this.callbacks.onReceiverButton('prev');
      } else if (code === 'BracketRight' || code === 'KeyX') {
        this.callbacks.onReceiverButton('next');
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.keysDown.delete(e.code);
    };

    const onPointerDown = (e: PointerEvent) => {
      this.isPointerDown = true;
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      this.lastPointerPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!this.isPointerDown) return;
      const dx = e.clientX - this.lastPointerPos.x;
      const dy = e.clientY - this.lastPointerPos.y;
      this.lastPointerPos = { x: e.clientX, y: e.clientY };

      const snap = this.engine.getSnapshot();
      if (snap.mode === 'rescatista' && !snap.rescuer.tabletopCameraMode && !snap.xrActive) {
        this.engine.setRescuerHeading(snap.rescuer.headingRad + dx * 0.0055);
      } else {
        this.orbitYaw -= dx * 0.0075;
        this.orbitPitch = Math.max(
          -0.45,
          Math.min(1.15, this.orbitPitch + dy * 0.0065)
        );
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!this.isPointerDown) return;
      this.isPointerDown = false;
      const movedDist = Math.hypot(
        e.clientX - this.pointerDownPos.x,
        e.clientY - this.pointerDownPos.y
      );
      if (movedDist < 7) {
        this.handleCanvasClick(e.clientX, e.clientY);
      }
    };

    const onWheel = (e: WheelEvent) => {
      const snap = this.engine.getSnapshot();
      if (snap.mode === 'inspector' || snap.mode === 'chaleco' || snap.rescuer.tabletopCameraMode) {
        e.preventDefault();
        const maxD = snap.rescuer.tabletopCameraMode ? 48 : 2.4;
        const minD = snap.rescuer.tabletopCameraMode ? 12 : 0.62;
        this.orbitDist = Math.max(
          minD,
          Math.min(maxD, this.orbitDist + e.deltaY * 0.0022)
        );
      }
    };

    const onResize = () => {
      if (this.disposed || this.xrSession) return;
      const w = Math.max(320, this.container.clientWidth);
      const h = Math.max(240, this.container.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    dom.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    // Save cleanup reference on instance
    this.cleanupListeners = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
    };
  }

  private cleanupListeners: () => void = () => {};

  private handleCanvasClick(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const snap = this.engine.getSnapshot();

    if (snap.mode === 'inspector') {
      const hits = this.raycaster.intersectObjects(
        [this.inspectorVest.root, this.inspectorReceiver.root],
        true
      );
      if (hits.length > 0) {
        const hitObj = hits[0].object;
        if (hitObj.userData.buttonAction) {
          this.callbacks.onReceiverButton(hitObj.userData.buttonAction);
        }
        if (hitObj.userData.partId) {
          this.callbacks.onSelectHotspot(hitObj.userData.partId);
          if (hitObj.userData.partId === 'imu') {
            this.callbacks.onVestTap();
          }
        }
      }
    } else if (snap.mode === 'chaleco') {
      const vest014 = this.beaconVests.get('WTS 014');
      if (vest014) {
        const hits = this.raycaster.intersectObject(vest014.root, true);
        if (hits.length > 0) {
          // Clicking anywhere on the 3D vest knocks rhythmic SOS!
          this.callbacks.onVestTap();
          if (hits[0].object.userData.partId) {
            this.callbacks.onSelectHotspot(hits[0].object.userData.partId);
          }
        }
      }
    } else if (snap.mode === 'rescatista') {
      // Allow clicking physical buttons on the 3D handheld receiver!
      if (this.handheldReceiver.root.visible) {
        const hits = this.raycaster.intersectObject(
          this.handheldReceiver.root,
          true
        );
        if (hits.length > 0 && hits[0].object.userData.buttonAction) {
          this.callbacks.onReceiverButton(hits[0].object.userData.buttonAction);
        }
      }
    }
  }

  private processInputs(dt: number, snap: SimulationSnapshot): void {
    let f = this.touchMove.forward;
    let s = this.touchMove.strafe;
    let turn = this.touchMove.turn;

    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) f += 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) f -= 1;
    if (this.keysDown.has('KeyD')) s += 1;
    if (this.keysDown.has('KeyA')) s -= 1;
    if (this.keysDown.has('ArrowLeft') || this.keysDown.has('KeyQ')) turn -= 1.85;
    if (this.keysDown.has('ArrowRight')) turn += 1.85;

    if (snap.mode === 'chaleco') {
      this.engine.moveVestWearer(s, -f, dt);
    } else if (snap.mode === 'rescatista' && !snap.xrActive) {
      this.engine.moveRescuer(f, s, turn, dt);
    }
  }

  private renderFrame = (nowMs: number, xrFrame?: XRFrame): void => {
    if (this.disposed) return;

    const dt = Math.min(0.1, Math.max(0.001, (nowMs - this.lastFrameTime) / 1000));
    this.lastFrameTime = nowMs;

    const preSnap = this.engine.getSnapshot();
    this.processInputs(dt, preSnap);

    // Handle WebXR Mixed Reality hit-test & camera pose mapping
    if (xrFrame && this.xrSession) {
      const refSpace = this.renderer.xr.getReferenceSpace();
      if (refSpace) {
        if (!this.xrAnchorPlaced && this.xrHitTestSource) {
          const hitResults = xrFrame.getHitTestResults(this.xrHitTestSource);
          if (hitResults.length > 0) {
            const pose = hitResults[0].getPose(refSpace);
            if (pose) {
              this.xrReticle.visible = true;
              this.xrReticle.matrix.fromArray(pose.transform.matrix);
            }
          } else {
            this.xrReticle.visible = false;
          }
        } else if (this.xrAnchorPlaced) {
          // Convert real-world XR viewer pose into disaster-map coordinates!
          const viewerPose = xrFrame.getViewerPose(refSpace);
          if (viewerPose) {
            const camPos = new THREE.Vector3(
              viewerPose.transform.position.x,
              viewerPose.transform.position.y,
              viewerPose.transform.position.z
            );
            const localPos = this.worldGroup.worldToLocal(camPos.clone());
            const quat = new THREE.Quaternion(
              viewerPose.transform.orientation.x,
              viewerPose.transform.orientation.y,
              viewerPose.transform.orientation.z,
              viewerPose.transform.orientation.w
            );
            const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
            this.engine.setRescuerPoseFromXR(localPos.x, localPos.z, -euler.y);
          }
        }
      }
    }

    // Advance WTS simulation
    this.engine.step(dt);
    const snap = this.engine.getSnapshot();

    // Update visibility between Disaster World vs Studio Inspector
    if (snap.mode === 'inspector' && !snap.xrActive) {
      this.worldGroup.visible = false;
      this.handheldReceiver.root.visible = false;
      this.inspectorGroup.visible = true;

      // Update live animations on Inspector Vest & Receiver from active beacon
      const activeBeacon = snap.beacons[snap.rescuer.selectedBeaconIndex] ?? snap.beacons[0];
      if (activeBeacon) {
        this.inspectorVest.updateFromBeacon(activeBeacon, snap.elapsedSec);
        this.inspectorReceiver.updateDisplay(
          activeBeacon,
          snap.links[activeBeacon.id],
          snap.rescuer.receiverBatteryPct,
          snap.elapsedSec
        );
      }

      // Orbit studio camera
      const cx =
        this.orbitTarget.x +
        Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDist;
      const cy =
        this.orbitTarget.y + Math.sin(this.orbitPitch) * this.orbitDist;
      const cz =
        this.orbitTarget.z +
        Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDist;
      this.camera.position.set(cx, cy, cz);
      this.camera.lookAt(this.orbitTarget);
    } else {
      this.inspectorGroup.visible = false;
      if (!snap.xrActive) {
        this.worldGroup.visible = true;
      }

      // Update dust particles gently
      this.dustParticles.rotation.y = snap.elapsedSec * 0.015;

      // Update all 4 survivor vests, proximity rings & optional educational RF lines
      for (const b of snap.beacons) {
        const vest3D = this.beaconVests.get(b.id);
        if (vest3D) {
          vest3D.root.visible = !b.rescued;
          if (!b.rescued) {
            vest3D.root.position.set(b.x, 0.56, b.z);
            vest3D.updateFromBeacon(b, snap.elapsedSec);
          }
        }

        const proxRing = this.proximityRings.get(b.id);
        if (proxRing) {
          const dist = Math.hypot(
            b.x - snap.rescuer.x,
            b.z - snap.rescuer.z
          );
          const ringMat = proxRing.material as THREE.MeshBasicMaterial;
          if (!b.rescued && dist <= RESCUE_DISTANCE_METERS + 1.2) {
            proxRing.position.set(b.x, 0.04, b.z);
            const pulse = 0.55 + 0.35 * Math.sin(snap.elapsedSec * 6);
            ringMat.opacity = pulse;
            ringMat.color.setHex(
              dist <= RESCUE_DISTANCE_METERS ? 0x22c55e : 0x38bdf8
            );
          } else {
            ringMat.opacity = 0;
          }
        }

        const rfLine = this.rfRayLines.get(b.id);
        if (rfLine) {
          rfLine.visible = snap.rescuer.showEducationalRfRays && !b.rescued;
          if (rfLine.visible) {
            const posAttr = rfLine.geometry.getAttribute(
              'position'
            ) as THREE.BufferAttribute;
            posAttr.setXYZ(0, b.x, 0.72, b.z);
            posAttr.setXYZ(1, snap.rescuer.x, 1.35, snap.rescuer.z);
            posAttr.needsUpdate = true;

            const link = snap.links[b.id];
            const mat = rfLine.material as THREE.LineBasicMaterial;
            if (link.isLost || link.signalBars === 0) {
              mat.color.setHex(0xef4444);
              mat.opacity = 0.35;
            } else if (link.signalBars <= 2) {
              mat.color.setHex(0xfacc15);
              mat.opacity = 0.65;
            } else {
              mat.color.setHex(0x22c55e);
              mat.opacity = 0.85;
            }
          }
        }
      }

      // Update Rescuer avatar position
      this.rescuerAvatar.position.set(snap.rescuer.x, 0, snap.rescuer.z);
      this.rescuerAvatar.rotation.y = -snap.rescuer.headingRad;

      // Update Handheld 3D Receiver display
      const selectedBeacon = snap.beacons[snap.rescuer.selectedBeaconIndex];
      const selectedLink = selectedBeacon
        ? snap.links[selectedBeacon.id]
        : undefined;
      this.handheldReceiver.updateDisplay(
        selectedBeacon,
        selectedLink,
        snap.rescuer.receiverBatteryPct,
        snap.elapsedSec
      );

      // Position non-XR Camera according to active mode
      if (!snap.xrActive) {
        if (snap.mode === 'chaleco') {
          this.handheldReceiver.root.visible = false;
          this.rescuerAvatar.visible = true;
          const vest014 = snap.beacons[0];
          const d = Math.max(0.75, Math.min(2.1, this.orbitDist));
          const target = new THREE.Vector3(vest014.x, 0.62, vest014.z);
          this.camera.position.set(
            target.x + Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * d,
            Math.max(0.35, target.y + Math.sin(this.orbitPitch) * d),
            target.z + Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * d
          );
          this.camera.lookAt(target);
        } else if (snap.rescuer.tabletopCameraMode) {
          // Orbital Tabletop / Tactical Maqueta view
          this.handheldReceiver.root.visible = false;
          this.rescuerAvatar.visible = true;
          const d = Math.max(16, Math.min(46, this.orbitDist < 5 ? 28 : this.orbitDist));
          const pitch = Math.max(0.45, this.orbitPitch);
          this.camera.position.set(
            snap.rescuer.x * 0.4 + Math.sin(this.orbitYaw) * Math.cos(pitch) * d,
            Math.sin(pitch) * d,
            snap.rescuer.z * 0.4 + Math.cos(this.orbitYaw) * Math.cos(pitch) * d
          );
          this.camera.lookAt(snap.rescuer.x * 0.4, 0, snap.rescuer.z * 0.4);
        } else {
          // First-Person Rescuer View holding the 3D Receptor del Rescatista!
          this.rescuerAvatar.visible = false;
          // Show 3D handheld receiver on wider viewports so mobile screens aren't double-crowded
          const showHandheld3D = this.container.clientWidth >= 860;
          this.handheldReceiver.root.visible = showHandheld3D;

          const walkBob =
            snap.rescuer.speed > 0.2
              ? Math.sin(snap.elapsedSec * 10) * 0.032
              : 0;
          this.camera.position.set(
            snap.rescuer.x,
            1.68 + walkBob,
            snap.rescuer.z
          );
          const lookX =
            snap.rescuer.x + Math.sin(snap.rescuer.headingRad) * 10;
          const lookZ =
            snap.rescuer.z - Math.cos(snap.rescuer.headingRad) * 10;
          this.camera.lookAt(lookX, 1.56 + walkBob * 0.5, lookZ);

          // Subtle receiver hand sway
          this.handheldReceiver.root.position.y = -0.2 + walkBob * 0.45;
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  public dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.cleanupListeners();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}
