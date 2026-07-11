// fxLayer.js — the shared "juice" engine (RK.fx). Pure-canvas animated FX (no WebGL, no shaders,
// CSP-safe) used by BOTH the top-down tiled renderer and the iso renderer so a scene lights up the
// same way in either projection: dancing torch/hearth flame + warm glow, and pulsing hazard tiles
// (lava / poison / spikes) for the dungeon. Everything is a function of `now` (ms) so callers just
// keep a RAF loop alive and pass the clock — no per-particle state to thread through.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};
    var fx = RK.fx = RK.fx || {};

    // Fire flicker → 0..1. Layered sines at incommensurate rates so it reads as a living flame
    // rather than an obvious pulse. `seed` decorrelates neighbouring torches.
    fx.flicker = function (now, seed) {
        seed = seed || 0;
        var t = now / 1000;
        var v = 0.62
            + 0.20 * Math.sin(t * 11.3 + seed * 1.7)
            + 0.11 * Math.sin(t * 24.1 + seed * 4.3)
            + 0.07 * Math.sin(t * 3.7 + seed * 0.9);
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    };

    // Smooth 0..1 pulse for hazards (slower, sinusoidal breathing).
    fx.pulse = function (now, period, seed) {
        period = period || 1400;
        return 0.5 + 0.5 * Math.sin((now / period) * Math.PI * 2 + (seed || 0));
    };

    // Additive warm/tinted glow disc centred on (cx, cy).
    fx.glow = function (ctx, cx, cy, radius, opts) {
        opts = opts || {};
        if (radius <= 0) return;
        var rgb = opts.rgb || '255,180,90';
        var a = opts.intensity == null ? 0.5 : opts.intensity;
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
        g.addColorStop(0.45, 'rgba(' + rgb + ',' + (a * 0.35) + ')');
        g.addColorStop(1, 'rgba(' + rgb + ',0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };

    function flamePath(ctx, cx, cy, w, h, sway) {
        ctx.beginPath();
        ctx.moveTo(cx - w / 2, cy);
        ctx.quadraticCurveTo(cx - w * 0.5 + sway, cy - h * 0.55, cx + sway, cy - h);
        ctx.quadraticCurveTo(cx + w * 0.5 + sway, cy - h * 0.55, cx + w / 2, cy);
        ctx.quadraticCurveTo(cx, cy + h * 0.14, cx - w / 2, cy);
        ctx.closePath();
    }

    // A dancing flame whose BASE sits at (cx, cy) and licks upward. `scale` ≈ flame width.
    fx.flame = function (ctx, cx, cy, scale, now, seed) {
        seed = seed || 0;
        var f = fx.flicker(now, seed);
        var sway = Math.sin(now / 150 + seed) * scale * 0.16;
        var h = scale * (1.5 + f * 0.7);
        var w = scale * 0.95;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        // Outer flame (orange envelope).
        var og = ctx.createRadialGradient(cx, cy - h * 0.45, 0, cx, cy - h * 0.4, h);
        og.addColorStop(0, 'rgba(255,225,150,0.95)');
        og.addColorStop(0.4, 'rgba(255,140,40,0.72)');
        og.addColorStop(1, 'rgba(190,40,10,0)');
        ctx.fillStyle = og;
        flamePath(ctx, cx, cy, w, h, sway);
        ctx.fill();
        // Inner core (white-hot).
        var ig = ctx.createRadialGradient(cx + sway * 0.5, cy - h * 0.32, 0, cx + sway * 0.5, cy - h * 0.3, h * 0.55);
        ig.addColorStop(0, 'rgba(255,255,238,0.95)');
        ig.addColorStop(1, 'rgba(255,205,95,0)');
        ctx.fillStyle = ig;
        flamePath(ctx, cx, cy, w * 0.52, h * 0.62, sway * 0.6);
        ctx.fill();
        ctx.restore();
    };

    // A fire emitter = flame + a soft warm ground glow. Used for torches (small) and hearths
    // (large) alike; `scale` drives both.
    fx.fire = function (ctx, cx, cy, scale, now, seed) {
        var f = fx.flicker(now, seed || 0);
        fx.glow(ctx, cx, cy - scale * 0.2, scale * (3.4 + f * 0.6), { rgb: '255,170,80', intensity: 0.16 + f * 0.12 });
        fx.flame(ctx, cx, cy, scale, now, seed || 0);
    };

    // Hazard palettes. `rgb` = the emissive heat colour; `base` = the flat tint painted into the
    // tile footprint; `period` = pulse speed (ms).
    var HAZARD = {
        lava:   { rgb: '255,110,30', base: 'rgba(70,15,5,0.55)',  period: 1500 },
        poison: { rgb: '90,230,90',  base: 'rgba(15,50,20,0.50)', period: 2200 },
        spikes: { rgb: '170,190,215', base: 'rgba(20,24,30,0.35)', period: 1000 }
    };
    fx.isHazard = function (kind) { return !!HAZARD[kind]; };
    fx.hazardKinds = function () { return Object.keys(HAZARD); };

    // Pulsing hazard overlay. The renderer passes a `drawFootprint(ctx)` callback that traces the
    // tile shape (a square cell top-down, a diamond in iso) so the flat tint clips correctly; the
    // heat glow rides on top additively.
    fx.hazard = function (ctx, kind, cx, cy, radius, now, drawFootprint) {
        var s = HAZARD[kind];
        if (!s) return;
        var p = fx.pulse(now, s.period, cx * 0.13 + cy * 0.07);
        if (drawFootprint) {
            ctx.save();
            drawFootprint(ctx);
            ctx.fillStyle = s.base;
            ctx.fill();
            ctx.restore();
        }
        fx.glow(ctx, cx, cy, radius * (1.0 + p * 0.25), { rgb: s.rgb, intensity: 0.16 + p * 0.4 });
    };
})(typeof window !== 'undefined' ? window : this);
