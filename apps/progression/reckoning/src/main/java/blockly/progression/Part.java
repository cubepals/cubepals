// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;

/**
 * What is caught up, in the parts its owner can turn off one by one on the server's settings page:
 * which parts are on reaches the plugin or mod as `CUBEPALS_PROGRESSION`, a list of their names, at
 * every start. Without it (an older control plane, a server run by hand), every part is on but
 * fire, as Cubepals' own default.
 *
 * Which part a block belongs to is read from its class and the classes it extends, by Minecraft's
 * own names (`of`), the same on Paper and Fabric, so a mod's crop built on Minecraft's crop counts
 * as a crop. A block of none of them is left alone: the Nether portal, whose random ticks spawn
 * mobs, and anything a mod adds of its own.
 */
enum Part {
    /** Furnaces, smokers, blast furnaces, brewing stands and campfires. */
    FURNACES("furnaces"),
    /** Crops, stems, cane, cactus, bamboo, cocoa, wart, berries, vines, mushrooms, saplings, farmland. */
    PLANTS("plants"),
    /** Baby animals growing up, breeding waiting out, sheep's wool, turtle eggs and dried ghasts. */
    ANIMALS("animals"),
    /** Copper aging, leaves decaying, grass, mycelium and nylium, ice and snow melting, amethyst, dripstone. */
    WORLD("world"),
    /** Lava setting things alight, and fire spreading and burning out. */
    FIRE("fire");

    /** What `CUBEPALS_PROGRESSION` is read from. */
    static final String ENV = "CUBEPALS_PROGRESSION";

    final String key;

    Part(String key) {
        this.key = key;
    }

    /** The parts a server's start turned on: the variable's names, or Cubepals' default without it. */
    static Set<Part> fromEnv(String value) {
        if (value == null) return EnumSet.complementOf(EnumSet.of(FIRE));
        Set<Part> on = EnumSet.noneOf(Part.class);
        for (String name : value.split(",")) {
            for (Part part : values()) if (part.key.equals(name.trim())) on.add(part);
        }
        return on;
    }

    /** A block's part, from its class's simple name and those of the classes it extends; null for none. */
    static Part of(List<String> classes) {
        for (String name : classes) {
            Part part = ofClass(name);
            if (part != null) return part;
        }
        return null;
    }

    /**
     * Whether a block spreads to its neighbours (grass, mycelium, nylium): its random ticks mostly
     * find nothing to spread to, so it is given up on after a run of them that changed nothing
     * (`RandomTicks.SETTLED`).
     */
    static boolean spreads(List<String> classes) {
        for (String name : classes) if (name.startsWith("SpreadingSnowy") || name.equals("NyliumBlock")) return true;
        return false;
    }

    /** Whether a block is fire that spreads (not soul fire): its ticks are scheduled, not random. */
    static boolean isFire(List<String> classes) {
        return !classes.isEmpty() && classes.get(0).equals("FireBlock");
    }

    private static Part ofClass(String name) {
        switch (name) {
            case "CropBlock", "StemBlock", "SugarCaneBlock", "CactusBlock", "ChorusFlowerBlock", "CocoaBlock",
                    "NetherWartBlock", "SweetBerryBushBlock", "BambooStalkBlock", "BambooSaplingBlock",
                    "GrowingPlantHeadBlock", "PitcherCropBlock", "SaplingBlock", "VineBlock", "MushroomBlock",
                    "FarmlandBlock", "EyeblossomBlock", "FlowerPotBlock":
                return PLANTS;
            case "LeavesBlock", "SpreadingSnowyBlock", "SpreadingSnowyDirtBlock", "NyliumBlock", "IceBlock",
                    "SnowLayerBlock", "BuddingAmethystBlock", "PointedDripstoneBlock", "SpeleothemBlock",
                    "RedStoneOreBlock":
                return WORLD;
            case "TurtleEggBlock", "DriedGhastBlock":
                return ANIMALS;
            case "LiquidBlock", "FireBlock":
                return FIRE;
            case "NetherPortalBlock":
                return null;
            default:
                return name.startsWith("Weathering") ? WORLD : null;
        }
    }
}
