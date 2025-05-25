# Wowngeon Code Architecture

## Overview
The Wowngeon roguelike game has been refactored into a modular architecture with clear separation of concerns between frontend and backend components. Recent major improvements include fixing critical movement bugs, implementing auto-start functionality, and resolving duplicate event handler issues.

## Recent Major Bug Fixes and Improvements

### 🎯 Movement System Overhaul
**Problem**: Players were skipping over tiles when moving through hallways, especially when approaching from certain directions.

**Root Cause**: Double event handler registration caused duplicate keydown events, leading to rapid-fire movement commands.

**Solution**:
- Added `_initialized` flags to prevent multiple initializations of InputHandler and SocketHandlers
- Implemented 100ms movement throttling on both client and server sides
- Enhanced movement validation and debugging with comprehensive logging
- Fixed module initialization order in `index.html`

**Result**: Players now move exactly one tile per keypress with no skipping.

### 🚀 Auto-Start System Implementation
**Problem**: Game was hanging on "waiting for server..." screen instead of starting immediately for testing.

**Root Cause**: Missing `SocketHandlers.init()` call in `index.html` meant client couldn't receive `game_start` events.

**Solution**:
- Added proper SocketHandlers initialization to HTML document ready function
- Implemented auto-start that sends "enter" command 500ms after connection
- Enhanced server-side auto-start to immediately begin games in DEBUG_MODE
- Improved error handling and connection flow

**Result**: Games now start instantly for faster development and testing.

### 🔧 Code Architecture Improvements
**Problem**: Monolithic code structure made debugging and maintenance difficult.

**Solution**:
- Split frontend JavaScript into focused modules (ui.js, socketHandlers.js, inputHandler.js)
- Added initialization protection to prevent duplicate module setup
- Enhanced logging with emojis and timing information for easier debugging
- Maintained backward compatibility while improving code organization

**Result**: Much cleaner, more maintainable codebase with improved debugging capabilities.

## Backend Architecture

### Core Classes

#### `Player` (/player.js)
- Manages player state and position
- Methods: `moveTo()`, `isAt()`, `getState()`, `setState()`, `reset()`
- Properties: x, y, hasKey, hasTreasure

#### `Monster` (/monster.js) 
- Manages monster state and AI behavior
- Methods: `moveTowardPlayer()`, `hasCaughtPlayer()`, `getState()`, `setState()`
- AI Features: Smart pathfinding toward player, collision detection

#### `DungeonGenerator` (/dungeon.js)
- Handles procedural dungeon generation using ROT.js
- Methods: `generate()`, `getRandomRoomCenter()`, `isFloorTile()`, `isWallTile()`
- Features: Room placement, entrance/exit/treasure positioning

#### `Game` (/game.js)
- Main game logic coordinator
- Uses Player, Monster, and DungeonGenerator classes
- Manages game state, FOV calculation, and entity interactions
- Methods: `movePlayer()`, `moveMonster()`, `getState()`, `updateFOV()`

### Supporting Files *(ENHANCED)*
- `user.js` - User management and game instantiation with improved socket ID mapping
- `index.js` - Server entry point with movement throttling, auto-start, and enhanced debugging
- `dbcalls.js` - Database operations
- `rpccalls.js` - Wownero blockchain integration

## Frontend Architecture

### Modular JavaScript Components

#### `ui.js`
- UI utilities and visual helpers
- Functions: `scrollChat()`, `updateBlockHeight()`, `updateFocusIndicator()`
- Manages teletype animations and browser detection

#### `socketHandlers.js` *(MAJOR UPDATES)*
- All WebSocket event handlers with initialization protection
- Events: connect, game_start, game_update, game_over, etc.
- **NEW**: Auto-start functionality for testing (sends "enter" after 500ms)
- **NEW**: `_initialized` flag prevents duplicate handler registration
- **FIXED**: Proper initialization order ensures events are received
- Clean separation of network communication logic

