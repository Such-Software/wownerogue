# Wowngeon Code Architecture

## Overview
The Wowngeon roguelike game has been refactored into a modular architecture with clear separation of concerns between frontend and backend components.

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

### Supporting Files
- `user.js` - User management and game instantiation
- `index.js` - Server entry point and socket handling
- `dbcalls.js` - Database operations
- `rpccalls.js` - Wownero blockchain integration

## Frontend Architecture

### Modular JavaScript Components

#### `ui.js`
- UI utilities and visual helpers
- Functions: `scrollChat()`, `updateBlockHeight()`, `updateFocusIndicator()`
- Manages teletype animations and browser detection

#### `socketHandlers.js` 
- All WebSocket event handlers
- Events: connect, game_start, game_update, game_over, etc.
- Clean separation of network communication logic

#### `inputHandler.js`
- Keyboard and form input management  
- Handles WASD/arrow key movement, chat input, focus management
- Event delegation for game controls

#### `game.js` (frontend)
- Core game rendering and client-side state management
- ROT.js display integration, FOV rendering, entity drawing
- Maintained original structure for compatibility

### HTML Structure
- `index.html` - Streamlined main page that loads modular components
- `index_original.html` - Backup of original monolithic structure

## Key Improvements

### Backend Benefits
1. **Modularity**: Clear separation of Player, Monster, and Dungeon logic
2. **Maintainability**: Each class has single responsibility
3. **Testability**: Individual components can be unit tested
4. **Extensibility**: Easy to add new entity types or game mechanics

### Frontend Benefits  
1. **Reduced Complexity**: 471-line index.html reduced to ~80 lines
2. **Code Organization**: Related functionality grouped into logical modules
3. **Reusability**: UI and input handlers can be reused/extended
4. **Debugging**: Easier to locate and fix issues in specific modules

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

## Migration Summary
- ✅ Backend modularized into Player, Monster, DungeonGenerator classes
- ✅ Frontend split into logical modules (UI, Socket, Input handlers)
- ✅ Removed unused files (game_refactored.js, displayManager.js, etc.)
- ✅ Maintained full game functionality and compatibility
- ✅ All game mechanics verified working (movement, FOV, collision, treasure)

## Testing Verification
- [x] Server starts without errors
- [x] Game initialization works
- [x] Player movement functional  
- [x] Monster AI and collision detection operational
- [x] Treasure collection working
- [x] Frontend modules load correctly
- [x] All socket events properly handled

The refactored codebase is now much more maintainable and follows modern software engineering practices while preserving all original game functionality.
