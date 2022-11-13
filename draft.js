import * as THREE from "https://unpkg.com/three/build/three.module.js";

let renderer, scene, camera;
let index = 0;
let line;
const MAX_POINTS = 30000;
let drawCount = 0;

init();
animate();

function init() {
  // renderer
  renderer = new THREE.WebGLRenderer();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // scene
  scene = new THREE.Scene();

  // camera
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    1,
    10000
  );
  camera.position.set(0, 0, 1000);

  // geometry
  const geometry = new THREE.BufferGeometry();

  // attributes
  const positions = new Float32Array(MAX_POINTS * 3); // 3 vertices per point
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  // drawcalls
  drawCount = 2; // draw the first 2 points, only
  //	geometry.setDrawRange( 0, drawCount);

  // material
  const material = new THREE.LineBasicMaterial({
    color: 0xff0000,
    linewidth: 3,
  });

  // line
  line = new THREE.Line(geometry, material);
  scene.add(line);

  // update positions
  //	updatePositions({x: 0, y: 0});
  //  updatePositions({x:1, y: 1})
  document.addEventListener("mousemove", updatePositions);
}

// update positions
function updatePositions(e) {
  const positions = line.geometry.attributes.position.array;
  line.geometry.attributes.position.needsUpdate = true;

  let x, y, z;
  x = y = z = 0;
  //  z += ( Math.random() - 0.5 ) * 30;
  z = 0;

  x = e.x;
  y = e.y;

  positions[index++] = x;
  positions[index++] = y;
  positions[index++] = z;

  console.log(
    index,
    drawCount,
    positions[index - 3],
    positions[index - 2],
    positions[index - 1]
  );

  /* 	for ( let i = 0, l = MAX_POINTS; i < l; i ++ ) {
	
	  positions[ index ++ ] = x;
	  positions[ index ++ ] = y;
	  positions[ index ++ ] = z;
	
	  x += ( Math.random() - 0.5 ) * 30;
	  y += ( Math.random() - 0.5 ) * 30;
	
	
	}
	 */
}

// render
function render() {
  renderer.render(scene, camera);
}

// animate
function animate() {
  requestAnimationFrame(animate);

  drawCount = (drawCount + 1) % MAX_POINTS;

  line.geometry.setDrawRange(0, drawCount);
  //console.log(drawCount)

  if (drawCount === 0) {
    // periodically, generate new data

    //		updatePositions();

    line.geometry.attributes.position.needsUpdate = true; // required after the first render

    line.material.color.setHSL(Math.random(), 1, 0.5);
  }

  render();
}