#### `inputHandler.js` *(MAJOR UPDATES)*
- Keyboard and form input management with movement throttling
- **NEW**: 100ms movement cooldown prevents rapid-fire commands
- **NEW**: `_pendingMove` system prevents movement overlap
- **FIXED**: Duplicate event handler prevention
- Handles WASD/arrow key movement, chat input, focus management
- Enhanced debugging with movement timing logs

#### `ui.js`
- UI utilities and visual helpers
- Functions: `scrollChat()`, `updateBlockHeight()`, `updateFocusIndicator()`
- Manages teletype animations and browser detection

#### `game.js` (frontend)
- Core game rendering and client-side state management
- ROT.js display integration, FOV rendering, entity drawing
- Maintained original structure for compatibility

### HTML Structure *(UPDATED)*
- `index.html` - Streamlined main page with proper module initialization order
- **FIXED**: Added missing `SocketHandlers.init()` call to prevent auto-start hanging
- **IMPROVED**: Clean document ready structure ensures proper initialization sequence
- `index_original.html` - Backup of original monolithic structure

## Key Improvements

### Backend Benefits
1. **Modularity**: Clear separation of Player, Monster, and Dungeon logic
2. **Maintainability**: Each class has single responsibility
3. **Testability**: Individual components can be unit tested
4. **Extensibility**: Easy to add new entity types or game mechanics
5. **Movement Validation**: Server-side throttling and validation prevents cheating
6. **Debug Capabilities**: Comprehensive logging for troubleshooting

### Frontend Benefits  
1. **Reduced Complexity**: 471-line index.html reduced to ~80 lines
2. **Code Organization**: Related functionality grouped into logical modules
3. **Reusability**: UI and input handlers can be reused/extended
4. **Debugging**: Easier to locate and fix issues in specific modules
5. **Movement Reliability**: Throttling prevents duplicate commands and tile skipping
6. **Auto-Start Testing**: Instant game start for development and testing

## File Structure
```
/wowngeon/
├── Backend Classes
│   ├── player.js          # Player entity and state
│   ├── monster.js         # Monster AI and behavior  
│   ├── dungeon.js         # Procedural generation
│   └── game.js            # Main game coordinator
├── Backend Support
│   ├── index.js           # Server and socket handling
│   ├── user.js            # User management
│   └── ...other files
└── Frontend
    ├── index.html         # Clean modular HTML
    └── js/
        ├── game.js        # Core game rendering
        ├── ui.js          # UI utilities
        ├── socketHandlers.js  # Network communication
        ├── inputHandler.js    # Input management
        └── ...libraries
```

## Migration Summary *(UPDATED)*
- ✅ Backend modularized into Player, Monster, DungeonGenerator classes
- ✅ Frontend split into logical modules (UI, Socket, Input handlers)
- ✅ **CRITICAL BUG FIXES**: Movement skipping and auto-start hanging resolved
- ✅ **MOVEMENT SYSTEM**: Added throttling and duplicate prevention
- ✅ **INITIALIZATION**: Fixed module loading order and event handler registration
- ✅ **DEBUGGING**: Enhanced logging with emojis and timing information
- ✅ Removed unused files and maintained full compatibility
- ✅ All game mechanics verified working (movement, FOV, collision, treasure)

## Testing Verification *(COMPREHENSIVE)*
- [x] Server starts without errors
- [x] Game initialization works with proper module loading
- [x] **NEW**: Auto-start functionality working (500ms delay → instant game start)
- [x] **FIXED**: Player movement functional with no tile skipping
- [x] **VERIFIED**: Single-tile movement precision confirmed via server logs
- [x] Monster AI and collision detection operational
- [x] Treasure collection working
- [x] **ENHANCED**: Frontend modules load with initialization protection
- [x] **CONFIRMED**: All socket events properly handled and received
- [x] **TESTED**: Movement throttling prevents rapid-fire commands
- [x] **VALIDATED**: Server-side movement validation working correctly

## Current Status: ✅ MAJOR BUGS RESOLVED
The Wowngeon game is now in excellent working condition with all critical movement and initialization bugs fixed. The codebase is much more maintainable and follows modern software engineering practices while preserving all original game functionality.
