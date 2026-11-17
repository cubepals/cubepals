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
 * is read as it starts, from the chunk as it is then; a chunk that unloads before its turn is left
 * owing what it didn't get (`Level` keeps its old stamp for it).
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
    private final long owed;
    private final Set<Part> parts;
    private final Totals totals;
    private final SplittableRandom random = new SplittableRandom();
    private final ArrayDeque<Work.Job> phases = new ArrayDeque<>();
    private int settled;
    private boolean started;

    ChunkCatchUp(ServerLevel level, LevelChunk chunk, long owed, Set<Part> parts, Totals totals) {
        this.level = level;
        this.chunk = chunk;
        this.owed = owed;
        this.parts = parts;
        this.totals = totals;
    }

    boolean started() {
        return started;
    }

    @Override
    public boolean step(long deadline) {
        if (level.getChunkSource().getChunkNow(chunk.getPos().x(), chunk.getPos().z()) != chunk) return true;
        if (!started) {
            if (++settled < SETTLE) return false;
            started = true;
            plan();
            totals.chunk(owed);
        }
        while (!phases.isEmpty()) {
            if (!phases.peek().step(deadline)) return false;
            phases.poll();
        }
        return true;
    }

    /** Reads what the chunk holds of the parts that are on, as it is now, into its phases. */
    private void plan() {
        if (parts.contains(Part.FURNACES))
            for (BlockEntity entity : chunk.getBlockEntities().values())
                if (Cooking.cooks(entity)) phases.add(Cooking.job(level, entity.getBlockPos(), owed, totals));
        Map<Part, Rounds<BlockPos>> rounds = randomTicks();
        for (Part part : Part.values()) {
            if (rounds.containsKey(part)) phases.add(rounds.get(part));
            if (part == Part.ANIMALS && parts.contains(Part.ANIMALS)) phases.add(animals());
        }
        if (parts.contains(Part.FIRE)) {
            List<BlockPos> fires = FireSpread.firesIn(chunk);
            if (!fires.isEmpty()) phases.add(FireSpread.job(level, fires, owed, totals));
        }
    }

    /** A set of rounds for each part, of every block in the chunk random ticks change. */
    private Map<Part, Rounds<BlockPos>> randomTicks() {
        int speed = level.getGameRules().get(GameRules.RANDOM_TICK_SPEED);
        Map<Part, Rounds<BlockPos>> rounds = new EnumMap<>(Part.class);
        LevelChunkSection[] sections = chunk.getSections();
        int minX = chunk.getPos().getMinBlockX();
        int minZ = chunk.getPos().getMinBlockZ();
        for (int index = 0; index < sections.length; index++) {
            LevelChunkSection section = sections[index];
            if (section.hasOnlyAir() || !section.maybeHas(state -> RandomTicking.ticks(state, parts))) continue;
            int bottom = chunk.getSectionYFromSectionIndex(index) * 16;
            for (int y = 0; y < 16; y++)
                for (int x = 0; x < 16; x++)
                    for (int z = 0; z < 16; z++) {
                        BlockState state = section.getBlockState(x, y, z);
                        if (!RandomTicking.ticks(state, parts)) continue;
                        Part part = RandomTicking.partOf(state);
                        rounds.computeIfAbsent(part, p -> new Rounds<>(RandomTicking.ticker(level, parts), this::count))
                                .add(new BlockPos(minX + x, bottom + y, minZ + z), RandomTicks.count(owed, speed, random),
                                        RandomTicking.spreads(state), part);
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
                if (!level.areEntitiesLoaded(chunk.getPos().pack()) && ++waited < ANIMALS_WAIT) return false;
                totals.animals += Herds.catchUp(level, chunk, owed, System.currentTimeMillis(), random);
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
