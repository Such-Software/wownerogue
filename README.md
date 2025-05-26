# Wowngeon

A blockchain-based roguelike dungeon crawler built on the Wownero network.

## Project Overview

Wowngeon is a web-based roguelike game that integrates with the Wownero blockchain for a unique gaming experience. Players enter a randomly generated dungeon with the goal of escaping before the next block is discovered on the network. The player requests to enter (and optionally pay an entrance fee), and then waits for the next block to be mined. When the next block is found, the player is placed in the dungeon and must escape before the next block is found. If they fail to escape, they die and lose their entrance fee. There is a singular monster and treasure in the dungeon. If the monster catches the player, they die. If the player finds the treasure and manages to escape, they could win 3x or 5x instead of just 2x for escaping sans treasure.

The game is built using Node.js for the backend, with Express and Socket.io for real-time communication. The frontend is developed using HTML5, CSS, and JavaScript, with ROT.js for rendering the dungeon and managing game mechanics. The Wownero blockchain is integrated via RPC calls to monitor block height and handle transactions.

## Key Features

- **Blockchain-linked gameplay**: Players enter when one block is found and must escape before the next block (approximately 5 minutes in Wownero)
- **Permadeath mechanics**: If a player fails to escape before the next block is found, they die
- **Random dungeons**: Each game features procedurally generated maps using ROT.js
- **Monster AI**: Evade monster as you navigate the dungeon
- **Treasure hunting**: Find treasure for bonus rewards
- **Real-time multiplayer**: Multiple players can play simultaneously with efficient socket broadcasting
- **Structured chat system**: Public chat broadcasts and private status updates with command separation
- **Field of view**: Limited visibility adds challenge and atmosphere
- **HTML START button**: Visible button in status area for game entry
- **Auto-return system**: 30-second timeout returns players to title screen after game over
- **Spectator-ready architecture**: Socket system designed for future spectator mode implementation

## Technology Stack

- **Backend**: Node.js with Express and Socket.io
- **Frontend**: HTML5, CSS, JavaScript with ROT.js for tile-based rendering
- **Blockchain**: Wownero RPC integration for block monitoring
- **Database**: SQLite for user data and game history
- **Real-time Communication**: WebSocket connections via Socket.io with structured event broadcasting

## Socket.io Real-Time Communication

The game implements a sophisticated real-time communication system using Socket.io:

### Broadcasting Strategy
- **Block Height**: Broadcast to all clients every 5 seconds (not just on changes)
- **Game Updates**: Player-specific with spectator support planned
- **Chat Messages**: Public broadcasts vs private status updates
- **Connection Status**: Immediate updates on connect/disconnect

### Event Categories
1. **Global Broadcasts** (`io.emit()`) - Block height, public chat
2. **Player-Specific** (`io.to(socketId).emit()`) - Game updates, status messages
3. **Future Spectator Support** - Multi-cast game updates to viewers

### Production Scalability
- Efficient event routing prevents unnecessary network traffic
- Structured for adding spectator mode without performance impact
- Clean separation between commands and actual chat messages

## Architecture

The project has been refactored into a clean, modular architecture with clear separation of concerns:

### Backend Structure (`src/backend/`)

- **index.js** - Main server file handling HTTP requests, WebSocket connections, game lifecycle, blockchain monitoring, and structured socket event broadcasting
- **game.js** - Game class with dungeon generation, player movement, monster AI, and field-of-view calculations
- **user.js** - User registration, authentication, game association, and payment tracking
- **player.js** - Player state management and movement logic
- **monster.js** - Monster AI and behavior
- **dungeon.js** - Dungeon generation and map management
- **dbcalls.js** - Database operations for user data and game history
- **rpccalls.js** - Wownero blockchain RPC integration

#### Socket Event Broadcasting (index.js)
- **Helper Functions**: `sendGameUpdate()`, `broadcastBlockHeight()`, `sendStatusUpdate()`
- **Event Types**: Global broadcasts, player-specific updates, status messages
- **Spectator Ready**: Architecture supports future multi-cast to spectators
- **Regular Broadcasting**: Block height sent every 5 seconds to all clients

