/**
 * InputHandler - Manages keyboard input and translates to game actions
 */
var InputHandler = {
    gameActive: false,
    eventCallbacks: {},

    init: function() {
        console.log("Initializing keyboard handler");
        
        const self = this;
        window.addEventListener('keydown', function(e) {
            self.handleKeyDown(e);
        });
        
        console.log("Keyboard handler initialized");
    },

    setGameActive: function(active) {
        this.gameActive = active;
    },

    on: function(eventName, callback) {
        if (!this.eventCallbacks[eventName]) {
            this.eventCallbacks[eventName] = [];
        }
        this.eventCallbacks[eventName].push(callback);
    },

    emit: function(eventName, data) {
        if (this.eventCallbacks[eventName]) {
            this.eventCallbacks[eventName].forEach(function(callback) {
                callback(data);
            });
        }
    },

    handleKeyDown: function(e) {
        if (!this.gameActive) {
            return;
        }

        let direction = null;

        switch (e.key) {
            case 'ArrowUp':
            case 'w':
            case 'W':
                direction = 'up';
                break;
                
            case 'ArrowDown':
            case 's':
            case 'S':
                direction = 'down';
                break;
                
            case 'ArrowLeft':
            case 'a':
            case 'A':
                direction = 'left';
                break;
                
            case 'ArrowRight':
            case 'd':
            case 'D':
                direction = 'right';
                break;
                
            default:
                return;
        }

        e.preventDefault();
        console.log(`Key pressed: ${e.key}, sending direction: ${direction}`);
        
        // Emit movement event
        this.emit('movement', direction);
        
        // Send to server via socket
        if (window.socket && direction) {
            window.socket.emit('move', direction);
        }
    }
};
