# ThreeGPUSortedParticle
Particle with Sort by Use GPU for Three.js

# Overview これは何？
Three.jsで楽にアルファ付きパーティクルを表示するためのアドオンクラスです。  
最小で6行をソースに追加するだけで、GPUを利用したパーティクルを表示することができます。    
また、多様なパラメータにより、出現するパーティクルの見た目を自由に変更することができます（予定）。  
  
「加算透明」ではなく、「アルファ付き透明」を正しく行おうとすると、遠いモノから近くのものを順に描画するというステップが必要になり、そのために「並べ替え」が必要になります。  
この並べ替えは、パーティクル数が多くなるほど指数関数的に処理時間が延びるため、パーティクルを増やすほどＦＰＳ（画面更新回数）が減るという悩みに直面した人は多いでしょう。たぶん。  
その並べ替え処理時間の解決方法に、ＧＰＵを使った処理(GPGPU）を使用し、表現力と処理の軽量化の両立を図ったのがこのサンプルの狙いです。  
  

## Demo

* [demo](http://adrs2002.sakura.ne.jp/sandbox/particle2/sample/particleTest.html) (WIP!!)
* [demo2](http://adrs2002.sakura.ne.jp/sandbox/particle2/sample/particleEasyTest.html)  (easy版による雲の表現)


## Requirement　必要なもの
* [THREE.js](https://github.com/mrdoob/three.js/)

--------

## how to use　使い方的な。

### 0. 'three.js(three.min.js)'　と　'ThreeGpuSortedParticle.js' の２つのjsファイルを読み込む文を追加する。  
  ( ･･･この説明は必要ないよね？）

### 1. 後でパーティクルオブジェクトになるものを、前もって定義する。  
　これは、後々アクセスできるようにするため。

```
	var jenP = null;
```

### 2. パーティクルを初期化し、シーンに追加します

```
	// after scene =new THREE.Scene...
	
	jenP = new ThreeGpuSortedParticle();
	scene.add(jenP);

```

### 3. シーンに対して、パーティクルを出現させます。

	jenP.appearsParticles(1);


### 4. 各フレームループによる描画の【前】に、パーティクルのソートを行います。

```
    jenP.updater();
    jenP.sort(renderer, camera);    // ←Important!! must be before  [ renderer.render ] !
    renderer.render(scene, camera);
```

### 注意事項

モバイル環境(特にモバイルiOS)では、最大パーティクル数に制限をかけています（最大64x32＝2048)。  
これは、モバイルのiOSでは、浮動小数点の精度に制限が掛けられており、この数以上のソートを行うと、とたんに不安定になるからです。  
（現状でも、64x32で行うと、手前側の一部のパーティクルが正しくソートされない現象が見られます。32x32では発生しません）  
手は打とうと思うのですが、若干手詰まり感。誰かへるぷ。  

## LICENCE
 MIT.
