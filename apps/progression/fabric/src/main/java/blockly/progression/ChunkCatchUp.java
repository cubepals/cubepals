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
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.gamerules.GameRules;

/**
 * One chunk made up for one gap, in the parts that are on (`Part`), as a job done over as many ticks
 * as it needs (`Work`), once it has ticked for a second. Its work is a queue of phases, what players
 * look for first: furnaces, brewing stands and campfires (`Cooking`); then blocks that change on
 * random ticks, a set of rounds for each part in `Part`'s order (`RandomTicking`, `Rounds`), with
 * the animals themselves (`Herds`) after the animals' blocks; then fire (`FireSpread`). What it finds
 * is read as it starts, a section at a time within the same budget; a chunk that unloads before its
 * turn is left owing what it didn't get (`Level` keeps its old stamp for it).
 */
final class ChunkCatchUp implements Work.Job {
    /** Ticks to wait for a chunk's animals to load after its blocks before going on without them. */
    private static final int ANIMALS_WAIT = 200;

    /**
     * Ticks a chunk ticks before it is made up: a second, for the ticks it had scheduled as it was
     * saved to run first, as leaves cut off from their log learn so by one.
     */
    private static final int SETTLE = 20;

    private final ServerLevel level;
    private final LevelChunk chunk;
    /** Ticks owed to its blocks, and to its animals (`Level`: the two can differ). */
    private long owed;
    private long animalsOwed;
    private final Set<Part> parts;
    private final Totals totals;
    private final SplittableRandom random = new SplittableRandom();
    private final ArrayDeque<Work.Job> phases = new ArrayDeque<>();
    private int settled;
    private boolean started;
    private boolean ended;
    /** While its blocks are being read (`scan`): where it is, and what it found. */
    private boolean scanning;
    private int nextSection;
    private int speed;
    private final Map<Part, Rounds<BlockPos>> rounds = new EnumMap<>(Part.class);
    private final List<BlockPos> fires = new ArrayList<>();

    ChunkCatchUp(ServerLevel level, LevelChunk chunk, long owed, long animalsOwed, Set<Part> parts, Totals totals) {
        this.level = level;
        this.chunk = chunk;
        this.owed = owed;
        this.animalsOwed = animalsOwed;
        this.parts = parts;
        this.totals = totals;
    }

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

    @Override
    public boolean step(long deadline) {
        if (ended) return true;
        ended = run(deadline);
        return ended;
    }

    private boolean run(long deadline) {
        if (level.getChunkSource().getChunkNow(chunk.getPos().x(), chunk.getPos().z()) != chunk) return true;
        if (!started) {
            if (++settled < SETTLE) return false;
            started = true;
            plan();
            totals.chunk(Math.max(owed, animalsOwed));
        }
        if (scanning && !scan(deadline)) return false;
        while (!phases.isEmpty()) {
            if (!phases.peek().step(deadline)) return false;
            phases.poll();
        }
        return true;
    }

    /**
     * Begins reading what the chunk holds of the parts that are on, as it is now: its furnaces and
     * the like at once (there are few), its blocks a section at a time (`scan`).
     */
    private void plan() {
        if (owed == 0) {
            if (parts.contains(Part.ANIMALS)) phases.add(animals());
            return;
        }
        if (parts.contains(Part.FURNACES))
            for (BlockEntity entity : chunk.getBlockEntities().values())
                if (Cooking.cooks(entity)) phases.add(Cooking.job(level, entity.getBlockPos(), owed, totals));
        speed = level.getGameRules().get(GameRules.RANDOM_TICK_SPEED);
        scanning = true;
    }

    /**
     * Reads the chunk's blocks, a section at a time until `deadline` (at least one each step), into
     * a set of rounds for each part and the fires; true once all are read and queued as phases.
     */
    private boolean scan(long deadline) {
        LevelChunkSection[] sections = chunk.getSections();
        while (nextSection < sections.length) {
            scanSection(sections, nextSection++);
            if (System.nanoTime() >= deadline && nextSection < sections.length) return false;
        }
        scanning = false;
        for (Part part : Part.values()) {
            if (rounds.containsKey(part)) phases.add(rounds.get(part));
            if (part == Part.ANIMALS && parts.contains(Part.ANIMALS) && animalsOwed > 0) phases.add(animals());
        }
        if (!fires.isEmpty()) phases.add(FireSpread.job(level, fires, owed, totals));
        return true;
    }

    /** One section's blocks that random ticks change, and its fires where fire is on. */
    private void scanSection(LevelChunkSection[] sections, int index) {
        LevelChunkSection section = sections[index];
        if (section.hasOnlyAir()) return;
        boolean fire = parts.contains(Part.FIRE) && section.maybeHas(FireSpread::isFire);
        if (!fire && !section.maybeHas(state -> RandomTicking.ticks(state, parts))) return;
        int minX = chunk.getPos().getMinBlockX();
        int minZ = chunk.getPos().getMinBlockZ();
        int bottom = chunk.getSectionYFromSectionIndex(index) * 16;
        for (int y = 0; y < 16; y++)
            for (int x = 0; x < 16; x++)
                for (int z = 0; z < 16; z++) {
                    BlockState state = section.getBlockState(x, y, z);
                    if (fire && FireSpread.isFire(state)) fires.add(new BlockPos(minX + x, bottom + y, minZ + z));
                    if (!RandomTicking.ticks(state, parts)) continue;
                    Part part = RandomTicking.partOf(state);
                    rounds.computeIfAbsent(part, p -> new Rounds<>(RandomTicking.ticker(level, parts), this::count))
                            .add(new BlockPos(minX + x, bottom + y, minZ + z), RandomTicks.count(owed, speed, random),
                                    RandomTicking.spreads(state), part);
                }
    }

    /** The chunk's animals, once its entities have loaded, or a few seconds on without them. */
    private Work.Job animals() {
        return new Work.Job() {
            private int waited;

            @Override
            public boolean step(long deadline) {
                if (!level.areEntitiesLoaded(chunk.getPos().pack()) && ++waited < ANIMALS_WAIT) return false;
                totals.animals += Herds.catchUp(level, chunk, animalsOwed, System.currentTimeMillis(), random);
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
