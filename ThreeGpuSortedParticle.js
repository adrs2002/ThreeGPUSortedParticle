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
    constructor(_renderer, _oneLine, _colArray, _gravity) {
        super();

        // 2の累乗チェック
        let m =0;
        while (!(Math.pow(2, m) <= _oneLine && _oneLine < Math.pow(2, m + 1))){
            m++;
        }

        _oneLine = Math.pow(2, m);
        this.oneLineWidth = _oneLine ? _oneLine: 256;
        this.oneLineHeight = _oneLine ? _oneLine: 128;
        if(( /(iPad|iPhone|iPod)/g.test( navigator.userAgent ) ) ){
            this.oneLineWidth = Math.min(this.oneLineWidth, 32);
            this.oneLineHeight = Math.min(this.oneLineWidth, 32);
        } else {
            this.oneLineWidth = Math.min(this.oneLineWidth, 256);
            this.oneLineHeight = Math.min(this.oneLineWidth, 128);
        }

        this.particleCount = this.oneLineWidth * this.oneLineHeight;

        this.gravity = _gravity? _gravity : new THREE.Vector3();

        this.activedCount = 0;
        this.isAddLoopded = false;
        
        this.dataTexture = this._createDataTexture();
        this.dataArray = this.dataTexture.image.data;

        this.dataTexture2 = this._createDataTexture();
        this.dataArray2 = this.dataTexture2.image.data;

        this.dataTexture3 = this._createDataTexture();
        this.dataArray3 = this.dataTexture3.image.data;

        this.dataTexture4 = this._createDataTexture();
        this.dataArray4 = this.dataTexture4.image.data;


        this.colArray = _colArray ? _colArray :  [new THREE.Vector4(1.0, 0.9, 0.5, 0.8), new THREE.Vector4(0.8, 0.2, 0.0, 0.5), new THREE.Vector4(0.2, 0.0, 0.0, 0.0),
                                                  new THREE.Vector4(0.8, 1.0, 1.0, 0.5), new THREE.Vector4(0.0, 0.4, 0.8, 0.5), new THREE.Vector4(0.0, 0.0, 0.4, 0.0),
                                                  new THREE.Vector4(0.75, 0.75, 0.73, 0.2), new THREE.Vector4(0.6, 0.6, 0.7, 0.1), new THREE.Vector4(0.9, 0.9, 0.9, 0.0)
                                                ];
        
        const noizeImage = this._createNozieFrom64()
        this.noiseTexture = new THREE.Texture();
        this.noiseTexture.image = noizeImage;
        noizeImage.onload = () => {
            this.noiseTexture.wrapS = THREE.RepeatWrapping;
            this.noiseTexture.wrapT = THREE.RepeatWrapping;
            this.noiseTexture.repeat.set(10, 10);
            this.noiseTexture.needsUpdate = true;
        };

        this.blankQue = [];

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                map: { value: this.noiseTexture },
                dataMap: { value: this.dataTexture },
                dataMap2: { value: this.dataTexture2 },
                dataMap3: { value: this.dataTexture3 },
                dataMap4: { value: this.dataTexture4 },
                gravity : { type:"v3", value : this.gravity },
                sortMap: { value: null },
                colors: { type: "v4v",  value: this.colArray}
            },
            vertexShader: this._getParticleDrawVshader(),
            fragmentShader: this._getParticleDrawFshader(this.colArray.length / 3),
            depthTest: true,
            depthWrite: false,
            transparent: true,
            depthFunc: THREE.LessEqualDepth,
            blending:  THREE.NormalBlending
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

        this.localClocl = new THREE.Clock();
        
        return this;
    }

    /** 
     * 初期位置用（ソートの邪魔をしないように）、めっちゃ遠い位置にパーティクルを移動しておく
    */
    _getFarPosition(){
        return new THREE.Vector3(65535 - Math.random() * 100 , -65535 - Math.random() * 100 , 65535  - Math.random() * 100 );
    }

    _createDataTexture(){
        const texture = new THREE.DataTexture( new Float32Array( this.oneLineWidth * this.oneLineHeight * 4), this.oneLineWidth, this.oneLineHeight, THREE.RGBAFormat, THREE.FloatType );      
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
		texture.needsUpdate = true;
        texture.generateMipmaps = false;
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
        for ( let j = 0; j < this.oneLineHeight; j++ ) {
            for ( let i = 0; i < this.oneLineWidth; i++ ) {
                this.idUvArray[ p++ ] = i / ( this.oneLineWidth - 1 );
                this.idUvArray[ p++ ] = j / ( this.oneLineHeight - 1 );
            }
        }

        this.preRenderScene =  new THREE.Scene();
        this.sortScene = new THREE.Scene();
        this.sortCam = new THREE.Camera();
        this.lastUseRt = null;

        // const ext = _renderer.context.getExtension('WEBGL_color_buffer_float');
        this.rt1 = new THREE.WebGLRenderTarget( this.oneLineWidth,  this.oneLineHeight, {
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
            type: ( /(iPad|iPhone|iPod)/g.test( navigator.userAgent ) ) ? THREE.HalfFloatType : THREE.FloatType,
            wrapS :THREE.ClampToEdgeWrapping , // なんで RepeatWrapping からClampToEdgeWrappingに変えたら正しく動いたのだろう…
            wrapT :THREE.ClampToEdgeWrapping ,
            stencilBuffer: false
        });
        this.rt2 = new THREE.WebGLRenderTarget( this.oneLineWidth,  this.oneLineHeight, {
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
            type: ( /(iPad|iPhone|iPod)/g.test( navigator.userAgent ) ) ? THREE.HalfFloatType : THREE.FloatType,
            wrapS : THREE.ClampToEdgeWrapping ,
            wrapT : THREE.ClampToEdgeWrapping ,
            stencilBuffer: false
        });
        this.rtSwitch = true;


        this.preRenderMaterial = new THREE.RawShaderMaterial({
            uniforms: {
                dataMap: { type: "t", value: this.dataTexture },
                dataMap2: { type: "t", value: this.dataTexture2 },
                dataMap3: { type: "t", value: this.dataTexture3 },
                gravity : { type:"v3", value : this.gravity },
                modelViewM: { type: "fv1", value: null },
                projectionM: { type: "fv1", value: null }
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

    /**********************************/

    setPosition(_id, _pos){
        this.dataArray[_id * 4 + 0] = _pos.x;
        this.dataArray[_id * 4 + 1] = _pos.y;
        this.dataArray[_id * 4 + 2] = _pos.z;
    }

    setDulTime(_id, _dul){
        this.dataArray[_id * 4 + 3] = _dul;
    }

    getDulTime(_id){
        return this.dataArray[_id * 4 + 3];
    }    

    addDulTime(_id, _dul){
        this.dataArray[_id * 4 + 3] += _dul * this.getTimeFactor(_id);
    }

    /////////////////

    setVector(_id, _vec){
        this.dataArray2[_id * 4 + 0] = _vec.x;
        this.dataArray2[_id * 4 + 1] = _vec.y;
        this.dataArray2[_id * 4 + 2] = _vec.z;
    }

    getSpeed(_id){
        return this.dataArray2[_id * 4 + 3];
    }

    setSpeed(_id, _speed){
        this.dataArray2[_id * 4 + 3] = _speed;
    }

    /////////////////

    setUseCol(_id, _ptn){
        this.dataArray3[_id * 4 + 0] = _ptn;
    }

    setScale(_id, _scale){
        this.dataArray3[_id * 4 + 1] = _scale;
    }

    setSpeedGamma(_id, _f){
        this.dataArray3[_id * 4 + 2] = _f;
    }

    setBlur(_id, _blur){
        this.dataArray3[_id * 4 + 3] = _blur;
    }

    getBlur(_id){
        return this.dataArray3[_id * 4 + 3];
    }

    /////////////// 

    setTimeFactor(_id, _life){
        this.dataArray4[_id * 4 + 0] = _life;
    }

    getTimeFactor(_id){
       return this.dataArray4[_id * 4 + 0];
    }

    setColorGamma(_id, _f){
        this.dataArray4[_id * 4 + 1] = _f;
    }

    setImageGamma(_id, _f){
        this.dataArray4[_id * 4 + 2] = _f;
    }

    ///////////////////

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
            speedGamma = 3.5,
            lifeTimeFactor = Math.random()* 0.75 + 0.5,
            blur = 0.15,
            colorGamma = 1.0,
            imageGamma = 0.4
        } = _option;

        this.setDulTime(i, 1.0);
        if(lifeTimeFactor === 0){ this.setDulTime(i, 1.1);}
        this.setPosition(i, basePos);
        this.setScale(i, scale + (Math.random() - 0.5) * scaleRandom);                

        //移動方向を決める
        if (explose > 0.0) {
            const l_v = new THREE.Vector3().copy(vect);
            const addV = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            l_v.lerp(addV, explose);            
            this.setVector(i, l_v);
        } else {            
            this.setVector(i, vect);
        }
        this.setSpeed(i, speed);

        this.setSpeedGamma(i, speedGamma);

        this.setTimeFactor(i, lifeTimeFactor);
        
        this.setUseCol(i, colId);

        this.setBlur(i, blur);

        this.setColorGamma(i, colorGamma);

        this.setImageGamma(i, imageGamma);
    }

    /** 
     * パーティクルのアップデート。
     * 必ず手動で呼ぶ必要がある。
     */
    updater() {
        // 1粒毎のアップデート
        const delta = this.localClocl.getDelta();
        for (let i = 0; this.isAddLoopded ? i < this.particleCount: i < this.activedCount; i++) {
            if (this.getDulTime(i) > 0.0) {
                this.addDulTime(i, delta);
                // オプション挙動サンプル。Blurの値を、時間経過とともに下げる
                // this.setBlur(i, this.getBlur(i) * Math.min((1.0 - (this.getDulTime(i) - 1.0) ) * 1.5, 0.98) );
                this.setBlur(i, this.getBlur(i) * 0.98 );

                if (this.getDulTime(i) >= 2.0) {
                    //1秒経過していたら、消滅させる。
                    this.setDulTime(i, 0.0);
                    this.setScale(i, 0.0);
                    this.blankQue.push(i);
                }
            }
        }

        this.dataTexture.needsUpdate = true;
        this.dataTexture2.needsUpdate = true;
        this.dataTexture3.needsUpdate = true;
        this.dataTexture4.needsUpdate = true;
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
        
        this.lastUseRt = null;
        
        // step1 現在の位置を、ソート用のデータテクスチャに入れるための事前描画を行う        
        this.preRenderMaterial.uniforms.modelViewM.value = _camera.matrixWorldInverse.elements;    
        this.preRenderMaterial.uniforms.projectionM.value = _camera.projectionMatrix.elements;
        this.preRenderMaterial.needsUpdate = true;
        this.lastUseRt = this.rt1;
        _renderer.render(this.preRenderScene, this.sortCam, this.lastUseRt);

        // step2 作成したデータテクスチャを使い、ソートする
        // thanks to: http://t-pot.com/program/90_BitonicSort/index.html
        const pow = Math.log2(this.oneLineHeight * this.oneLineWidth);
        for(let i =0; i < this.oneLineHeight * this.oneLineWidth ;i++) {
            
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

        this.material.uniforms.sortMap.value = this.lastUseRt.texture;

    }

    //////////////////////

    /**
     * シェーダーの共通ロジック：移動後の位置の算出
     */
    _makeFunc_VPos() {
        return `        
        vec4 getModelViewPosition (mat4 mvM, vec4 valPos,vec4 valVec,vec4 valEx1,float timeF ) {
            // 位置を算出
            vec3 movePow =  vec3(valVec.xyz) * (pow(timeF, 1.0 / valEx1.z) * valVec.w);
            return mvM * vec4( valPos.xyz + movePow.xyz, 1.0 );
        }        
        `;
    }

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

        #define sortResolution vec2( ${this.oneLineWidth}.0, ${this.oneLineHeight}.0 )

        uniform vec3 gravity;
        uniform sampler2D map;
        uniform sampler2D dataMap;
        uniform sampler2D dataMap2;
        uniform sampler2D dataMap3;
        uniform sampler2D dataMap4;
        uniform sampler2D sortMap;

        attribute vec2 idUv;

        varying vec2 vUv;
        varying vec2 vUv2;
        varying float vColId;
        varying float vTime;
        varying float vColGamma;
        varying float vBaseImageGamma;

        ${this._makeFunc_VPos()}

        void main() {

            // ソート後のIDを取得する
            vec4 sortVal = texture2D( sortMap, idUv );

            // ID位置にある位置情報その他を取得する
            vec2 indexUv = vec2(sortVal.x, sortVal.y);

            // 位置取得
            vec4 valPos = texture2D( dataMap, indexUv);
            vec4 valVec = texture2D( dataMap2, indexUv);
            vec4 valEx1 = texture2D( dataMap3, indexUv);
            vec4 valEx2 = texture2D( dataMap4, indexUv);

            float timeF = max(0.0, valPos.w - 1.0);

            // 算出したＩＤ用ＵＶを、テクスチャのＵＶ変異にも使用
            vUv2 = uv * valEx1.y * 0.5 + vec2(indexUv.x, indexUv.y);

            vec4 mvPosition = getModelViewPosition(modelViewMatrix,valPos,valVec,valEx1,timeF );

            vec3 vertexPos =  position * (valEx1.y +  timeF);    
            vec4 mvVector = vec4(mvPosition.xyz + vertexPos, 1.0);

            vec4 noVectPos =  modelViewMatrix * vec4( valPos.xyz , 1.0 );
            
            // ビルボードに対して方向ブラーを適用する仕組み。あんまり根拠ないけど動いてるからヨシ
            vec4 pass1Pos = projectionMatrix * mvPosition;  // P
            vec4 pass2Pos = projectionMatrix * mvVector;   // B
            vec4 pass0Pos = projectionMatrix * noVectPos;   // A

            vec3 BA = pass2Pos.xyz - pass0Pos.xyz;
            vec3 PA = pass1Pos.xyz - pass0Pos.xyz;
            vec3 Badd = pass2Pos.xyz - pass1Pos.xyz;
            float f = max(0.0, length(BA) - length(PA));
            f = mix(1.0,f,valEx1.w);

            gl_Position = vec4( mix(pass0Pos.x, pass2Pos.x +  Badd.x, f), 
                                mix(pass0Pos.y, pass2Pos.y +  Badd.y, f),
                                mix(pass0Pos.z, pass2Pos.z +  Badd.z, f), 
                                mix(pass0Pos.w, pass2Pos.w, f));

            vUv2 = vUv2 + uv * valPos.w * 0.2;
            vUv = uv;
            vTime = timeF;
            vColId = valEx1.x;
            vColGamma = valEx2.y;
            vBaseImageGamma = valEx2.z;
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
        uniform sampler2D dataMap2;
        uniform vec4 colors[${_colCount * 3}]; 

        varying vec2 vUv;
        varying vec2 vUv2;
        varying float vTime;
        varying float vColId;
        varying float vColGamma;
        varying float vBaseImageGamma;

        vec4 getIdCol(float _id, int _add){
            ${this._makeColFunction(_colCount)}
            return colors[0];
        }

        void main() {
            if(vTime < 0.01){ discard; }
                
            vec4 texColor = texture2D( map, vUv2 );
            
            float uvDist = length(vUv - 0.5) * 2.5;

            float f = abs(texColor.x - 0.5) + 0.5;
            
            // テクスチャの色をガンマ補正
            f = abs(f - vBaseImageGamma) / vBaseImageGamma * (1.0 / vBaseImageGamma);
             
            texColor = vec4(f);
            
            gl_FragColor = texColor * mix(mix( getIdCol(vColId, 0 ), getIdCol(vColId, 1 ), uvDist) , getIdCol(vColId, 2 ),  pow(vTime, 1.0 / vColGamma));    
        
            // 明るいところの透明度を上げる
            gl_FragColor.a = max(length(gl_FragColor.rgb) * gl_FragColor.a, gl_FragColor.a);

            // 開始時は透明～徐々に出現させるしくみ
            if(vTime < 0.1){
                gl_FragColor.a *= vTime * 9.0;
            } 

            // 中央から離れるにつれ透明度が下がるようにする仕組み & 開始後の、時間経過とともに透明になる仕組み
            gl_FragColor.a *= max((1.0 - uvDist), 0.0) * ( 1.0 - vTime);

            //gl_FragColor = texColor;
        }
        
        `;
    }

    /***************************************************/
    /***************************************************/
    /*********** GPU SORTING  **************************/
    /***thanks to :  http://t-pot.com/program/90_BitonicSort/index.html ***/
    /***************************************************/
    /***************************************************/

    /**
     * ソート前の位置計算算出シェーダー
     */
    
    _getPreRendShader() {
        return `
        
        #define resolution vec2( ${this.oneLineWidth}.0, ${this.oneLineHeight}.0 )

        precision mediump float;
        uniform sampler2D dataMap;
        uniform sampler2D dataMap2;
        uniform sampler2D dataMap3;

        uniform vec3 gravity;

        uniform float modelViewM[ 16 ];
        uniform float projectionM[ 16 ];

        // mat4 を直接 uniform で渡すと、なぜか動かん！なんでじゃ！！
        // 仕方がないので、float配列で渡して、mat4にシェーダ側で変換している。動くんだけど、びみょー
        mat4 getModelViewM(){
            mat4 ref;
            ref[0][0] = modelViewM[0];
            ref[0][1] = modelViewM[1];
            ref[0][2] = modelViewM[2];
            ref[0][3] = modelViewM[3];

            ref[1][0] = modelViewM[4];
            ref[1][1] = modelViewM[5];
            ref[1][2] = modelViewM[6];
            ref[1][3] = modelViewM[7];

            ref[2][0] = modelViewM[8];
            ref[2][1] = modelViewM[9];
            ref[2][2] = modelViewM[10];
            ref[2][3] = modelViewM[11];

            ref[3][0] = modelViewM[12];
            ref[3][1] = modelViewM[13];
            ref[3][2] = modelViewM[14];
            ref[3][3] = modelViewM[15];

            return ref;
        }

        mat4 getProjectionM(){
            mat4 ref;
            ref[0][0] = projectionM[0];
            ref[0][1] = projectionM[1];
            ref[0][2] = projectionM[2];
            ref[0][3] = projectionM[3];

            ref[1][0] = projectionM[4];
            ref[1][1] = projectionM[5];
            ref[1][2] = projectionM[6];
            ref[1][3] = projectionM[7];

            ref[2][0] = projectionM[8];
            ref[2][1] = projectionM[9];
            ref[2][2] = projectionM[10];
            ref[2][3] = projectionM[11];

            ref[3][0] = projectionM[12];
            ref[3][1] = projectionM[13];
            ref[3][2] = projectionM[14];
            ref[3][3] = projectionM[15];

            return ref;
        }

        ${this._makeFunc_VPos()}

        void main() {
            vec2 uv = gl_FragCoord.xy / resolution.xy;
            vec4 valPos = texture2D( dataMap, uv);
            vec4 valVec = texture2D( dataMap2, vec2(uv.x, uv.y) );
            vec4 valEx1 = texture2D( dataMap3, vec2(uv.x, uv.y) );

            float timeF = max(0.0, valPos.w - 1.0);

            // 位置を算出する
            vec4 mvPosition = getModelViewPosition(getModelViewM(),valPos,valVec,valEx1,timeF );

            // 画面に出す座標系にする
            vec4 pass1Pos = getProjectionM() * mvPosition; 

            // テクスチャに出力
            gl_FragColor = vec4(uv.x, uv.y,  (pass1Pos.z * 1000.0 - 1000.0) / length(resolution) * 0.01, 1.0);

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
        #define resolution vec2( ${this.oneLineWidth}.0, ${this.oneLineHeight}.0 )

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
        
            // 同じ距離はありえる、という想定
            if (val0.z == val1.z){
                gl_FragColor = val0;
            } else {

                vec4 cmin = (val0.z < val1.z) ? val0: val1;
                vec4 cmax = (val0.z < val1.z) ? val1: val0;

                // 遠い順から表示したいので、昇順にする
                gl_FragColor = (csign == cdir) ? cmax : cmin;
    
            }

        }

        `;
    }
 
    /** 
     * フラクタルなノイズ画像のBase64。雲模様ってやつ。
    */
    _createNozieFrom64() {
        const image = new Image();
        image.src = 'data:image/png;base64,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';
        return image;
    }

    

}

