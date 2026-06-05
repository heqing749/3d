import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- 全局变量 ---
let scene, camera, renderer, controls;
let raycaster, mouse;
let isPaused = false; // 状态锁：false=漫游，true=拆解
let modelGroup;       // 存放整个模型
let parts = [];       // 存放拆分出来的零件对象

// 动画相关
const moveSpeed = 0.05; // 移动速度
const targetDistance = 1.0; // 目标移动距离 (1米)

init();
animate();

function init() {
    // 1. 场景设置
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a); // 深色背景

    // 2. 相机
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1, 10); // 初始视角
    camera.lookat(0, 0, 0);

    // 3. 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);

    // 4. 灯光 (为了让木头有质感)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);

    // 5. 控制器 (漫游用)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // 6. 射线检测 (点击用)
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // 7. 加载模型
    loadModel();

    // 8. 事件监听
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('pointerdown', onPointerDown); // 使用 pointerdown 兼容性更好
    document.getElementById('pause-btn').addEventListener('click', togglePauseMode);
}

function loadModel() {
    const loader = new GLTFLoader();
    // 替换为你的模型文件名，例如 'sunmao.gltf'
    loader.load('./model/model.gltf', (gltf) => {
        modelGroup = gltf.scene;

        // --- 核心修复：自动识别左右零件 ---
        // 我们遍历模型里的所有 Mesh，根据它们的 X 轴位置分类
        const meshes = [];
        modelGroup.traverse((child) => {
            if (child.isMesh) {
                // 确保材质可见，并开启射线检测
                child.material.side = THREE.DoubleSide;
                meshes.push(child);
            }
        });

        // 简单的排序逻辑：X 坐标小的在左边，大的在右边
        // 注意：如果你的模型是整体导入的，可能需要先分离。
        // 这里假设 C4D 导出时已经是两个独立的 Mesh 或者 Group。
        // 如果是一个整体，我们需要手动拆分（这里做简化处理，假设是两个主要部件）

        // 为了演示效果，如果只有一个大组，我们尝试按 X 轴切分逻辑（模拟）
        // 实际项目中，最好在 C4D 里把“榫”和“卯”作为两个顶层对象导出。

        // 这里我们取前两个主要的 Mesh 作为左右件
        if (meshes.length >= 2) {
            // 按中心点 X 坐标排序
            meshes.sort((a, b) => {
                const boxA = new THREE.Box3().setFromObject(a);
                const boxB = new THREE.Box3().setFromObject(b);
                return boxA.getCenter(new THREE.Vector3()).x - boxB.getCenter(new THREE.Vector3()).x;
            });

            // 标记属性，方便后续逻辑判断
            meshes[0].userData.isPart = true; // 左件
            meshes[0].userData.originalPos = meshes[0].position.clone();
            meshes[0].userData.moveDir = -1; // 向左移

            meshes[1].userData.isPart = true; // 右件
            meshes[1].userData.originalPos = meshes[1].position.clone();
            meshes[1].userData.moveDir = 1;  // 向右移

            parts = [meshes[0], meshes[1]];
        } else {
            console.warn("未检测到足够的零件，请检查模型结构");
        }

        scene.add(modelGroup);

    }, undefined, (error) => {
        console.error('模型加载失败:', error);
    });
}

// --- 交互逻辑 ---

function togglePauseMode() {
    isPaused = !isPaused;
    const btn = document.getElementById('pause-btn');
    const hint = document.getElementById('hint-text');

    if (isPaused) {
        // 进入暂停/拆解模式
        btn.innerText = "继续漫游";
        btn.classList.add('active');
        hint.innerText = "拆解模式：点击零件使其分离或复位";
        controls.enabled = false; // 锁定视角，防止拖拽干扰点击
    } else {
        // 恢复漫游模式
        btn.innerText = "暂停 / 进入拆解";
        btn.classList.remove('active');
        hint.innerText = "默认模式：拖动旋转视角 | 暂停模式：点击零件进行拆解";
        controls.enabled = true; // 解锁视角
        resetParts(); // 退出时自动复原
    }
}

function onPointerDown(event) {
    // 如果没点到 Canvas 或者是点击了按钮，不处理
    if (event.target.id === 'pause-btn') return;

    if (!isPaused) return; // 非暂停模式下不处理点击拆解

    // 计算鼠标位置 (-1 到 +1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    // 检测交叉
    const intersects = raycaster.intersectObjects(parts, false); // false 表示不递归检测子级，只检测这两个零件

    if (intersects.length > 0) {
        const clickedPart = intersects[0].object;
        animatePart(clickedPart);
    }
}

// --- 动画逻辑 ---

function animatePart(part) {
    // 如果正在移动中，不重复触发
    if (part.userData.isMoving) return;

    const currentDist = part.position.distanceTo(part.userData.originalPos);

    // 如果已经移开了（距离大于 0.1），则归位
    if (currentDist > 0.1) {
        part.userData.targetPos = part.userData.originalPos.clone();
    } else {
        // 如果合拢着，则向外移
        const direction = new THREE.Vector3(part.userData.moveDir, 0, 0);
        part.userData.targetPos = part.userData.originalPos.clone().add(direction.multiplyScalar(targetDistance));
    }

    part.userData.isMoving = true;
}

function resetParts() {
    parts.forEach(part => {
        part.userData.targetPos = part.userData.originalPos.clone();
        part.userData.isMoving = true;
    });
}

function updateAnimations() {
    let isAnyMoving = false;

    parts.forEach(part => {
        if (part.userData.isMoving && part.userData.targetPos) {
            isAnyMoving = true;
            // 线性插值移动 (Lerp)
            part.position.lerp(part.userData.targetPos, 0.1);

            // 检查是否到达目标
            if (part.position.distanceTo(part.userData.targetPos) < 0.01) {
                part.position.copy(part.userData.targetPos);
                part.userData.isMoving = false;
            }
        }
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    updateAnimations(); // 每一帧更新零件位置
    renderer.render(scene, camera);
}
