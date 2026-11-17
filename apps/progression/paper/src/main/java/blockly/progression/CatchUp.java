// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SplittableRandom;
import org.bukkit.Chunk;
import org.bukkit.ChunkSnapshot;
import org.bukkit.GameRule;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.data.BlockData;

/**
 * One chunk made up for one gap, in the parts that are on (`Part`), as a job done over as many ticks
 * as it needs (`Work`), while the chunk ticks. Its animals go first, as soon as its entities tick
 * (`Herds`), before any wander in. The rest waits a second, then is a queue of phases, what players
 * look for first: furnaces, brewing stands and campfires (`Cooking`); then blocks that change on
 * random ticks, a set of rounds for each part in `Part`'s order (`RandomTicking`, `Rounds`); then
 * fire (`FireSpread`). What it finds is read as it starts, a section at a time within the same
 * budget, so a chunk that unloads before its turn is left owing what it didn't get (`Chunks` keeps
 * its old stamp for it). The same as the
 * Fabric mod's.
 */
final class CatchUp implements Work.Job {
    /** Ticks to wait for a chunk's animals to load and tick before going on without them. */
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
    private boolean herded;
    private int waited;
    /** The chunk as it was as its catch-up began, while its blocks are being read (`scan`). */
    private ChunkSnapshot snapshot;
    private int nextSection;
    private int speed;
    private final Map<Part, Rounds<Block>> rounds = new EnumMap<>(Part.class);
    private final List<Block> fires = new ArrayList<>();

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

    /**
     * Whether it has begun to give its chunk what it was owed: once its blocks are read, since
     * reading them gives nothing, and a chunk that goes while they are read still owes it all.
     */
    boolean started() {
        return started && snapshot == null;
    }

    /** Whether it has begun reading its chunk, which a later gap can't be added to. */
    boolean planned() {
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
        Chunk chunk = world.getChunkAt(chunkX, chunkZ);
        Chunk.LoadLevel level = chunk.getLoadLevel();
        // A chunk players left waits until it ticks again: its edge blocks reach into neighbours
        // that may no longer be loaded.
        if (level != Chunk.LoadLevel.TICKING && level != Chunk.LoadLevel.ENTITY_TICKING) return false;
        if (!herded) herd(chunk, level);
        if (!started) {
            if (++settled < SETTLE) return false;
            started = true;
            plan(chunk);
            totals.chunk(Math.max(owed, animalsOwed));
        }
        if (snapshot != null && !scan(deadline)) return false;
        while (!phases.isEmpty()) {
            if (!phases.peek().step(deadline)) return false;
            phases.poll();
        }
        return herded;
    }

    /**
     * The chunk's animals, first and at once, as soon as its entities tick and are loaded: the
     * animals in it then are the ones that missed its time, before any wanders in from a chunk that
     * didn't. Without them a few seconds on, it goes on without them.
     */
    private void herd(Chunk chunk, Chunk.LoadLevel level) {
        if (animalsOwed == 0 || !parts.contains(Part.ANIMALS)) {
            herded = true;
        } else if (level == Chunk.LoadLevel.ENTITY_TICKING && chunk.isEntitiesLoaded()) {
            totals.animals += Herds.catchUp(chunk, animalsOwed, System.currentTimeMillis(), random);
            herded = true;
        } else if (++waited >= ANIMALS_WAIT) {
            herded = true;
        }
    }

    /**
     * Begins reading what the chunk holds of the parts that are on, as it is now: its furnaces and
     * the like at once (there are few), its blocks a section at a time (`scan`).
     */
    private void plan(Chunk chunk) {
        if (owed == 0) return;
        if (cooking != null && parts.contains(Part.FURNACES))
            for (BlockState state : chunk.getTileEntities(block -> true, false))
                if (Cooking.cooks(state)) phases.add(cooking.job(state.getBlock(), owed, totals));
        Integer rule = world.getGameRuleValue(GameRule.RANDOM_TICK_SPEED);
        speed = rule == null ? 0 : rule;
        snapshot = chunk.getChunkSnapshot(false, false, false);
    }

    /**
     * Reads the chunk's blocks, a section at a time until `deadline` (at least one each step), into
     * a set of rounds for each part and the fires; true once all are read and queued as phases.
     */
    private boolean scan(long deadline) {
        int min = world.getMinHeight();
        int max = world.getMaxHeight();
        while (nextSection * 16 + min < max) {
            scanSection(nextSection++, min, max);
            if (System.nanoTime() >= deadline && nextSection * 16 + min < max) return false;
        }
        snapshot = null;
        for (Part part : Part.values()) if (rounds.containsKey(part)) phases.add(rounds.get(part));
        if (!fires.isEmpty()) phases.add(FireSpread.job(fires, owed, totals));
        return true;
    }

    /** One section's blocks that random ticks change, and its fires where fire is on. */
    private void scanSection(int section, int min, int max) {
        if (snapshot.isSectionEmpty(section)) return;
        boolean fire = parts.contains(Part.FIRE);
        int bottom = min + section * 16;
        for (int y = bottom; y < bottom + 16 && y < max; y++)
            for (int x = 0; x < 16; x++)
                for (int z = 0; z < 16; z++) {
                    Material type = snapshot.getBlockType(x, y, z);
                    if (fire && type == Material.FIRE) fires.add(world.getBlockAt(chunkX * 16 + x, y, chunkZ * 16 + z));
                    if (!ticking.mayTick(type, parts)) continue;
                    BlockData data = snapshot.getBlockData(x, y, z);
                    if (!ticking.ticks(data, parts)) continue;
                    Part part = ticking.partOf(data);
                    rounds.computeIfAbsent(part, p -> new Rounds<>(ticking.ticker(parts), this::count))
                            .add(world.getBlockAt(chunkX * 16 + x, y, chunkZ * 16 + z),
                                    RandomTicks.count(owed, speed, random), ticking.spreads(data), part);
                }
    }

    private void count(Part part) {
        if (part == Part.PLANTS) totals.plants++;
        else if (part == Part.ANIMALS) totals.animals++;
        else if (part == Part.FIRE) totals.fires++;
        else totals.world++;
    }
}
