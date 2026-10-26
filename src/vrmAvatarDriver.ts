import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { config, smplxMapping } from './config';
import type { AvatarDriver } from './avatarDriver';

export interface VrmAvatarSwitches {
  swapSidesBody: boolean;
  swapSidesHands: boolean;
  negateYzFirstHand: boolean;
  negateYzSecondHand: boolean;
  negateYzFirstJointOfBodyPair: boolean;
  negateYzSecondJointOfBodyPair: boolean;
  fingerRotationScale: number;
}

export const defaultVrmAvatarSwitches: VrmAvatarSwitches = {
  swapSidesBody: false,
  swapSidesHands: false,
  negateYzFirstHand: false,
  negateYzSecondHand: false,
  negateYzFirstJointOfBodyPair: false,
  negateYzSecondJointOfBodyPair: false,
  fingerRotationScale: 1,
};

export function switchesToReadoutText(switches: VrmAvatarSwitches): string {
  return [
    `swapBodySides=${switches.swapSidesBody}`,
    `swapHands=${switches.swapSidesHands}`,
    `negateFirstHand=${switches.negateYzFirstHand}`,
    `negateSecondHand=${switches.negateYzSecondHand}`,
    `negateFirstBodyJoint=${switches.negateYzFirstJointOfBodyPair}`,
    `negateSecondBodyJoint=${switches.negateYzSecondJointOfBodyPair}`,
    `fingerRotationScale=${switches.fingerRotationScale.toFixed(2)}`,
  ].join(', ');
}

export class VrmAvatarDriver implements AvatarDriver {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private clock: THREE.Clock;
  private rootElement: HTMLDivElement;
  private avatar: VRM | null;
  private pendingApplyFrame: Float32Array | null;
  private warnedBones: Set<string>;
  private readyCallbacks: Array<() => void>;
  private errorCallbacks: Array<(message: string) => void>;
  private animationFrameHandle: number | null;
  private resizeObserver: ResizeObserver | null;
  private resizeListener: (() => void) | null;
  private disposed: boolean;

