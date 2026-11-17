// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayDeque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.bukkit.Material;
import org.bukkit.block.Block;

/**
 * Fire made up for a gap: fire's ticks are scheduled, every 30 to 40 game ticks, not random, so each
 * fire in the chunk is given Minecraft's own fire tick (`Block.tick`) once a round, a round for each
 * 35 ticks owed, and a fire it lights is ticked from the next round on. So fire spreads to what
 * burns and burns it away, goes out in the rain or with nothing to burn, and does nothing where
 * `doFireTick` is off or no player is near enough, as in the game. Lava setting things alight is a
 * random tick (`RandomTicking`).
 *
 * Only fire whose neighbouring chunks are loaded is ticked, so a fire at an edge never loads another
 * chunk, and at most `MOST_ROUNDS` rounds. The same as the Fabric mod's.
 */
final class FireSpread {
    private static final int TICKS_A_ROUND = 35;
    private static final int MOST_ROUNDS = 150;

    private FireSpread() {}

    static Work.Job job(List<Block> fires, long owed, Totals totals) {
        return new Burn(fires, Math.min(owed / TICKS_A_ROUND, MOST_ROUNDS), totals);
    }

    /** The rounds of a chunk's fires, a fire at a time within the deadline: a round can be large. */
    private static final class Burn implements Work.Job {
        private final ArrayDeque<Block> burning;
        private final Set<Block> next = new LinkedHashSet<>();
        private final Totals totals;
        private long rounds;
        private boolean inRound;
        private int before;

        Burn(List<Block> fires, long rounds, Totals totals) {
            this.burning = new ArrayDeque<>(fires);
            this.rounds = rounds;
            this.totals = totals;
        }

        @Override
        public boolean step(long deadline) {
            while (true) {
                if (inRound && burning.isEmpty()) {
                    totals.fires += Math.max(0, next.size() - before);
                    burning.addAll(next);
                    next.clear();
                    inRound = false;
                }
                if (!inRound) {
                    if (rounds == 0 || burning.isEmpty()) return true;
                    rounds--;
                    before = burning.size();
                    inRound = true;
                }
                if (System.nanoTime() >= deadline) return false;
                tick(burning.poll());
            }
        }

        private void tick(Block fire) {
            // Loaded first: a fire spread into a neighbour may be in a chunk unloaded since, and
            // reading its block would load it.
            if (!neighboursLoaded(fire) || fire.getType() != Material.FIRE) return;
            fire.tick();
            for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 4; dy++)
                    for (int dz = -1; dz <= 1; dz++) {
                        Block near = fire.getRelative(dx, dy, dz);
                        if (near.getType() == Material.FIRE) next.add(near);
                    }
        }
    }

    private static boolean neighboursLoaded(Block fire) {
        int cx = fire.getX() >> 4;
        int cz = fire.getZ() >> 4;
        for (int dx = -1; dx <= 1; dx++)
            for (int dz = -1; dz <= 1; dz++)
                if (!fire.getWorld().isChunkLoaded(cx + dx, cz + dz)) return false;
        return true;
    }
}
