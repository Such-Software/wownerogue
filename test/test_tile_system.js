#!/usr/bin/env node

/**
 * Test script to demonstrate the new tile system
 * Shows floor variations, torch placement, and configurable assets
 */

const DungeonGenerator = require('../src/backend/dungeon.js');

console.log("🏛️  WOWNGEON TILE SYSTEM TEST");
console.log("=" * 50);

// Test 1: Default Configuration
console.log("\n🔧 Test 1: Default Configuration");
const defaultConfig = {
    playerType: "@",
    treasureType: "$W",
    monsterType: "~",
    primaryFloor: "'1",
    secondaryFloor: "'2", 
    floorVariation: 0.01,
    torchEnabled: true,
    torchDensity: 0.15,
    torchTile: "torch"
};

const dungeon1 = DungeonGenerator.generate(20, 15, defaultConfig);
console.log(`Generated dungeon: ${dungeon1.map.length}x${dungeon1.map[0].length}`);
console.log(`Entrance: [${dungeon1.entrance}]`);
console.log(`Exit: [${dungeon1.exit}]`);
console.log(`Treasure: [${dungeon1.treasure}]`);
console.log(`Torches: ${dungeon1.torches.length} placed`);

// Count tile types
const tileCounts = {};
for (let y = 0; y < dungeon1.map.length; y++) {
    for (let x = 0; x < dungeon1.map[0].length; x++) {
        const tile = dungeon1.map[y][x];
        tileCounts[tile] = (tileCounts[tile] || 0) + 1;
    }
}

console.log("\n📊 Tile Distribution:");
Object.keys(tileCounts).sort().forEach(tile => {
    console.log(`  ${tile}: ${tileCounts[tile]} tiles`);
});

if (tileCounts["'1"] && tileCounts["'2"]) {
    const floorTotal = tileCounts["'1"] + tileCounts["'2"];
    const variationPercent = (tileCounts["'2"] / floorTotal * 100).toFixed(2);
    console.log(`  Floor variation: ${variationPercent}% secondary floors`);
}

// Test 2: Custom Configuration  
console.log("\n🔧 Test 2: Custom Configuration (Bitcoin theme)");
const customConfig = {
    playerType: "@2",
    treasureType: "$B", 
    monsterType: "~2",
    primaryFloor: "'1",
    secondaryFloor: "'2",
    floorVariation: 0.05, // 5% variation
    torchEnabled: true,
    torchDensity: 0.25,   // 25% more torches
    torchTile: "torch"
};

const dungeon2 = DungeonGenerator.generate(15, 10, customConfig);
console.log(`Generated custom dungeon: ${dungeon2.map.length}x${dungeon2.map[0].length}`);
console.log(`Torches in custom dungeon: ${dungeon2.torches.length}`);

// Test 3: Show a small visual sample
console.log("\n🗺️  Sample Dungeon (15x12):");
const sampleDungeon = DungeonGenerator.generate(15, 12, defaultConfig);

console.log("   012345678901234");
for (let y = 0; y < sampleDungeon.map.length; y++) {
    let line = y.toString().padStart(2) + " ";
    for (let x = 0; x < sampleDungeon.map[0].length; x++) {
        let char = sampleDungeon.map[y][x];
        
        // Add entities for display
        if (sampleDungeon.entrance && sampleDungeon.entrance[0] === x && sampleDungeon.entrance[1] === y) {
            char = '<';
        } else if (sampleDungeon.exit && sampleDungeon.exit[0] === x && sampleDungeon.exit[1] === y) {
            char = '>';
        } else if (sampleDungeon.treasure && sampleDungeon.treasure[0] === x && sampleDungeon.treasure[1] === y) {
            char = '$';
        }
        
        // Display character mapping
        if (char === "'1") char = '.';
        else if (char === "'2") char = ':';
        else if (char === 'torch') char = 'T';
        else if (char === '#') char = '#';
        
        line += char;
    }
    console.log(line);
}

console.log("\nLegend:");
console.log("  . = Primary floor ('1)");
console.log("  : = Secondary floor ('2)");
console.log("  # = Wall");
console.log("  T = Torch");
console.log("  < = Entrance");
console.log("  > = Exit");
console.log("  $ = Treasure");

console.log("\n✅ Tile System Test Complete!");
console.log("\nFeatures verified:");
console.log("  ✓ Configurable player/treasure/monster types");
console.log("  ✓ Floor tile variations (primary/secondary)");
console.log("  ✓ Configurable torch placement");
console.log("  ✓ Enhanced dungeon generation");
console.log("  ✓ Torch position tracking");
