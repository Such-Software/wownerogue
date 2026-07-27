// ThreeRenderer: a lit, textured 3D projection of the shared Scene. It uses GLB avatars when
// available and falls back to low-poly pieces so the mode stays usable without them.
//
// The level is drawn with three InstancedMeshes (walls / ground / props) so a 70x35 dungeon costs
// three draw calls instead of ~2500 individual meshes, and per-instance colour carries the same
// fog-of-war brightness the 2D modes use. Textures are generated on a canvas at startup: no new
// asset downloads, nothing for the CSP to block, and the walls read as stone instead of flat boxes.
(function (root) {
    'use strict';

    function colorNum(hex) { return parseInt(String(hex || '#9aa4b2').replace('#', ''), 16) || 0x9aa4b2; }
    function tintForVisual(visual, fallback) {
        if (root.RK && RK.avatarVisuals && RK.avatarVisuals.tintColorFor) {
            return RK.avatarVisuals.tintColorFor(visual && visual.appearance, fallback);
        }
        return fallback || null;
    }

    // Deterministic PRNG: generated textures are byte-identical every session, so the dungeon
    // does not subtly re-skin itself on reload.
    function lcg(seed) {
        var s = seed >>> 0;
        return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }

    function makeCanvas(size, paint) {
        var cv = root.document.createElement('canvas');
        cv.width = size; cv.height = size;
        paint(cv.getContext('2d'), size);
        return cv;
    }

    // Coursed stone blocks: mortar gaps, per-block value variation, a lit top edge and a shaded
    // bottom edge. The bevel is baked in so the walls have relief even at grazing light angles.
    function stoneCanvas(size) {
        return makeCanvas(size, function (c, s) {
            var rnd = lcg(0x5713);
            c.fillStyle = '#241f1a'; c.fillRect(0, 0, s, s);
            var rows = 4, h = s / rows, bw = s / 2.5;
            for (var r = 0; r < rows; r++) {
                var offset = (r % 2) * (bw / 2);
                for (var bx = -1; bx < 4; bx++) {
                    var x = bx * bw + offset, y = r * h;
                    var v = 116 + Math.floor(rnd() * 40);
                    c.fillStyle = 'rgb(' + v + ',' + (v - 7) + ',' + (v - 20) + ')';
                    c.fillRect(x + 2, y + 2, bw - 4, h - 4);
                    c.fillStyle = 'rgba(255,246,225,0.11)'; c.fillRect(x + 2, y + 2, bw - 4, 2);
                    c.fillStyle = 'rgba(0,0,0,0.26)'; c.fillRect(x + 2, y + h - 4, bw - 4, 2);
                }
            }
            for (var i = 0; i < s * 10; i++) {
                c.fillStyle = 'rgba(0,0,0,' + (rnd() * 0.18).toFixed(3) + ')';
                c.fillRect(Math.floor(rnd() * s), Math.floor(rnd() * s), 1, 1);
            }
        });
    }

    // Irregular flagstones: a broken grout grid plus grain, so a large floor never shows an
    // obvious repeat.
    function groundCanvas(size) {
        return makeCanvas(size, function (c, s) {
            var rnd = lcg(0x2f19);
            c.fillStyle = '#1d1a16'; c.fillRect(0, 0, s, s);
            var n = 4, cell = s / n;
            for (var gy = 0; gy < n; gy++) {
                for (var gx = 0; gx < n; gx++) {
                    var pad = 1.5 + rnd() * 1.5;
                    var v = 96 + Math.floor(rnd() * 34);
                    c.fillStyle = 'rgb(' + v + ',' + (v - 4) + ',' + (v - 14) + ')';
                    c.fillRect(gx * cell + pad, gy * cell + pad, cell - pad * 2, cell - pad * 2);
                    c.fillStyle = 'rgba(255,244,220,0.06)';
                    c.fillRect(gx * cell + pad, gy * cell + pad, cell - pad * 2, 1.5);
                }
            }
            for (var i = 0; i < s * 14; i++) {
                c.fillStyle = 'rgba(0,0,0,' + (rnd() * 0.2).toFixed(3) + ')';
                c.fillRect(Math.floor(rnd() * s), Math.floor(rnd() * s), 1, 1);
            }
        });
    }

    // Vertical fade for the objective beacons: bright at the floor, gone by the top. Without it the
    // beam cylinder renders as a flat uniform column that looks like a solid prop.
    function beamCanvas(h) {
        var cv = root.document.createElement('canvas');
        cv.width = 4; cv.height = h;
        var c = cv.getContext('2d');
        var g = c.createLinearGradient(0, h, 0, 0);
        g.addColorStop(0, 'rgba(255,255,255,0.85)');
        g.addColorStop(0.35, 'rgba(255,255,255,0.30)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.fillRect(0, 0, 4, h);
        return cv;
    }

    // Soft round sprite for the dust motes drifting in the torchlight.
    function moteCanvas(size) {
        return makeCanvas(size, function (c, s) {
            var g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
            g.addColorStop(0, 'rgba(255,236,196,1)');
            g.addColorStop(0.45, 'rgba(255,206,140,0.5)');
            g.addColorStop(1, 'rgba(255,190,120,0)');
            c.fillStyle = g; c.fillRect(0, 0, s, s);
        });
    }

    // Wall-family kinds occupy the full cell height; ground kinds are a thin slab; everything else
    // is a prop box sized per kind. `emissive` marks hazards/fire that glow on their own.
    var WALLISH = { wall: 1, window: 1, door: 1, archway: 1, torch: 1 };
    var GROUND = { floor: 1, floor2: 1, rug: 1, dirt: 1, entrance: 1, exit: 1, treasure: 1 };
    var PROP_HEIGHT = {
        bar: 0.52, table: 0.40, chair: 0.30, keg: 0.50, barrel: 0.50, shelf: 0.92,
        crate: 0.44, chest: 0.38, hearth: 0.30, column: 1.30,
        lava: 0.05, poison: 0.05, spikes: 0.09
    };
    var HAZARD_GLOW = { lava: 0.85, poison: 0.5, spikes: 0.12 };
    // Ground tints. The scene legend colours are tuned for flat 2D fills and read almost black in a
    // lit 3D scene, so wall/floor use material-appropriate values; everything else falls back to
    // the legend.
    var KIND_TINT = {
        wall: '#a49a8b', window: '#7d94a8', door: '#9c7a4a', archway: '#a49a8b',
        torch: '#a49a8b',
        floor: '#7a6a53', floor2: '#6a5d4b', rug: '#8a4a45', dirt: '#645540',
        entrance: '#4d7f57', exit: '#8a743c', treasure: '#7c7062',
        lava: '#ff6a2a', poison: '#4fd07a', spikes: '#9aa3ad'
    };

    function ThreeRenderer(host, opts) {
        opts = opts || {};
        if (!root.RK || !RK.THREE || !RK.THREE.THREE) throw new Error('THREE not loaded');
        this.name = '3d';
        this.host = host;
        this.THREE = RK.THREE.THREE;
        this.GLTFLoader = RK.THREE.GLTFLoader;
        this.SkeletonUtils = RK.THREE.SkeletonUtils;
        this.models = {};
        this.mixers = [];
        this.entities = {};
        this.last = {};
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.buckets = {};
        this.torchCells = [];
        this._destroyed = false;
        this._init();
    }

    ThreeRenderer.prototype._init = function () {
        var T = this.THREE;
        this.scene = new T.Scene();
        this.scene.background = new T.Color(0x000000);
        // Fog-of-war parity with the 2D modes: the camera follows the player, so distance fog fades
        // explored tiles to black away from you, and _buildTiles skips unexplored ('dark') tiles so
        // they never render. Together: unexplored = hidden, explored fades with distance, no map leak.
        // The fog band is measured from the CAMERA, which sits ~17 units back along the isometric
        // offset, not from the player. Tuning it as if it started at the player puts the player a
        // quarter of the way into fog and crushes the scene to near-black.
        this.scene.fog = new T.Fog(0x05060a, 21, 46);
        this.camera = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 120);
        this.camera.position.set(9, 11, 9);
        this.camera.lookAt(0, 0, 0);
        this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        this.renderer.domElement.className = 'rk-canvas';
        this.canvas = this.renderer.domElement;
        this.renderer.setPixelRatio(Math.min(2, root.devicePixelRatio || 1));
        if (T.SRGBColorSpace) this.renderer.outputColorSpace = T.SRGBColorSpace;
        if (T.ACESFilmicToneMapping != null) {
            this.renderer.toneMapping = T.ACESFilmicToneMapping;
            this.renderer.toneMappingExposure = 1.22;
        }
        this.renderer.shadowMap.enabled = true;
        if (T.PCFSoftShadowMap != null) this.renderer.shadowMap.type = T.PCFSoftShadowMap;
        this.host.appendChild(this.renderer.domElement);

        this._buildMaterials();

        // A dim cool ambient keeps unlit corners from going pure black; the warm key light and the
        // player's torch do the actual shaping.
        var hemi = new T.HemisphereLight(0x9fb4d8, 0x161a24, 0.5);
        this.scene.add(hemi);
        this.keyLight = new T.DirectionalLight(0xffd9a8, 2.3);
        this.keyLight.position.set(10, 8.5, 4); // low sun: long, readable wall shadows
        this.keyLight.castShadow = true;
        this.keyLight.shadow.mapSize.set(1024, 1024);
        this.keyLight.shadow.camera.near = 1;
        this.keyLight.shadow.camera.far = 46;
        this.keyLight.shadow.camera.left = -13;
        this.keyLight.shadow.camera.right = 13;
        this.keyLight.shadow.camera.top = 13;
        this.keyLight.shadow.camera.bottom = -13;
        this.keyLight.shadow.bias = -0.0015;
        this.keyLight.shadow.normalBias = 0.04;
        this.scene.add(this.keyLight);
        this.scene.add(this.keyLight.target);
        // A player-carried torch adds depth and keeps the followed avatar readable without washing
        // out the dungeon's black fog-of-war background.
        this.playerLight = new T.PointLight(0xffb35c, 4.4, 14, 2);
        this.playerLight.position.set(0, 2.6, 0);
        this.scene.add(this.playerLight);
        // A small pool of lights reassigned to whichever torches are nearest the player each frame:
        // a level can hold dozens of torches, but only a handful are ever on screen.
        this.torchLights = [];
        for (var i = 0; i < 6; i++) {
            var pl = new T.PointLight(0xff9a3c, 0, 11, 2);
            pl.visible = false;
            this.scene.add(pl);
            this.torchLights.push(pl);
        }

        this.world = new T.Group();
        this.scene.add(this.world);
        this.tileLayer = new T.Group();
        this.fixtureLayer = new T.Group();
        this.entityLayer = new T.Group();
        this.world.add(this.tileLayer);
        this.world.add(this.fixtureLayer);
        this.world.add(this.entityLayer);
        this._buildMotes();

        this.clock = new T.Clock();
        var self = this;
        this._raf = requestAnimationFrame(function tick() {
            if (self._destroyed || !self.renderer) { self._raf = null; return; }
            if (self._animate() === false) { self._raf = null; return; }
            self._raf = requestAnimationFrame(tick);
        });
    };

    ThreeRenderer.prototype._buildMaterials = function () {
        var T = this.THREE;
        function tex(canvas, repeat) {
            var t = new T.CanvasTexture(canvas);
            t.wrapS = t.wrapT = T.RepeatWrapping;
            t.repeat.set(repeat, repeat);
            t.anisotropy = 4;
            return t;
        }
        var stone = stoneCanvas(128), ground = groundCanvas(128);
        this._textures = [];
        var stoneMap = tex(stone, 1), groundMap = tex(ground, 1);
        var stoneBump = tex(stone, 1), groundBump = tex(ground, 1);
        if (T.SRGBColorSpace) { stoneMap.colorSpace = T.SRGBColorSpace; groundMap.colorSpace = T.SRGBColorSpace; }
        this._textures.push(stoneMap, groundMap, stoneBump, groundBump);

        this.wallMat = new T.MeshStandardMaterial({
            map: stoneMap, bumpMap: stoneBump, bumpScale: 0.55, roughness: 0.94, metalness: 0.02
        });
        this.groundMat = new T.MeshStandardMaterial({
            map: groundMap, bumpMap: groundBump, bumpScale: 0.35, roughness: 0.96, metalness: 0.0
        });
        this.propMat = new T.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 });
            // Hazards/fire glow on their own so they stay legible in an unlit corridor.
        this.glowMat = new T.MeshStandardMaterial({
            roughness: 0.55, metalness: 0.0, emissive: new T.Color(0xffffff), emissiveIntensity: 0.9
        });
    };

    // Dust motes drifting through the torchlight. Purely atmospheric, one draw call, and they are
    // re-centred on the player so the same 160 particles cover the whole level.
    ThreeRenderer.prototype._buildMotes = function () {
        var T = this.THREE, n = 160;
        var pos = new Float32Array(n * 3);
        this._moteSeed = new Float32Array(n);
        var rnd = lcg(0x9e37);
        for (var i = 0; i < n; i++) {
            pos[i * 3] = (rnd() - 0.5) * 26;
            pos[i * 3 + 1] = rnd() * 5.5;
            pos[i * 3 + 2] = (rnd() - 0.5) * 26;
            this._moteSeed[i] = rnd() * 6.28;
        }
        var geom = new T.BufferGeometry();
        geom.setAttribute('position', new T.BufferAttribute(pos, 3));
        var map = new T.CanvasTexture(moteCanvas(32));
        this._textures.push(map);
        this._moteMat = new T.PointsMaterial({
            size: 0.11, map: map, transparent: true, depthWrite: false,
            blending: T.AdditiveBlending, opacity: 0.55, sizeAttenuation: true
        });
        this.motes = new T.Points(geom, this._moteMat);
        this.motes.frustumCulled = false;
        this.scene.add(this.motes);
    };

    // Fill the host and frame a fixed "screenful" around the player. The camera follows the player
    // (see _animate) instead of framing the whole level, so 3D behaves like the other modes. Only
    // does work when the host size actually changed, so it is cheap to call every frame.
    ThreeRenderer.prototype._fitToHost = function () {
        var host = this.host;
        var w = (host && (host.clientWidth || host.offsetWidth)) || 640;
        var h = (host && (host.clientHeight || host.offsetHeight)) || 400;
        if (w === this._cw && h === this._ch) return;
        this._cw = w; this._ch = h;
        this.renderer.setSize(w, h, true); // updateStyle:true so the canvas CSS-fills the host
        var aspect = w / h, span = 6.6 / (this.zoom || 1); // fixed screenful, user-adjustable zoom
        this.camera.left = -span * aspect;
        this.camera.right = span * aspect;
        this.camera.top = span;
        this.camera.bottom = -span;
        this.camera.updateProjectionMatrix();
    };

    ThreeRenderer.prototype.setZoom = function (zoom) {
        var next = Math.max(0.55, Math.min(3.2, Number(zoom) || 1));
        if (Math.abs(next - this.zoom) < 0.001) return;
        this.zoom = next;
        this._cw = null; // force projection update even when the host dimensions did not change
        this._fitToHost();
    };

    // `attachCamera` reports drag pan in viewport pixels. 3D keeps that contract and converts the
    // offset to ground-plane world units in _animate(), where the followed player's current smoothed
    // position is available. The bound of one viewport keeps a stray gesture from losing the dungeon.
    ThreeRenderer.prototype.setPan = function (x, y) {
        var w = (this.host && (this.host.clientWidth || this.host.offsetWidth)) || 640;
        var h = (this.host && (this.host.clientHeight || this.host.offsetHeight)) || 400;
        this.panX = Math.max(-w, Math.min(w, Number(x) || 0));
        this.panY = Math.max(-h, Math.min(h, Number(y) || 0));
    };

    ThreeRenderer.prototype._mat = function (hex) {
        var T = this.THREE;
        return new T.MeshStandardMaterial({ color: colorNum(hex), roughness: 0.82, metalness: 0.02 });
    };

    ThreeRenderer.prototype._disposeObject = function (object) {
        if (!object || !object.traverse) return;
        var keep = [this.wallMat, this.groundMat, this.propMat, this.glowMat];
        object.traverse(function (obj) {
            if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
            if (!obj.material) return;
            var materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            materials.forEach(function (mat) {
                if (mat && mat.dispose && keep.indexOf(mat) === -1) mat.dispose();
            });
        });
    };

    // One InstancedMesh per bucket, grown geometrically. Reusing the mesh across rebuilds keeps a
    // fog-of-war update from re-allocating the whole level every time the player steps.
    ThreeRenderer.prototype._bucket = function (name, geom, mat, needed) {
        var T = this.THREE;
        var b = this.buckets[name];
        if (!b || b.capacity < needed) {
            if (b) { this.tileLayer.remove(b.mesh); b.mesh.dispose(); }
            var capacity = Math.max(64, Math.ceil(needed * 1.35));
            var mesh = new T.InstancedMesh(geom, mat, capacity);
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.castShadow = name !== 'ground';
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            this.tileLayer.add(mesh);
            b = this.buckets[name] = { mesh: mesh, capacity: capacity, geom: geom };
        }
        return b;
    };

    ThreeRenderer.prototype._buildTiles = function (scene) {
        var T = this.THREE;
        if (!this._geom) {
            this._geom = {
                wall: new T.BoxGeometry(1, 1, 1),
                ground: new T.BoxGeometry(1, 0.12, 1),
                prop: new T.BoxGeometry(1, 1, 1)
            };
        }
        var legend = scene.legend || {};
        var light = scene.lightGrid || null;
        var cx = (scene.cols - 1) / 2, cz = (scene.rows - 1) / 2;
        var walls = [], grounds = [], props = [];
        this.torchCells = [];

        var y, x, kind;
        for (y = 0; y < scene.rows; y++) {
            for (x = 0; x < scene.cols; x++) {
                kind = scene.grid[y] && scene.grid[y][x];
                if (!kind || kind === 'dark') continue; // unexplored: never rendered (fog-of-war)
                var def = legend[kind] || {};
                var lb = (light && light[y] && light[y][x] != null) ? light[y][x] : 1;
                // In the 2D modes lightGrid IS the lighting; here real point lights do the falloff.
                // Applying the grid at full strength to the albedo as well would double-darken every
                // surface into near-black, so it is compressed into a gentle range and the lamps
                // shape the scene.
                var b = 0.38 + 0.62 * Math.max(0, Math.min(1, lb));
                var tint = KIND_TINT[kind] || def.color || '#6d6558';
                var cell = { x: x - cx, z: y - cz, gx: x, gy: y, b: b, tint: tint, kind: kind };
                if (WALLISH[kind]) walls.push(cell);
                else if (GROUND[kind]) grounds.push(cell);
                else props.push(cell);
                // Wall-mounted torches: a brazier fixture + a light source candidate.
                if (def.fx === 'fire') this.torchCells.push(cell);
                if (def.hazard) cell.hazard = def.hazard;
            }
        }

        this._wallCells = walls;
        this._writeGround(grounds);
        this._writeProps(props);
        this._writeWalls();
        this._syncFixtures();
    };

    ThreeRenderer.prototype._writeGround = function (cells) {
        var T = this.THREE;
        var b = this._bucket('ground', this._geom.ground, this.groundMat, cells.length);
        var m = new T.Matrix4(), c = new T.Color();
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            m.makeTranslation(cell.x, 0, cell.z);
            b.mesh.setMatrixAt(i, m);
            c.set(colorNum(cell.tint)).multiplyScalar(cell.b);
            b.mesh.setColorAt(i, c);
        }
        b.mesh.count = cells.length;
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    };

    ThreeRenderer.prototype._writeProps = function (cells) {
        var T = this.THREE;
        var b = this._bucket('prop', this._geom.prop, this.propMat, cells.length);
        var m = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), c = new T.Color();
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            var h = PROP_HEIGHT[cell.kind] != null ? PROP_HEIGHT[cell.kind] : 0.3;
            s.set(0.88, h, 0.88);
            p.set(cell.x, h / 2, cell.z);
            m.compose(p, q, s);
            b.mesh.setMatrixAt(i, m);
            // Hazards keep near-full brightness: a lava pool you can barely see is a trap, not a
            // difficulty curve.
            var hb = cell.hazard ? Math.max(0.7, cell.b) : cell.b;
            c.set(colorNum(cell.tint)).multiplyScalar(hb);
            b.mesh.setColorAt(i, c);
        }
        b.mesh.count = cells.length;
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    };

    // Walls are rewritten whenever the player's cell changes so the cutaway follows them: walls
    // sitting between the isometric camera (+x/+z) and the player are squashed and darkened, the 3D
    // equivalent of the iso renderer's fade. Without it the near wall of every corridor hides you.
    ThreeRenderer.prototype._writeWalls = function () {
        var cells = this._wallCells;
        if (!cells) return;
        var T = this.THREE;
        var b = this._bucket('wall', this._geom.wall, this.wallMat, cells.length);
        var m = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), c = new T.Color();
        var px = this._plx, py = this._ply;
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            var h = 1.45, dim = 1;
            if (px != null && cell.gx >= px && cell.gy >= py) {
                var d = (cell.gx - px) + (cell.gy - py);
                if (d > 0 && d <= 3) { h = 0.40; dim = 0.62; }
            }
            s.set(1, h, 1);
            p.set(cell.x, h / 2, cell.z);
            m.compose(p, q, s);
            b.mesh.setMatrixAt(i, m);
            c.set(colorNum(cell.tint)).multiplyScalar(cell.b * dim);
            b.mesh.setColorAt(i, c);
        }
        b.mesh.count = cells.length;
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    };

    // Braziers on the torch walls. Only newly appeared cells get geometry: the tile buckets are
    // rewritten on every move (that is how remembered tiles keep dimming), and building a fresh mesh
    // per torch per step would churn the GPU for no visual gain.
    ThreeRenderer.prototype._syncFixtures = function () {
        var T = this.THREE;
        this._flames = this._flames || {};
        var want = {}, i, cell, k;
        for (i = 0; i < this.torchCells.length; i++) {
            cell = this.torchCells[i];
            k = cell.gx + ',' + cell.gy;
            want[k] = true;
            if (this._flames[k]) { cell.flame = this._flames[k].flame; continue; }
            var bowl = new T.Mesh(
                new T.CylinderGeometry(0.17, 0.10, 0.16, 8),
                new T.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.9 })
            );
            bowl.position.set(cell.x, 1.30, cell.z);
            this.fixtureLayer.add(bowl);
            var flame = new T.Mesh(
                new T.ConeGeometry(0.13, 0.34, 7),
                new T.MeshBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.92 })
            );
            flame.position.set(cell.x, 1.55, cell.z);
            this.fixtureLayer.add(flame);
            cell.flame = flame;
            this._flames[k] = { bowl: bowl, flame: flame };
        }
        for (k in this._flames) {
            if (want[k]) continue;
            var rec = this._flames[k];
            this.fixtureLayer.remove(rec.bowl);
            this.fixtureLayer.remove(rec.flame);
            this._disposeObject(rec.bowl);
            this._disposeObject(rec.flame);
            delete this._flames[k];
        }
    };

    ThreeRenderer.prototype._fallbackAvatar = function (e, visual) {
        var T = this.THREE;
        var g = new T.Group();
        var body = new T.Mesh(new T.CapsuleGeometry(0.40, 1.05, 4, 12), this._mat(tintForVisual(visual, e.color || '#9aa4b2')));
        body.position.y = 0.95;
        body.castShadow = true;
        g.add(body);
        var face = new T.Mesh(new T.BoxGeometry(0.22, 0.12, 0.06), this._mat('#0a0c0f'));
        face.position.set(0, 1.30, 0.40);
        g.add(face);
        return g;
    };

    // Monsters share the dungeon with the player, so they must never read as a second hero: a
    // hunched dark-red body with glowing eyes and its own red spill light.
    ThreeRenderer.prototype._makeMonster = function (e) {
        var T = this.THREE;
        var g = new T.Group();
        var body = new T.Mesh(
            new T.CapsuleGeometry(0.42, 0.62, 4, 12),
            new T.MeshStandardMaterial({ color: 0x7a1d1d, roughness: 0.65, emissive: 0x2a0505, emissiveIntensity: 0.7 })
        );
        body.position.y = 0.68;
        body.castShadow = true;
        g.add(body);
        var eyeMat = new T.MeshBasicMaterial({ color: 0xff5b4a });
        for (var s = -1; s <= 1; s += 2) {
            var eye = new T.Mesh(new T.SphereGeometry(0.07, 8, 8), eyeMat);
            eye.position.set(s * 0.15, 0.98, 0.34);
            g.add(eye);
        }
        var horns = new T.MeshStandardMaterial({ color: 0x3d1414, roughness: 0.5 });
        for (var h = -1; h <= 1; h += 2) {
            var horn = new T.Mesh(new T.ConeGeometry(0.07, 0.28, 6), horns);
            horn.position.set(h * 0.22, 1.16, 0);
            horn.rotation.z = h * -0.3;
            g.add(horn);
        }
        var light = new T.PointLight(0xff4a3a, 1.4, 4.5, 2);
        light.position.set(0, 0.9, 0);
        g.add(light);
        g._menace = true;
        return g;
    };

    // Dungeon features and items (entrance/exit/treasure/pickups) are set dressing, not avatars, so
    // they get their own geometry rather than the humanoid capsule an avatar would draw.
    ThreeRenderer.prototype._makeFeature = function (e) {
        var T = this.THREE;
        var g = new T.Group();
        var ch = e.char || '?';
        if (ch === '<' || ch === '>') {
            var down = ch === '>';
            var tone = down ? 0xd8a13f : 0x4fbf62;
            var stepMat = new T.MeshStandardMaterial({ color: 0x5d564a, roughness: 0.9 });
            for (var i = 0; i < 4; i++) {
                var step = new T.Mesh(new T.BoxGeometry(0.82, 0.11, 0.82 - i * 0.17), stepMat);
                step.position.set(0, down ? 0.05 - i * 0.09 : 0.05 + i * 0.09, i * 0.09);
                step.receiveShadow = true;
                g.add(step);
            }
            // A soft beacon column: from across a dark room you can see where the stairs are without
            // the fog-of-war having to leak the whole layout.
            if (!this._beamTex) {
                this._beamTex = new T.CanvasTexture(beamCanvas(64));
                this._textures.push(this._beamTex);
            }
            var beam = new T.Mesh(
                new T.CylinderGeometry(0.30, 0.46, 3.2, 14, 1, true),
                new T.MeshBasicMaterial({
                    color: tone, map: this._beamTex, transparent: true, opacity: 0.5,
                    side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending, fog: false
                })
            );
            beam.position.y = 1.6;
            g.add(beam);
            g._beam = beam;
            var bl = new T.PointLight(tone, 1.1, 5, 2);
            bl.position.set(0, 0.8, 0);
            g.add(bl);
            g._pulse = bl;
        } else if (ch.charAt(0) === '$') {
            var wood = new T.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.8 });
            var gold = new T.MeshStandardMaterial({
                color: 0xf5c624, roughness: 0.28, metalness: 0.85,
                emissive: 0x6b4c07, emissiveIntensity: 0.7
            });
            var body = new T.Mesh(new T.BoxGeometry(0.62, 0.34, 0.44), wood);
            body.position.y = 0.24;
            body.castShadow = true;
            g.add(body);
            var lid = new T.Mesh(new T.CylinderGeometry(0.22, 0.22, 0.62, 12, 1, false, 0, Math.PI), gold);
            lid.rotation.z = Math.PI / 2;
            lid.position.y = 0.41;
            g.add(lid);
            var glow = new T.PointLight(0xffc65c, 1.6, 4.5, 2);
            glow.position.set(0, 0.7, 0);
            g.add(glow);
            g._pulse = glow;
            g._bob = true;
        } else {
            var item = new T.Mesh(
                new T.OctahedronGeometry(0.22, 0),
                new T.MeshStandardMaterial({
                    color: colorNum(e.color || '#fbbf24'), roughness: 0.3, metalness: 0.6,
                    emissive: colorNum(e.color || '#fbbf24'), emissiveIntensity: 0.55
                })
            );
            item.position.y = 0.5;
            item.castShadow = true;
            g.add(item);
            g._spin = item;
            g._bob = true;
        }
        g._static = true;
        return g;
    };

    ThreeRenderer.prototype._applyModelTint = function (model, visual) {
        var tint = tintForVisual(visual, null);
        if (!model) return;
        var T = this.THREE;
        var color = tint ? new T.Color(colorNum(tint)) : null;
        model.traverse(function (obj) {
            if (!obj.isMesh || !obj.material) return;
            obj.castShadow = true;
            var materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            var next = materials.map(function (mat) {
                if (!mat) return mat;
                var copy = mat.clone();
                if (color && copy.color) copy.color.copy(color);
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
        var scale = 1.8 / maxDim;
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

    ThreeRenderer.prototype._makeAvatar = function (e) {
        var T = this.THREE, self = this;
        var shell = new T.Group();
        var visual = this._visualFor(e);
        shell._isAvatar = true;
        shell._body = this._fallbackAvatar(e, visual);
        shell.add(shell._body);
        if (visual && visual.allowed !== false && visual.model) {
            this._loadModel(visual, function (rec) {
                if (!rec || !rec.gltf || !shell.parent) return;
                var model = self.SkeletonUtils && self.SkeletonUtils.clone
                    ? self.SkeletonUtils.clone(rec.gltf.scene)
                    : rec.gltf.scene.clone(true);
                self._applyModelTint(model, visual);
                model.rotation.y = Math.PI;
                var fitted = self._fitModel(model);
                if (shell._body) {
                    shell.remove(shell._body);
                    self._disposeObject(shell._body);
                    shell._body = null;
                }
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

    ThreeRenderer.prototype._makeEntity = function (e) {
        if (e.kind === 'feature' || e.kind === 'item') return this._makeFeature(e);
        if (e.kind === 'monster') return this._makeMonster(e);
        return this._makeAvatar(e);
    };

    ThreeRenderer.prototype.render = function (scene) {
        if (!scene || !this.renderer) return;
        this._fitToHost();

        // Track the followed player's CELL first: the wall cutaway is computed from it during the
        // tile build, so it has to be current before _buildTiles runs.
        var pcell = null, i;
        for (i = 0; i < scene.entities.length; i++) {
            var pe = scene.entities[i];
            if (pe.you || pe.cameraTarget || (!pcell && pe.kind === 'player')) pcell = pe;
            if (pe.you || pe.cameraTarget) break;
        }
        if (pcell) { this._plx = pcell.x; this._ply = pcell.y; }

        // Rewrite the level every render. `render` is called on game updates (a keypress), not per
        // frame, and the buckets are three reused InstancedMeshes, so this is a few thousand matrix
        // writes, not an allocation. It has to be unconditional: `lightGrid` re-shades remembered
        // tiles on every step, so keying the rebuild on the grid alone would freeze the fog-of-war
        // fade at whatever it was when a cell was first seen.
        this._buildTiles(scene);

        var seen = {}, cx = (scene.cols - 1) / 2, cz = (scene.rows - 1) / 2;
        for (i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i], id = e.id;
            seen[id] = true;
            var ent = this.entities[id];
            if (!ent) {
                var obj = this._makeEntity(e);
                obj.position.set(e.x - cx, 0, e.y - cz);
                ent = this.entities[id] = { obj: obj, x: e.x, y: e.y };
                this.entityLayer.add(ent.obj);
            }
            ent.e = e;
            ent.tx = e.x - cx;
            ent.tz = e.y - cz;
        }
        for (id in this.entities) {
            if (!seen[id]) {
                var removed = this.entities[id].obj;
                this.entityLayer.remove(removed);
                if (removed._mixer) {
                    removed._mixer.stopAllAction();
                    var mixerIndex = this.mixers.indexOf(removed._mixer);
                    if (mixerIndex >= 0) this.mixers.splice(mixerIndex, 1);
                }
                this._disposeObject(removed);
                delete this.entities[id];
            }
        }
    };

    // Reassign the small torch-light pool to whichever braziers are nearest the followed player.
    ThreeRenderer.prototype._updateTorchLights = function (px, pz, now) {
        var lights = this.torchLights;
        if (!lights || !lights.length) return;
        var cells = this.torchCells || [];
        var near = [];
        for (var i = 0; i < cells.length; i++) {
            var d = Math.abs(cells[i].x - px) + Math.abs(cells[i].z - pz);
            if (d < 16) near.push({ c: cells[i], d: d });
        }
        near.sort(function (a, b) { return a.d - b.d; });
        for (var li = 0; li < lights.length; li++) {
            var slot = near[li];
            var light = lights[li];
            if (!slot) { light.visible = false; light.intensity = 0; continue; }
            var flicker = 0.78 + Math.sin(now / 90 + slot.c.gx * 3.1) * 0.13 + Math.sin(now / 37 + slot.c.gy) * 0.07;
            light.visible = true;
            light.position.set(slot.c.x, 1.5, slot.c.z);
            light.intensity = 3.6 * flicker * Math.max(0.3, slot.c.b);
            if (slot.c.flame) {
                slot.c.flame.scale.set(1, 0.85 + flicker * 0.3, 1);
                slot.c.flame.material.opacity = 0.7 + flicker * 0.25;
            }
        }
    };

    ThreeRenderer.prototype._animate = function () {
        if (!this.renderer) return;
        try {
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
            // Set dressing bobs and spins on its own clock; only characters get the gait bounce.
            if (o._static) {
                o.position.y = o._bob ? 0.06 + Math.sin(now / 520 + o.position.x) * 0.06 : 0;
                if (o._spin) o._spin.rotation.y = now / 900;
                if (o._beam) o._beam.material.opacity = 0.34 + Math.abs(Math.sin(now / 900)) * 0.26;
                if (o._pulse) o._pulse.intensity = 1.1 + Math.abs(Math.sin(now / 700)) * 0.7;
                continue;
            }
            o.position.y = moving
                ? Math.abs(Math.sin(now / 95)) * 0.08
                : Math.sin(now / 620) * 0.018;
            if (o._menace) o.position.y += Math.sin(now / 380) * 0.03;
            if (o._body) {
                o._body.rotation.z = moving ? Math.sin(now / 120) * 0.055 : 0;
            }
            if (o._model) {
                o._model.rotation.z = moving ? Math.sin(now / 120) * 0.045 : 0;
            }
            this._playAction(o, moving ? 'run' : 'idle');
            // Face the way you move. Prefer explicit facing (tavern); else infer from the world delta
            // (the SP game does not send player.facing). world x=grid x, world z=grid y.
            var face = ent.e && ent.e.facing;
            if (!face && moving) { face = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'right' : 'left') : (dz > 0 ? 'down' : 'up'); ent._face = face; }
            face = face || ent._face;
            if (face) {
                var r = face === 'up' ? Math.PI : face === 'left' ? -Math.PI / 2 : face === 'right' ? Math.PI / 2 : 0;
                o.rotation.y += (r - o.rotation.y) * 0.18;
            }
        }
        // Player-follow camera: keep the fixed iso offset but re-target the player's world position
        // each frame. The player mesh itself lerps, so the camera glides smoothly with it.
        this._fitToHost(); // picks up any host resize
        var pcam = null;
        for (var pid in this.entities) {
            var pen = this.entities[pid];
            if (pen.e && (pen.e.you || pen.e.cameraTarget)) { pcam = pen.obj; break; }
            if (!pcam && pen.e && pen.e.kind === 'player') pcam = pen.obj;
        }
        if (pcam) {
            // Dragging the viewport should move the rendered dungeon with the pointer. Translate the
            // camera target opposite the corresponding screen-space axes while retaining the fixed
            // isometric camera offset and player-follow smoothing.
            var viewportHeight = (this.host && (this.host.clientHeight || this.host.offsetHeight)) || 400;
            var unitsPerPixel = (13.2 / (this.zoom || 1)) / Math.max(1, viewportHeight);
            var diagonal = unitsPerPixel / Math.sqrt(2);
            var targetX = pcam.position.x + (-this.panX - this.panY) * diagonal;
            var targetZ = pcam.position.z + (this.panX - this.panY) * diagonal;
            this.camera.position.set(targetX + 9, 11, targetZ + 9);
            this.camera.lookAt(targetX, 0, targetZ);
            if (this.playerLight) {
                this.playerLight.position.set(pcam.position.x, 2.6, pcam.position.z);
                // Hand-held torch: a slow irregular flicker, not a strobe.
                this.playerLight.intensity = 4.2 + Math.sin(now / 140) * 0.3 + Math.sin(now / 61) * 0.15;
            }
            // Keep the shadow frustum tight around the player so a 1024 map stays sharp on a big level.
            if (this.keyLight) {
                this.keyLight.position.set(pcam.position.x + 10, 8.5, pcam.position.z + 4);
                this.keyLight.target.position.set(pcam.position.x, 0, pcam.position.z);
                this.keyLight.target.updateMatrixWorld();
            }
            if (this.motes) {
                this.motes.position.set(pcam.position.x, 0, pcam.position.z);
                this.motes.rotation.y = now / 60000;
            }
            this._updateTorchLights(pcam.position.x, pcam.position.z, now);
        }
        this.renderer.render(this.scene, this.camera);
        } catch (err) {
            if (root.console) console.warn('3D animate error; stopping 3D loop:', err && err.message);
            return false;
        }
        return true;
    };

    ThreeRenderer.prototype.destroy = function () {
        this._destroyed = true;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        for (var i = 0; i < this.mixers.length; i++) this.mixers[i].stopAllAction();
        this._disposeObject(this.world);
        for (var name in this.buckets) {
            if (this.buckets[name].mesh.dispose) this.buckets[name].mesh.dispose();
        }
        this.buckets = {};
        for (var g in (this._geom || {})) this._geom[g].dispose();
        this._geom = null;
        [this.wallMat, this.groundMat, this.propMat, this.glowMat, this._moteMat].forEach(function (m) {
            if (m && m.dispose) m.dispose();
        });
        (this._textures || []).forEach(function (t) { if (t && t.dispose) t.dispose(); });
        this._textures = [];
        if (this.motes && this.motes.geometry) this.motes.geometry.dispose();
        if (this.renderer) {
            if (this.renderer.domElement && this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            this.renderer.dispose();
            if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
        }
        this.renderer = null;
        this.entities = {};
        this.models = {};
        this.mixers = [];
        this.torchCells = [];
    };

    root.RK = root.RK || {};
    root.RK.ThreeRenderer = ThreeRenderer;
})(window);
