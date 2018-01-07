"use strict";

// import * as THREE from './three.module'

/**
 * @author Jey-en  https://github.com/adrs2002
 * 
 * this repo -> https://github.com/adrs2002/ThreeGPUSortedParticle
 *
 */

/**
 * @constructor
 * @extends THREE.Object3D
 */
class ThreeGpuSortedParticle extends THREE.Object3D {
    // コンストラクタ
    constructor(_renderer, _oneLine, _colArray) {
        super();
        this.oneLineWidth = _oneLine ? _oneLine: 256;
        this.particleCount = this.oneLineWidth * this.oneLineWidth;
        this.activedCount = 0;
        this.isAddLoopded = false;
        
        this.dataTexture = this._createDataTexture();
        this.dataArray = this.dataTexture.image.data;

        this.colArray = _colArray ? _colArray :  [new THREE.Vector4(1.0, 0.9, 0.5, 0.8), new THREE.Vector4(0.8, 0.3, 0.0, 0.5), new THREE.Vector4(0.2, 0.0, 0.0, 0.0),
                                                  new THREE.Vector4(0.5, 1.0, 1.0, 0.5), new THREE.Vector4(0.0, 0.4, 0.8, 0.5), new THREE.Vector4(0.0, 0.0, 0.4, 0.0)];
        
        const noizeImage = this._createNozieFrom64()
        this.noiseTexture = new THREE.Texture();
        this.noiseTexture.image = noizeImage;
        noizeImage.onload = () => {
            this.noiseTexture.wrapS = THREE.RepeatWrapping;
            this.noiseTexture.wrapT = THREE.RepeatWrapping;
            this.noiseTexture.repeat.set(2, 2);
            this.noiseTexture.needsUpdate = true;
        };

        this.blankQue = [];

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                map: { value: this.noiseTexture },
                dataMap: { value: this.dataTexture },
                sortMap: { value: null },
                colors: { type: "v4v",  value: this.colArray}
            },
            vertexShader: this._getParticleDrawVshader(),
            fragmentShader: this._getParticleDrawFshader(this.colArray.length / 3),
            depthTest: true,
            depthWrite: false,
            transparent: true,
            depthFunc: THREE.LessEqualDepth,
            blending: THREE.NormalBlending
        });
        
        this.initSortShader(_renderer);

        this.geo = new THREE.InstancedBufferGeometry();
        this.geo.copy(new THREE.CircleBufferGeometry(1, 8));

        this.geo.addAttribute("idUv", new THREE.InstancedBufferAttribute(this.idUvArray, 2));

        const mesh = new THREE.Mesh(this.geo, this.material);
        mesh.frustumCulled = false;
        mesh.scale.set(1, 1, 1);
        mesh.matrixAutoUpdate = false;
        this.add(mesh);

        return this;
    }

    /** 
     * 初期位置用（ソートの邪魔をしないように）、めっちゃ遠い位置にパーティクルを移動しておく
    */
    _getFarPosition(){
        return new THREE.Vector3(65535 - Math.random() * 100 , -65535 - Math.random() * 100 , 65535  - Math.random() * 100 );
    }

    _createDataTexture(){
        const texture = new THREE.DataTexture( new Float32Array( this.oneLineWidth * this.oneLineWidth * 4 * 4 ), this.oneLineWidth, this.oneLineWidth * 4, THREE.RGBAFormat, THREE.FloatType );      
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
		texture.needsUpdate = true;

		return texture;
    }

    /**
     * ソートの事前準備。必ず初期化終了後に行う必要がある。
     * @param { THREE.WebGLRenderer } _renderer 
     */
    initSortShader(_renderer) {
        // テクスチャから情報を取得する「番地」の取得用UVの作成
        this.idUvArray = new Float32Array(this.particleCount * 2);
        let p = 0;
        for ( let j = 0; j < this.oneLineWidth; j++ ) {
            for ( let i = 0; i < this.oneLineWidth; i++ ) {
                this.idUvArray[ p++ ] = i / ( this.oneLineWidth - 1 );
                this.idUvArray[ p++ ] = j / ( this.oneLineWidth - 1 );
            }
        }

        this.preRenderScene =  new THREE.Scene();
        this.sortScene = new THREE.Scene();
        this.sortCam = new THREE.Camera();
        this.lastUseRt = null;

        // const ext = _renderer.context.getExtension('WEBGL_color_buffer_float');
        this.rt1 = new THREE.WebGLRenderTarget( this.oneLineWidth,  this.oneLineWidth, {
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
            type: THREE.FloatType,
            wrapS :THREE.ClampToEdgeWrapping , // なんで RepeatWrapping からClampToEdgeWrappingに変えたら正しく動いたのだろう…
            wrapT :THREE.ClampToEdgeWrapping ,
            stencilBuffer: false
        });
        this.rt2 = new THREE.WebGLRenderTarget( this.oneLineWidth,  this.oneLineWidth, {
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
            type: THREE.FloatType,
            wrapS : THREE.ClampToEdgeWrapping ,
            wrapT : THREE.ClampToEdgeWrapping ,
            stencilBuffer: false
        });
        this.rtSwitch = true;


        this.preRenderMaterial = new THREE.RawShaderMaterial({
            uniforms: {
                dataMap: { type: "t", value: this.dataTexture },
                cameraPosition : { type: "v3", value: new THREE.Vector3(0,0,0) }
            },
            vertexShader: this._getInitialVShader(),
            fragmentShader: this._getPreRendShader(),
            depthTest: true,
            depthWrite: false,
            transparent: true,
            // side: THREE.DoubleSide,
            depthFunc: THREE.NeverDepth,
            blending: THREE.NormalBlending
        });
        this.preRenderScene.add(new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), this.preRenderMaterial));

        this.sortMaterial = new THREE.RawShaderMaterial({
            uniforms: {
                texture: { type: "t", value: null },
                stepno : { type: "f", value:0.0 },
                offset : { type: "f", value:0.0 },
                stage : { type: "f", value:0.0 }
            },
            vertexShader: this._getInitialVShader(),
            fragmentShader: this._getSortFShader(),
            depthTest: true,
            depthWrite: false,
            transparent: true,
            // side: THREE.DoubleSide,
            depthFunc: THREE.NeverDepth,
            blending: THREE.NormalBlending
        });
        this.sortScene.add(new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), this.sortMaterial));

    }

    /* get texture positions method *******************/

    _getPositionIdBase(_id) {
        return this.particleCount * (0 * 4) + _id * 4;
    }
    /////
    _getVectorIdBase(_id) {
        return this.particleCount * (1 * 4) + _id * 4;
    }

    _getSpeedId(_id) {
        return this.particleCount * (1 * 4) + _id * 4 + 3;
    }
    //////
    _getUseColId(_id) {
        return this.particleCount * (2 * 4) + _id * 4 + 0;
    }

    _getUvEditIdBase(_id) {
        return this.particleCount * (2 * 4) + _id * 4 + 1;
    }

    _getViscosityId(_id) {
        return this.particleCount * (2 * 4) + _id * 4 + 3;
    }
    //////
    _getScaleId(_id) {
        return this.particleCount * (3 * 4) + _id * 4 + 0;
    }

    _getDulTimeId(_id) {
        return this.particleCount * (3 * 4) + _id * 4 + 1;
    }

    _getBlurId(_id) {
        return this.particleCount * (3 * 4) + _id * 4 + 2;
    }

    _getTimeFactorId(_id) {
        return this.particleCount * (3 * 4) + _id * 4 + 3;
    }

    /**********************************/

    setPosition(_id, _pos){
        this.dataArray[this._getPositionIdBase(_id) + 0] = _pos.x;
        this.dataArray[this._getPositionIdBase(_id) + 1] = _pos.y;
        this.dataArray[this._getPositionIdBase(_id) + 2] = _pos.z;
        // this.dataArray[this._getPositionIdBase(_id) + 3] = _id;
    }

    setVector(_id, _vec){
        this.dataArray[this._getVectorIdBase(_id) + 0] = _vec.x;
        this.dataArray[this._getVectorIdBase(_id) + 1] = _vec.y;
        this.dataArray[this._getVectorIdBase(_id) + 2] = _vec.z;
    }

    getSpeed(_id){
        return this.dataArray[this._getSpeedId(_id)];
    }

    setSpeed(_id, _speed){
        this.dataArray[this._getSpeedId(_id)] = _speed;
    }

    setUseCol(_id, _ptn){
        this.dataArray[this._getUseColId(_id)] = _ptn;
    }

    setUvEdit(_id, _uve){
        this.dataArray[this._getUvEditIdBase(_id) + 0] = _uve.x;
        this.dataArray[this._getUvEditIdBase(_id) + 1] = _uve.y;
    }

    setViscosity(_id, _v){
       this.dataArray[this._getViscosityId(_id)] = _v;
    }

    getViscosity(_id){
      return this.dataArray[this._getViscosityId(_id)];
    }

    setScale(_id, _scale){
        this.dataArray[this._getScaleId(_id)] = _scale;
    }

    setDulTime(_id, _dul){
        this.dataArray[this._getDulTimeId(_id)] = _dul;
    }

    getDulTime(_id){
        return this.dataArray[this._getDulTimeId(_id)];
    }
    
    addDulTime(_id, _dul){
        this.dataArray[this._getDulTimeId(_id)] += _dul * this.getTimeFactor(_id);
    }

    setBlur(_id, _blur){
        this.dataArray[this._getBlurId(_id)] = _blur;
    }

    getBlur(_id){
        return this.dataArray[this._getBlurId(_id)];
    }

    setTimeFactor(_id, _life){
              this.dataArray[this._getTimeFactorId(_id)] = _life;
    }

    getTimeFactor(_id){
       return this.dataArray[this._getTimeFactorId(_id)];
    }

    /** this is Main logic for your Particle ADD.
     * パーティクルの追加メソッド
     * 
     * @param {Number} _cnt - number of adding Particle Count. 追加するパーティクル数
     * @param {Object} [_option = {} ] - optional object
     *          
     *  @param {THREE.Vector3}  _option.basePos - 
     */
    appearsParticles(_cnt, _option = {}) {

        let rooped = false;

        while(this.blankQue.length > 0 && _cnt > 0){
            this._appearsParticle(this.blankQue.pop(), _option);
            _cnt--;
        }
        if (_cnt <= 0) { return; }

        for (let i = this.activedCount; i < this.particleCount; i++) {            
            if (this.getDulTime(i) == 0.0) {
  
                this._appearsParticle(i, _option);

                this.activedCount++;
                if(this.activedCount >= this.particleCount) {
                    this.isAddLoopded = true;
                    if(rooped){break;} else{
                        rooped = true;
                        this.activedCount = 0;
                        i = 0;
                    }
                } 
                _cnt--;
                if (_cnt <= 0) { break; }

            }
        }

    }

    _appearsParticle(i, _option) {

        const {
            basePos = new THREE.Vector3(0, 0, 0),
            scale = 1.0,
            scaleRandom = 0.2,
            vect = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
            colId = 0,
            speed = 1.0 + Math.random() - 0.5,
            explose = 1.0,
            viscosity = 0.02,
            lifeTimeFactor = Math.random()* 0.75 + 0.5,
            blur = 0.5
        } = _option;

        this.setDulTime(i, 1.0);
        this.setPosition(i, basePos);
        this.setScale(i, scale + (Math.random() - 0.5) * scaleRandom);                

        //移動方向を決める
        if (explose > 0.0) {
            const addV = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            vect.lerp(addV, explose);
        }
        this.setVector(i, vect);
        this.setSpeed(i, speed);
        this.setViscosity(i, viscosity);

        this.setTimeFactor(i, lifeTimeFactor);
        
        this.setUseCol(i, colId);

        this.setBlur(i, blur);

    }

    /** 
     * パーティクルのアップデート。
     * 必ず手動で呼ぶ必要がある。
     */
    updater() {
        // 1粒毎のアップデート
        const delta = clock.getDelta();
        for (let i = 0; this.isAddLoopded ? i < this.particleCount: i < this.activedCount; i++) {
            if (this.getDulTime(i) > 0.0) {

                this.addDulTime(i, delta);
                this.setSpeed(i, this.getSpeed(i) + this.getSpeed(i) * this.getViscosity(i));

                // オプション挙動サンプル。Blurの値を、時間経過とともに下げる
                this.setBlur(i, this.getBlur(i) * (this.getDulTime(i) - 1.0));

                if (this.getDulTime(i) >= 2.0) {
                    //1秒経過していたら、消滅させる。
                    this.setDulTime(i, 0.0);
                    this.setScale(i, 0.0);
                    this.blankQue.push(i);
                }
            }
        }

        this.dataTexture.needsUpdate = true;
        this.material.needsUpdate = true;
        super.updateMatrixWorld.call(this);

    }

    /**
     * ソートの本体ロジック。
     * 自動では呼ばれないので、必ず呼ぶ必要がある　＆　renderer.render の【前】に呼ばれる必要がある
     * @param { THREE.WebGLRenderer } _renderer 
     * @param { THREE.PerspectiveCamera } _camera 
     */
    sort(_renderer, _camera){
        const size = this.oneLineWidth;
        this.lastUseRt = null;
        
        // step1 現在の位置を、ソート用のデータテクスチャに入れるための事前描画を行う        
        this.preRenderMaterial.uniforms.cameraPosition.value = _camera.position;
        this.preRenderMaterial.needsUpdate = true;
        this.lastUseRt = this.rt1;
        _renderer.render(this.preRenderScene, this.sortCam, this.lastUseRt);

        /*
        if(window.captFlag){
            let pixelBuffer_bef = new Float32Array( 4 );
            //read the pixel under the mouse from the texture
            for(let i =0; i < 10;i++){
                _renderer.readRenderTargetPixels(this.lastUseRt,i, 0, 1, 1, pixelBuffer_bef);
                console.log(`id:${i} = ${pixelBuffer_bef[0]} , dist = ${pixelBuffer_bef[1]}  `);
            }

        }
        */

        // step2 作成したデータテクスチャを使い、ソートする
        // thanks to: http://t-pot.com/program/90_BitonicSort/index.html
        const pow = Math.log2(size * size);
        for(let i =0; i < size;i++) {
            
            let step = i;
            let rank;
            for (rank = 0; rank < step; rank++) {
                step -= rank + 1;
            }

            let stepno = 1 << (rank + 1);
            let offset = 1 << (rank - step);
            let stage = 2 * offset;

            this.sortMaterial.needsUpdate = true;
            this.sortMaterial.uniforms.stepno.value = stepno;
            this.sortMaterial.uniforms.offset.value = offset;
            this.sortMaterial.uniforms.stage.value = stage;
            
            if (i % 2 === 0) {
                this.sortMaterial.uniforms.texture.value = this.lastUseRt.texture;
                this.lastUseRt = this.rt2;
            } else {
                this.sortMaterial.uniforms.texture.value = this.lastUseRt.texture;
                this.lastUseRt = this.rt1;
            }

            _renderer.render(this.sortScene, this.sortCam, this.lastUseRt);
   
            if(pow <= rank) {break;}

        }

        /*
        if(window.captFlag){
            for(let i =  0; i < this.particleCount;i+=100){                
                let pixelBuffer = new Float32Array( 4 );
                _renderer.readRenderTargetPixels(this.lastUseRt,i, 0, 1, 1, pixelBuffer);
                console.log(`id:${i} = ${pixelBuffer[0]} , dist = ${pixelBuffer[1]}  `);
            }
        }
        window.captFlag = false;
        */
       
        this.material.uniforms.sortMap.value = this.lastUseRt.texture;

    }

    //////////////////////

    /** *
     * 板ポリをただ出すだけのシェーダー
     */
    _getInitialVShader() {
        return `
        attribute vec3 position;
        void main(){ 
            gl_Position = vec4( position, 1.0 );
        }
        `;
    }

    /** 
     * 最終的なパーティクルの描画VSシェーダー
    */
    _getParticleDrawVshader() {
        return `
        #include <common>

        #define sortResolution vec2( ${this.oneLineWidth}.0, ${this.oneLineWidth}.0 )
        #define gravity vec3( 0.0, 0.0, 0.0 )

        uniform sampler2D map;
        uniform sampler2D dataMap;
        uniform sampler2D sortMap;

        attribute vec2 idUv;

        varying float indexid;
        varying vec2 indexUv;
        varying vec2 vUv;
        varying vec2 vUv2;
        varying float vTime;
        varying float vColId;

        void main() {

            // ソート後のIDを取得する
            vec4 sortVal = texture2D( sortMap, idUv );

            // ID位置にある位置情報その他を取得する
            // 今回描画IDを、UV値に変換する
            indexid = sortVal.x;
            indexUv = vec2(mod(indexid, sortResolution.x) / sortResolution.x, floor(indexid / sortResolution.x) / sortResolution.y);

            // 今回は画像を伸ばすことで情報を増やしているので、yのみ値が縮小する。
            indexUv.y = indexUv.y * 0.25;

            // 位置取得
            float _idx = 0.0;

            vec4 valPos = texture2D( dataMap, indexUv);
            vec4 valVec = texture2D( dataMap, vec2(indexUv.x, indexUv.y + 0.25) );
            vec4 valEx1 = texture2D( dataMap, vec2(indexUv.x, indexUv.y + 0.50) );
            vec4 valEx2 = texture2D( dataMap, vec2(indexUv.x, indexUv.y + 0.75) );

            float timeF = valEx2.y - 1.0;

            float addUVSize = valEx2.x * 0.175;

            // 算出したＩＤ用ＵＶを、テクスチャのＵＶ変異にも使用
            vUv2 = uv * (0.25 + addUVSize) + vec2(indexUv.x, indexid * 0.01);


            vec3 movePow =  vec3(valVec.xyz) * (valVec.w + timeF);
            vec4 mvPosition = modelViewMatrix * vec4( valPos.xyz + movePow + (gravity.xyz * timeF), 1.0 );
 
            vec3 vertexPos = position * (valEx2.x +  timeF);           
            vec4 mvVector = vec4(mvPosition.xyz + vertexPos, 1.0);

            vec4 noVectPos =  modelViewMatrix * vec4( valPos.xyz + (gravity.xyz * timeF), 1.0 );

            vec4 pass1Pos = projectionMatrix * mvPosition;  // P
            vec4 pass2Pos = projectionMatrix * mvVector;   // B
            vec4 pass0Pos = projectionMatrix * noVectPos;   // A

            vec3 BA = pass2Pos.xyz - pass0Pos.xyz;
            vec3 PA = pass1Pos.xyz - pass0Pos.xyz;
            vec3 Badd = pass2Pos.xyz - pass1Pos.xyz;
            float f = max(0.0, length(BA) - length(PA));
            f = mix(1.0,f,valEx2.z);

            gl_Position = vec4( mix(pass0Pos.x, pass2Pos.x +  Badd.x, f), 
                                mix(pass0Pos.y, pass2Pos.y +  Badd.y, f),
                                mix(pass0Pos.z, pass2Pos.z +  Badd.z, f), 
                                mix(pass0Pos.w, pass2Pos.w, f));

            vUv2 = vUv2 + uv * timeF * addUVSize * 0.25;

            vTime = timeF;
            vColId = valEx1.x;
            vUv = uv;
        }

        `;
    }

    /**
     * シェーダー内で配列にアクセスするには定数を使うしかないから、こうなった。
     * もっと効率の良い方法求。
     * @param {*} _colCount 
     */
    _makeColFunction(_colCount){
        let ref = "";
        for(let i =0; i < _colCount;i++){
            ref += `
            if(_id < ${i}.1){
                if(_add == 0){ return colors[${i * 3}]; }
                if(_add == 1){ return colors[${i * 3 + 1}]; }
                if(_add == 2){ return colors[${i * 3 + 2}]; }
            }
            `;            
        }
        return ref;
    }

    /**
     * 最終的に出力されるパーティクルの描画シェーダー
     * @param { int } _colCount カラー配列数。カラーの組み合わせ（３つで1組）の組み合わせ数が引数となる
     */
    _getParticleDrawFshader(_colCount) {
        return `
        precision mediump float;
        uniform sampler2D map;
        uniform sampler2D dataMap;
        uniform vec4 colors[${_colCount * 3}]; 

        varying float indexid;
        varying vec2 indexUv;
        varying vec2 vUv;
        varying vec2 vUv2;
        varying float vTime;
        varying float vColId;

        vec4 getIdCol(float _id, int _add){
            ${this._makeColFunction(_colCount)}
            return colors[0];
        }

        void main() {
            vec4 texColor = texture2D( map, vUv2 );
            
            float uvDist = length(vUv - 0.5) * 2.5;

            float f = (texColor.x - 0.4) / (1.0 - 0.4 * 2.0) + (1.0 - uvDist);
            if(uvDist < 0.001 || f < 0.001){ discard; }
                
            texColor = vec4(f,f,f,f);
            
            gl_FragColor = texColor * mix( mix( getIdCol(vColId, 0 ), getIdCol(vColId, 1 ), uvDist) , getIdCol(vColId, 2 ),  vTime);    


            // 開始時は透明～徐々に出現させるしくみ
            if(vTime < 0.1){
                gl_FragColor.a *= vTime * 9.0;
            } 

            // 開始後の、時間経過とともに透明になる仕組み　＆　中央から離れるにつれ透明度が下がるようにする仕組み
            gl_FragColor.a *= max((1.0 - uvDist), 0.0) * ( 1.0 - vTime);
        }
        
        `;
    }

    /***************************************************/

    /**
     * ソート前の位置計算算出シェーダー
     */
    _getPreRendShader() {
        return `
        #define resolution vec2( ${this.oneLineWidth}.0, ${this.oneLineWidth}.0 )
        #define gravity vec3( 0.0, 0.0, 0.0 )

        precision mediump float;
        uniform sampler2D dataMap;
        uniform vec3 cameraPosition;

        void main() {
            vec2 uv = gl_FragCoord.xy / resolution.xy;
            // uv.y = 1.0 - uv.y;
            vec2 elem2d = floor(gl_FragCoord.xy);
            float elem1d = elem2d.y * resolution.x + elem2d.x;
            
            uv.y = uv.y * 0.25;

            // 描画位置（ワールド）の決定。同じことを最終描画時にやるけど、まぁ仕方がない
            
            vec4 valPos = texture2D( dataMap, uv);
            vec4 valVec = texture2D( dataMap, vec2(uv.x, uv.y + 0.25) );
            vec4 valEx1 = texture2D( dataMap, vec2(uv.x, uv.y + 0.50) );
            vec4 valEx2 = texture2D( dataMap, vec2(uv.x, uv.y + 0.75) );

            float timeF = max(0.0, valEx2.y - 1.0);

            vec3 movePow =  vec3(valVec.xyz) * (valVec.w + timeF);
            vec3 putPosition = vec3(valPos.xyz) + movePow + (gravity * timeF);

            float d = distance(putPosition, cameraPosition);
            gl_FragColor = vec4(elem1d, d, timeF, 1.0);     
        }
        `;
    }

    /** 
     * ソートするシェーダー本体
    */
    _getSortFShader() {
        return `
        #define delta ( 1.0 / 60.0 )
        #define halfDelta vec2( 0.5, 0.5 )
        #define resolution vec2( ${this.oneLineWidth}.0, ${this.oneLineWidth}.0 )

        precision mediump float;

        uniform float stepno;
        uniform float offset;
        uniform float stage;
        uniform sampler2D texture;

        void main() {

            vec2 elem2d = floor(gl_FragCoord.xy);

            float elem1d = elem2d.y * resolution.x + elem2d.x;
        
            float csign = (mod(elem1d, stage) < offset) ? 1.0 : -1.0;
        
            float cdir  = (mod(floor(elem1d / stepno), 2.0) <= 0.5) ? 1.0 : -1.0;

            // レンダリング位置のテクセルを読み込む
            vec4 val0 = texture2D(texture, elem2d / resolution);
            
            // ソート対象のテクセルを読む込む
            float adr1d = csign * offset + elem1d;        
            vec2 adr2d = vec2(mod(adr1d, resolution.x), floor(adr1d / resolution.x));    

            vec4 val1 = texture2D(texture, adr2d / resolution);
        
            vec4 cmin = (val0.y < val1.y) ? val0: val1;
            vec4 cmax = (val0.y < val1.y) ? val1: val0;
        
            gl_FragColor = (csign == cdir) ? cmax : cmin;// 遠い順から表示したいので、昇順にする

        }

        `;
    }
 

    _createNozieFrom64() {
        const image = new Image();
        image.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAIc2SURBVHjajJ3hmhzLbUPL9jiy8+J5Zcl27LQuR9jTB+xR9oc+abU709NdxSJBAPzT//zP//zpT3/6xz/+8b9/fP3rX//697//fc65/ry+ef15/e/1zes7f/nLX/7rv/7r+st//vOf88fX/OT1W3/+85+vH7t+YP6c/72++Xq95oevb+a3rq/rx+Yv//nj6/rLvMX1gtdv/fWvf339+vrLH1/zavN28/c//fE1/zt/uS5j3mh+fn74evHrn9frXD8zbzQ//OdfX7lavtS81/Xn9f3rYua3/vnPf15vcX0/f15f+VDz+tef1y2aV85Hm9eZi5nbO692fV13OO8+dzI3f/733398zRtdn+L69et3eQ3Xn/O+82cubF5k/jlPcH5mPmMexPzW9b9zbfPx87ivf14ff55jbtRc58HX/GRuXW7v9Zd5lH//+9/zWK+fnz+vd5wr5EtdLzIPax7HXF6uc+5nbuz8/Fxtbu/15/fv37OY+S65OXzT1yydvNm89L9/feW98wt5nPNU8lv8+3x+bpWsznwzz4l7KX+fS+dzmmcwn2cuY27x3LK5rXMBWRZ5x/mV+Xu+k9fJmpj7cH0/2/X631lAuewsKT2YrAA+y/maW8Hd8q9fX1qI85NzYflnfmU+oxZfnk7urR7WvEg+yOxMBqC5gdmKsw3mF+fHchn5RNyrekyzCeeuzlO4/n5t5vzW/HNeLasi6yeXl9XM8JGVxjvAy7j+TChPvONdnRDAEPzKp52wl5Cgu3zdo7k47ddECy1i3rgEyPmZbABdE+/m9Ze5WXyRPLmstvnzKR7Mu3B98Gtu0zyn+UW+F+9R/p7F10+d38wq6a/8VxYTPz7Xd8Lk9Z1rxcw/+y7xBJvfXaNVflK3NKFxvskPwqMyu2t+bN5rFsys+HnlrM4JE/NbVzy+/nmF/7lR89R0q3NvJzBxpeXvyRTmVuTu8eb8768vPqC5q/PRclfzYV9zsPI4SwRiXpGjjY+c7zSxmW88rzOBObE5D5gxWLuF2z2baj55IlMeM3MbnhtZ37N7tW5yUMyjYgp3vcg8Ld6p3JNs2tw0rXWuMB1x888cTdr/DIdZfPPNPFdd9rq38+CY4OVx5MSbr3nZSXJyeVnlc8NztPKQzysr6mUlzC29VmeyCS4hZmLz99xqRiUtp3mvCVWTIyUVTEjl9TA6cFExmrw/Yc6+XG4ecDKHnBLJNbkCspKYpc3rMPNhkpM1nZ3KNIyvnF+Zn0+in02Y38pVze3IamDUYUaoJ5etOH+fAqAPKK7p5KwpJHjm5nnw+Sllmo85uy6PJ8ElcT05Qx8+eVK5831hCU/zEOduz+Kb1ckUYB4Hd0tCAF+kz7dsEhYk8yyuX5kCad491zwrZDKxOfHykblwJ3HS95nfc9HyvGUyrN/6+abK3phOTTDIQ0psy23KiZnSmYc7D4RUw7xW7hklmjq+85A62DBUd3GSo2PCxsTUubC511l/s3quDDLhJ+tSkT6POctxFj0/YyepqaSZB+Z85yEw3+R3WG/0HUjxmhs1v87Tch5fLpiVwKzLLJ25e/lEfMcu5PSlVIKP+/rd613yEHPazDabHGl+PZ/o+vv1OHIBvNssmeaBqmjsdJGLh7H7laCeR5JNyXOT5dSUifkATAY6rM4/8zO5HfnJvKwwCkbTID/n+WveIocYP/9EF0Iic9lMK1XcJ3Hkg8wKezoeWbQJbVCU4Yea35q4mAMtyWvS3OtnBhdSZcLCjisjrzz/y6NYlcP1+gyQeQVtOZbO/aB5z2cRM7TNQ2EKNDf5+uZAi7xOHp5dWDIS5THxtMxnYTbB7cGD5V0Ezx5QwXRtysH+VDkxSZhPxaMjESifk/c39yJVhKqTQGAJYHnrfLNr615tXLVzc3OGKlblJxmc5s/5lRzNBCjWZaFwxWJLdfNaFs99I65wLY7rpSY7yiXpXbJ7FcgUL5LlqzZQLddogdJFJtx8haBnPJQUd2clBAiaY2EC0Kw0LRKmT0KleIcV+1lNPYXLHLAvrrD5hdmXOfqD6Oep5wqYiPPp6u4zB5gHSdya8EvA4/nALFYIfSopD6SYl+3nl1M1B5diM4/FWUkpjpX+5uhgism/p/boABbYkeetNlUiN38gLRdG8ZzGnahwcfD2KtsMzMALTpDOx88qVIhllJklG0AzCEqWL0EehY8Ue6zTguXPg5gMiquLJdNTXcTuwYo73TbAbESmWXl1Aag8T4OfqA/AZE6LI5gGbyL7UH/59cUCt0PXfIwcmmo+qBJ62h6MauwJ5PELUda2yZPOU2eBlFvEJy3siAeFltc8ePVMch+4ItkQyL3VHSOgSSR+TS+5yFbAZ7ZftkeiTJYKwwrjevYhz2T1MQl2zfteP6w+Cct9pjp9mvWVZN++lHglYCSmcsN1TZ21q8/ADqUuiI+T8WltbeRJN+DYyBe3OzsgeopZuL2aBUARTGTq3MkMEyTB6oLzArZ2XpuNNKFnzkYCX/OTExQZywMI6qlfm4e3kY1ehqqUp/lTEN/nr/nsWUJsPKf4Znqc02aiJJ+gSsS87LzIVAuTMrE2S1qYU4gITS5SWMKbJfBUxeeHWKglb8kqZ8KaqMMmlPpcfFRryOFO5Yur1TCvkzubArqbUOz1qgZVyyw7UzBrr1qt6dTN00/tG60eyFNuyl51PlF2JiNFjh1mqvpKBcWgkKWZD6JWY+4Vz3OdAPzLXBsjEVOvQNtJk3ie8+bz3jZSl/Uwe5XfzBPncTHBIgkItxmjxs+sZ62v8/GEJHBZM+udKEUOwvxK5zmMdnP3CaF0RZFQl8eZEK6lk0STn1lVe9oCOQQSDhN1iCHwLyzp1JXkD6eP099nJ7t3vrqtikF5FvO5EgVzaExU+vHjR6f76SGwccs+NHGn1K9qva+n9LxmOEuNsSZuJsXNouQu4sNKsMh3GNp0VM79T7LKvRHoMjdNa2b+6/2BmT6qhBIc2XlL0v0khUrF+IKpY5hbK9ymilLNKh5LIrra9fP6DRuznmEnm/QnpeYiAglRZp9BB4JyUL6IAIMwi5JtrllHKtSkWAmoeZ2BFNlyzr2dp0zEkFu6q/kEPoEtecdsgEFvxANQ1GPLhcwxLvF0FVlUMKHoZxdEOx1GMcoY2oiC3JgK6jkTu5jL5SGrvmM6eWQ+KilX9pwQ273uBKfs+JTmPIUFAWnFKP3I3shS5k7Ik1PrTSzA3v/Zt1x/XdpyCfbv8nhkxZyjTIXW/NYVbucmJzkeMu/sc35ecWx0AU0M0aGnpj5vNaveefpKa6erxTR9moCk2SYv4qkbUnCznlQB62gS3JKklBggIaNsvxc3onBPMluy4xlF5r8GYCajK3uR1GhVt0Ra+OHzCMlYJpLDl2XZmuqHqF9OBjV69GiZCWQprKySuYnqCqdc6wRAHBvRpZJn67zKHVOHmFs0vzhBgf3gbAw1HMNfyFkkhIeRi7uI5Wmy7fB8mLrw1SYpaBo8r7MZxEpc16+V/KI9E0BCsA1z0Z/LdbJGAoV872YOCrNj4zMPj0XknFO6mzw6WB6Q/U+yJ6sxdYvXnkg2jJr57Gop+9JHJvNsXnMgCL1at2CElJNdTApNgijvDDE3cbmYAiV2pK4Np11Rf/AiLgId0SsdfUV7yZAfhkIqVx5fahA9nW+JGgk965Jr2ouaGHmOrFS14vXItA5fwhCbO9ELqLnmsz6u+5IY3EUC7/J85klY11aX1Cosl9eEiocaTzpGIFG1sv3WNadlJHZGNp4WelARsoOYHxIaZhbLI56QWpIosqpyumbnT/aciE7hRBch67pn7Zfahthi+DZhZ0TcEz55zqVJyXobUOmS84RQYed+ZI9HE9LiGFEknjoAiWtf65mvJZxIt1Jbk83aRL7BAXWcdfsp+eU8Ti333j/smOp46eqTmHe+T6pFN62eGmRcAdO1mbpQGbZSxPnn5MEkr6cJKIY20aQmSmQPr72tdEmZZ2ZTqTrXCZ9rXjmFWkDM1lI7ZT01wLpWgF2WpOPORUkeTRhEOTpUOBF2735R3kWE3+z8V/dNWaaI7sZLzFYWVvOBpCG8mZuBDWCt/ogVJdBpXc6N543SOUckg/Ta9SQazTIgO3kFiyRF4OGQtSj9lwCZbgmzOl+JjSECJYFMVTrpJRcNL5VPLam/4mIS6CQ/YgGmgmc3RhSv8Jyn/GXyqbuXW52eF2uhqDVElxA1NXcs60HF/drRf/2W2P3UoxGxZI7gBBVxPPr+ijdP4JYlOFHqnAAtuWSAZ6fjAx2qwcocCAxsCvDaKgotbIwwwq3JlQoV7ljycNlSlc44whetQqaajEedDqU8kFqAB1p2QpIcZfxzNyhJmyZU1ozwLrKDBC5FiJPHJyErQ4AQtqCRq9SWOAfbu68PrNGG4XUq8capcmB7QVAAFzrhnWioqU9vBIa7QvpO3R2xVtaS5inzWdvVbFPog2s/ZylExaYsi7wjIa3qbbF7SMxXjcuoOsl7bRW8jriJNVO8SVHdsA/ToT7P2UxYWYCNbz7VyiGWruwvhgZRDNUKWJ+sOvQvqjmzLXgWJ6YOKXd+5vp7flKXwpAcrhjxe5a5VMGmcMweePfqfm0/ZkSN23a7jYc1qz0R+HSeKt9jpduao/UZk6OW3CwbnuVHQCr213nZHZtIDGa3YUCFrJ5cdtrn5JARDmevcJZ4NGuzMbIbY7KgQkIULJ1yCSg8E5QmdHOzQe3WRhJrJiKv2LSKGXK3X+TTpudFvhQT9IC72XDJPRJlKdZkKsICP6ufRyGB/0in2aXOKdYFCT/eXHzur3rga7eyg4QkV+xQdut04rRaH/znsLXynHhhs0noyyBxmUQRuS2MU4kvBNDSl6BWKZXik8hdBExBSWkEMTjq5lMS2KplHgVzW5RdN5aaz9t7gB9HnBeREXN86Yj4wtSCMbGanHs0BH3+V+TSKf64KbMH5g5mF5Ef0kFxHt71Xsl/CI11+c+bkko9Jh/k0P+WzziFWmMFpOjx9vHKpfzsrhCbJJ3rN6tULMAAR6T0tYR1laG1dF2IaoC7lr+widYCVCI8LDonBj9VuipGh9ym8C9Ykjf8lH3OmguQ0USUr9PaL02wCgXRZXUSBemfJZs7SDRXevYDNysGKlYz2YSfV4koPY0Zc6uQD/gh8F+rX3wsNeyaU03ODPuyyseIk7I5v2a3Ya1JTiDhiP7JNINi63WDdSnSP6y+7wcgQeV4ehFyISDmwU8dBVkDYjRTmvjbP8NDjE+Zf8bwYX30P59IakpptKlOnFQ1FW2Kp2bFZXtESEn6h5IWopZtOrQmcDkcuOCa35Jeo04JUgkEFzzx1RJRRFPp0DvHCFNSxovANdreEYjxAsaaRdCnaDMqKEnn/vzFZIAZcyPXgXezmpsqxmeqCJIFM5+XT5yciOiD1Q7T65BX0k8htJoPDFbZArwrzKmc1tavgmvKUO6HJHBMh6SNHHiHZl0EPSQtXWWp8jki36HpqyuyTrYJqaBEq2iwwTNNZnItbiITKaxM6ijWtmjum5h/q/KLdXwLJ+Z947imu0ezMB5Ws115qsx3uN+aJE9QLqRU7tJ82Hz2gUyCaiQYZWs1qv6ZNK5nQaSBEvNeCYTI33oAqvSV4yYH5XtPjk7JSzZxejFzFzpF6x5z74GnDlo+W1pLDVjRVUaINYOuGI4N5q6qoKTgzbmlBCmRfh5wctwgM2ruEsxNjM+yCFjZwKs0cWv4T4ajhto0tlP2ULDSq009V3FnRCKKoIzgYYJgdz8lXRD5RdJqCQAU3Sj5Z1pFEUK3F168iE4JYlaa62unpPn5ka5S5RkAjvFMXDrReFi5rhpcaRdFfE3plhdMstS2h6QzfFC+iqzSxWKXImum1y4JfdjO6menT/w2tjZTB0eSoqojinKZ2M3PX9/MwxKnkM5wT+gZZQwSGFBWryXUGuWu9ChRyM8LxW5OMXNXQhQH5j1EVhIHXyxilP0zW6UmdT3NB+Wd03/K4nZy/UBwpesBtVqztVQDrYm4Mr91RfZvkeTIQ6ZL4eYtKgSIu8GHnQQscDUZfqsA+qkKag4SAX6qaVPniOo8Epb5U7dLYOspD6+kPTwBYr49f4leJ1ViEL815LcxTN6RO5B3e0Uy5KokLUFSfcIYb0lkA640x+Pq7wDWGMtAmZQXMmjR90+canKzJE2cY/TcZeOEAtmjVR7ZJK2QWyZAJnkIYiBQXzgMfY87erXxej4Lb2MyYCqkEmLO3UJmbdKLrTBlejgLkSmyp5sKO/A0P8V6xKmLTGgkwUK+n3lfeQoKL0keSwXmhxB5NleVtUKgkxXxX4ls35fBLlIuRQqMFQltLj47u8wx+IxFq1YQokVw+uEjg5oMsjlkDFHtgBKgujFgeTlqNoL0eCTb0R9Acmeiw2JJzPUPthM5r3qobGzpQFY8ppyKlz37YbjKOQdmuee5SMjS9DIt7i/i5B2Ajn0qHZQl1GT90Gxida9yw+lK/5QsqDiUCCG1fjZnw6zvInjNGagWZf239krnzbI41JxqJccHisiqd5ZdcCs7xZZrarc8OQ7chLj5m0nSllgSAzF4Bx3u0j/zPgbSDv6t12d7tb3j+UHIzg9hIUs/wzWI6M/PaPXzXnUCJshV254ruKHSU2aJHbDlWNGMILI2ZG3Wmaf2QEMCFL5+bQBF3z7NCb2LNzKrnF4g8795qamM5XxGDkwah+LTN4lS7DFmVjzsZJWzkuA5OITySLaEnuiHSi75CimZGDVCcAoa2NSGvue9BMXSS9ozf8bY6/r7jx8/aNNAmEgdrqQo8l8QO1/aA64htWm17hnIpeTWlug2lnphihRrA1jldbeiad6atfRiO0aIaUpmrbyzuSQwZSe7g/kuveL65rZ8WyeXtrjO1g/0Q81EYW6d7dd9peD6tGFTLd6oMYvgqb0CaPTi7u4mK40+i7j0p4pN93eOr2T/iZrdu2hznj4T2oo9vygDgXM3eGSRttasDPByKOpjnPMQWCVnpsGHpoHE2aIR3KgQK+dOflIsmNomu1F2btbMOCFI+vmLb61uK7Oa3ofJ/DRQ7MD/ULgnRxlo9AYP4k786KKV9gg5HWHOXv/M7DC1F5SKrO3Y7NiEf67+yYJS0LNS5EHH2M/pL52dtqiXJCVSL8NZkr8yM5zeMDydaBEnS8ko63ltw0rsAME7FjG+EM8nZs2rOSeKVSuVon3O6GqvwWzkUUowxQSUqraYbfHUi8jog9ZscG4aozOoty1pk8XJ+qIJNhXA9J0mcVUG17M3svqTWa2mnDSGIYWOzY1A+wn58zUfmfBoSti2qu7jSMuu605qqRNf1eHuhP4DGK28KycziWSicLLhwBtFoV+aVELwlPjdFGFnG/ix5jxPhfnq3cmVJxBK1pPcNv1GLfxVPGZ1yxtHPWcy5mzF9K3XDIS/RSrR3F8qTvLAOI7pwDhIA6Y+ABpdfFPMkKvNsp7NMEl/YB9xfhh6aDrdLgy8jd1pWW19OzcW178/lzaechK1mfl0aLXCBSZPN+rUadOrdCtk/peCkOrrptZwltZ8M7StVtwqEtAFZC2zmtYmglrur7weVpLMmBfkeCVZUgSbBn/kTxbruyTNrLoaKOSN/tDDesI0OvpmS+cjTNQPqE9Qi9X5OjPvSU7EqkBBaj0u1EZ4GpCjD7gOz9WM19+in2sdJeukp48ZYPpdA1AMSvI0AfXQtqSFJzVt5dxmt/HH1P3hJlGLm2VrQ13aDGvamuxZ9W7fKTYiiK+zMcJ3z+JW4h6xBLVsvXpou3vKop1JPFk9SeuT+bBG5BibtdL4LbG5JVcSjtG8PlOn1kpSee+5j+jjZKCmV/XO7NSALa3VzloqCI2ytjluz12kOW6ny02HZlcviAFx3ANfKhZ84tsJ/AoGzAT6M9OhMSUhhiJLSmb1RC/rtiIZPqvr+hyPLBB1YcSjOBRV53Cuf5b+4P3M8gnj9mfkAAfJPjlMgKuf5xsBPTaz2yrz3OcGnLtNZT5XbtqHhpdedp1NJk+xA6fug3mV4rbdEnXhROs891Q/oSSIvEqPuwPTFB4sGsCqfm1v+mThZLZEIR6RRDe6s4LJrSCVUqCHDj0VBnJn0Jw58t0b/mP/uxN0rsUwKJPp0uhqrKaSFk+fiy2tBBThbCtA/I580NDJLu5pNHpifzf71D8dHIJF4LlPUmM6rWytKwQqSNctN6/A42VdwEKEZi29VPdICC9kU32KtaqTvQ+nBQc1y0C4JzQmpYya/xyLSXqtQsLKlltFYTl/uiEQDsV5dpbUQiFMxIZXLl53LOwdRZ9ZyrSHYFGekpdzV7MfMtQjR+iqMW9+q7jQXbCSDanmY4OHjLvyoF6hDnU/VB6cu2UlL4Y0sJVF31AbIb6XIiL9Z6Tf6dUmhzZeWe7RaCyooyd0IKnhk9JK0D4f4WwDGcNLYvKB6sx3kSScSeoqF36SC+ocuBnx3afzhsS2WtwQyM93iIES7WGTSyz/7jqR4sVuMes0WpURf5T1JaMvZX2EYtIkoayeE+GZOLBrS/iybY8bwGw99Ad50LsJoJEyDQg2ondqmq+64mK9JibltE3pQ6R/FYhx9XcXuc3blBe1a7kSX/Y419XfuRAlMisKzlF2bDzLayw4ptQeOohI+0kpzMbwanvBiSxrf5dVQQoeSt2zpjU1NT0+4f30DWlkidFakDeTyacZlRKyKJb3SDKZsa6x9U1P5rnMbf3Ekk0ASCKo3wqpOLbpNJ6YdPbcDS0+mBlR1EOQKstFZY1kipJNrRx61s3Kf3QrD6YDEk9IwqM9lh0YInF78jBREcebnaBguEzVdM3cYLKyWw/tViOxkOW0AZGdBKiTLEggRMkhRRH6ASo/aWIpx0V+sy0f12T1bK4ipkKsyOs63zMbna1+njVc/fz8zEHp15cyqFkScifW56eVzSy1prVwcAhXzOqc/NvEkaFRP5A5bRz/QfpAM3jVNI2mfsVMQ3tOYUD+D6t5AmUa2dLUAM1DkNop/2TvheMldQDyY2Zt9DwyWgnRIlLDOdmPT6OpDSxk0LSOu12tnb94mTqUuReDSefEb8q7dO6xx0i9y1F51Gewm6YwzECoOdji0I/MR9d5tumwSSSYdZzN8prJaDc4w+x/KiSS6A8Sws5olObdxAhbZNWhz3/N6he0JSYzSbU9kIF1KkEncTypChAK2QBDtA0q0pLNsztB2/oDI7Y8tezwJA6S/8rsVpwuUpvITwsLvUGkF12N1oyK+tSnln56ZGp+nfukrU6XG7xXuUY6pwghcdbuJmVzDM99+tqHNuFq6q1ZFasb2akJThwOx2NntYZmphQYm82B7BCSmijAlaSB3UZWLN0NaHqCKl3ejcBZH065dT6Q6u9zd1ymKoOMPQHlynDWtkAL3GnZom7s1zJdx3sEQVdgIBk1Da/1oWYSDDHg5ngqX6I999kMCLL6Dyw41ySK8b7HQDSGm64z5SyKkUJUpBJcj2P6aJyam0ZQiH70lPnmTx1inGmXV6ZFDSc9n83xQeCP/F6fRvfJ/vozQV+rX0aOecE5E5hHzHc4o4RNIbF9iASuahhFz3cKxP4Zi4mV7hJaRL90z0focQytKSEMQkXsauipHZzNGTSpa7sPriF9s6gcbxk0LWTUveY2EIuLENDaxey1zn5C+A5EgUJHzeOnGDUhPz5cPdiKZUwKhuToTffX7Clms/8frpEctYgihJUtipEGXjCpZo63dhU6VaEW5cblGUyGDPJ1nM5vJ4aTf8InSiacyp11UTZupQgnVRE7TbxNUg8+mdf+9kPlQAj2xR52FkdbXz3x+Tovp6GDht1OIcH/4s+IBL+yXzSGhyVcz9s8d6+KfPC1ZUa/HVaPWjBci6lwZvUPS9z85F8Um5hSns39m33AFeDifiaNlFnDVwpEpvFK++FSyGQrJrsqZzk7tffPeNg/eVGtv6jdTEtdlg2tgyE+uAoRn+xXpeVnLsQ4St6OTrYPFL1V9Mg+N3sFcfLhfFK2AlbL+FTkdC7LBcshZ6WlEN+TKj87MMFoqpRZ06tq6sAoaVZ/+IJqj7LCZqRvtstTZ3aoBrlsDRAitvaKbOXbt29069YAj9jWdkdN/V112jiLTkXVasHJKcpqkZK2JQi/izllhEoPzn2UPB8P8+8uecl44eOUO0uSChVwH46dprUy5wkSyqY1c9+nCRpsmtJzjp9rdJu55/rILRQRV/yU6YHm9xA/mFfI6o8vPwez59xgOOgp7nzrlsgog9DH+ZoTzPrsetdA0RpDxEUj65EZ3cyF1WiPaoM5lMMMfSKH6NU+8AH7CG5CWOtCGP4TJiPkl7CLCytNQLbGP8weJfLYurP1a7J/Yj7JfDpHVbklvhY/XQAMBovc2NV1hzszoZeoCbF8nW8Jpny+8504xGjYqx5Qm4AwKWqGFfsMmrTJ2clfyOyqI3niURA5pgkMJwAIkMkzk5sIh59RYEW6BPEQtdNjS5rynaGOzfOMOKBRZrdpWOflrFTrg4MLBlrmXMBzn4fF8B/CjLpR63CnNLno55M/1Q9aQ4Z0j3n2dAjmp5ZeT7tXXXOZserj9ymXwU1NmtD5IOVgWKsZMZ/lu3LLGbhVw4gQydLipdZSYlsIPB1ueQuy1Nac7NwnXqnsyyGQJ5qV13YaZ7PxIFjJ/lTyOo5km/ON1QX1ROJyc9dJ/0HXeHkftdcnvSQo8RFBlxccazc2etfhlvldAfwraql87GsF3Ks+0ki7sjolz105BHNwZbR4Wp/aSM0p1HDO/gjMkNuaUll66zfYQX9//BXGuq4+1P++xF5/XYCmUdIW8krZ6ZasCDpRVvD//FYYV2qFrnybtUPZXRU2JnMKxZlUc4FCbdLdE+LOqJkbomEITOuZXlPdz3Glq24p1KP0Qdc12ngOf4WfRUlaMg0OQcpPanxqcuO5e7J8lT8IZ+ewEmirZvZ82LRVx7bXMxssZJT8fIgjXDjlfxgJbHj5p1zUleBqY5A4KRfytfesuTIcJS0+UvfCesA9R7jRe0IZgqTiqnQnxkvyL21nt9goIMzHb3cD+WJw9VMnIMP3LFaeDPz7uc9FXnE22X5Jga5p9ec+6WcNl3wowUaD5Wfe3sQmTqNqpsbT2ZKymK1SPaxTzhr8zrRTIiKdh/JSdNR4Hw6xCdrA+QDs89O3Z+WTcmoap0pxxp6sMBmWqPPX5FN5Mid5k081z6XMPrv+/uPHD2UCgU1yEn6g/qflzNR8ZGuxtWEF1lRtkv5jb5hzQNu71Y8cEpPwz5krfCKBOsioXStgFpQjSTs1r4VtrNYVisg4G3ue1GwJiQdzFMwREVMm7nCWGbzm1u5qQte5m4G/Q4lAffVBaAMfGUdH61POm0/ZW7DRtdifFZ/1tPYXE9uUXNHIMR9nIB3WM3nrOHVef//73/+uMb0seQXvKuFuYqkY2rJv6WJp7irZPu3g+UFqQzyX6zK1AZeOXC3Ui+Ro65yWnP+usoH+z4zf8reMWzjnbeb1p3jLDaeQksJiockaPSG7NM1JaInZV9EbVQqZJGKHi9lynj0w+gBhWZbzJEIckua1Q6i8UZmf/clxNbTjbAgscgLVzXL2lKqasBKLY8rYD/yieyb2BDPaf6/pRJpcT6OeZ+nIR7+Fzmkqce2SSpTkh5Msmqok/OMJsGrZRn43NyenRPbDPP15xBqFlgat+qoswJQOhVVKFYFwrailybmYH34rrwWdRvqwjutKySWZZruLMTtkfTO0pwCRnKvOQMsSRySqU3NN5NoSe7BMdiJ3Mj9Pgm5+kotYlnV8GLIDIuUmIZwTJbKxewCj1Jh9cgYp19CNvMXqsM3nzfI6MxzUiMx35nb9dlQHL0AERzLwGFMkGxBWkXC8fpzuWsorlwQw7W31r4Lgv1oAlXO/eyg6PtTKPXf7zhzBa4M9zItkdZx99CRBXk8nkngl5+fEqCmA+PM066SqlWisNIFP6DuHPdLKgcBiPO0my1ful8ynBR8khK9GrmmeEKJImM/HYZ3GsR2DgPF5ZaOeso/mAUvLzu7KEwOdOpgJdtuSJn6FBNBS90Y7iPCqFFnbsqaKsJe56v8Fd3BWXN5y9fVlWaZYnlylDRG4mp/WfW9IbVd2AzSgm6pfprPMoLhniPkI9JRZPu9DAjb7DOx3Ui/B8L+WTwqE4Yz03cvdUDsyGzj3JGf4BIJr74WKPJ+USGVzENiYW63vNMIwUC/P4Tyj661HPJTkhwOe1/kmB37dPJCT/+jZPUltX5KnNJmEiDJlrNy7V62pWrvJG5ofSCovjx1ySLl61EZd0fe52lwwd1HuJj3qaDtDsYsKplkrMwkh7o6tChC1Mxkd6THBN+g3LL2/LCpoEBuuP8cf0Uahe17JK6jIY5xSoigmVZPk1C1mxUnrJ0VrDsmlDo5KD85WIjD1oYvCNi4JsHE2EfdMO+FnZZUyVIbaNH1vHLANtZ8cm0leiEthTzNeZ2VSiqnSVoNkQvebf7IrnHs6bzqcv7VjysbcqVkbEaywzpYtgmqDTpkUa2RfrjcS71fNf1lZtUfagcuvXkQdgGAy2QMrlXUiS9hitGs/MC6n1TOZL4zo7ei65u4t72bIUxdI1urtvSkq/vtDtfhV0wtbG05VzgqQy/ed3EbVAJrIssb1qUq5N9hJiRkYZ/tRAzqJ+JPlhlSXxIiuY431E0kfRGOVB567S7g2czqMU/ywMcIZr+RatnEvvX6Z8kmSvzbCn3pMNNU627AWCpopG2I0zbNgVyR7W4ITGsWJQdzyxaaitd5IXquaU3G2KQE/D/Y1r3hKmPrPLA4SryV0lFArWUHatNwAWR9BTolH5YBT2kDgn/Z9Q/P+INJ7IthoIvJ0pujm0HOBRFCjMwC17SEmNVbD4R1r1huhRR8yK+2HGdST9EJhi3a8ZGSxkl6JmVq+rT4lusBNpWU6AWsFWxMyGKpIQWeOwJOflaSJyXyEkWASGleewNjQAxGYjTSznCkExfJE8QLApyQdtroYEOxSk1wQ/QfdyBqrUUHZDr4HbhyxnyA5nEk2HZ4VsdTkJnFQC+XJw0vqHPqdEFoQj5D1Q1C/KNpEs8m5MQy8KBxkHy8Oee4hKWjBagk8yDTuSWnQBPJk46yDm13PiYMcocAklpAJ3/eVaaTcN0zmnmzVKLvmiRNiCQdlh+RIYPupSKdHzVy6nEjaJyOM6BgW5RcljJiFwkp0RhgF/14tr+ds6ccmCWLngeTNi7sxa7HteBtVy92mE5b0a3zwB17TOppoi6SR7uG5BA/lcLfuLuUxsfdE+xxWtIQT+jZSAqo3Yvd6dVToIWiCKOPsTwu6uaU/V6m0LLNMOfNiHcXeUV8u08zUJ8rKT0a63q4vyR0nYyTpk1qVs/SjM1IUz8XPd64/m5LVkjkGy0z5JefslEM3p0IxGJNAdTBO5t2P/KUQCmE7lJBzHyHOZDLriVB97k+mYfMHwpLgJ82Kz7VFI6ZXjmEw7b45JTZ/UcKTV17HBTH+cmIA8RgyxpXBtvMzT6cewxFE8Sce3fnWBKQYHlFbLYA5aB3XPSezxxRaE0VZDScDWQfVUHVOnoWEiLPuZwO8J3/gNZPLBRhNEJV+RVCmgEWWmPKoOxhrKZRDm6Q9u/knDb5V0bKY/mAnzIbXk00Gd3W2ivQlkSn2TBN5NNHcgQ+IbriiEbB1RdRrLW2ZQwqTVCaZzC1PQUri1rG8xODlT0xvIg9VQvhcn6ZOcJ4CW1EMw3TykYiEP0MrwmzCaVvOlaTVmoGkKZq1qeZXOK6mwTi5flPWrA7X9V4/fvxo60nKX3pC0ZNmiJxnHsgK85QEzM+w97yys+TIGxi6OQukG9BjPWt9ksYezUYYioUcIz0HtBAp6Yx8BbvD1tGJxJ+RtzttGEWd5A35uR46r5qfmNWfJEzaRYZJHrVnGwI+EZqHLEk4sZxoaRLHofFUycMbsmcKAJp2Jd4nBx0hdutx13XDCoethmyJb9++ZUL4Wh1Sz35gUSp9raxLWTo32YQILM+KJoBwtjvBKMFHq9/eLOscC+T5SPwZ5qkaFKcc81epYA8O4zYmhju681RNbHH0jOfcH4mkaYKUK3zpSJ1fSF96fmiIU9msiRnzJ2eSBovk0tGLc9CiVnkqBzL7u3lEp5aUGfnmVMzzF6Y9OTfYDGZICwc9w6ilkwqyOX+5PuZK3sz9FdVPJ55UYOLqdWOBllUMrm3tpsZtWK5PXZdQpLL+5tB70sgL4Oaip8ct80mNw2lITYGVFKn8GOcUshtIKzf2MXUfyKf6oh7TIUxmUkRqqULgSUqkOR94HWUnMrN4PvnMwWEiRuFZwYR+flIdMQ7zy5DqtBTm44S4ce4TZIcQJtn1qcG3yQaDdPXYmPnm4AyZ7SXuPl1PlL7LaoAuFcG1Gt3LtgnKofEL0t+dsveh2kE4WzNi2KxMlqLDkClNzrrGUdbBXJSG8jBRx5e++ZnHrOlM2U4Nab4E+eXESbyZ55fwyexfUoHkefNo+aiYvchqt8UlciGnMKVn0ky/NsHvr398cZOkJHjyI2l9KvMfgUVZiCG0SUV+7kONWhilkRkiO0j1my+2XGh/kNM4uyjAF3OetiFjV6E9x0XVJlJ04IUsY4EW5sYW4Gwjd3nCSD9NG5gepS5jnpijicLNgQbqXH1Vlc2tpwf3XD0HyXS+qMOLqp9Jn/QzPAragIl9u3AV5TtLjx1uITYQuO4nKWJwklPLuU9hSPFD1Ks145ppwIilJslabEzpkgSyBbJPxIQDb6LWqbCOp7pcCcC5zwSRKrJd4nTs8E/2LtcSPAV091J7EqnGwsozVNQVUrCaNaQxBcwAc6NejNMHVvR8g1YwtCJO2Dl9M2WwQ7mtwiftGGji10WYTkN27KmMmdNAp82529dFhCpgap1IrrwoFFFGLFXSBAFXF+s13ZeFzLn7wmo0JQee8xzO/6at29jUU1ZDZqXoYVn3HNSlCcr0leDC5US95DBKyVQa5WRTXrrqBPuNmL6KOX9LgdZRWXGsjofuKXO1lRBBG5xEiy7m6P9IKCN7tyfm9qJJbpbtTiYPbR5pFaF4z8ONy/SJKNX2JFK9UdLRaW5kHwkTqbAJ4AS/4okn80bSEJ6EINTsPnm2csRJEOeUs3TGbjxxza9YyK5xs3dgOwQz3e9nkeyoG8anRif1WI2fEVN2a/QfnmA8SfAsMoG+9Gfmo+0Zy+QqSsYmlONgkC3vZud2Yf/LcC9Vb0xN5PgSKSoZzjmsdebMyRA6EEtY6gp6xFN3tWk3kqQ8XkkrM3xVIyWWrxTUczedZ5bIJbLOP+ebtqtmsymT6MrGpwEGRWU5JQ5asJKOJLI720CDU9M7u55RyM4Z9VJjOXQdNiPSPFeLMXtDs5RFmki7V/tBWSZlDaKz04MphGehyARAgxetI21S9sS25Enr2NXOms9MVG6TUPIFEj7IE54M6myzUoJjfJhOK0s5EtdoJJrlMnA2J4jJqkyGhymjWQHnGQUMJOlLEue1k72+nQTK7KK2w9qKKT+p9fusvt1nzooSz1bbnY3hsEHm+mKKzb4Ms7qkBHHG5Rxm5fFPFXZy8WT2jH+hweVwUP29pjEReYgzx0YB4S+uvM5q2h02VytdhCa4hCyUA5m4ZKcQ3UMljZlZnEbwzuMYzft8aklGWsn0lPWRQ7kONFmFFi33y57J0RcvNh6tMhjujOspZSU+y3P4XQRLadGiUtWOnOdDZ/oh4gczbWxnluP0F4nVtNZbSnBNQes+MeHCcx9o8ARl9KmSU5gtMKbmK8uAxKfzPN1DejzKiRL7ZTnYGYXWkyjNqY81XDo1cR4rU6wQe1dhe+vc6cUdGGD16W/Tb1lXEGQTO5UNMlaPvUXlvqNil/c/hZZe6tXUXzZuwncV73ydSX/uA0J0+vDvs62ZO/V4lXVUh0jO+TyE/1cw+4NqhJ9XTBXNfu0CoHXihCPSIMtdFTVatDY6ghEfU/ne1HziiZJZUpJLRm2M8cSOlIKnL1Kc1nmpYE3te0c0iVm+NM1ns91NukH5oTTvKo7bDnod8M7e1Iu3TNuUDR2yMlhW88zl9hClmf420YLlMbQH6JqRd1k2J6ZW/4Gr3spCocx8xezXXxTlm7J3LlaalAQXnrTnbBNi6IrHjFRHQVd4SbrWeVOCejv9ZcNY3I0em6AKR5xQol5kBEo82DoK5t4kvZEX2E1AEVq7/xVONcF3ReEvKsTsodgSJmCscyOfxg6nKX3lQtNI1nSJUAt72PU6d1Xrg/shvFRywgL+pBm3uoRz3f/zjy+eddTj9YYkiUjMER3umqJFvicVoaemfnB3PR2zLZIkJ+VpAKtk/lTANIsp+0HuLz2+lh70HAy8Wset4i+Wy5r9yI1KDs7K9F59FdgcVIh8rzRO7UwzmRYa525BSicp5qxZlESNGtIRJ5tep2spRrAsCy4WI+oSnBp31XtAME5QJpqdfCaHUsmwXjCXMkdzcwhuX08zYdYJpPLDYwEqBhFb+0864MYcyURaMVDNZgxG1Dw8Qd5tUsuMoNn8/LwaUMRcQ5VhI0Ki26jL/kpCorGblGAeWL6x8cYhzIQduiOWH5AoTmYEvZ4Y49m66kaYgOFwKD4DQaqGu/2+OgPkfQOkCK5RzqMmcSfxOdwl8f6tlUNnz0y4ZbrKhFbMe5W5LYBMrFGLgHkaLfToMRxKfI7BRvcPfGCzpRlt12eRupacTrbtxMxvkOrVLbeW557NPUrh5IMfcgrw9SKSdNE5g+KbU8aDPdeki4QPPijC2kPtDArJ4eEsWugcyKyUjzMV27S6BA7mRbjnWQh+LtxXiIa+gisaI85iw1ar+JsDpEXoWIUfDZHJCIi+L6LPnLvbn5BxhQzNmEoJ3kMBtc3aMvoGg64fo4lWYfWsj5Ygbqb35PM3cpIgrXMgfB6daBRnyt1Wpb103FKgJvMhSD/2gLlrmSOSVK1zMxLos5+H3xZ1gdD6NHekwqNvfSgJT+4JIpm2dSmn3itxZ9ndvmsScAfqpbePss0eT0iETSJp0feZxJIprf0pgUv7R2RZsvdPFCRPU6HnpREmCiqiuTaXgSwGSTCbMi4/HK1dkk+fcusPNjjSy35I5ZPQjzQ+osdZ/XMBIWm2omU1sMge/scfX+G+S/ckYrNmEDFDYCuKwAv1jcHunmZjtTOkuNCtwZVSjPYKyvIFNjQVNDuQM4Q4JYgwP7FOxgWu/nXuU1KDIIriOwgzVWH9UvtjNYpaxySemim0oo1UArDKzFACWhucbSYSv9OZT/sCtJuSRjDNutd7qeGVKMIEiXkn0yTiYMMdEplRR98QSLNQyIhuK/PugkkqRdCQsZ8jvknMFHlBamAVA0+EP/LyO3/r/JMDEFhP5vE12qtLIplSUyw4AJOBmADjOgX954mhDssKEfTqJ+TEENjV2wrM0ek/QUKO8hquoSQ14AM7suIsUCnCHZsVwFkMJFRS95g/89ESh7IHwiGfvD+JR24I2aYRDCQoKOWIh9I6dEdcCelCOn61Yl29He5hEQ3a26+nFEuGspqucra75jid+wwUBse1Z6INqXDcEVkzfLvT+uLG6rSnU16NEGVUJujRQzdoSZvKPXc8DM01w1mbO9pRxCgmwIcLJK9JIr/hY4eeuR4L9ADVNSS2TebTQsfAQRLm5icjyZ2FkiluapRKL5JpA0obNOE05cFKDFl70iJE8YyVv4Puag9SyEegBIdgRlgVHFyg+jjptNQgFI5zEARNdHhzZALyrhnothCDYg0056L5gHw3ZZKgbwqpJyySgYThje/OSyKpkOyaPE7p66Ut7NYYhUsrJCDaDFXtif20NZeySQtOkr/8k/Ox12nyqUnYiFjnVrRbmShShPOZy9G0R90JURgp+lM9w2aI3IGYmmt2C2cfrYVNp0ksUJXBKismp/1rEGj8k/NClOKzfTAfJqXGikV2LkvnEu3guHk+FRIKWvTaFrFW53W4dxMm44lytolX5z5jSyOMWpXH5IcwP8ue2IFNit+EYVrhHgyJIXQjCx2m8pTGdshY+Xlax+I1KPTQxZ+lAkMVMwI+CJXXhHrZaJLZ1qwoUZKaENXTbLX0u0ANZYiUpzcdk+8kTOrAxVJvsAZyjrro5DXBg8wIkvVaKNQuNOoJsPsmSnOr2kU2nOWV3yLZgd3QlWPDH6bjA6HuDDyltcE8MM7DYzquUTEi9MsdVX3fdPFaF0ZxTOvuuch4gBOvPPcZ5iQ70NxSR7Hqdc0KIn+bWzrTyuTxpsZoCMVsvcmgbm2MaObLK+t11I9048l+lenSSjVhHOKoCKaYMjuJk3Muuk2bYwQ9OcPYv618GHI2h3CqDRPMLsfCOvmGpsokgWoeOs8KruPYqaeQFUGSi3vAaUE0sRsTDptyRe490pjztGnHqHMfcE3wgzaDmjgWuYUK0E6GaVEobWSftOor59YxKMsCQ4ZRWTasg4lYiC4gh9mfa4MWX5PefOi/aN6lDuVONBlpOI0r0q1V8J8FzQI093TsqJjP8ARIvB9vM01JUgIT+VsW6/xXZJCcFMah80rWOdiCS1/mCMI31TOmQ626yMoB5CPE2prruNnFXLvi8Al4FWy1dmfJzFGJKQZxd684sSqZzHpKtI1IZ/y5hnV0ZHiT1AN8TWLPm2VEa0ReFMKvbUga+baSiEBE+weurusHUyTIwMvso6HZZYwPRwkpSM/qz+y3pykM8yKz4HJ0JLch44rxO/sk16DtFGcUtniZHbFsyEbSyCPyfDhu8QkoI/rEUrvp3LKYVkLFOjjZrNo1NE0TkEoEjLRq7iueaT3DgZkYO4nyhtI4H9pTq0jg3xVqX6tokvqxprB2DaqrZ/OCPYSc2vS04Z1NapFTglVL7Im05pT1NtrQbVQunakE6GL95F8iu45E+jz1oZf2cDuWFlwo81+5fnKnV2rQnNXtO726XNGfuRn8atKLjkbKgAafrYL9fOSkf5Kxrwhyawy0xHmmrezxWWAcoqWo/6QM/gI/2xBK8xuVM3XGIicwrRh6ElIHxB7TqI0ZwmPFLolgIA4KI+jIwLU7GV04OTSb4GGdJTuROCvyg/HJhP9sm/wWXy15SFpa0R7MYh28fzCiFrBLuqpsXnVq+54fDKIklkUzelqtqOX8wSKAk51o3KT9f+4TbNepKMFX5iY8gdQyds7iTh3cBYb89E/NDvwqgsl91fzGkGS4drv06cnp6jZ3kpMMZLKUFKZcl8Q3kvu2JCXfofd8dldMrXN/GYSyfDmbkedJAArm9ByJkJIgJIi0sWJRNj+cNlkchZPos2+gG9ss8UQQnSeSAmfNsR1JCwnNVunXVFLehodzJZNhzsdkB4N7uKll7XSWoQQfcHBxHFZScBQmPVK68YCf2yl0yOih2p4ksMzqY567kImrXbcRG6ZPJc+f1SFV4C7DOYvanBhZ4mox0pNCrp2q8GQB3Xg2OS1se2n1B+ZPsjQdX4KVU0WkiUYrv4O5iytzTpaGZJ0QYKAzFy1je9IWN/YqPVsbl+GKNi4ipjc5S2wME1ed14xz+Ll7Cq4rhAVxTwNRTiVizs/KMlbmU1zGsUxts6Czq/yKzAg6AuSi6VmwWj5FjRl6wnUXsoJ5zE2wESEvm1N2ILOGghq1R6wi7jjnKOch8kPCc3BM8hdWjGjOhwRv4qQ5GdIBpbH4LAW1RTlcME8hSHRD3aESBClmo3oNtxr8ygSYldtEfebxGlstA0Pd7TaNE3iYoQGEbp+Ug2qfBUaXo5H1AIx8WamZQzqYo9wVNQiEXkDdgOQ4ZVlmy3pptO2nRszzuZJFQ/nBE3khGX+K73U0GBtt85OBdIjlB6hW4csPmJ0wKz5/pzxgfmxSJkJAaY+oXKPAP3ROliicaq7ZGau4lGleyxVa7DH3vLlV+UnZSxL2OTVSgKtfWmo+qfmkHF5/ML1G0FMX9HQra8x0PsvPu5oDS4PN8sgnR9JMP41aCNDJnja5YiIGhwEqHwdZv88hICJH4lm0/G0xrejIWP5k9yDOczSc6wASgU7zGWeVJxvmnMZshpwMXP3ZaZzH2D5zk0GRjCDaYijBT0JQoXy/FRzLxpAVfLJZaugapX3yKhQ/ilEveuuYDoVDoMl5T92qsB5m8yTU6mB5QwKcUM3PRlESwzlxSZnRiobOnIFyJ7bBk7GEGp5AuMrYeRZNurI+bwK1T4Ql7Q26/pOmSzGHJmCzbTfJDPu4FJTl0NAGmD0gAfi521PncZJWOQGMiFZbhjEvkk2vlLsru7ZhDD6IJ92mLLtzD9mVW8eAM6SGIqCDnTI3DmZP8kLQSX7Akg19ucfy1oRH8DSuWXyMgxkEJDnFcZJIeXC3ieuqtiNiZBOAu2JeSuOyx5JRtzJbgkirQho/Y5qRKpHJ+9cowiBLIrcl/7l+5fv37wkEaSmmHkjmo1ksHd2fZFxjbErT4/adFRulIc5JYkmJm392EiXQKaSBbq2QxUD5L6dQMwwlfaK1SUtqRBElepFCnEKZcDfCuVypUK/WZSveS3k5C5Q1lmTIwYIiAyVOn66Qnmvq2uRtPOYkL445XAzJlNN/cEhd5eerZoIGCqT0tacxbSBSJUsXxrlJI5vM+UCjMQ1CJGYgg1FB4NJ1NKDcm0RqAXYDiJ/2DNy55gQOMtKe2vznPvuRgnrqe5JLa7A775LijuQvT6M4z91a68sefS0f22ksQbodMznTtzvHmkGSSlEyBZmNXuGTQ1B0x9UZYZ6TlsUpn0aeQkps2sclxxFfNo3qHn7K3vD16X78+MHqNkdHegVtENQ0NdIN2nKU7TOOtCG1s3lyKxtFZbHkXYrZrdI823yAdggXvzUxfkKbUA1uOdo9NC9hvXsSiKZK6ZPtFYCfH0zKkvTeOLQnC5EnAEOXVK2NvpPCSmQtDsb0nc5VTebz1Dw6GEcuxhXFjbLr4jDgs41yocd/1rrGmSQL6iRHshuy5cLGTRRIp1YNICZLUjAmjurTJVQF2tbRTdRSRhVKDURqiFMGmf0ShUVo1Rm/nlckhIO4aNpNj1Sig6qGUcgK5NRsY4qJ351gefkejII7GNYiGh1Xf7KXxLmp88g561vAoeHBQ1nBkJraOuOUQZx9zexLDhRkmJKbRC3Bmh2pt5C0fpay9kBAT5IClElTISBzfZps5uOvpLG1GyMCzzrErX2mGBRlJCN+HqMAN0k0VUEts1JXfGJuaTqYJDnnBKDkQAyaPK8A67nO8IJmkcxwHaV/xAleB9Zf5G9p5oXuvv5Xz4N90PCrpPsmZfc8TNOQMpreqDI5ElLEHdI2E6vNPzlIzZUg2UYECr11EJ7GuUMg1QBt9tdF4JvnR4gwz0IFG1FmJsqJ6+SHkZUZ4K5NQpl8r2QeaVMzUlr5fRtgyeF5irqAKznH2B4OGKrD+WnQvJI9xtnbWIkgP3J6argg8bLv8rlPQk8/SJuBC4XjXRvMnn/OSUL6q6bx5AbRDY5DXxIhAlxOjIktipyic4yqhccUlos7E/KSTbWkq3NC3Q2xfynuvr6+ffuWfKNxRjbaeUrTiCorko0aUrJPDQ9mgdRskU7G1MwRr0wYLgVSDKOEUhjagok1PVm/nrtBUJEGiWokvyfFMzGScFNdWJ3XqseJeIgEr/yKkSMO46nhKBHOs1fPi9VIZ0Rs4jK50pUHimGwb5KW9CUs2bmM2gBU5AK+JhHMFtYRGEgvcn3Z9oyhFk+6AuactM8gCNYpUxOHPgvBeWHaBuunmJYOa9z2PUio0h5WSpKbTJPjFtnShPTFoC5JTk8BIu+SHTQ2/5mQkBdJYjOjZpKKUKAU4Kcn0OrHSSdI+mN6GratSsOcoe081d6RdEPhlp4CYPYPC2JtaaZk2iGJrPLtEeaT863ncNFxQ3s7Zxq1bDJrSCG7ei4pRSS//wP7XXRR1ScyS6SfRY/XXk+YOXIpH1fjv3Mh+r6t/YrXjx8/WEp/tYjhzknAUUNERBQLpV6NGNmOS8InNV1WW/LCrJVUQrnIpLBRdbI5mreW+TP1WXQgVEIihu1Ut2HCsZw9my02SS9PVqGyP1kF3d2yTc0g9jKjZh6HRkvQ9V5tJq1FJqt5nZkj8YG0TB64VifTDw665A9Qa9UuRqvnMRX0LBiywyUlD5fsLYgRk451PVd/m0xJARhgpKXljDQKvcHyZAGSKpBzWtVtYPuMwuqYTgdVCDpBEJ3NipyqmpGR+D0JQ4/FlhNEiHRMM1QbcLJGNNadiwcU1qKP4nkVRmZ6Z2gX6pQlByPnTE1cxS81c7hJ5OifhTvk4i4SRPBem57reSL8XRYpIaXmpokunihAz9P3BmjKfs+41ExmRk2WhvL2aAOPc3csJPLDBbHSEiUUVht4boHoEtMxyH3hjSMS8lsLPorfGeGIDhEgYrErywPetzyYXs3CDYkFtda2DeTUOVGMUxNzHXNN0wpC7yyUNVFTW3FETkpO5gFJaswKfp2/TVSUebxarpTCtLdVy0TfMChXeUolktV6GGAzQ8QEFtG3SYVqXGt4rbh+bbk6PxNUOEeeDCxoyJUPz3lNsqDinKUD0/Oe8chFn6ZHWmAkujH2sxvKe8gVTCnWfDPdwKa7PhWjbY2/EkNIJFYdmTPtaV6l8jFSdJRQKEkjUhRK6QdXkbQp2eLIE9QeyCZpO7re6u8iOBAn000SB2LlKVY69U1XLREuQPSByje44iXeaQoHr1idJgKmDdeE3X2tGynTc4gNIY9FOfshBFI12lF0rgneWdaTBObv2ZbUjBNe5ClEeJFkmISrXABtlFRDR7fEE0OuTZrvsh4d5LHTvqpF9BIKi7jW6VlDiCGMBfLqEigClXniI1OJlquHJCjIsnHGeuMNg85/64hndKfnFo+nhPmQW3gCsNZktAtxT9ybtglqr2PZdSWFZfLKhuVsg7ll152lHxY9knQ9YZ+LuhfxOyN6uNDXp76iQA4BVskUy/IIFXuMu10rmwN91XBV51UmpJr5lUE4JOQm1rCh0Srh1fiNOEGObtnwi+wplJkwq0YbsSmW9ZBmf28z4ihcFbkYpmQTzV8UN4S53uXvTEedxUQA7vv373zALBBzHQmBnI0sPXjCs9weBcyzaZqSgAPImhE0aFI4c/S1FVzYrdAs9yhFs9xnz18r/vsfX/OdwERZQPQv4lmnxlD3xc7dVVL1Cd3mRA9mVqm0UPwFNmUnDsrmVlyGeTuSu/gsgmjnaU5XmCKk1gCEHKXx3XN6cz+Q3zWBOIeAjiY64/LdaU8YlOwtvWVfU3VwUEi5UIRixRyABwjtxzRJV0KZJ53uk0n8rLCZTS9cPyXEvOncx9zTiAqCvuU2sdOp+JRcf943x931wbP64wjC4ZACHNg44yncpMs+LZmmCxsQRYraa1ln5rRpwgv75cyEA0Nz1jw3CdPubD/6yrQokRE9wEDyumSnKTtVwMh4kwuaeG7Wrc72sEveZXHDGsw4u86Q/jDzsDgRiNkYXS+1+sXCkGLoPAxEYC8zJwbz6eg5yJQaOGhOgNzriR/t6p7jK0ZJs6qutZ4M58evLz7FyCNZ7BIOSvqUuEs8ZHWhaohwlkhOth5FsVIVtPcSFJoBISSRzvKNZPCf7JymxzzWTCGhcOgYE4fQH8l3oBFgS+PX2cNZgUl359fzWajH+rnNomwissGkhbd4+nCyBGULjC5D5MbId1JUGQ61fhr1TMUZATUZ6xLrlXNj+sSc9CE+LadfMZ8OtvPPX1+j+QrtWdTo1AYiMzYmlguTL7ca23Qzz26ZZ0f6pHYOp3oJmVXTnWcIe3YC5aiW7sYzfZ717ORLR6ew7sqlDJN5urLTMHyJX2UDBC1Iicsk7YsNmvEkSdn1qBpwZeUqXzShKLTAV7GhKMLLEvTGQkp6fNqn6fsR3bMFplnN3UiKulQpNdf9/KnlLn5H/p67qjYweRB9VfQaW9vAGmpIZ+lzn2krcQxPlYC87L5pOkurW859hpXyGeoHIu+cGxhc7sDST1zRLlqSeDfZaa4htoLk9kZnm7OFfBCeb6+00OjAISYjawj5kFHfPa9IsWwClYaO5DbJKEbuRZrTxtdZ3WCY2mqeIUOLkDihE4w3OaPD/JHxm2R7qycA75U44bIyFhiyHhfdMZXLfsvkuyeQ6DPrMml3I/dPILpyNukhiZQEgiRuIySA7oNTi3NmT24vt4GGWK60GqHAjIzT7/95AqhhJjBn0hjlCWmWccTf0xxm8o31yU9NduEhcMrskimTeBMShRC1YFdoCqB0x+Z2R9e/tudS+DLZiwmcdq+UD1z34oCwsb+m/k8sS35AuX8+Wes1FVfuBwENeXmsUsRrFPmZD4t8Xq5ONS54fgaZoSlvprxlD4gpTN8AGqtw82sCMQdNfM1FjpZHN1eutIy4nMXCnrEeA5udnBX+JGfu9krCQIraHpHbUJ3E/wl1rPCCjlGDJro5Nb7JeZIL0RZuJRtSzaQpYF3e9E3W8iUhPvF7dXsVC7KHJrE1SUOnJ/14t66Yrem4OzUxW1BMRweW0fOASAwZ9IKxKW4/4pAKCk9nTRGKZns/cZHVbGjt3kVXKgKMqOcCrVjjc4eQsNGzZtuCRkkC8911iJDsIHWGUGwp5VErHOJ+FbJDdgKpzilbO3nrGoBqUk37elKQtmKTpiMhw3L8VPdSulA+d3dkxqM1R+0hWhIu94aRa6Jub/+8ZiKxpKHSVepN4tpphNMGVHb8XxtABHSBoepQyumJlHGSljsJ5u1jR7lb6318qyRV5td9ljyMAFm5pJQoctTKsHhCCoR3ZGYYBCPNsl6pEacyQwivJBCWpocwq1znftM2R3ues7qypkmF6K2lp3buA10ESrb4mAw5BjI9ypWtQORamVKWorKmcUMiXYpLKKtcEMu5u8QyIrzIsxMgleub3yS2naOATSihs2w25THI2LnrTgGvkhQHdCdc0MrxoPiSLqQ9PMXfXAy7NtpOs1voaxtBAp+fnjf7GBqZ2PDuOrODSkvBA7SNaEcgjVPvDvEH2xxhfU92VzyxV4vF4FFykm0BOx8few60C2CdFgv1HAXtkEWBVBOWsnSTJb660FSo4F+kbyTwd7Z5ChpLmjbe+luKNFpVOm1Ub7FHNnEizRcKYmbdP9EnieGE40mVDxvDhGiik2Q6RNKVjhodWTLybykFJzWJlkwXbjqxtVcAVzn7lR2hm55ES8w+z0X3YjeTkbiN9JRnRs4SMGawWtZp7cLGJU635ibGEmvKn6/v37/nLq8us0+iQW4SOtoRs1cS3wu6webmafXMlS62xKzKKNLQUeiR9Bly4TCfNAEkDVlHmubYIQyyFpEyehDtSiG8Qcn1NdcKiv3yhrY/yFDyLFp9Sysu/Up7HrIy1FvrBtIegt0DAhuEViPzYJctrGnZGZHFk5GQc/6/BuATt44qZsJbCf/sLHJuK2flKr/vUTYBQ7NzOCSCNssMEkwq+PwESamNOptBofSJ4C6pyjoKm5O/0jmW2dMpA12mAcRqhKiS+pHHL4OmdRv0llu3TfYDHRE1f+XUuAAxZ9XfbCkpSebkz3EcrTTHyZqSMwezTnDJAtNF0rlV34k2cE6SwRXfNkRzAkyXToNgpeeSzR3jjbzIV3OEdgSg2080KwK2xLRbG7frwZoglHT/wEh11ZUSJw0pILPAKCmSgIvckKZwsx0umxqeez0eLyAvEV5NbmYGmNXTo9Xp+iaZvEBk9T0VyGRlIGNJuYiy9MrNp2ZSnaL5gaSsfJSJ66SgZkeptg65gV/Dm5qXzSP+iQJdG2BqZxLrnrR5AuxX4/KnJs46d7EjHFWqEeZphlzuCFU7ay+M80vUg1xpZ8JhMkBS7ZFEFILKGXzEPcDpY+wbBptaxSg893NzEgs1sWuFINdkiRIi5WONrqoMY+xXN1NpGOVE4q41HpCTk0clZ8/QtXuehbKvVAjyelF/I4oFqStfHCDH/JjeyA0FCFMXABKwjywj9fnb1ka+S82BEfsgjW7N/yCFmHXwxIYotZPgdh7MwkPQIenBvPXkPGtCzLn76RKRCN8ri0bmVqeM/9eBWeskT963zOdrnxtNGiWZnqE3wAN7sSqdOdSDrXr6tMrehjMoaCGzkkFi+EXAoJtOPJ8ZGkIMY4v2RSeJoRYJoyVHvNW67OQToEgezzGaxFjIX+iSQ9MaW0ys/kDyE0WaNA5z42Ltn6RLFmCdoa2oOVeDWkIcCqZHyCjLEQ86MOeDyJSyoz49z3jY6hmpKtP9nNUfI+52ltWZEBhxdSBUvSt1tbq2q+ZBdl0cDzP7ipPPBdL0POYnpCtH/WtSZCa+HzyPwkAOtqC2SJwX5j7OtbLJKjnImoivluVd9ap9QZsN9RbYCGNlpo+ssR2yt1D3OnesO9+yi2tuEhNrErM4eYTpaNtIyT1lnY9GwT7JiBydMrqt7Lc82TYJXiMCLdY+kJH6i9W/6qK5QkmEDyZcNXtCT1O0XELDEuC/yXDdBGiKX2NnBCWo6mqjL907YjhtKUPHBLFHm1zwVIGELZeAqrGh3fTpdsTqp6CiKL0VzaEQ2CdZyQeHhXamOOXJp7Gcaqtr5AQLHj3QPKn2w1rvQL/LhwImee/a/iM8QGYk42mMzzgYLxVCzhASDvR5e/UezF74UoQ1nLK6xLCvmUlVLNQ41LJdb1OINChxyhiQKQTvOJMNSuOyvOQsRB09GygUAcswufvTaTFSn959DCpIV6IoGTvdZklYYTxugyCmbW3q2uQc4aFPNp3nPlOsj2hWa521Ngdu3bq6twxtnRQx3aLor03zCVuzchBsw2EUX4u2WyfrMNfsE+rtyT6d/5KqWneEcFgqvxxJ5BqFcSnerMKkkKjJHQcqCV+gPV/ZXpUtkprcEr/ysI6aWzGsByZ0PvA0wJS4JwGDtSEl9r9M3VYPnFSucrOiAYw0EuLq9B5jkJojkdNG2BKV5iRZeNg04ok1fsCzpScZ55vMS1MgdZ783gCkR4tW1cRMNuGJGIqdIj/UfDC6mMgJh+xrwv/yE6eBB5EBXhIV1hm2x0KFQEdgwVwPCVVtJJa1kilggUcUqrMT6M7blRWN6SlZXiehr7ygBm1kMxO4hixIzXNX7dflBz+aFmW32Mgt1QQGwj4iEX4Y7UpVTa5Bd6aZEWt/UMnOSxLSloCJTtwpTVt6ZGmu6Mp1BREhEEum2Y5Qi5XCpROtYzmdapIgZYVlnXEsNvt6eh3CYj3/S7QwJmkRZcsAcHXy0AnwlDpTGivDPLF0epYeW2AEr7tV/8SNF+shUTZZXIJCuiiJ9Kxcf/z4kRf59u2bIDg6lwW/D0pJ/Ya6tFKktH08f/hGDRXBuunjmjTfQoqVpcj8Mll+6tSO9M0UTyhlPqeGQB5q4LweXK6wqum53dZtcKmtTRJXYtYg5OfAy1bz/HiFHI6bULcCZa04UT+YNPK5z2rxNl2Z3vFcN+fBPU67XcQEIrxpdPDxXV9c/b3ZEg5UPAQgCjq0ttXO3UCbd1Ub/qURJnRVYNZ77jMDWUloKFXjifmLeI5q04hbKuEISU5y2gm1hgxHwuH6fnc9tV3JhJN8p+VapHAzBSdlPwO/koJLOMrDSpxHnTBPxNvz7Ba68uqEDeQWMYOX617jy5y61dja6vG/rvsr/Gd636SgYgTLCoBzk1pKFdxzeNR8Fu2H8FJR1aaFTdDvUoFbsEeGdQwLbhMjnfDe+LI6BNYBseRFNw+W5rhqrK6G7MJYSdFJdKcDxRxlnSK263couPQ1ynMdPG22QdYlYRad8smn5WzFJISDH3v1c1giKUPnPiF8naDMQRsiS9Ov/DaP+vVaL+Zvf/vb9+/fk9kzX2V4avt7WuuRgSYUm3upDYZ/1l3rCFhmkGto6SdEdj7Lxyf2oiZrrN3KlYxEzx9ilNJAUt3XBSXpTFpGYhaJfaQKtRuxsac9GErAdmakHnMN4xTCYExuLM1RQp1gzZofXklcrT7ptKqbNtQGyZVR3qDyk2w/snhxU8rY4Z8kqxVNOTBr4qv1KAMpHDkga1Ugfk0QUuaa8JmOb2eB65hvjaRVbqB0ohtGqyh2rQtb79znftM/s4zIt2O85+pnjb66OLJmyCNkh0E9u3N3B2Gdug6KE47R3cZVV0mch/oKhkNyQGJZQN6RHKZEwSCcqsqYd0D3bV1CvDzCJ1/GDXCaons5iQgsDjnGmIVN05zfXCCaN8lZoI/jpgPltrZDBiNWeBproqLZVaTacsT808kgsmSYj+kmtmzvc9N+JXWG7/lEx09o765QnrR84BLzmPc/nZzU77ITrKCuydWsjAkTda0lw0naTcvCMZIjCk0kbMo2m+T2+nsXAAr2PTaXPdbMxSKFRGIgUSHpNLEKrA0RSG5HLILkwcbFxBpIebrKsekHJuldl27N/dDA50yAUqRngM/8WkHduV+SaIkHyoyzu0XNrzx35x8leLMzOSRUj59pSVtDz1ZP7CfRY93Voa+y2ZI43f6hN8ns6yU/r5UgxGBPIEQnyfXP//7v/56bOZtBwIPgGjo8K6YM5qaUiauIgAHnJipYvCgpYD2RAJCSKFGHQAepuey2SLajAYmcbvuEc5/NHYR2HWm49gBkPqokD9QE0RqAiQoLx1aiNQFGZa6CYt5dfDXZMwmaYPR9SvaS/7Rd4bn7ies1m+C0zj/XwUI/BAJZUqKSg8A2ZZj9BwOykvqvHfpek6rFlbuu9U93coPYfpHh5DEtVIHELB4I1IXIhFBCHmrqm/YsCwnN4tUARsHSeagtENHTpXlgpo1TTsrI91RvrIKePgeoSW/ipFRarOqUimhdil4V8RD1U2tPRu4vGStI9/MD9/0Q4zkmdN5lXDjjF5Yd3v0i9WKTxAfizAV0BOxJ1eScp4siultOs8yD40ISozkTRn6GQs61Vgf+yXhsUG0ZMCWX4E/GUZAZC12j1b7NsaD/agqKzr4mV69TeJmYETxdRX0ylOR9SCH7wbuT8IC6bORKnDJIlEGvht0mEDYkpYZuGwdp3OK5z51nEFT5pz/ZGWScEvmsJyHwrTn4upmL/Ds/YA/w1e4lNYY0tpV3+HMDrOndBIkkP091JwuUZo9SGCXSToZxUK3TY3nWnFjn1dMhoEKTeylVhHZRewIos4zahpRPGhBkBA57f1KTcWlOTI3Oo+0k8prRV2QLpQygxWy2vVTaiiNMccUZIR4lfDPRgWOLYjSS+ZOaepjwF+5wrnbuTzoGeSIk0cjJ/QNtORuA4Kw8O5gfvo+UDP9oLhfTaN2ODyx5Fq9RlNOP5cAdW0whGi32scg6hnPy+PDEDVRJuqI3slVsO6ruxMk6U41YjoHgpqVpSvjkXK+sRtSr0orUTWCiqIyZVzL7hxzjrEVmOwSjlJuRubS63ax+MFL0EyFUc01FKrPrD0v/c+8oORt7CImPrzhL5rQdBmUGbHB95IjJMdQfVdqLKdi5FMb5jIuP7HC1GLOO8xRVhDyBkkk6eTpHzkaRinoaIrScmlOWMpf2gwwcn9t5BDRSJxCVpyii86XVs40tp65lk1OdX8Y7IVeuLRRuj+xVSrpZP8zv0sL2iVvZ59L1OjwWmCBxbWRxtrTg3M1DnzRGzKAGD8yne40aOht0zFGEIvNWsvSUuUC3rsTUJROwLedjQtgvIhiLKeBvB9mqcNRYLnGtRBJeG3aMzbQTPffJ1QdefCthYdaNpk/PmhCtoBuCWklswKfUC3rYrzMOm4ysYnPIhXxtpGQB5OIDLWi+7dPxOx+TGl9tbzFNzt1gXVtd8y/0pn2AvEP5PMIJ6jxYlTBRhkKe6iq/Z6OOB7TmZciUhr5uwljEZRDHIbXRepc5Lo7ZHWdlN49AZUDgLM4qZPGTDklWQ0q9ZmSQyTiXHZ3HZIw/fvyQXbu8JWlGy8krKmOa5sBHyVfr9c19TlgiKQDPQ8ULjvGcLzWtciW8FcGgA7jNymwpvRrkzS3otT6pPp91UP63fkrSCllGH1jTUHjGe9reYBTBaEBGR+jVQl4OyT0q5+mLoBhj/7m7L+a90iJIBZanHuoEkwH2TdkzkY0Cbfp0UBDxIMZy7YEM8mCkXz2DmcQTgW1kgu221t2rxmgmZsrQJ1/KWa80QMjpQWcx6UB4DZOcMGEW7YD3kIYjYsvS7o4ABtdAwuKLFvVse5FD9x4p/Os85bhfSStWlrl0TAJ5NFBkPaf6dpBuyUaYmiOELwgdUiMmCicPt9zNOJbRnTyxU2xTlqSa2iuYn20WanHypOUq3oJ6LX2iK41u8RzI+dzzKnkIdI9f3QkCVvSvJdMxkiCCY3z0dJXNeBh6OumxCvVfGwsyehPNJMv+1c3khAoNF0g5xQinT8JmkwYDrkPOZD1EJrpSMgH2Z3PJ1SAGycF6lQeOTGYlQ1/xW7nW6VfMgpiKwci3eYCQJ5tjRxEuAYx1cHfWW/snMWdnBdpL63Hag+ObCsmoND/27du3qSuSW3L83NyKJ48jUbLDG28KoMADRiJOJm8oT3hjHvqLHYqV88yVR4YzE54n01Y+VBW4srnlmdBMspQo5z6fZlVINgFYyBW7OXlgSaODEtJpgkgLr5ASFsGCwcXFoSeup3ZYEOcsvlQIBy6LodwK7aESqlvXWnwc/kDqYduVCkPT8+I1sGFHex9N32kH7EwS4Q2ZcSS6243MCvkVlYY2JYJzxhDpxVePhOw8uFYxYGsJ0krxsxsMy8QGQIUwqKWvxUSo+0k6o27i2kC5Vr/k3k3OE6eA58xTfq8tmiaRLkxqhL/97W+cOpX3Gkg32yAuf+RxiDpBWHnl/EjOu5IvOqGVJoakVCYOsU/lZ6Q/V08666Z+HjRBJ978ntFGagltZ3NVf/319fOozAmQk0twrApKxv5mENCmNMk08yJWt7lBTyPWeMwpH5XC7WniKt3/BCzKczNpTHIzSf5XAT5VLOIw8iNHBCd/B3W4NJdAQtv0sBn700FXS06j5lQj6l4R5GhXQy61VGsNc8sRJ2nMFVyCuqozKDOfUxM6ZpOTIacUWt0kylqS3zLjpxnem0vbwNmqLWIuRIMDPmAmSNlLvOlaTytuRQ9KAlMcbtNprggkyhRpmifghYRtmog0oqUkmxAQ1QgJb+zn0zC501D2Ja7lcmBzqfYzTWgUtohYEFThrLs8DhXZ/EW6GutAUBQn5LWqRJha53ORlUSLMcX+yPnFvSfNQdiaXoeqiVj/tpDoxZsb+FY1OL28ibUlA3lSb/Fye36BPISbjnbKvpzkU0b9oNrqpCSt76ydJxu5qOxwq2gh6ET5shI25sRJQ7tSmlCkgWKnBk0n00hNmRdn5yG/xePi3J0A+zE1gUWA0soOEulfq5B9D+LIkUOx2ZejQPGRj3XNxPJf+WhyvhBKMT8/N+1WGep2cKF0X4zGoKfGNCTVkZ61AdDV56xl2q2e0SkhB4onfJqpneonssZF5GbHpBPCUEVopNXN+Z5a1/CFrkfNHZVMSeoampPJlKTuORb4Y7H6U+BkFpcCSffzlPuiyN6SJXHyVzoezNNWHLzrh3XTCrzh3LQkPKfmtb25QAdOg9zWpNd19Z1lyqZ6LleD17OkyB0XO4rMNm7TOMll+35w/qDnnJyeNIXgM4mKg4OaXt9NEi01HcftNCH4gU1DhaHcrlBB81yZl5OqRCXuJEJcW5osdO4+cEyiBipJ/iM/P5FlOCY53C0VJ5o8y4OdOyEFzOATTOt7LN0Hx7SMPhDSQFDrxZyvj3Ux26ZX3/4iPApzgzjykrJo4fccn8oek+zXP4yAfep7C5lJ27+NH7UaWA+oTlDlwESfJW/3AclpS/xuugdTiD4hw22cpcnylMmA8PtUNWnniX//gbtGv5ZpCFILryjDT5GBjVLGTGiY2D+vH7CfhfKcVBznqOkqCZcsJrnJaTO8Osi/IWNpBajqVz+cIks1mJiZyKE/gX+2tRSuNC9IscJKVFFEXNE+tcWLJnOGeX8QZUFmykk4YlULUWtOqHkrpEL3T/dXah4h7onHAnNCZtQBInyZ4EkEDGvyGW1D6vUEuKyhhIyJx8z4g7eyBzyfl5qn+IQqZMxO4DpRRcexn6xzcr7xJw88kbKcNHyNjaC3LYoSqeuCZqemLcA48YEWf8pQm4xWDZbrtqIscUhaXutjapRbrqAJgc1K53HJJDhgjlBLqtHbD0dae75m64HYl1nlf2vP9Wyz8VYmX5rWJEILHiBZiJLfZFYEatNq1f1cK0bW3AlkA2jGgGcAAIbRSS4UieIf1QYthE2Zmx2MZRn+jtyLZaD9YqBVl4csmnUgAre+NBayGNDYlab6JLLmw3SaroRPCYYKmESRD8q1tRgYyjjrmV55eUI9uqKPo8Q/bVdu+ybTtxaHAIPGnDAWcGUQ4Ccnj7d9FtmEYcKsXWXyyjUFnsGLraRZvnnBSQHYmpUIOyuVqeDBbGAmORp/LRw8mQ9rHlKJ34fkSgiJkGXtusn7pBuHGjdPWqVm0AY+J0LP8MbZ0aKadcuiPc+EnZ+7ybsGnLXtQlf8SpGzFpsRyO5YdgVBRkaps03YzWfkTA22mbPgmI6KWZhuybUWB4wXqJ8iLTy/J2kogSNaNgknTZogEgQd4whc5tf/8Y9/ZPChGGxhRrETmkCpCQmt7+PZK0Tn5n+vCcMJn4mmasU18MTJPEqumL7z7CM8wvBJrebTCKpWA0lL2rMZZSDO1nUSpERr0vGpJehc5Xp4DBY8H9TiyIjsJNnzFybNfH6DmgfYWTuP4vAwLgrSVVc7rO+ky2x3amJIjqAnrzSiK9lRQmk5oDuvH6Q19UDkNRxDNmZYVMM+yVbnTel5RYuD237urCbKDKFI8r0Ssyqrh7Wy7EbUiO1dlFCt4dsy9+tBSWuifJ4d4HoCV0Cxznx4ZK8WLOrCPI2c0vqWE2hgEzUB8spEYLrtkAXKo48BJeLDJjPP3uM4uhUmlixJ8BcXSWOOTJZmaXFJZGRqzNyD+/UBm1+Znz/3+VR8U3mbKvV9b5UVQ5UQSYFQ3crm5ZHnrIpZq5/tui+K9q8JGpLzkv3CZdSCcc1bVzEtHJDVgjJIydKbEteOD6qJaVAjvVtIKfOkcxTwI9NkgZuKvjIfeh0qNmTNRCVKS/zam+NpP7R+IHK2D+MjDmznshNSs7adCUfCRUipdmGnwXRe6bD7pkKQBHZqlhMNFjU6RWw7FkarJ73OR3YftZSvM1HcSd7oxCqVlZ28yr2Vfr3iPJNuxRMpSmjxwJt9yVyfWTsnXopBJAce8V7y8zpUiVZxRA2bRKuKSA0sdfSDJ/KkXfXWDT3pRGXlw55XCoNv376RuxabMCbP889ZBvK66qb+E8BI3lpqBl7tK/sjT2jlW5OSzkZBHp44ybwvcgAWsy33i+py2vC3GJcbJkiwWkvJbtnPTt3JbhRhPrE/5L6WzJKQfz5RAMQeghRuM/txFPgTsRYePelBzlLi6HFoo0KV257QEw9PJUJcLpNkS9ulxq1ETpKtRcPQQTfTNyiwHJcKwu6B/OdrhAFyIlLVl83GQR4c2L6KIt5cIDWbZHjNSoIUN3IM15mEuSyZAWZ8XcZucwMIXOMzFuImjqsUn+wb5McO/B55JlAWTO2BJBRcE08SwdSLITMGamTjPCdGXjaKHB70BF4pWIvZbcuD1lqLm59ohKR2lKFp1pia1u1CQAW2KBVs3g8S1S2gMMDzyjkK0kIl35FpeQ7wTB/lZ48imahgFt5LDPuzjZLWxKvclOROIn4QguBtYnjo9Cn0Mj0PpbOcbM7ZBcxBAwWysGbPJWn3074itCfbPS5E8jeTy81vKX7nv7ju52VHnNFGzeGxRg8ppWKLSNphYM0T2HhWvtQW3+f/8aX7xiA9UWxyWuZISjR63jV979IRDyuWhJGEYDp+U7ZGD4tzN118NdWEZNdV6NgeEE8tTM43pg2OSGBpN66VFmHy/PAEEoGzPTyGMYlAU5e8HcwSmxk22OjloudxJFm9GC+rgow0kAnw04+L3o0tT35YUdyUq6xyNlntiiAZ4v76Okxpksxw6cu1JaZDPb9DMvEcrdSQcMDrRI05CqQTEvwQHpF8KQnsfpF56VDQ+FrzE5uDrgejR8KUmk5jmWGmrGNM45gLraw7GRdTCk2X8PYFYESnU4MkJgpvrBbYUyQ7v1kYgRY4nUBvoclI/KSZNEo4Txmt9GUSo/YQDcqM+GOk0F57YJxb23+A0Mo6VlUNStqPckyoUgNCvZkdyk4izWQby8+YKQ5yDhEjJibiaLwvQ9zDnKSBxlR3tmFvJja3n0wr7sl+4xjqdmHQL/ICmDuJl8Zsjf9L8qDw7A7Gc9lpnbZk59Qs25Wq1DiVgnFoRbowgv0BAIIJktnWAmjNeG2aUI8566M7b7H2p9M6aDmv/kKnutBXJefn81UszwaY0pzz1zQckXE22yNz6ISq8cde7Forcq+sIxm0K20V8kiQhBMIBRQSNqHxS5rBRA+HCRzPMK0MRr7ccR1HTy7wgoDySWkcRHdbGVcpLIWWmNdpd1v+b4bSBUGnOUoqij4PKTDXsdD+gSsVSlOBD2x0eX9kEip31GnoZkVKXajjdI56se5yJd+/f+fumkj0gavCl53Ly5GbllHsA5MmvGvUHLUrkaaHoq7+AkRjxB3ggJl2aGHfgAbWjXx/Gdn9sQH4ytwebP6Lr6KRsare1v2gVCGQrmR4+RTBdpUSNB4fozF1bdrjhCeS9H5i1wRvbUEz/cEbudewnINZl6yROCF8WAkq6rhqJd49NZhZcBDxiXN3B6QeiNK2vGYrmzmZJeGmKYZfijBC8uLcUW/BtEwCvKwMzqzmKlwbVbFLIA09WSnD//nlFEk6igih1E9weckNj3k/vdlWTwBW0ronZO1Hr6wpehrlJEoZ9c08rPXMOJwvjNqefUL64AcIiGSkJ4ZIN7ZO2b8S3uiOrN5XBMS20uGbZl/N6w+ClMkuFDxoFjoXjKjHzR16T4rPKwq7oCcHpSTytFnbouLPUL+jTk2af4RTzn3KBjN4Zf9SljAVaToa/WvbKzfNrEZIyOhiBCKfnuit3PKEPkl6prp2aCCqL9NHIyngiWwigLwFT+ILrOMdqFzVAS4hgZad5Ht6Zdn7JeVbfbBJwpvjaN46RoucgStn4px4TG1YTXEWzotMlRYXP0FgkR1IFqOihGGmx5akNahrSuJLkw/JVZW9aC3SqVxgCDkOio6zrJW1C9ZoYXWaA+zZCbNq4Y6sJkVSaifaKGIzkU41HweRnDL3JJt6Zalwv/E12euIVeNaPetU4a4Tg4uHwGrgHrobT498DdCZGbgH3v3EgkO1SK2VJTQf5MXf6TnBHCDX1czZLIUDaHAsrmg5wluJKrZ4V6iOnEP73gngT7xMFcVgrHqUK14nw2pX0SVv/13lYHPUDgxAZf8YJwVFxOvnBxMUNCnxxzp7XQ5lKw+Ac+80ym311ZI7WKsRGo8OgK5YE3TkQ/eJ7yU2cYLvdX9YE8aKPeKKL1CHg+vCP9N9jLc6acMdGuMjIPE4HQGYOxGjmKNNbrghMFHqtjpTnLt9Gk/wqFqpbeUdnO4yX4oqiOQnLAO6ZRvosAlRrI66aagcktRI+W+PJOr683q6AculB8/akhdsl/gfACL6xNAwRraE525v2pKjqYhkuMLTgM9CSaZmRxwM+5GduvrB8xTCM2ULhbq8bOz3CSAHd6UT5z6fMH8SEmVirfNBLLw22s+JEYVUJ8dagszy9aRDCJnfDeVYFXBuDbkJomq2l9ZqH0J1OZ2wuhLVAJXcYYKJnPqhzGQk5Nf3NXlb5J+nd++hT+3Yl+/Pe9FSZdUArMM5ZZza8DpvfppOXGzdUU04awVVGEpdE5MOnZucc+nnDuGhv8pSe9/nNElawoSHXGVV30xJvyYVv16MBAH4V+EVW7y6rTmsYgOaz5lyJYRNviO9goO4tSxLIy3YbWFbWvmPTLJWxkfWfZDsqX+YtSf2ky6v4WWrkKXTVEKorbINAXPeIv3XTjUpYHiiS+TgJaIgzZDonJ+VTLHSUWqaLJoUNQb+hHgCMBP4vs6jfBjx9fX8qOULjKj+q4w707KWMRYTNcGFsyA6OOnEbCg9r6lNK8YB6QxzRASZNmX89WqXpEZ+MgyUfYyePdpDLih4zafIA8tKTV+T9lJqiHJNC7mm9zrDU+tg5oThZ3wiwOngJclinTwgmq06A3LJJRlWhei6zyV4YogcDZoe2dv6pHkjLeclaBjapogDatay6M5IZCaIAcuIlLPPQEVyi7KZaBEzjk+tqCzM/8RFne9/+/ath+M+cW9k08lHKMo097aqalacgXe4K9RpET9HWRBJxU8tv/w88bFzt5RjevZh6lbHxDZ51sZjdMujp+Tj3O1vY5WVQztSwVNmpqyyVgeT9jx/U3g6i+WK0VihYUqxrBSwrdYBs532t6IiRKszYhcxZ8Q/666NPH9SFmcKRh4Al2aGwzJbk8CUYZjr5smtkbR7rX4m+uTwUeHKHzgwTCe/pXth7NQS/yZhRNNgG7Js4eypMevnPn6L0ZeZW2sJxafsrFtcm4y7HRhg/cVO86TF4ZlAo3mL4gk/seef/ZevWEbSUryB+VQheRfO7hSRuBVeAoVo7ctPO3VhqLAsVIg9a6cRyMp7tRNW8pkOh3JVSQ7dppnJsCekxSFQCYaS4GyPmEYxC2K+pKYNKXRsaLJvs07x4N4goEm274f1Jwa1PCmaWs/O5oT2SAupLyWNR2e7+B2q3DTBjTvqK80+9wGr2eVXSkCVQ8Ik14oybCbQWff88Jkql2gnJYcsqRlBo4OR54K8N2RWLhYGk/4Ancq+1lO+JUHKs8/dy7sJpPRL7Vh77vboGs2bFlun/j3kWBv16YDiHN/WeAgmStrNXHyeMqdYa0KRBE+rlD73PD14TnKYlx1Qn/EiGaMIi9nb2hhdk3x5FiaoyDilA/MsQULmNBRZ06zGLlPhyWqYFUUXi7NYxz1Gp7MsylYoMIWEhrIQfm1NHLsZHF3IYz3SClYvE8ySZcmajx1KsmjkNZsjgnMm+Xee2Exp8jOcz9dPQcJOJWY6ANUUehLK0NdWVopCEdbDhF4Yw34lYkOGy0C0Ss80XYa9vDVJfvcBThnfTX+BYTLnO6vh1RSJXTfFdQG0SVFINu4ZhjGUTbWg4dWi5ai7THCJT0KG4OxpMLfOadMKT47cE3MkaJKmHKwNMkWprJv5CLTLFOdcwkiuS0WWcbSlkRYZKL2OY+RK8vApezI6oIlJGhIOocKu955oc0yNIm9K8swbvlqHxDMm07eeJgm8G2FJ32NBwVQknYtYF62TttqMZW49FYAa45Mn8XRYz31M8tOgkJZFrlaeKzI6ph9jS7TYrOBoAo3vDnNODhrtAtLi0nkk3ftc3VaUUTCetVmqRBoMgfMssmrVnFHKJC/KtaOcfkLWqDrEAZe5ZiS27nTx3OcAdPIZJGM+xUgIuRtpKERekIaVvBthY0oxQYJmztoA526G/lTCn/uEpT4f8+LSDUf7zCeU1JB7UvY7DE7BoUmcpOh2FgH3ns4xXXkoCXNVk4yqhy9xjDiVT2IxTs1oVkLuhmjn9HmW9IK/qLiuUd7NTeBm0Gs2w5ldMBlYMC+YdR+b4Q/DjtZpfAnHMnHiUg5AFPpq3FPI46AirAUkL1pRf5mmYwPkYc+HaWOW8zDJi+IPasnZLgmDPydyaujEe1Xbqz/MtNNJpBPNgTGJrDiNOVJEjLwoqcho89TtbiEyZ3t17aUGttzyNK+A2XO2Ii+SpLo86eDllI9wNfONMnGVJ8xaPRN6Jj+P9IT4XGQDMLQ1dkLoTBGEVLTcZOppdU6yrzJFgqgZJCK8z2EdqWrc3ObpwUJwRRW6H3zKQp6W8ynR4gFGkQSx8Ha3a2ZlvFJOjdBSJioaBQXQ52G88W/dQVZxMDHiYJc9V2ulwkulTbJDTx5QyO9e/jCjyKLlr2fqj476fCh6LIshyythd4hxh05qrWBeW4qr9YuQUA0GpnqBU5ZJAIkh6RdXkk1fDbslzVWMnR5ySk0WK2ZpqVZhTaDMeOIpP+aCaNw3niKJN6l75gHkIObqj+ogOSslTn3op6wn+tbRnQ5nDSOytmNr5omeOR2AtmnSnC/+L4vdpHCBBcPPidCk+0dSGmncm+7PapNIEuRAAiwSOj3WCZ+6JSK7NZMk3SZaPHXQJdZhN/N9AiQsNX1PfDUeDiuay93P7hJlrKtWiKN5dQ5GBk7343Mf0DnJfXg4JC9kexC95bjV1dEg24OsqQxQ0cPjuNz5yXzM+WeCTS+UJ46NFO7zUiwYNFbs3OfPcXYTcbYYUEfJRTt73ZxsknCM2VV8smDRWBpSNXMzk9VwbAexYB1fIdKvDgxPLrzr/ODUCUGZTS5ttro4ZFGQyarkCf8SryGegWKVnW0IwESXiK/n7FN1MVjT5DBhcfLQnO+ngKEuJ7q2MKjzA3MK6aTK+2ZV0UF6EolUC2I4kz3B2b3nPpmYycw6ZI2blttjVv+wOImBpmc0+yrdcSHiOkNaYy4/TLaTg/ilYKPNQujAcR9qAZoKiSc1WSBaOv+p97f2Geebc3O43n4+ZV4reR0SwkvdIkCXwFFqFG3H5p2nWmcbTk27AJGU2Au/nxcPj5oYc2pf9q0I6qesZH0pOn6CTbIgUYj5bFors45E6IIvi3U9DPWaNHmeDKe5cU2J0QEugLxpBVyjmttJuVliUA9WVGjTYGb6MLTATYtN8gmyVDhYgL5JTAiJkPKo+bJS6cnjUZNoOC5hOJYKFBZqflMXyms5S9mUgPNJ8sLsT+FLtCF5v1Sq+d9zNyQTlJE9wNOWNl4BWyLgYDnU3B51GJn9sz6jZKK3x9k8OgUhxDdz3X6skqe5lnHZkdXKliZuHSKq9BTN+ZmsfklVlbco1xX3bF0erZCO42rrPJnUaSNNOGNJ9i7nmmXJEVcr86exFEqutO9zjD7JHdisFQ79AZChfCwMbaZnDcm10VDyMU286/qbiX5yJ3EHhArktO1D/4qXQ+BTRquomfxwoldS8ID9Wf0re5QkudRFdKXXauCi5IhyIphtpMdvJlOaAKE8jaMT1zawwFAy4b7YyxhrzQGvLJe13tRKE9j46lRJSGjjMOJyZvUnCWFhnX7eWAQzvFE9KIbGfJ+ZX4Y1qWLh8pLcIfgPN6cOlk42KP7MiUEDblEL5cWyIhvEQ8mu5ZMg0UjcCvkCiRbKbmCWC/vKnEdEX7S0k4TMJufkUJlAbUwvZfyh3XLujqUfEOQmlschuOdO9KAn9oWarR03+Q5GX2zQ3LsMEpTefN27OiVWSipx63G8EeT8YdJjFt/afFih9/kVtr2eNEp0UV1hhCb8qI1FZxvBc8lJBGkLXWC9K5Wj+sQdLNnqp/yP2Y6afQylzI9lMcYXFw4uQHwdIymTBPFM1WU65TtEnkI0MRRXtQFrNxx1qDL5SU5+E8Tw51YHOQL8kompolVE1wOTtPepbG8+7RNRmaa8DHiNl4nQNmDCLFbiQkqTmPys0Gf+5DQAubqvqp3cjbh+Syzbh4MGBJ4ykGKfWBnIWCQQTuVY9rYZZdIoBZmM8ZoUqDZF8xRFqVx7PkkB+EHYiOgBwxTsJ3Qy8V7dgl9ioYh91YnjKqAhU1dgDncRAZ8PWLj6Dz30aqXX9jdTsApCUR0sy7qsYNLvmPyk3ggK8e3bN5aV5z6Y9ekBrNfTzML2CCH5r4FwmrcJ2iL2lTOQKiJNpFvlZmQ7M8bLT5sEZlJXlF8I/aRqguEsOX0+Gpk/DRXkmVLczBL8/XCbls0X1ZhiLSZ1wunp163KD8NL+kOyh0WrOWqFtfrXFhuL8rikdPOSg6x5fHNG8joRiM8+x2OcnNmmISNAFM44rlE0l34N4SlCmZJ6EatZHW7O3ff8CWAQtKIpv8NRa6PIVtJlzeU+kKCebCodFaYePBtZsCXEEDxVvJaQmvWP9NMJBy8VplRMPpHeeOspVsoh3j8pMqBqTaUHpO4QiQqqM20XVedPxGDyHTgpUd3u3FmiRudula7khAOzAinSHovPmA+pKdPJcRPbZmOk4/ZbifqaDXdOS0xzRb1WHJYgZlDIHERCn3m8zGIIfUPjMTWzrO31z30aX8qYKKuS1KVfoTotO63JJj8vYOA8IWVz0QyKeTzrIMR/44sG0RQKKjKtrlIJEsSVD3yhRxSW1u8a+3P9s6B5vmc/5FOv1xPRM9MGvb5ydEYpOZ9mD4gkR3sSyfGYtobC0LZWVEvqjCUTiYuPww0+76iW4FDpoUDLIdsN6ciSQyM9e+gLvRM5P4UlqCTICV4cZsVAQ6kjsZxXMC9uxNxTDsNZCYCsHMSvmveYEpPowcr5UYJI6VmU+Gm4zOpXIjSNwKhIxbhmrkKGaadeKgyaocn+cWCKoElCcjj/XTP/dEjSd3ae6CrDlyEcHeZ0tkgpxnQij1vWXfwnZzbSAp5nFxMkjUpY1UurFTs3p3yiKGRTupW5kZQ+ZqHzOjmgUrf0JzBAQ6VmYgVDbUfVBFpmQawZhJlOhSQmj249W3K0YQzpjTVod3Yl+J/hXBxbr1nChDKVDo2UaSVgT4ofzo8cHLprqxnMuc/54TifZnMS32RWkBWT1wn/QjboPdNb5zkH0YWUJmBaxgo9NClrIGyl2HOothZkknfhLE2OWWEykzGp3R0fOZj8M4kjkerGGi+75RWEizyNg4kdYtfQVoW6UmWNK7GE7CWVp7M3njTHVBFQ3cLHkCgueqa4d9JhNgqcLiaRRMHJPE+SrGvd513EeVTRIg7SKRM45seNUKcDysehNpD0bqsoWaNyqa/vQWCdJmXbZ83R4KSP/adRYoKAqX8gnM0B2i0Lpn/oU7H+VWbwsI5oUBZRTUTRWd9QfZfkWmps7zfHQXZxmu3ObZYMRKBtXjMmr4EmCAK2T8FQ2KfMiFdH4sfcboZ/5fccitOqhnMfHcIBAoz9yr/lByHbDlVlT2Q4VR2n5tJpDQmpXCtmem8RitV4ogDKSYbzixLricTFLmrK7rnh5P/xnqyTuNqE4utilKJlIg0bsU/odSchUuw3lNSQdo5Reb0zC6IxBH+RwlCt+4k9+d+wqVcMOwdiEi2tkvmZ68CdkibxSTAzi+M5oNUNpPlkE6GfOHBrudV3uyOculRKOBsy15HLH2MVvk5mEL9w7hJthtcQptbEb+kS88pjEsxzVW5FH9h1zBJ/1gChgqSmSQayQuYf2rQagp1XS10RwFu0hbiCPW0A/pdogKyAOVcw1WefDAIuifxE8tL+diTbZA/MKay4O74yVDlH7CYnNoXtvBENQ5smRO2L0P31GeUE4x0QM4qcv4Ha2IIkf7jHM2uDpbrjcJp1nI9IJUrhEraSFo4/NiVyT31Dgu9rm+ur3ksGzzGP7Ff3S5AI3pxexglWEXz2bLiyqovqSjRSwZdPrB4CTQMEzTZOJhphxHyTztjpNvTwRvVBcwon9VekYYmclRcBlKg7TzQk/ST9y1QlixPWlASVJfJI1Dkwq5824Oc+zkxPsNuuAtYC5XXC+UTh1iXxdmlah/piTyxoSjT1NF95NlSU8zQgA0TOKDxw27VTW5zJDxmUmS8bKICHqdxjetFzUjfvDoft0BNcZzdjSY8M4zJtDTQPlpWApNxMnFCBwu2bwjEw7Rcd3lvcr+TnTHJuakeG88hHqHwik6fzENpc5wglSsF1LCGoFMwkNn/Of9ZG9YcadUWE10X4FsSIUczgQcmfuED9rp0OrcqShiNOjVWjRkeEUHYqyBbkAaooNTjaOpo3R3/yMYEbgcPnpZ7gBU68eqJOqQ8vf5uE+QMHDYm4eeuSZc2pJYYZq22580oznSRTg2XJ36TsjttDIipReugdtNLd2PRV+JjrZOgJwyDmOivozD2/nqhawy+pm1MMMGlL8he4I80/IaQUKzDZIodRqDaNgNamCaeMCDrk0mEBdDAGOHk553GwBqB1x7n7agzg0/ax3HhM3DVJgPwIAkfBtrVXNSpYbMc81CyLCNg5p0ezGijwzyVxZEv7HgSwZoooPWT8RpXcZwDRysjitHOdh1r9KlXJoZx3H+JZHLDXPdBVL/OCd+xgHq+ZALRH5+pfl+x6zJ2a5Z3L5Wbg+Ixs1hZStvBK329kdiqBUHRYk/Gm8Dhm713EnoAbhJ/b6f8JGdMVClYW7+1sE3y7RM7dy/bu16ethlrdTG7pF8TnrkRR1uda/VzoT0SjD4wYrn5GBE21YfeDAaghx1aZMVK/5VzSZ7SGrd1jlNuQZ0JFmBqT6uZEdHfKWXpdBCsgy8v4gIQ0ePUhxczFZ9IeaRQ5HJ78aqTbIEgvQ+PWrZOUwT4X94AMIXUPW3DIoavCFTg8vMs2Uc1ZJYqdrkaElvWIAdVeVPNUkreGAXigcV4yyxI1GemfuabiP9e2PnnsCc59XK5q0/60vZVpVN1YSreHVgZ/4wYfvijEZhNUr6ZGFRFr3kTdSpYBat92X7lnGbFVJ/eHRPQ0d3KMcMp3BwK5rTBTamFNtsHa1Varvhk+Tw3NZvL2+RxOUZqbzSNsleOPHz8O3Ekaas87hnNBYs6Qf2gTLUbTu/zj+cjdyTx+pUZztES3t2R9owXxFGlYzvZTJ7mAM3T189yuuenEv1aaCkkpzSjO6mfzi66rzaBMw0H9Uc2gDud54G25mgWo6SGtrG4pKshVzUAhLX3WxykAmDxQtaijW6al5+6TF9q9SJ1r8GoFIxlZBKkGtk7ASuCnTj9rZu4tZ7CKyNQL+CXhGX+0PQAbFFPI7EEmnETf4Zyu/21T3sbcKkD5yum4dZdA07mnCM4eYC85HSvyydLt4gRiEshW0oeuNoUTp33RkUWnRCq8UPpSNAfO54pk641JpkgW527qxr6pNtgqLU9QI7Lc5q3y1ZQ6isQhnrSd96ZEEcGWFd0T4MazKyO1W2D9YoNmfX7r95s5nKUvWyKSeGm5IWPaAGot881LcVqEvPbXMoMLPZ3pdUvnWGAMm7U7Y9nT900EYrKxUtzUBMgOT2jgPODk9MTOOaImOuZZgjmmyHXl6N+UBxy8p+7Yh8nQ9L1b12i/svRD5JIIv+bsnBVBafIS2Suzz2M5SrGOqoU5DagmmwZonJReEkRrEBpVcPSzl6xbHIxu9WfqkwaNdLnWXcxQd3RMNe+Nsz7PfUiMMgem/txsAisT7OPhk8xH+DTzAbKDtB8YC9NInj225tCqQdVIprGPjF7o9sOmBO/q2QYLsFlOt/cV0gnDon12OYqPPTIe783/6QnKWUtp84VnQd/InJyS5z/5HHOg8kvni2RjnNEZljZ/TO3ofuMMZ05V0GNcf1vyqt+RyEp8I9uPIHdss3J3ZOjAhkDT6YZSQSzoc0uYLIknpJh14ZBbeI6HJc9jmVZt18/Mhpln0SnfCk4ISs5MBjHhRHefDxJNBUc4k3nB0atiX+Y0YLttXe7UtbWOlO/OfvYs4hi8Upge5cb8WKqa/MD7EFDuJdie0iFShkJh6INMzsYf8ishZWlk8ojv/n8+Np+TfrJnnzSKmh4n7cR6KSfjF9QtOGX++ePHDxWyZI+x9p2XGmpXD+zgDG0ST7IQ5fHdRpxsIfV0ynU2sE4b6gRXYtlqByY2JGeB5ln0BAANbgnDvEczkZ6TeYS5z5OYBavQoUR3vSyYF9cQk2khA3lLLix2ndh4I15LVmObQrLYyuBLKmYELOh1urzWX3Sy52M+cbO4+jm8g1SFYDvaOas4Q8VfktEW+xFOIfuXIEF/QIZehvAG5U5ZdbBfnmeUOxZL9GCjg+VzT2o8Hu1BNUReHvESMyXHDrqgVCpNbjbpmBqxzdomI7IUmFebgVcvPQ/2RJNRdAinMEclxFpi5jpSAFF+2ofa5B4yLe1DhpwwzSsn/DyAIGm6KSWlk9ShrIb8gRc5S2H1HddOQpJ+krS41pmo0P6bUZM0nlOT3FcvoA754T7mcXcbK/0jGh4rESVGpwHM8sfPL04NSu8gNs4Tv4llJ0NTm7+zymggdRLqAfGbb3NcmYqxwKVFSjew0jXjWtHFyQkrlWjr9AL90rFditVTPmE8CihyzTbjKLXJC7mYOCWg99h6RLAUZuDk9qC+WxQGnq4Jfmvs4P3RYRtA6WzTx7QZ2Fvlg6D3qO5tGwSpLFSDjPPMo/niUEo2uVg0r0Ww5B/zlxRLGkK3ysHXp8YmzJeoWv1d2apkabKqI5QhrlLWYnPNpVFobEFG2KNITB7CvgwzRfZ9V/s0HjLUUqQin70hlEnWJkp42Ag7GM2rpm/EHAw8bOLErpC7Xc4iIsO0ozW3AWc4yKSWoFy4Q/ogOj/JCZVEjos11QtF2933lAaQRMYP7aYVHtUeiKI9h1J7SfBhjcT+tgFEBDp3z5+g+KJk8hxcCUI8UnkCEGluzJSTJGl6Tm5W8B+WHOrFNA2J0GHGzc5e4mRvTpNeyUIT5K6Sl6Dk9KqSyOWEIUpG1Hw25IgwxVNIQpwwxHjPxos85dvwayXere5xQjiaqyueGZtinFSi+9+4ZP8MLW3Ofdwqn6CG9vGozLuMCuI6LmjR2elDjuUXDbtVTYp7qA8QTpgQDLUhE+nXk1RXz4FnnBnMS5L9E9XQPH9YtZMjTk0wmdtqSig5Sd9q5eQ8IaTsVIj7JVBl3kiFmkgoqZSYTpxfg+kZFHrFi4ge/zl9Fh3L7CipDhSyRANQ0ntn/7Pq0ObMCdbjkJkBkg64en1Llsljah1MkaX1eiJaBl2hHFZPKOuJN27VuQbK0DKNepAj0yLvUtJCbZeG3tA1aPpZ0yyULDjLKDzeyCPPZjLHolwoPrciM3vKjlYfVUa+uUKGvUCu7HCnasp5y5GP4kR1dJRDDjceBasyqKLagcDdfPZxTmA5q/pS9VsP1Ws24ZPMd8W+RJAWaEbq/hoUviIdnxA9C8S1yBjKJKzMnRjeaN4iJmnOAbVOGWjVJA8CSO3yU3tBI/SGTphxQH1ocgfS5EI4D6N7wCVmjFm4BDGI8PKAypLKP0Nim8xqGs9qA9F8KjRg2s6lqBCytCYhWoWC/pRNCaoWUZRRnznzyFyJ/jU59NyNZdubqEmjVCa0XkI9H1Fu1z3wCoFMbIpGlMOGSIST28e5OzBytlk3aFq4yMDGfJdIq24E+xpX2jdFM+mByaak1MkzmMXEcyb7QZ3dnt5Hu3A1KLIKE4fSwNfyymWIfMYynVtdE4o6Uq4DxfIdEemS9/MWBVNmO6nnblBkqAQjqEATtlfyC4E+CYsV7HPgSxel6PABiydm+vO5NGrJ8rTbdcxePihRsh25YdQCpJxP4gFBDc0vUrbG2pS2MGl5kJKlfHFUY1ltYjJT+cUGGdWSTXTNez1NT1lnqxACJrqa9EYD3FU7HQz0VsYv2z91JBk7ad7YaRu1exyEfO7mMYwj4zeToz4vm0+UMDGPoNPss/kdiXPAaNstkT49vsgykzoH0lYw46iLMHjz8CbiCnVi90q6MJo/cnFokhJfkI46TKJ0VlKVy1loHA2tZ0lCSyoKWo6GDLdq9sZwjuIV5nsKHzErbsWq+rJz62b1kODE7sET0qfzgYUT8xM+HYp6NWmdDVdN7ySSMdhXLGmZScobhj5ftCQjQv/Z2U5MShlOtrI+zUeNt8vI6rc9ugZ3qprOXtc0uNVviFn7KdflNmgnoU0D5KLl4b7PYcJJHD30Lstl5boNwWsq4FSWE85Dn9LwYD7vNP7adkUz4XIuC87rnEGQC5EfGjn2j0lCee5+600DobBdesjMo29XbW0tqZemaRNpVNCFlf7JY+3cp8N/YBZ127tt87pRnd01y2YuwF5JhNhWkyZe7jpqrzmPnEWs8prkHMJBySsk8m+mnQQ+ZFDRmT1tqYH82cbiXIbza84Ca5gsaFnvkwhNP8NUqIrQ7bZAzkKeTX4x1S2zIAYdbjMB06vIUDajbKzKkFRsgoT8OeSl2G7h1AT1eKuINs+gIJOL1TDvPE9m6eYdDbRziNG57MCPXkDT2xv0aeQOqWyJFhTsihAvyKl7tyRyZoAZPV/prkMhafNMaUFM0J3t9/SksjeShMyKn4/cXktTGOiEkY5RJRo/tSI9Y6e4+0miFJgzuk8jUtRIZnAZ/evchMQIJh5sNnMn0GSTpYs07FqR2X5MnAI5hA2Rb9J1Qr/OMlpUgzWxab6tQAvOavjtULb/E2AAMpcohzMuxlcAAAAASUVORK5CYII=';
        return image;
    }

    

}

