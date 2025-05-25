# Wownero Roguelike

A tile-based dungeon crawler game using ROT.js with modular architecture.

## Features
- Tile-based rendering with ROT.js
- Block-based game timing (30-second intervals)
- Field of view computation
- Debug mode for development

## Usage

### Production
1. Wait for "NEW BLOCK FOUND!" message (every 30 seconds)
2. Type "ENTER" in chat during 5-second window
3. Use arrow keys to move

### Development (localhost only)
- Press 'D' on welcome screen to start immediately

## Architecture
- `DisplayManager.js` - ROT.js display management
- `ScreenManager.js` - Screen states and UI
- `RenderEngine.js` - Game rendering with tile stacks
- `GameState.js` - Game state management
- `game.js` - Main game controller
