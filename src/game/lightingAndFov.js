const ROT = require('./rot.js');

class LightingAndFov {
    /**
     * Initializes the FOV calculator.
     * @param {object} dungeonMap - The dungeon map.
     * @param {object} gameConfig - Game configuration containing tile definitions.
     * @returns {object} ROT.FOV.PreciseShadowcasting instance.
     */
    static initializeFOV(dungeonMap, gameConfig) {
        return new ROT.FOV.PreciseShadowcasting(
            (x, y) => {
                if (!dungeonMap[y] || dungeonMap[y][x] === undefined) return false;
                const tile = dungeonMap[y][x];
                const primaryFloor = gameConfig.primaryFloor || "'1";
                const secondaryFloor = gameConfig.secondaryFloor || "'2";
                return tile === primaryFloor || tile === secondaryFloor;
            }
        );
    }

    /**
     * Updates the visible tiles based on player position and FOV.
     * @param {object} fov - The FOV calculator instance.
     * @param {object} player - The player object with x, y coordinates.
     * @param {object} dungeonMap - The dungeon map.
     * @param {number} fovRadius - The radius of the FOV.
     * @returns {object} The visible tiles object.
     */
    static updateFOV(fov, player, dungeonMap, fovRadius = 10) {
        const visibleTiles = {};
        fov.compute(player.x, player.y, fovRadius, (x, y, r, visibility) => {
            if (visibility > 0) {
                if (!visibleTiles[y]) {
                    visibleTiles[y] = {};
                }
                if (dungeonMap && dungeonMap[y] && dungeonMap[y][x] !== undefined) {
                    visibleTiles[y][x] = dungeonMap[y][x];
                }
            }
        });
        return visibleTiles;
    }

    /**
     * Calculates lighting levels for all visible tiles based on distance from torches.
     * @param {object} player - The player object with x, y coordinates.
     * @param {Array} allTorches - An array of all torch positions [[x,y], ...].
     * @param {object} visibleTiles - The visible tiles object.
     * @param {number} fovRadius - The player's FOV radius.
     * @returns {object} The lighting data object.
     */
    static calculateLighting(player, allTorches = [], visibleTiles, fovRadius = 10) {
        const lightingData = {};
        const playerX = player.x;
        const playerY = player.y;
        // const maxLightDistance = 6; // Max distance light from a torch can reach // Old value
        const maxDarknessDistance = 8; // Distance at which light fully drops to max darkness
        const maxTorchInfluenceRadius = fovRadius + maxDarknessDistance;

        const nearbyTorches = allTorches.filter(torch => {
            const distToPlayer = Math.max(Math.abs(torch[0] - playerX), Math.abs(torch[1] - playerY));
            return distToPlayer < maxTorchInfluenceRadius;
        });

        // console.log(`[CalculateLighting] Player at (${playerX},${playerY}). Found ${allTorches.length} total torches. Nearby torches (radius ${maxTorchInfluenceRadius}): ${nearbyTorches.length}`);

        // let sampleAlpha1 = -1, sampleAlpha2 = -1, sampleAlpha3 = -1; // For logging flicker
        // let sampleAlpha4 = -1, sampleAlpha5 = -1; // Optional for extended logging

        for (const yKey in visibleTiles) {
            const y = parseInt(yKey);
            lightingData[y] = {};
            for (const xKey in visibleTiles[y]) {
                const x = parseInt(xKey);
                let minDistanceToTorch = Infinity;

                if (nearbyTorches.length === 0) {
                    minDistanceToTorch = maxTorchInfluenceRadius; // Effectively max darkness if no torches nearby
                } else {
                    for (const torch of nearbyTorches) {
                        const distance = Math.max(Math.abs(x - torch[0]), Math.abs(y - torch[1]));
                        minDistanceToTorch = Math.min(minDistanceToTorch, distance);
                    }
                }

                let alpha = 0.0;
                if (minDistanceToTorch === 0) { // Tile is a torch
                    alpha = 0.0;
                } else if (minDistanceToTorch === 1) {
                    alpha = 0.05 + Math.random() * 0.15; // Flicker: 0.05 - 0.20
                    // if (sampleAlpha1 < 0) sampleAlpha1 = alpha;
                } else if (minDistanceToTorch === 2) {
                    alpha = 0.15 + Math.random() * 0.15; // Flicker: 0.15 - 0.30
                    // if (sampleAlpha2 < 0) sampleAlpha2 = alpha;
                } else if (minDistanceToTorch === 3) {
                    alpha = 0.25 + Math.random() * 0.15; // Flicker: 0.25 - 0.40
                    // if (sampleAlpha3 < 0) sampleAlpha3 = alpha;
                } else if (minDistanceToTorch === 4) {
                    alpha = 0.35 + Math.random() * 0.15; // Flicker: 0.35 - 0.50
                    // if (sampleAlpha4 < 0) sampleAlpha4 = alpha;
                } else if (minDistanceToTorch === 5) {
                    alpha = 0.45 + Math.random() * 0.15; // Flicker: 0.45 - 0.60
                    // if (sampleAlpha5 < 0) sampleAlpha5 = alpha;
                } else {
                    // Stable falloff for distances > 5 up to maxDarknessDistance
                    const falloffStartDistance = 5; // End of flicker zones
                    const lightLevelAtFalloffStart = 0.6; // Max alpha from distance 5 flicker (0.45 + 0.15)
                    const maxDarknessAlpha = 0.9;

                    if (minDistanceToTorch >= maxDarknessDistance) {
                        alpha = maxDarknessAlpha;
                    } else { // minDistanceToTorch is between (falloffStartDistance + 1) and (maxDarknessDistance - 1)
                        let progress = (minDistanceToTorch - falloffStartDistance) / (maxDarknessDistance - falloffStartDistance);
                        alpha = lightLevelAtFalloffStart + progress * (maxDarknessAlpha - lightLevelAtFalloffStart);
                    }
                }
                alpha = Math.max(0.0, Math.min(0.9, alpha)); // Clamp alpha between 0.0 and 0.9
                lightingData[y][x] = alpha;
            }
        }
        // console.log(\`💡 Flicker samples (dist 1,2,3): \${sampleAlpha1.toFixed(3)}, \${sampleAlpha2.toFixed(3)}, \${sampleAlpha3.toFixed(3)}\`);
        return lightingData;
    }
}

module.exports = LightingAndFov;
