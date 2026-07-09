/**
 * MatchEngine — server tick driver for a MatchRoom.
 *
 * The engine is intentionally thin: all state/rules live in MatchRoom, and this class owns
 * the timer that calls `room.resolveTick()` at a fixed interval. It also handles graceful
 * shutdown and can be used by MatchManager to drive many concurrent matches.
 *
 * Transport-agnostic: no Socket.IO here. The manager that owns this engine consumes the
 * tick result and broadcasts it.
 */

class MatchEngine {
    /**
     * @param {object} opts
     * @param {MatchRoom} opts.room
     * @param {number}    [opts.tickMs]    default 250ms
     * @param {Function}  [opts.onTick]    callback(tickResult, room)
     * @param {Function}  [opts.onFinish]  callback(room)
     */
    constructor({ room, tickMs = 250, onTick = null, onFinish = null } = {}) {
        if (!room) throw new Error('MatchEngine requires a MatchRoom');
        this.room = room;
        this.tickMs = tickMs;
        this.onTick = onTick;
        this.onFinish = onFinish;
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.running) return false;
        const started = this.room.start();
        if (!started) return false;
        this.running = true;
        this.timer = setInterval(() => this._tick(), this.tickMs);
        return true;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.running = false;
    }

    /**
     * Run a single tick synchronously. Useful for tests and for manually stepping.
     * @returns {{tick:number, events:Array, finished:boolean}}
     */
    tick() {
        return this._tick();
    }

    _tick() {
        const result = this.room.resolveTick();
        if (this.onTick) this.onTick(result, this.room);
        if (result.finished) {
            this.stop();
            this.room.finalize();
            if (this.onFinish) this.onFinish(this.room);
        }
        return result;
    }

    /**
     * Force end (e.g. block deadline or hard ceiling). The manager should call this when
     * it knows the match must end regardless of in-engine state.
     * @param {string} reason
     */
    expire(reason) {
        this.room.expire(reason);
        this.stop();
        this.room.finalize();
        if (this.onFinish) this.onFinish(this.room);
    }
}

module.exports = MatchEngine;