  public constructor() {
    this.rootElement = document.createElement('div');
    this.rootElement.style.width = '100%';
    this.rootElement.style.height = '100%';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1020');

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    this.camera.position.set(0, 1.4, 3.1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(800, 420);
    this.rootElement.appendChild(this.renderer.domElement);

    const hemisphereLight = new THREE.HemisphereLight('#ffffff', '#1f2937', 1.5);
    this.scene.add(hemisphereLight);

    const keyLight = new THREE.DirectionalLight('#ffffff', 1.4);
    keyLight.position.set(2, 4, 3);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight('#93c5fd', 0.7);
    fillLight.position.set(-2, 2, -2);
    this.scene.add(fillLight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = true;
    this.controls.target.set(0, 1.3, 0);
    this.controls.update();

    this.clock = new THREE.Clock();
    this.avatar = null;
    this.pendingApplyFrame = null;
    this.warnedBones = new Set();
    this.readyCallbacks = [];
    this.errorCallbacks = [];
    this.animationFrameHandle = null;
    this.resizeObserver = null;
    this.resizeListener = null;
    this.disposed = false;
    this.loadAvatar();
    this.bindLoop();
  }

  public onReady(callback: () => void): () => void {
    this.readyCallbacks.push(callback);
    if (this.avatar) {
      callback();
    }
    return () => {
      this.readyCallbacks = this.readyCallbacks.filter((currentCallback) => currentCallback !== callback);
    };
  }

  public onError(callback: (message: string) => void): () => void {
    this.errorCallbacks.push(callback);
    return () => {
      this.errorCallbacks = this.errorCallbacks.filter((currentCallback) => currentCallback !== callback);
    };
  }

  public mount(target: HTMLElement): void {
    if (this.disposed) {
      return;
    }

    if (!target.contains(this.rootElement)) {
      target.innerHTML = '';
      target.appendChild(this.rootElement);
    }

    this.resizeRenderer(target.clientWidth, target.clientHeight);

    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.disposed) {
          return;
        }
        this.resizeRenderer(target.clientWidth, target.clientHeight);
      });
      this.resizeObserver.observe(target);
    }

    if (!this.resizeListener) {
      this.resizeListener = () => {
        if (this.disposed) {
          return;
        }
        this.resizeRenderer(target.clientWidth, target.clientHeight);
      };
      window.addEventListener('resize', this.resizeListener);
    }
  }

  public applyFrame(frame: Float32Array): void {
    if (this.disposed || !this.avatar) {
      return;
    }

    this.pendingApplyFrame = new Float32Array(frame);
  }

  public reset(): void {
    this.pendingApplyFrame = null;
    if (this.avatar) {
      this.avatar.humanoid?.getNormalizedBoneNode('hips')?.quaternion.identity();
    }
  }

  public dispose(): void {
    this.disposed = true;

    if (this.animationFrameHandle !== null) {
      cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
      this.resizeListener = null;
    }

    this.controls.dispose();

    if (this.avatar) {
      this.avatar.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }

        const material = mesh.material;
        if (material) {
          if (Array.isArray(material)) {
            for (const entry of material) {
              entry.dispose();
              if ('map' in entry) {
                entry.map?.dispose();
              }
            }
          } else {
            material.dispose();
            if ('map' in material) {
              material.map?.dispose();
            }
          }
        }
      });
      this.scene.remove(this.avatar.scene);
      this.avatar = null;
    }

    this.renderer.dispose();
    this.rootElement.remove();
    this.readyCallbacks = [];
    this.errorCallbacks = [];
    this.pendingApplyFrame = null;
    this.warnedBones.clear();
  }

  private bindLoop(): void {
    const animate = () => {
      if (this.disposed) {
        return;
      }

      const deltaTimeSeconds = this.clock.getDelta();
      if (this.avatar) {
        this.avatar.update(deltaTimeSeconds);
      }

      if (this.pendingApplyFrame) {
        this.applyFrameData(this.pendingApplyFrame);
        this.pendingApplyFrame = null;
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.animationFrameHandle = requestAnimationFrame(animate);
    };

    this.animationFrameHandle = requestAnimationFrame(animate);
  }

  private resizeRenderer(width: number, height: number): void {
    if (width === 0 || height === 0 || this.disposed) {
      return;
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private loadAvatar(): void {
    const gltfLoader = new GLTFLoader();
    gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

    gltfLoader.load(
      config.avatarModelPath,
      (gltf) => {
        if (this.disposed) {
          return;
        }

        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          this.emitError('Avatar file not found. Place avatar.vrm in the public folder');
          return;
        }

        this.avatar = vrm;
        const rootObject = vrm.scene;

        if (vrm.meta?.version === '0') {
          VRMUtils.rotateVRM0(rootObject);
        }

        rootObject.position.set(0, -0.7, 0);
        rootObject.rotation.y = Math.PI;
        this.scene.add(rootObject);

        const bounds = new THREE.Box3().setFromObject(rootObject);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) * 0.6;
        this.camera.position.set(0, 1.3, radius * 2.3);
        this.camera.lookAt(center);
        this.controls.target.copy(center);

        this.emitReady();
      },
      undefined,
      () => {
        if (!this.disposed) {
          this.emitError('Avatar file not found. Place avatar.vrm in the public folder');
        }
      },
    );
  }

  private emitReady(): void {
    for (const callback of this.readyCallbacks) {
      callback();
    }
  }

  private emitError(message: string): void {
    for (const callback of this.errorCallbacks) {
      callback(message);
    }
  }

  private applyFrameData(frame: Float32Array): void {
    if (!this.avatar || this.disposed) {
      return;
    }

    const upperBodyJoints = smplxMapping.upper_body.joints as Array<{ vrm_bone: VRMHumanBoneName; columns: number[] }>;
    for (const joint of upperBodyJoints) {
      this.applyJointRotation(joint.vrm_bone, frame, joint.columns);
    }

    const firstHandJoints = smplxMapping.first_hand_block.joints as Array<{ vrm_bone: VRMHumanBoneName; columns: number[] }>;
    for (const joint of firstHandJoints) {
      this.applyJointRotation(joint.vrm_bone, frame, joint.columns);
    }

    const secondHandJoints = smplxMapping.second_hand_block.joints as Array<{ vrm_bone: VRMHumanBoneName; columns: number[] }>;
    for (const joint of secondHandJoints) {
      this.applyJointRotation(joint.vrm_bone, frame, joint.columns);
    }
  }

  private applyJointRotation(boneName: VRMHumanBoneName, frame: Float32Array, columns: number[]): void {
    if (!this.avatar || this.disposed) {
      return;
    }

    const boneNode = this.avatar.humanoid?.getNormalizedBoneNode(boneName);
    if (!boneNode) {
      if (!this.warnedBones.has(boneName)) {
        console.warn(`Missing VRM bone: ${boneName}`);
        this.warnedBones.add(boneName);
      }
      return;
    }

    const axisX = frame[columns[0]] ?? 0;
    const axisY = frame[columns[1]] ?? 0;
    const axisZ = frame[columns[2]] ?? 0;
    const rotationVector = new THREE.Vector3(axisX, axisY, axisZ);
    const angle = rotationVector.length();

    if (angle < 0.000001) {
      boneNode.quaternion.identity();
      return;
    }

    const normalizedAxis = rotationVector.clone().normalize();
    boneNode.quaternion.setFromAxisAngle(normalizedAxis, angle);
  }
}