### Frontend Structure (`html/`)

#### Modular JavaScript Architecture:

1. **DisplayManager.js** - Display & Canvas Management
   - ROT.Display initialization and setup
   - Display state management and clearing
   - Tile-based rendering system

2. **ScreenManager.js** - Screen State Management
   - Welcome screen with block simulation (30-second intervals)
   - Win/lose screens and waiting screens
   - Centered text drawing utilities
   - HTML START button visibility control

3. **RenderEngine.js** - Game Rendering Engine
   - Game screen rendering and object drawing
   - Field of view rendering and visibility checks
   - Drawing game objects (player, monsters, items, terrain)

4. **GameState.js** - Game State Management
   - Player, map, monster, item data management
   - Game state updates and validation
   - Field of view computation fixes
   - Player movement logic

5. **game.js** - Main Game Controller
   - Coordinates all modules with clean APIs
   - Provides backward-compatible interface
   - Handles game initialization and flow

6. **Additional Modules**:
   - **inputHandler.js** - Keyboard/mouse input with movement throttling and HTML button handling
   - **socketHandlers.js** - WebSocket communication with initialization protection
   - **ui.js** - User interface management and chat functionality

## Socket Event Architecture

The game uses a structured socket.io event system designed for real-time multiplayer gameplay with future spectator support:

### Event Broadcasting Strategy

#### **Block Height Broadcasting** (All Clients)
- `blockheight` - Broadcast to ALL connected clients every 5 seconds
- Ensures all players stay synchronized with blockchain state
- Immediate emission on client connection
- Regular updates prevent clients from missing block changes

#### **Game State Updates** (Player + Future Spectators)
- `game_update` - Currently sent to active player only
- **Future Goal**: Broadcast to spectators watching specific games
- Structured for easy expansion to multi-viewer support
- Contains player position, FOV, monster state, items

#### **Chat System** (Broadcast vs Player-Specific)
- `chat_broadcast` - PUBLIC chat messages sent to ALL clients
- `status_update` - PRIVATE status messages sent to individual players
- Commands (like "enter", "hello") trigger status updates, not chat broadcasts
- Real chat messages include username, timestamp, and message content

#### **Connection & Status Management**
- `status_update` - Player-specific notifications (errors, confirmations, help)
- `welcome` - Initial connection acknowledgment
- `game_start` / `game_over` - Game lifecycle events
- Connection status immediately broadcast on client connect

### Socket Event Types

```javascript
// Broadcast Events (All Clients)
io.emit('blockheight', blockHeight);
io.emit('chat_broadcast', { username, message, timestamp });

// Player-Specific Events  
io.to(socketId).emit('status_update', { type, message, timestamp });
io.to(socketId).emit('game_update', gameState);
io.to(socketId).emit('game_start', gameState);
io.to(socketId).emit('game_over', { status, reason, message });

// Future Spectator Events (TODO)
io.to(spectatorId).emit('spectator_update', { playerSocketId, gameState });
```

### Future Spectator System (Roadmap)

The socket architecture is designed to support spectating with minimal changes:

1. **Spectator Registration**: Players can request to watch active games
2. **Multi-Cast Updates**: Game updates broadcast to player + all their spectators  
3. **Spectator-Specific Events**: Special events for spectator UI (player info, game stats)
4. **Spectator Chat**: Separate chat channels for spectators vs players
5. **Spectator Limits**: Configurable limits on spectators per game

### Real-Time Communication Goals

- **Blockchain Sync**: All clients receive block updates every few seconds (not just on block changes)
- **Scalable Game Updates**: Player actions broadcast efficiently to relevant viewers only
- **Rich Chat System**: Distinction between commands/status and actual chat communication
- **Spectator Ready**: Architecture supports adding spectator features without major refactoring

## Recent Major Improvements

