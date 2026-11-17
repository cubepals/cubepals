// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.bukkit.Chunk;
import org.bukkit.ChunkSnapshot;
import org.bukkit.Material;
import org.bukkit.World;
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

    static List<Block> firesIn(Chunk chunk) {
        World world = chunk.getWorld();
        ChunkSnapshot snapshot = chunk.getChunkSnapshot(false, false, false);
        List<Block> fires = new ArrayList<>();
        int min = world.getMinHeight();
        int max = world.getMaxHeight();
        for (int section = 0; section * 16 + min < max; section++) {
            if (snapshot.isSectionEmpty(section)) continue;
            int bottom = min + section * 16;
            for (int y = bottom; y < bottom + 16 && y < max; y++)
                for (int x = 0; x < 16; x++)
                    for (int z = 0; z < 16; z++)
                        if (snapshot.getBlockType(x, y, z) == Material.FIRE)
                            fires.add(world.getBlockAt(chunk.getX() * 16 + x, y, chunk.getZ() * 16 + z));
        }
        return fires;
    }

    static Work.Job job(List<Block> fires, long owed, Totals totals) {
        return new Work.Job() {
            private final ArrayDeque<Block> burning = new ArrayDeque<>(fires);
            private long rounds = Math.min(owed / TICKS_A_ROUND, MOST_ROUNDS);

            @Override
            public boolean step(long deadline) {
                while (rounds > 0 && !burning.isEmpty()) {
                    if (System.nanoTime() >= deadline) return false;
                    rounds--;
                    Set<Block> next = new LinkedHashSet<>();
                    for (Block fire : burning) {
                        if (fire.getType() != Material.FIRE || !neighboursLoaded(fire)) continue;
                        fire.tick();
                        for (int dx = -1; dx <= 1; dx++)
                            for (int dy = -1; dy <= 4; dy++)
                                for (int dz = -1; dz <= 1; dz++) {
                                    Block near = fire.getRelative(dx, dy, dz);
                                    if (near.getType() == Material.FIRE) next.add(near);
                                }
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

    private static boolean neighboursLoaded(Block fire) {
        int cx = fire.getX() >> 4;
        int cz = fire.getZ() >> 4;
        for (int dx = -1; dx <= 1; dx++)
            for (int dz = -1; dz <= 1; dz++)
                if (!fire.getWorld().isChunkLoaded(cx + dx, cz + dz)) return false;
        return true;
    }
}
