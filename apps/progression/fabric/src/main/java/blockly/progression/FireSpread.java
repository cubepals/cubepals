// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Fire made up for a gap: fire's ticks are scheduled, every 30 to 40 game ticks, not random, so each
 * fire in the chunk is given Minecraft's own fire tick once a round, a round for each 35 ticks owed,
 * and a fire it lights is ticked from the next round on. So fire spreads to what burns and burns it
 * away, goes out in the rain or with nothing to burn, and does nothing where `doFireTick` is off or
 * no player is near enough (`fireSpreadRadiusAroundPlayer`), as in the game. Lava setting things
 * alight is a random tick (`RandomTicking`).
 *
 * Only fire whose neighbouring chunks are loaded is ticked, so a fire at an edge never loads another
 * chunk, and at most `MOST_ROUNDS` rounds: a fire that would still burn after that many burns on in
 * the game once the chunk ticks.
 */
final class FireSpread {
    /** Game ticks between one fire tick and the next, about: 30 plus 0 to 9, on average 35. */
    private static final int TICKS_A_ROUND = 35;

    /** The most rounds made up: about an hour and a half of fire. */
    private static final int MOST_ROUNDS = 150;

    private FireSpread() {}

    /** The fires in a chunk, as it is now. */
    static boolean isFire(BlockState state) {
        return Part.isFire(RandomTicking.classes(state.getBlock()));
    }

    /** The job: rounds of fire ticks, a round each step until done. */
    static Work.Job job(ServerLevel level, List<BlockPos> fires, long owed, Totals totals) {
        return new Work.Job() {
            private final ArrayDeque<BlockPos> burning = new ArrayDeque<>(fires);
            private long rounds = Math.min(owed / TICKS_A_ROUND, MOST_ROUNDS);

            @Override
            public boolean step(long deadline) {
                while (rounds > 0 && !burning.isEmpty()) {
                    if (System.nanoTime() >= deadline) return false;
                    rounds--;
                    Set<BlockPos> next = new HashSet<>();
                    for (BlockPos pos : burning) {
                        BlockState state = level.getBlockState(pos);
                        if (!isFire(state) || !neighboursLoaded(level, pos)) continue;
                        state.tick(level, pos, level.getRandom());
                        for (BlockPos near : BlockPos.betweenClosed(pos.offset(-1, -1, -1), pos.offset(1, 4, 1)))
                            if (isFire(level.getBlockState(near))) next.add(near.immutable());
                    }
                    int before = burning.size();
                    burning.clear();
                    burning.addAll(next);
                    totals.fires += Math.max(0, burning.size() - before);
                }
                return true;
            }
        };
    }

    private static boolean neighboursLoaded(ServerLevel level, BlockPos pos) {
        int cx = pos.getX() >> 4;
        int cz = pos.getZ() >> 4;
        for (int dx = -1; dx <= 1; dx++)
            for (int dz = -1; dz <= 1; dz++)
                if (level.getChunkSource().getChunkNow(cx + dx, cz + dz) == null) return false;
        return true;
    }
}