### 🔌 Socket Architecture Overhaul
- **Implemented**: Structured event system for broadcast vs player-specific messages
- **Features**: Block height broadcasting, chat system separation, spectator-ready design
- **Helper Functions**: `sendGameUpdate()`, `broadcastBlockHeight()`, `sendStatusUpdate()`
- **Result**: Clean separation of concerns and foundation for spectator mode

### 💀 Death Logic Fix
- **Fixed**: Players not dying at correct block timing in autostart/debug mode
- **Solution**: Updated death logic to kill players the block after they enter
- **Result**: Players die exactly when block advances after entry (block N+1 after entering on block N)

### ⏰ Auto-Return to Title Screen
- **Added**: 30-second timeout after game over (win/lose/timeout)
- **Features**: Automatic return to welcome screen, proper game state reset
- **Result**: Seamless game flow without manual intervention

### 🎯 Movement System Overhaul
- **Fixed**: Players skipping over tiles in hallways
- **Solution**: Added movement throttling (100ms) and prevented duplicate event handlers
- **Result**: Precise one-tile-per-keypress movement

### 🎮 START Button Fix
- **Fixed**: START button invisible (cut off in game display area)
- **Solution**: Moved to HTML status area with proper styling and visibility control
- **Result**: Clearly visible green "🎮 START GAME" button

### 🚀 Auto-Start System
- **Added**: Immediate game start for development and testing
- **Features**: Debug mode detection, 'D' key shortcut, proper SocketHandlers initialization
- **Result**: Games start instantly in debug mode for faster development

### 🏗️ Modular Architecture
- **Completed**: Broke down 786-line monolithic game.js into focused modules
- **Benefits**: Better maintainability, reusability, clean APIs, separation of concerns
- **Result**: Much cleaner and more maintainable codebase

## Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone [repository-url]
   cd wowngeon
   ```

2. **Install dependencies**:
   ```bash
   cd src/backend
   npm install
   ```

3. **Start the backend server**:
   ```bash
   cd src/backend
   node index.js
   ```

4. **Access the game**:
   - Open your browser to `http://localhost:3000`
   - In debug mode (localhost), press 'D' to start immediately
   - In production mode, wait for block simulation and click "🎮 START GAME"

## Game Controls

- **WASD** or **Arrow Keys**: Move player
- **Enter** or **START Button**: Enter dungeon (when available)
- **D Key**: Debug instant start (localhost only)
- **Chat**: Type commands and communicate with other players

## Debug Mode

When running locally (localhost/127.0.0.1), the game includes debug features:

- **Immediate Start**: Press 'D' to bypass block timing
- **Debug Logs**: Enhanced console logging with timing information  
- **Block Simulation**: 30-second intervals instead of real Wownero blocks
- **Auto-Entry**: Instant game start for testing

## File Structure

```
wowngeon/
├── README.md                    # This file
├── src/backend/                 # Backend server code
│   ├── index.js                # Main server file
│   ├── game.js                 # Game logic and mechanics
│   ├── user.js                 # User management
│   ├── player.js               # Player state management
│   ├── monster.js              # Monster AI
│   ├── dungeon.js              # Dungeon generation
│   ├── dbcalls.js              # Database operations
│   └── rpccalls.js             # Blockchain RPC calls
├── html/                       # Frontend web interface
│   ├── index.html              # Main game page
│   ├── js/                     # Modular JavaScript
│   │   ├── displayManager.js   # Display management
│   │   ├── screenManager.js    # Screen states
│   │   ├── renderEngine.js     # Game rendering
│   │   ├── gameState.js        # Game state management
│   │   ├── game.js             # Main game controller
│   │   ├── inputHandler.js     # Input handling
│   │   ├── socketHandlers.js   # WebSocket communication
│   │   ├── ui.js               # User interface
│   │   └── options.js          # Game configuration
│   ├── styles/                 # CSS styling
│   └── tiles.png               # Game tile graphics
└── test/                       # Test files
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with proper commit messages
4. Test thoroughly in both debug and production modes
5. Submit a pull request

## License

[Add your license information here]

## Support

For questions, issues, or contributions, please refer to the project's issue tracker or contact the development team.
