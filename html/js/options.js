var tileSet = document.createElement("img");
var tileSetLoaded = false;

tileSet.onload = function() {
    tileSetLoaded = true;
};

tileSet.onerror = function() {
    console.error("Failed to load tileset image!");
};

tileSet.src = "tiles.png";

var options = {
    layout: "tile",
    bg: "transparent", 
    // Adjusted dimensions for ~800x600 display
    width: 25, // 25 tiles * 32px/tile = 800px
    height: 19, // 19 tiles * 32px/tile = 608px
    tileWidth: 32, // Width of a single tile in pixels
    tileHeight: 32, // Height of a single tile in pixels
    tileSet: tileSet,
    tileMap: {
        // Keep your existing tile mappings
        "'": [0, 0],  // Floor
        ">": [32, 0],  // Exit
        "@": [64, 0],  // Player
        "~": [96, 0], // Monster
        "<": [0, 32],   // Entrance
        "=": [32, 32],  // Monster Entrance
        "#": [64, 32], // Wall
        "$": [96, 32], // Treasure
        // ... include all other necessary character mappings ...
        "a": [128, 0],
        "b": [160, 0],
        "c": [192, 0],
        "d": [224, 0],
        "e": [256, 0],
        "f": [288, 0],
        "g": [320, 0],
        "h": [352, 0],
        "i": [384, 0],
        "j": [416, 0],
        "k": [448, 0],
        "l": [480, 0],
        "m": [512, 0], // Duplicate M? Ensure one is correct
        "n": [544, 0],
        "o": [576, 0],
        "p": [608, 0],
        "q": [640, 0],
        "r": [672, 0],
        "s": [704, 0],
        "t": [736, 0],
        "u": [768, 0],
        "v": [800, 0],
        "w": [832, 0],
        "x": [864, 0],
        "y": [896, 0],
        "z": [928, 0],
        "A": [128, 32],
        "B": [160, 32],
        "C": [192, 32],
        "D": [224, 32],
        "E": [256, 32],
        "F": [288, 32],
        "G": [320, 32],
        "H": [352, 32],
        "I": [384, 32],
        "J": [416, 32],
        "K": [448, 32],
        "L": [480, 32],
        "M": [512, 32], // Already mapped M
        "N": [544, 32],
        "O": [576, 32],
        "P": [608, 32],
        "Q": [640, 32],
        "R": [672, 32],
        "S": [704, 32],
        "T": [736, 32],
        "U": [768, 32],
        "V": [800, 32],
        "W": [832, 32],
        "X": [864, 32],
        "Y": [896, 32],
        "Z": [928, 32],
        "&": [0, 64],
        "-": [32, 64],
        "+": [64, 64],
        "`": [96, 64],
        "0": [128, 64],
        "1": [160, 64],
        "2": [192, 64],
        "3": [224, 64],
        "4": [256, 64],
        "5": [288, 64],
        "6": [320, 64],
        "7": [352, 64],
        "8": [384, 64],
        "9": [416, 64],
        ".": [448, 64],
        ":": [480, 64],
        ",": [512, 64],
        ";": [544, 64],
        "(": [576, 64],
        "*": [608, 64],
        "!": [640, 64],
        "?": [672, 64],
        "}": [704, 64],
        "^": [736, 64],
        ")": [768, 64],
        "[": [800, 64],
        "]": [832, 64],
        "{": [864, 64],
        "%": [896, 64],
        "^": [928, 64],
        " ": [992, 64]
    }
};

// Make options globally available
window.tileSet = tileSet;
window.tileMap = options.tileMap;
window.options = options;
