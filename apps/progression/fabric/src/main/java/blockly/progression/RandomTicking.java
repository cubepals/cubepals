// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Blocks that change on random ticks, made up for a gap: each is given the random ticks it would
 * have had (`RandomTicks`), in rounds among its neighbours' (`Rounds`), and each tick is
 * Minecraft's own (`BlockState.randomTick`), so what
 * happens is whatever that block does in the game. A crop grows only in light enough, faster on
 * wet farmland; copper ages faster beside less-aged copper; leaves cut off from their log decay;
 * grass spreads only to lit dirt; ice and snow melt only beside a light; lava sets alight only what
 * burns, where fire is allowed. `randomTickSpeed` counts.
 *
 * A block stops being ticked once it takes no more (a crop fully grown, copper fully aged, a leaf
 * gone), and one that spreads once it has had a run that changed nothing (`RandomTicks.SETTLED`).
 * A plant that grows a new block of its kind at its tip (sugar cane, cactus, bamboo, kelp, vines,
 * dripstone) passes its remaining ticks to the new tip, which is what would have been ticked.
 *
 * Which blocks, by part, is `Part.of`, read from Minecraft's own classes.
 */
final class RandomTicking {
    private static final Map<Block, Part> PARTS = new IdentityHashMap<>();
    private static final Map<Block, Boolean> SPREADS = new IdentityHashMap<>();

    private RandomTicking() {}

    /** A block's part; null for one none of them makes up. */
    static Part partOf(BlockState state) {
        Block block = state.getBlock();
        return PARTS.computeIfAbsent(block, b -> Part.of(classes(b)));
    }

    /** Whether a block is one of the given parts that random ticks change, as it is now. */
    static boolean ticks(BlockState state, Set<Part> parts) {
        Part part = partOf(state);
        return part != null && parts.contains(part) && state.isRandomlyTicking();
    }

    /** Whether a block spreads to its neighbours (`Part.spreads`). */
    static boolean spreads(BlockState state) {
        return SPREADS.computeIfAbsent(state.getBlock(), b -> Part.spreads(classes(b)));
    }

    /** One random tick, Minecraft's own, of the block at a place, for `Rounds`. */
    static Rounds.Ticker<BlockPos> ticker(ServerLevel level, Set<Part> parts) {
        return at -> {
            BlockState state = level.getBlockState(at);
            if (!ticks(state, parts)) return null;
            BlockPos above = at.above();
            BlockPos below = at.below();
            BlockState wasAbove = level.getBlockState(above);
            BlockState wasBelow = level.getBlockState(below);
            state.randomTick(level, at, level.getRandom());
            BlockState nowAbove = level.getBlockState(above);
            BlockState nowBelow = level.getBlockState(below);
            boolean changed = level.getBlockState(at) != state || nowAbove != wasAbove || nowBelow != wasBelow;
            BlockPos next = at;
            if (nowAbove != wasAbove && nowAbove.getBlock() == state.getBlock()) next = above;
            else if (nowBelow != wasBelow && nowBelow.getBlock() == state.getBlock()) next = below;
            return new Rounds.Outcome<>(next, changed);
        };
    }

    /** A block's class's simple name and those of the classes it extends, its own first. */
    static List<String> classes(Object of) {
        List<String> names = new ArrayList<>();
        for (Class<?> c = of.getClass(); c != null && c != Object.class; c = c.getSuperclass()) names.add(c.getSimpleName());
        return names;
    }
}
