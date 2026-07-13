// ThreeRenderer — lightweight 3D projection for the shared Scene. It uses generated GLB avatars
// when available and falls back to low-poly pieces so the mode remains usable during asset work.
(function (root) {
    'use strict';

    function colorNum(hex) { return parseInt(String(hex || '#9aa4b2').replace('#', ''), 16) || 0x9aa4b2; }
    function tintForVisual(visual, fallback) {
        if (root.RK && RK.avatarVisuals && RK.avatarVisuals.tintColorFor) {
            return RK.avatarVisuals.tintColorFor(visual && visual.appearance, fallback);
        }
        return fallback || null;
    }

    function ThreeRenderer(host, opts) {
        opts = opts || {};
        if (!root.RK || !RK.THREE || !RK.THREE.THREE) throw new Error('THREE not loaded');
        this.name = '3d';
        this.host = host;
        this.THREE = RK.THREE.THREE;
        this.GLTFLoader = RK.THREE.GLTFLoader;
        this.models = {};
        this.mixers = [];
        this.entities = {};
        this.last = {};
        this._sizeKey = null;
        this._init();
    }

    ThreeRenderer.prototype._init = function () {
        var T = this.THREE;
        this.scene = new T.Scene();
        this.scene.background = new T.Color(0x0a0c0f);
        this.camera = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
        this.camera.position.set(8, 9, 8);
        this.camera.lookAt(0, 0, 0);
        this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        this.renderer.domElement.className = 'rk-canvas';
        this.renderer.setPixelRatio(Math.min(2, root.devicePixelRatio || 1));
        this.host.appendChild(this.renderer.domElement);

        var hemi = new T.HemisphereLight(0xfff3d2, 0x283044, 2.1);
        this.scene.add(hemi);
        var key = new T.DirectionalLight(0xffffff, 1.6);
        key.position.set(6, 10, 5);
        this.scene.add(key);
        this.world = new T.Group();
        this.scene.add(this.world);
        this.clock = new T.Clock();
        var self = this;
        this._raf = requestAnimationFrame(function tick() { self._animate(); self._raf = requestAnimationFrame(tick); });
    };

    // Fill the host and frame a fixed "screenful" around the player. The camera FOLLOWS the player
    // (see _animate) instead of framing the whole level, so 3D behaves like the other modes. Only
    // does work when the host size actually changed (cheap to call every frame).
    ThreeRenderer.prototype._fitToHost = function () {
        var host = this.host;
        var w = (host && (host.clientWidth || host.offsetWidth)) || 640;
        var h = (host && (host.clientHeight || host.offsetHeight)) || 400;
        if (w === this._cw && h === this._ch) return;
        this._cw = w; this._ch = h;
        this.renderer.setSize(w, h, true); // updateStyle:true → the canvas CSS-fills the host
        var aspect = w / h, span = 8; // fixed zoom = a screenful around the player
        this.camera.left = -span * aspect;
        this.camera.right = span * aspect;
        this.camera.top = span;
        this.camera.bottom = -span;
        this.camera.updateProjectionMatrix();
    };

    ThreeRenderer.prototype._mat = function (hex) {
        var T = this.THREE;
        return new T.MeshStandardMaterial({ color: colorNum(hex), roughness: 0.82, metalness: 0.02 });
    };

    ThreeRenderer.prototype._buildTiles = function (scene) {
        var T = this.THREE;
        this.world.clear();
        this.tileLayer = new T.Group();
        this.entityLayer = new T.Group();
        this.world.add(this.tileLayer, this.entityLayer);
        var cx = (scene.cols - 1) / 2, cz = (scene.rows - 1) / 2;
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                var kind = scene.grid[y][x];
                var def = scene.legend[kind] || {};
                var h = kind === 'wall' ? 0.9 : (kind === 'bar' ? 0.42 : (kind === 'table' ? 0.28 : 0.08));
                var geom = new T.BoxGeometry(kind === 'wall' ? 1 : 0.96, h, kind === 'wall' ? 1 : 0.96);
                var mesh = new T.Mesh(geom, this._mat(kind === 'floor' ? '#4f4a3e' : (def.color || '#333333')));
                mesh.position.set(x - cx, h / 2 - 0.05, y - cz);
                this.tileLayer.add(mesh);
            }
        }
        this.world.position.set(0, 0, 0);
    };

    ThreeRenderer.prototype._fallbackAvatar = function (e, visual) {
        var T = this.THREE;
        var g = new T.Group();
        var body = new T.Mesh(new T.CapsuleGeometry(0.44, 1.18, 4, 12), this._mat(tintForVisual(visual, e.color || '#9aa4b2')));
        body.position.y = 1.0;
        g.add(body);
        var face = new T.Mesh(new T.BoxGeometry(0.22, 0.12, 0.06), this._mat('#0a0c0f'));
        face.position.set(0, 1.32, 0.44);
        g.add(face);
        return g;
    };

    ThreeRenderer.prototype._applyModelTint = function (model, visual) {
        var tint = tintForVisual(visual, null);
        if (!tint || !model) return;
        var T = this.THREE;
        var color = new T.Color(colorNum(tint));
        model.traverse(function (obj) {
            if (!obj.isMesh || !obj.material) return;
            var materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            var next = materials.map(function (mat) {
                if (!mat || !mat.color) return mat;
                var copy = mat.clone();
                copy.color.copy(color);
                return copy;
            });
            obj.material = Array.isArray(obj.material) ? next : next[0];
        });
    };

    ThreeRenderer.prototype._fitModel = function (model) {
        var T = this.THREE;
        var wrapper = new T.Group();
        model.updateMatrixWorld(true);
        var box = new T.Box3();
        var foundMesh = false;
        model.traverse(function (obj) {
            if (!obj.isMesh || !obj.geometry) return;
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            var meshBox = obj.geometry.boundingBox.clone();
            meshBox.applyMatrix4(obj.matrixWorld);
            box.union(meshBox);
            foundMesh = true;
        });
        if (!foundMesh) box.setFromObject(model);
        var size = new T.Vector3();
        var center = new T.Vector3();
        box.getSize(size);
        box.getCenter(center);
        var maxDim = Math.max(size.x, size.y, size.z) || 1;
        var scale = 5.0 / maxDim;
        model.position.set(-center.x, -box.min.y, -center.z);
        wrapper.scale.setScalar(scale);
        wrapper.add(model);
        return wrapper;
    };

    ThreeRenderer.prototype._loadModel = function (resolved, cb) {
        if (!resolved || !resolved.model || !resolved.model.url || !this.GLTFLoader) { cb(null); return; }
        var url = resolved.model.url;
        if (this.models[url]) {
            if (this.models[url].ready) cb(this.models[url]);
            else this.models[url].cbs.push(cb);
            return;
        }
        var rec = this.models[url] = { ready: false, cbs: [cb] };
        var loader = new this.GLTFLoader();
        loader.load(url, function (gltf) {
            rec.ready = true;
            rec.gltf = gltf;
            var cbs = rec.cbs; rec.cbs = [];
            cbs.forEach(function (fn) { fn(rec); });
        }, null, function () {
            rec.ready = true;
            rec.error = true;
            var cbs = rec.cbs; rec.cbs = [];
            cbs.forEach(function (fn) { fn(null); });
        });
    };

    ThreeRenderer.prototype._playAction = function (shell, name) {
        if (!shell || !shell._actions || shell._activeActionName === name) return;
        var next = shell._actions[name] || shell._actions[Object.keys(shell._actions)[0]];
        if (!next) return;
        if (shell._activeAction && shell._activeAction !== next) shell._activeAction.fadeOut(0.12);
        next.reset().fadeIn(0.12).play();
        shell._activeAction = next;
        shell._activeActionName = name;
    };

    ThreeRenderer.prototype._visualFor = function (e) {
        var appearance = (e && e.appearance) || { avatar: (e && e.avatar) || 'default' };
        if (root.RK && RK.avatarVisuals && RK.avatarVisuals.resolve) {
            return RK.avatarVisuals.resolve(appearance, { projection: '3d', context: 'tavern', entity: e });
        }
        if (root.RK && RK.resolveAppearance) return RK.resolveAppearance(e, '3d');
        return null;
    };

    ThreeRenderer.prototype._makeEntity = function (e) {
        var T = this.THREE, self = this;
        var shell = new T.Group();
        var visual = this._visualFor(e);
        shell._body = this._fallbackAvatar(e, visual);
        shell.add(shell._body);
        if (visual && visual.allowed !== false && visual.model) {
            this._loadModel(visual, function (rec) {
                if (!rec || !rec.gltf || !shell.parent) return;
                var model = rec.gltf.scene.clone(true);
                self._applyModelTint(model, visual);
                model.rotation.y = Math.PI;
                var fitted = self._fitModel(model);
                shell.add(fitted);
                shell._model = fitted;
                if (rec.gltf.animations && rec.gltf.animations.length) {
                    var mixer = new T.AnimationMixer(model);
                    shell._mixer = mixer;
                    shell._actions = {};
                    rec.gltf.animations.forEach(function (clip) {
                        shell._actions[String(clip.name).toLowerCase()] = mixer.clipAction(clip);
                    });
                    self._playAction(shell, 'idle');
                    self.mixers.push(mixer);
                }
            });
        }
        return shell;
    };

    ThreeRenderer.prototype.render = function (scene) {
        if (!scene || !this.renderer) return;
        this._fitToHost();
        var key = scene.cols + 'x' + scene.rows + ':' + scene.grid.map(function (r) { return r.join(''); }).join('/');
        if (key !== this._sizeKey) {
            this._buildTiles(scene);
            this._sizeKey = key;
        }
        var seen = {}, cx = (scene.cols - 1) / 2, cz = (scene.rows - 1) / 2;
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i], id = e.id;
            seen[id] = true;
            var ent = this.entities[id];
            if (!ent) {
                ent = this.entities[id] = { obj: this._makeEntity(e), x: e.x, y: e.y };
                this.entityLayer.add(ent.obj);
            }
            ent.e = e;
            ent.tx = e.x - cx;
            ent.tz = e.y - cz;
        }
        for (id in this.entities) {
            if (!seen[id]) {
                this.entityLayer.remove(this.entities[id].obj);
                delete this.entities[id];
            }
        }
    };

    ThreeRenderer.prototype._animate = function () {
        if (!this.renderer) return;
        var dt = this.clock.getDelta();
        var now = Date.now();
        for (var i = 0; i < this.mixers.length; i++) this.mixers[i].update(dt);
        for (var id in this.entities) {
            var ent = this.entities[id], o = ent.obj;
            var dx = (ent.tx || 0) - o.position.x;
            var dz = (ent.tz || 0) - o.position.z;
            var moving = Math.abs(dx) + Math.abs(dz) > 0.025;
            o.position.x += dx * 0.18;
            o.position.z += dz * 0.18;
            o.position.y = moving
                ? Math.abs(Math.sin(now / 95)) * 0.08
                : Math.sin(now / 620) * 0.018;
            if (o._body) {
                o._body.rotation.z = moving ? Math.sin(now / 120) * 0.055 : 0;
            }
            if (o._model) {
                o._model.rotation.z = moving ? Math.sin(now / 120) * 0.045 : 0;
            }
            this._playAction(o, moving ? 'run' : 'idle');
            if (ent.e && ent.e.facing) {
                var r = ent.e.facing === 'up' ? Math.PI : ent.e.facing === 'left' ? -Math.PI / 2 : ent.e.facing === 'right' ? Math.PI / 2 : 0;
                o.rotation.y += (r - o.rotation.y) * 0.18;
            }
        }

        // Player-follow camera: keep the fixed iso offset (8,9,8) but re-target the player's world
        // position each frame. The player mesh itself lerps, so the camera glides smoothly with it.
        this._fitToHost(); // pick up any host resize
        var pcam = null;
        for (var pid in this.entities) {
            var pen = this.entities[pid];
            if (pen.e && (pen.e.you || pen.e.kind === 'player')) { pcam = pen.obj; break; }
        }
        if (pcam) {
            this.camera.position.set(pcam.position.x + 8, 9, pcam.position.z + 8);
            this.camera.lookAt(pcam.position.x, 0, pcam.position.z);
        }
        this.renderer.render(this.scene, this.camera);
    };

    ThreeRenderer.prototype.destroy = function () {
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this.renderer) {
            if (this.renderer.domElement && this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            this.renderer.dispose();
        }
        this.renderer = null;
        this.entities = {};
        this.models = {};
        this.mixers = [];
    };

    root.RK = root.RK || {};
    root.RK.ThreeRenderer = ThreeRenderer;
})(window);
