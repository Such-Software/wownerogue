/**
 * Socket event handlers for the Wowngeon game
 */
const SocketHandlers = {
    _initialized: false,
    
    init: function() {
        if (this._initialized) {
            return;
        }
        
        if (!window.socket) {
            console.error("Socket not available!");
            return;
        }

        this.registerEventHandlers();
        this._initialized = true;
    },

    registerEventHandlers: function() {
        // Connection handlers
        socket.on('connect', this.onConnect);
        socket.on('welcome', this.onWelcome);
        socket.on('message', this.onMessage);
        socket.on('status_update', this.onStatusUpdate);
        socket.on('chat_broadcast', this.onChatBroadcast);
        
        // Game state handlers
        socket.on('waiting_status', this.onWaitingStatus);
        socket.on('queue_joined', this.onQueueJoined);
        socket.on('game_start', this.onGameStart);
        socket.on('game_update', this.onGameUpdate);
        socket.on('game_over', this.onGameOver);
        socket.on('queue_cancelled', this.onQueueCancelled);
        
        // Payment/Address handlers
        socket.on('address_detected', this.onAddressDetected);
        socket.on('address_confirmed', this.onAddressConfirmed);
        socket.on('payment_created', this.onPaymentCreated);
        socket.on('payment_confirmed', this.onPaymentConfirmed);
    socket.on('payment_detected', this.onPaymentDetected);
        
        // Block height handler
        socket.on('blockheight', this.onBlockHeight);
    },

    onConnect: function() {
        socket.emit('register_client', {
            clientId: socket.id,
            userAgent: navigator.userAgent
        });
    },

    onWelcome: function(msg) {
        $('#messages').append($('<li>').text("Connected to server!"));
        UI.scrollChat();
    },

    onMessage: function(msg) {
        $('#messages').append($('<li>').text(msg));
        UI.scrollChat();
    },

    onStatusUpdate: function(data) {
        const statusClass = data.type === 'error' ? 'error' : 'status';
        const statusColor = data.type === 'error' ? '#f00' : 
                           data.type === 'warning' ? '#ff0' : 
                           data.type === 'success' ? '#0f0' : 
                           data.type === 'payment' ? '#0af' : '#fff';
        
        $('#messages').append($('<li class="' + statusClass + '" style="color: ' + statusColor + '; white-space: pre-line;">').text(data.message));
        UI.scrollChat();
    },

    onChatBroadcast: function(data) {
        const msgElement = $('<li style="color: #aaa;">');
        if (data.socketId) {
            msgElement.html('<strong>' + data.socketId.substring(0, 6) + ':</strong> ' + data.message);
        } else {
            msgElement.text(data.message);
        }
        $('#messages').append(msgElement);
        UI.scrollChat();
    },

    onWaitingStatus: function(data) {
        if (data.status === 'waiting') {
            $('#messages').append($('<li style="color:#ff0;">').text(data.message));
            
            if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
                Game.drawWaitingScreen();
            }
        }
        UI.scrollChat();
    },

    onQueueJoined: function(data) {
        console.log('Queue joined:', data);
        
        $('#messages').append($('<li class="queue-info" style="color:#0f0;">').html(
            '�� <strong>Queue Joined!</strong> Position: ' + data.position + '<br>' +
            '📦 Current block: ' + data.currentBlock + ', Next: ' + data.nextBlock
        ));
        UI.scrollChat();
        
        if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
            Game.drawWaitingScreen();
        }
    },

    onGameStart: function(data) {
        $('#messages').append($('<li class="game-start">').text("Starting game..."));
        
        if (typeof Game !== 'undefined' && Game.stopWaitingScreen) {
            Game.stopWaitingScreen();
        }
        
        if (!data) {
            $('#messages').append($('<li class="error">').text("Error: No game data received from server."));
            if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
            return;
        }
        
        try {
            var success = Game.startGame(data.player, data.map, data.monster, data.items, data.visibleTiles, data.lighting, data.torches);
            
            if (!success) {
                $('#messages').append($('<li class="error">').text("Game start failed. Check console for details."));
                if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
            } else {
                setTimeout(function() {
                    $('#game-display').focus();
                }, 100);
            }
        } catch (error) {
            console.error("Error starting game:", error);
            $('#messages').append($('<li class="error">').text("Game start error: " + error.message));
            if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
        }
        
        UI.scrollChat();
    },

    onGameUpdate: function(data) {
        // Server pushed a game state update. The Game object exposes updateGameState().
        // Older code referenced Game.updateGame, which doesn't exist in the current refactor,
        // so updates were silently ignored (player appeared frozen).
        if (typeof Game !== 'undefined') {
            if (Game.updateGameState) {
                Game.updateGameState(data);
            } else if (Game.updateGame) { // Fallback if an alias gets added later
                Game.updateGame(data);
            } else {
                console.warn('Game update received but no updateGameState()/updateGame() method found on Game.');
            }
        }
        UI.scrollChat();
    },

    onGameOver: function(data) {
        $('#messages').append($('<li class="game-over">').text("Game Over: " + data.message));
        if (typeof Game !== 'undefined') {
            if (Game.endGame) {
                Game.endGame(data);
            } else if (Game.drawLoseScreen && data && data.reason) {
                // Minimal fallback if endGame not present
                if (data.reason === 'monster') Game.drawLoseScreen('monster');
            }
        }
        
        UI.scrollChat();
    },

    onQueueCancelled: function(data) {
        $('#messages').append($('<li style="color: #ff0;">').text("Queue entry cancelled."));
        
        if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) {
            Game._drawWelcomeScreen();
        }
        
        UI.scrollChat();
    },

    onAddressDetected: function(data) {
        console.log('Address detected:', data);
        $('#messages').append($('<li class="address-detected" style="color: #ff0; white-space: pre-line;">').text(data.message));
        UI.scrollChat();
    },

    onAddressConfirmed: function(data) {
        console.log('Address confirmed:', data);
        $('#messages').append($('<li class="address-confirmed" style="color: #0f0; white-space: pre-line;">').text(data.message));
        UI.scrollChat();
    },

    onPaymentCreated: function(data) {
        console.log('Payment created:', data);
        
        $('#messages').append($('<li class="payment-info">').html(
            '💳 <strong>Payment Required:</strong> ' + data.humanAmount + ' ' + data.cryptoType
        ));
        UI.scrollChat();
        
        setTimeout(function() {
            $('#chatInput').focus();
        }, 100);
    },

    onPaymentConfirmed: function(data) {
        console.log('Payment confirmed:', data);
        
        if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
            Game.drawWaitingScreen();
        }
        if (typeof Game !== 'undefined') {
            Game._pendingPaymentConfirmed();
        }
        
        $('#messages').append($('<li class="payment-success">').html(
            '✅ <strong>Payment confirmed!</strong> You are in the game queue.'
        ));
        UI.scrollChat();
    },

    onPaymentDetected: function(data) {
        console.log('Payment detected (mempool):', data);
        if (typeof Game !== 'undefined') {
            Game._pendingPaymentDetected(data);
            if (Game.drawWaitingScreen) Game.drawWaitingScreen();
        }
        $('#messages').append($('<li class="payment-mempool" style="color:#0af;">').html(
            '🌀 <strong>Payment seen in mempool</strong> – awaiting block confirmation...'
        ));
        UI.scrollChat();
    },

    onBlockHeight: function(data) {
        if (typeof UI !== 'undefined' && UI.updateBlockHeight) {
            UI.updateBlockHeight(data.blockHeight);
        }
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SocketHandlers;
}
