// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayDeque;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SplittableRandom;
import org.bukkit.Chunk;
import org.bukkit.ChunkSnapshot;
import org.bukkit.GameRule;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.data.BlockData;

/**
 * One chunk made up for one gap, in the parts that are on (`Part`), as a job done over as many ticks
 * as it needs (`Work`), once it has ticked for a second. Its work is a queue of phases, what players
 * look for first: furnaces, brewing stands and campfires (`Cooking`); then blocks that change on
 * random ticks, a set of rounds for each part in `Part`'s order (`RandomTicking`, `Rounds`), with
 * the animals themselves (`Herds`) after the animals' blocks; then fire (`FireSpread`). What it finds
 * is read as it starts, from the chunk as it is then, so a chunk that unloads before its turn is
 * left owing what it didn't get (`Chunks` keeps its old stamp for it). The same as the Fabric mod's.
 */
final class CatchUp implements Work.Job {
    /** Ticks to wait for a chunk's animals to load after its blocks before going on without them. */
    private static final int ANIMALS_WAIT = 200;

    /**
     * Ticks a chunk ticks before it is made up: a second, for the ticks it had scheduled as it was
     * saved to run first, as leaves cut off from their log learn so by one.
     */
    private static final int SETTLE = 20;

    private final World world;
    private final int chunkX;
    private final int chunkZ;
    /** Ticks owed to its blocks, and to its animals (`Chunks`: the two can differ). */
    private long owed;
    private long animalsOwed;
    private final Set<Part> parts;
    private final Cooking cooking;
    private final RandomTicking ticking;
    private final Totals totals;
    private final SplittableRandom random = new SplittableRandom();
    private final ArrayDeque<Work.Job> phases = new ArrayDeque<>();
    private int settled;
    private boolean started;
    private boolean ended;
    private boolean cancelled;

    CatchUp(World world, int chunkX, int chunkZ, long owed, long animalsOwed, Set<Part> parts, Cooking cooking,
            RandomTicking ticking, Totals totals) {
        this.world = world;
        this.chunkX = chunkX;
        this.chunkZ = chunkZ;
        this.owed = owed;
        this.animalsOwed = animalsOwed;
        this.parts = parts;
        this.cooking = cooking;
        this.ticking = ticking;
        this.totals = totals;
    }

    /** Whether it has begun, after which its chunk has had some of what it was owed. */
    boolean started() {
        return started;
    }

    /** Whether it is over, begun or not. */
    boolean ended() {
        return ended;
    }

    long owed() {
        return owed;
    }

    long animalsOwed() {
        return animalsOwed;
    }

    /** Adds a later gap to one that hasn't begun. */
    void owe(long more, long moreAnimals) {
        owed += more;
        animalsOwed += moreAnimals;
    }

    /** Ends it where it is: its chunk unloaded, and a load after is owed from the stamp kept (`Chunks`). */
    void cancel() {
        cancelled = true;
    }

    @Override
    public boolean step(long deadline) {
        if (ended) return true;
        ended = run(deadline);
        return ended;
    }

    private boolean run(long deadline) {
        if (cancelled || !world.isChunkLoaded(chunkX, chunkZ)) return true;
        if (!started) {
            if (++settled < SETTLE) return false;
            started = true;
            plan(world.getChunkAt(chunkX, chunkZ));
            totals.chunk(Math.max(owed, animalsOwed));
        }
        while (!phases.isEmpty()) {
            if (!phases.peek().step(deadline)) return false;
            phases.poll();
        }
        return true;
    }

    /** Reads what the chunk holds of the parts that are on, as it is now, into its phases. */
    private void plan(Chunk chunk) {
        if (owed == 0) {
            if (parts.contains(Part.ANIMALS)) phases.add(animals());
            return;
        }
        if (cooking != null && parts.contains(Part.FURNACES))
            for (BlockState state : chunk.getTileEntities(block -> true, false))
                if (Cooking.cooks(state)) phases.add(cooking.job(state.getBlock(), owed, totals));
        Map<Part, Rounds<Block>> rounds = randomTicks(chunk);
        for (Part part : Part.values()) {
            if (rounds.containsKey(part)) phases.add(rounds.get(part));
            if (part == Part.ANIMALS && parts.contains(Part.ANIMALS) && animalsOwed > 0) phases.add(animals());
        }
        if (parts.contains(Part.FIRE)) {
            List<Block> fires = FireSpread.firesIn(chunk);
            if (!fires.isEmpty()) phases.add(FireSpread.job(fires, owed, totals));
        }
    }

    /** A set of rounds for each part, of every block in the chunk random ticks change. */
    private Map<Part, Rounds<Block>> randomTicks(Chunk chunk) {
        Integer rule = world.getGameRuleValue(GameRule.RANDOM_TICK_SPEED);
        int speed = rule == null ? 0 : rule;
        Map<Part, Rounds<Block>> rounds = new EnumMap<>(Part.class);
        ChunkSnapshot snapshot = chunk.getChunkSnapshot(false, false, false);
        int min = world.getMinHeight();
        int max = world.getMaxHeight();
        for (int section = 0; section * 16 + min < max; section++) {
            if (snapshot.isSectionEmpty(section)) continue;
            int bottom = min + section * 16;
            for (int y = bottom; y < bottom + 16 && y < max; y++)
                for (int x = 0; x < 16; x++)
                    for (int z = 0; z < 16; z++) {
                        if (!ticking.mayTick(snapshot.getBlockType(x, y, z), parts)) continue;
                        BlockData data = snapshot.getBlockData(x, y, z);
                        if (!ticking.ticks(data, parts)) continue;
                        Part part = ticking.partOf(data);
                        rounds.computeIfAbsent(part, p -> new Rounds<>(ticking.ticker(parts), this::count))
                                .add(world.getBlockAt(chunkX * 16 + x, y, chunkZ * 16 + z),
                                        RandomTicks.count(owed, speed, random), ticking.spreads(data), part);
                    }
        }
        return rounds;
    }

    /** The chunk's animals, once its entities have loaded, or a few seconds on without them. */
    private Work.Job animals() {
        return new Work.Job() {
            private int waited;

            @Override
            public boolean step(long deadline) {
                Chunk chunk = world.getChunkAt(chunkX, chunkZ);
                if (!chunk.isEntitiesLoaded() && ++waited < ANIMALS_WAIT) return false;
                if (chunk.isEntitiesLoaded()) totals.animals += Herds.catchUp(chunk, animalsOwed, System.currentTimeMillis(), random);
                return true;
            }
        };
    }

    private void count(Part part) {
        if (part == Part.PLANTS) totals.plants++;
        else if (part == Part.ANIMALS) totals.animals++;
        else if (part == Part.FIRE) totals.fires++;
        else totals.world++;
    }
}
