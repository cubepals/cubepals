// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.Set;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.BlockData;

/**
 * Blocks that change on random ticks, made up for a gap: each is given the random ticks it would
 * have had (`RandomTicks`), in rounds among its neighbours' (`Rounds`), and each tick is
 * Minecraft's own (`Block.randomTick`), so what happens is
 * whatever that block does in the game, with Paper's own growth settings. A crop grows only in light
 * enough, faster on wet farmland; copper ages faster beside less-aged copper; leaves cut off from
 * their log decay; grass spreads only to lit dirt; ice and snow melt only beside a light; lava sets
 * alight only what burns, where fire is allowed. `randomTickSpeed` counts.
 *
 * A block stops being ticked once it takes no more (a crop fully grown, copper fully aged, a leaf
 * gone), and one that spreads once it has had a run that changed nothing (`RandomTicks.SETTLED`).
 * A plant that grows a new block of its kind at its tip (sugar cane, cactus, bamboo, kelp, vines,
 * dripstone) passes its remaining ticks to the new tip. The same as the Fabric mod's.
 */
final class RandomTicking {
    private final Classes classes;

    RandomTicking(Classes classes) {
        this.classes = classes;
    }

    Part partOf(BlockData data) {
        return classes.partOf(data);
    }

    /** Sorts every kind of block now (`Classes.warm`); how many. */
    int warm() {
        return classes.warm();
    }

    /** Whether a kind of block is of one of the given parts at all: the cheap look before `ticks`. */
    boolean mayTick(Material material, Set<Part> parts) {
        Part part = classes.partOf(material);
        return part != null && parts.contains(part);
    }

    /** Whether a block is one of the given parts that random ticks change, as it is now. */
    boolean ticks(BlockData data, Set<Part> parts) {
        Part part = classes.partOf(data);
        return part != null && parts.contains(part) && data.isRandomlyTicked();
    }

    boolean spreads(BlockData data) {
        return Part.spreads(classes.of(data));
    }

    /** One random tick, Minecraft's own, of the block at a place, for `Rounds`. */
    Rounds.Ticker<Block> ticker(Set<Part> parts) {
        return at -> {
            BlockData state = at.getBlockData();
            if (!ticks(state, parts)) return null;
            Block above = at.getRelative(BlockFace.UP);
            Block below = at.getRelative(BlockFace.DOWN);
            BlockData wasAbove = above.getBlockData();
            BlockData wasBelow = below.getBlockData();
            at.randomTick();
            BlockData nowAbove = above.getBlockData();
            BlockData nowBelow = below.getBlockData();
            boolean changed = !at.getBlockData().equals(state) || !nowAbove.equals(wasAbove) || !nowBelow.equals(wasBelow);
            Block next = at;
            if (!nowAbove.equals(wasAbove) && nowAbove.getMaterial() == state.getMaterial()) next = above;
            else if (!nowBelow.equals(wasBelow) && nowBelow.getMaterial() == state.getMaterial()) next = below;
            return new Rounds.Outcome<>(next, changed);
        };
    }
}
