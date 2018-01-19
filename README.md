[日本語ReadMe](README.jp.md)

# ThreeGPUSortedParticle
Particle with Sort by Use GPU for Three.js

# Overview

It is an add-on class for easily displaying particles with alpha in Three.js.  
By adding a minimum of 6 lines to the source, you can display particles using the GPU.  
Also, with various parameters, you can freely change the appearance of emerging particles (planned).  
  
If you try to do "transparency with alpha" correctly instead of "addition transparency", you will need the step of drawing near objects from distant objects in order, so "sort" is required for that.  
As this number of particles increases, the processing time increases exponentially, so many people face the trouble of decreasing FPS (number of screen updates) as more particles are added. maybe.  
The aim of this sample is to use GPU-based processing (GPGPU) to solve the rearrangement processing time and to achieve compatibility between expression power and processing weight.  

  
## Demo

* demo WIP
* [demo2](http://adrs2002.sakura.ne.jp/sandbox/particle2/sample/particleEasyTest.html)  (cloud view by use easy ver)


## Requirement
* [THREE.js](https://github.com/mrdoob/three.js/)

--------

## how to use

### 0. read 2 .js file , 'three.js(three.min.js)', and 'ThreeGpuSortedParticle.js' your HTML file.
  

### 1. Declaration Objecty for Particle by NULL

```
	var jenP = null;
```

### 2. Initialize Particle　

```
	// after scene =new THREE.Scene...
	
	jenP = new ThreeGpuSortedParticle();
	scene.add(jenP);

```

### 3. adding Particle to Scene　

	jenP.appearsParticles(1);


### 4. Sort the particles before Render Scene by each frame loop.

```
    jenP.updater();
    jenP.sort(renderer, camera);    // ←Important!! must be before  [ renderer.render ] !
    renderer.render(scene, camera);
```

### Notes

Perhaps at the moment, Mobile device is not supported. this will not move. What should I do. I Want to cry.


## LICENCE
 MIT.
