// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.EnumSet;
import java.util.List;
import org.junit.jupiter.api.Test;

class PartTest {
    @Test
    void withoutTheVariableEverythingButFireIsOn() {
        assertEquals(EnumSet.of(Part.FURNACES, Part.PLANTS, Part.ANIMALS, Part.WORLD), Part.fromEnv(null));
    }

    @Test
    void theVariableNamesThePartsThatAreOn() {
        assertEquals(EnumSet.of(Part.PLANTS, Part.FIRE), Part.fromEnv("plants, fire"));
        assertEquals(EnumSet.noneOf(Part.class), Part.fromEnv(""));
        assertEquals(EnumSet.of(Part.WORLD), Part.fromEnv("world,unknown"));
    }

    @Test
    void aBlockIsSortedByItsOwnClassOrOneItExtends() {
        assertEquals(Part.PLANTS, Part.of(List.of("BeetrootBlock", "CropBlock", "VegetationBlock", "Block")));
        // A mod's crop built on Minecraft's own.
        assertEquals(Part.PLANTS, Part.of(List.of("TomatoBlock", "CropBlock", "Block")));
        assertEquals(Part.WORLD, Part.of(List.of("WeatheringCopperDoorBlock", "DoorBlock", "Block")));
        assertEquals(Part.WORLD, Part.of(List.of("WeatheringLightningRodBlock", "LightningRodBlock", "Block")));
        assertEquals(Part.WORLD, Part.of(List.of("GrassBlock", "SpreadingSnowyBlock", "SnowyBlock", "Block")));
        assertEquals(Part.WORLD, Part.of(List.of("MyceliumBlock", "SpreadingSnowyDirtBlock", "Block")));
        assertEquals(Part.ANIMALS, Part.of(List.of("TurtleEggBlock", "Block")));
        assertEquals(Part.FIRE, Part.of(List.of("LiquidBlock", "Block")));
    }

    @Test
    void thePortalAndUnknownBlocksAreLeftAlone() {
        assertNull(Part.of(List.of("NetherPortalBlock", "Block")));
        assertNull(Part.of(List.of("StoneBlock", "Block")));
        assertNull(Part.of(List.of()));
    }

    @Test
    void onlyGrassMyceliumAndNyliumSpread() {
        assertTrue(Part.spreads(List.of("GrassBlock", "SpreadingSnowyBlock")));
        assertTrue(Part.spreads(List.of("NyliumBlock", "Block")));
        assertFalse(Part.spreads(List.of("CropBlock", "Block")));
    }

    @Test
    void onlyFireThatSpreadsIsFire() {
        assertTrue(Part.isFire(List.of("FireBlock", "BaseFireBlock", "Block")));
        assertFalse(Part.isFire(List.of("SoulFireBlock", "BaseFireBlock", "Block")));
    }
}
