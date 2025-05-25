# Wowngeon

A blockchain-based roguelike dungeon crawler built on the Wownero network.

## Project Overview

Wowngeon is a web-based roguelike game that integrates with the Wownero blockchain for a unique gaming experience. Players enter a randomly generated dungeon with the goal of escaping before the next block is discovered on the network. The player requests to enter (and optionally pay an entrance fee), and then waits for the next block to be mined. When the next block is found, the player is placed in the dungeon and must escape before the next block is found. If they fail to escape, they die and lose their entrance fee. There is a singular monster and treasure in the dungeon. If the monster catches the player, they die. If the player finds the treasure and manages to escape, they could win 3x or 5x instead of just 2x for escaping sans treasure. The game is designed to be played in a web browser, making it accessible to a wide audience.
The game is built using Node.js for the backend, with Express and Socket.io for real-time communication. The frontend is developed using HTML5, CSS, and JavaScript, with ROT.js for rendering the dungeon and managing game mechanics. The Wownero blockchain is integrated via RPC calls to monitor block height and handle transactions.

### Key Features:

- **Blockchain-linked gameplay**: Players enter when one block is found and must escape before the next block (approximately 5 minutes in Wownero)
- **Permadeath mechanics**: If a player fails to escape before the next block is found, they die
- **Random dungeons**: Each game features procedurally generated maps using ROT.js
- **Monster AI**: Evade monster as you navigate the dungeon
- **Treasure hunting**: Find treasure for bonus rewards
- **Wownero integration**: Players pay an entrance fee (10-100 WOW) and can win rewards
- **Chat system**: Players can communicate in real-time during gameplay
- **View other players' game states**: Spectate other players' dungeons in real-time

### Technology Stack:
- Backend: Node.js with Express and Socket.io
- Frontend: HTML5, CSS, and JavaScript with ROT.js for rendering
- Blockchain: Wownero RPC integration for block monitoring and transactions

## File Structure

### Server Files

**index.js**  
The main server file that handles HTTP requests, WebSocket connections, game lifecycle management, and blockchain monitoring. Coordinates the entire application. Now includes movement throttling, auto-start functionality, and improved socket ID handling.

**game.js**  
Contains the Game class and logic for dungeon generation, player movement, monster AI, field-of-view calculations, and game state management. Enhanced with better debugging and state synchronization.

**user.js**  
Manages user registration, authentication, game association, and payment tracking. Maintains a registry of all active users with improved socket ID mapping.

**dbcalls.js**  
Handles database operations for storing user data, game history, and payment records.

**rpccalls.js**  
Contains functions for interacting with the Wownero blockchain via RPC, including checking block height and verifying transactions.

### Client Files

**html/index.html**  
The main HTML file served to clients, containing the structure for the game UI and chat interface. Now includes proper module initialization order to prevent duplicate event handlers.

**html/js/game.js**  
Client-side game logic handling rendering the game state using ROT.js and managing core game functionality. Maintained original structure for compatibility.

**html/js/socketHandlers.js** *(NEW MODULAR STRUCTURE)*  
Dedicated module for all WebSocket event handling including connect, game_start, game_update, and game_over events. Includes auto-start functionality and initialization protection.

**html/js/inputHandler.js** *(NEW MODULAR STRUCTURE)*  
Handles all keyboard input (WASD/arrow keys) and form submissions. Includes movement throttling (100ms cooldown) and duplicate event prevention.

**html/js/ui.js** *(NEW MODULAR STRUCTURE)*  
UI utilities including chat scrolling, block height updates, teletype animations, and browser detection.

**html/styles/stylesheet.css**  
Styling for the game interface, ensuring proper layout and visual appeal.

**html/js/rot.js**  
The Roguelike Toolkit library that provides dungeon generation, field-of-view calculations, and display capabilities.

## Recent Bug Fixes and Improvements

### ✅ Movement System Overhaul (Completed)
- **Fixed movement skipping bug**: Players no longer skip over tiles when moving through hallways
- **Implemented movement throttling**: Added 100ms cooldown on both client and server to prevent rapid-fire commands
- **Resolved duplicate event handlers**: Fixed double initialization of InputHandler and SocketHandlers that caused movement issues
- **Enhanced debugging**: Added comprehensive logging with emojis and timing information for movement events

### ✅ Auto-Start System (Completed)
- **Instant game start**: Players automatically enter games without waiting for blockchain blocks (for testing)
- **Fixed socket initialization**: Resolved missing SocketHandlers.init() call that prevented game_start events from being received
- **Improved connection flow**: Streamlined the connection → registration → game start process
- **Enhanced error handling**: Better feedback when auto-start fails or hangs

### ✅ Client-Side Architecture (Completed)
- **Modular JavaScript structure**: Split monolithic code into focused modules (ui.js, socketHandlers.js, inputHandler.js)
- **Initialization protection**: Added flags to prevent multiple module initializations
- **Clean separation of concerns**: Network, input, and UI logic properly separated
- **Backward compatibility**: Maintained all original game functionality while improving code organization

### ✅ Server-Side Improvements (Completed)
- **Movement validation**: Server-side movement throttling and validation
- **Socket ID mapping**: Proper handling of client-to-server socket ID relationships
- **Disconnect cleanup**: Proper cleanup of player data when clients disconnect
- **Debug mode enhancements**: Improved block simulation for faster testing

## To-Do List

### High Priority
- [x] ~~Fix movement skipping bug~~ **COMPLETED**
- [x] ~~Fix auto-start hanging issue~~ **COMPLETED** 
- [x] ~~Resolve duplicate event handler registration~~ **COMPLETED**
- [ ] Implement proper payment verification through Wownero RPC
- [ ] Add visual indicators for block time status (when you're in danger)
- [ ] Add score tracking and leaderboard functionality

### Medium Priority
- [ ] Improve monster AI with more sophisticated pathfinding
- [ ] Add multiple dungeon layouts and difficulty levels
- [ ] Implement different monster types with varying behaviors
- [ ] Create persistent user accounts with game history
- [ ] Add sound effects and basic animations
- [ ] Optimize chat system for better message broadcasting

### Low Priority
- [ ] Implement additional power-ups or items in the dungeon
- [ ] Add achievements system
- [ ] Create detailed statistics tracking
- [ ] Optimize performance for mobile devices
- [ ] Add difficulty settings with corresponding reward multipliers

## Running the Game

1. Install dependencies: `npm install`
2. Configure Wownero RPC settings in `config.js` or environment variables
3. Start the server: `node index.js`
4. Access the game at `http://localhost:3000`

## Development Mode

The game includes a DEBUG_MODE setting that simulates block discovery every 30 seconds for easier testing. Set `DEBUG_MODE = true` in `index.js` to enable this feature.

### Auto-Start Testing Mode
When DEBUG_MODE is enabled, the game automatically:
- Connects players and sends "enter" command after 500ms
- Starts games immediately without waiting for blockchain blocks
- Provides instant feedback for testing movement and game mechanics
- Includes comprehensive debug logging with emojis for easy tracking

### Debug Features
- **Movement Logging**: Track every player movement with timing information
- **Socket Communication**: Monitor all WebSocket events and data flow
- **FOV Debugging**: Detailed field-of-view calculation logs
- **Game State Tracking**: Real-time monitoring of player, monster, and treasure states